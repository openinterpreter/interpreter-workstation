import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import {
  createDefaultMovieTimeline,
  createMovieManifest,
  MOVIE_MANIFEST_VERSION,
  type MovieAsset,
  type MovieAudioClip,
  type MovieManifest,
  type MovieTimelineDefinition,
  type MovieVideoClip,
} from '../../shared/movie-schema';
import {
  parseMovieTimelineModule,
  renderMovieComponentsModule,
  renderMovieIndexModule,
  renderMovieRuntimeModule,
  renderMovieTimelineModule,
} from '../../shared/movie-scaffold';
import type {
  MovieCompileComponentsRequest,
  MovieCompileComponentsResponse,
  MovieCancelExportRequest,
  MovieCancelExportResponse,
  MovieExportProgressEvent,
  MovieExportRequest,
  MovieExportResponse,
} from '../../electron/ipc/registry';
const MOVIE_MANIFEST_EXTENSION = '.movie';
const MOVIE_EXPORT_TIMEOUT_MS = 45_000;

let moviePreviewShimPromise:
  | Promise<Record<'react' | 'reactJsxRuntime' | 'reactJsxDevRuntime', string>>
  | null = null;

let movieRenderRuntimePackagePaths:
  | Record<'react' | 'reactDomClient' | 'reactJsxRuntime' | 'reactJsxDevRuntime', string>
  | null = null;

interface MovieAudioMixInput {
  input: string;
  trimStartSeconds: number;
  trimEndSeconds: number;
  timelineStartSeconds: number;
  volume: number;
}

interface ActiveMovieExport {
  abortController: AbortController;
  renderWindow: ElectronBrowserWindow | null;
  ffmpegProcess: ChildProcess | null;
}

class MovieExportCancelledError extends Error {
  constructor(message = 'Movie export cancelled') {
    super(message);
    this.name = 'MovieExportCancelledError';
  }
}

const activeMovieExports = new Map<string, ActiveMovieExport>();

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readMovieManifest(manifestPath: string): Promise<MovieManifest> {
  const raw = await fs.readFile(manifestPath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<MovieManifest>;

  if (parsed.version !== MOVIE_MANIFEST_VERSION) {
    throw new Error(`Unsupported .movie manifest version: ${String(parsed.version)}`);
  }
  if (!parsed.timelinePath || !parsed.runtimePath || !parsed.entryPoint) {
    throw new Error('Movie project is missing required scaffold paths');
  }
  if (!parsed.assetsDir || !parsed.metadataDir || !parsed.rendersDir) {
    throw new Error('Movie project is missing required directories');
  }
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error('Movie project is missing a valid name');
  }

  return parsed as MovieManifest;
}

function sanitizeFilenameSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'movie';
}

function isMovieExportCancelled(error: unknown): boolean {
  if (error instanceof MovieExportCancelledError) {
    return true;
  }

  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message === 'Movie export cancelled';
  }

  return false;
}

function assertMovieExportNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new MovieExportCancelledError();
  }
}

export function buildDefaultMovieExportPath(
  manifestPath: string,
  manifest: Pick<MovieManifest, 'name' | 'rendersDir'>,
  now = Date.now(),
): string {
  const projectDir = path.dirname(manifestPath);
  return path.join(
    projectDir,
    manifest.rendersDir,
    `${sanitizeFilenameSegment(manifest.name)}-${now}.mp4`,
  );
}

function toModuleImportPath(fromDir: string, targetPath: string): string {
  const relativePath = path.relative(fromDir, targetPath);
  const normalized = relativePath.split(path.sep).join('/');
  if (normalized.startsWith('.')) {
    return normalized;
  }
  return `./${normalized}`;
}

function resolveMovieAssetInputPath(projectDir: string, asset: MovieAsset): string | null {
  if (asset.sourceUrl) {
    if (asset.sourceUrl.startsWith('file://')) {
      return fileURLToPath(asset.sourceUrl);
    }

    if (asset.sourceUrl.startsWith('http://') || asset.sourceUrl.startsWith('https://')) {
      return null;
    }
  }

  if (path.isAbsolute(asset.path)) {
    return asset.path;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(asset.path)) {
    return null;
  }

  return path.join(projectDir, asset.path);
}

function resolveMovieAssetBrowserUrl(projectDir: string, asset: MovieAsset): string {
  if (asset.sourceUrl) {
    return asset.sourceUrl;
  }

  const absoluteSourcePath = resolveMovieAssetInputPath(projectDir, asset);
  if (absoluteSourcePath) {
    return pathToFileURL(absoluteSourcePath).toString();
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(asset.path)) {
    return asset.path;
  }

  return pathToFileURL(path.join(projectDir, asset.path)).toString();
}

function resolveMovieAssetFfmpegInput(projectDir: string, asset: MovieAsset): string {
  const absoluteSourcePath = resolveMovieAssetInputPath(projectDir, asset);
  if (absoluteSourcePath) {
    return absoluteSourcePath;
  }

  if (asset.sourceUrl) {
    return asset.sourceUrl;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(asset.path)) {
    return asset.path;
  }

  return path.join(projectDir, asset.path);
}

function toValidExportNames(moduleValue: Record<string, unknown>): string[] {
  return Object.keys(moduleValue).filter((key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && key !== 'default');
}

function createGlobalShimModuleCode(
  globalProperty: 'react' | 'reactJsxRuntime' | 'reactJsxDevRuntime',
  exportNames: string[],
  options?: { exportDefault?: boolean },
): string {
  const lines = [
    `const moduleValue = window.__INTERPRETER_MOVIE_PREVIEW?.${globalProperty};`,
    `if (!moduleValue) throw new Error('Movie preview runtime was not initialized for ${globalProperty}');`,
  ];

  if (options?.exportDefault) {
    lines.push('export default moduleValue.default ?? moduleValue;');
  }

  for (const exportName of exportNames) {
    lines.push(`export const ${exportName} = moduleValue[${JSON.stringify(exportName)}];`);
  }

  return `${lines.join('\n')}\n`;
}

async function getMoviePreviewShims(): Promise<Record<'react' | 'reactJsxRuntime' | 'reactJsxDevRuntime', string>> {
  if (!moviePreviewShimPromise) {
    moviePreviewShimPromise = (async () => {
      const reactModule = await import('react');
      const reactJsxRuntimeModule = await import('react/jsx-runtime');
      const reactJsxDevRuntimeModule = await import('react/jsx-dev-runtime');

      return {
        react: createGlobalShimModuleCode('react', toValidExportNames(reactModule), { exportDefault: true }),
        reactJsxRuntime: createGlobalShimModuleCode('reactJsxRuntime', toValidExportNames(reactJsxRuntimeModule)),
        reactJsxDevRuntime: createGlobalShimModuleCode('reactJsxDevRuntime', toValidExportNames(reactJsxDevRuntimeModule)),
      };
    })();
  }

  return moviePreviewShimPromise;
}

function getMovieRenderRuntimePackagePaths(): Record<
  'react' | 'reactDomClient' | 'reactJsxRuntime' | 'reactJsxDevRuntime',
  string
> {
  if (!movieRenderRuntimePackagePaths) {
    movieRenderRuntimePackagePaths = {
      react: require.resolve('react'),
      reactDomClient: require.resolve('react-dom/client'),
      reactJsxRuntime: require.resolve('react/jsx-runtime'),
      reactJsxDevRuntime: require.resolve('react/jsx-dev-runtime'),
    };
  }

  return movieRenderRuntimePackagePaths;
}

function createMoviePreviewEntrySource(projectDir: string, manifest: MovieManifest): string {
  const runtimeImportPath = toModuleImportPath(
    projectDir,
    path.join(projectDir, manifest.runtimePath),
  );
  const componentsImportPath = toModuleImportPath(
    projectDir,
    path.join(projectDir, manifest.componentsPath),
  );

  return `export { MovieStage, MovieSequence, useMovieConfig, useMovieFrame } from ${JSON.stringify(runtimeImportPath)};
export { movieReactComponents } from ${JSON.stringify(componentsImportPath)};
`;
}

function getMovieClipDurationInFrames(clip: MovieAudioClip | MovieVideoClip): number {
  return Math.max(1, clip.sourceEndFrame - clip.sourceStartFrame);
}

function findMovieAsset(timeline: MovieTimelineDefinition, assetId: string): MovieAsset {
  const asset = timeline.assets.find((candidate) => candidate.id === assetId);
  if (!asset) {
    throw new Error(`Movie asset not found: ${assetId}`);
  }
  return asset;
}

function clipFramesToSeconds(frame: number, fps: number): number {
  return frame / fps;
}

function collectMovieAudioMixInputs(
  timeline: MovieTimelineDefinition,
  projectDir: string,
): MovieAudioMixInput[] {
  const explicitAudioClips = timeline.tracks
    .filter((track) => track.kind === 'audio')
    .flatMap((track) => track.clips) as MovieAudioClip[];

  const videoClips = timeline.tracks
    .filter((track) => track.kind === 'video')
    .flatMap((track) => track.clips) as MovieVideoClip[];

  const inputs: MovieAudioMixInput[] = [];

  for (const clip of explicitAudioClips) {
    if (clip.muted) {
      continue;
    }
    const asset = findMovieAsset(timeline, clip.assetId);
    inputs.push({
      input: resolveMovieAssetFfmpegInput(projectDir, asset),
      trimStartSeconds: clipFramesToSeconds(clip.sourceStartFrame, timeline.settings.fps),
      trimEndSeconds: clipFramesToSeconds(clip.sourceEndFrame, timeline.settings.fps),
      timelineStartSeconds: clipFramesToSeconds(clip.startFrame, timeline.settings.fps),
      volume: clip.volume,
    });
  }

  for (const clip of videoClips) {
    if (clip.muted) {
      continue;
    }
    const asset = findMovieAsset(timeline, clip.assetId);
    if (!asset.hasAudio) {
      continue;
    }
    inputs.push({
      input: resolveMovieAssetFfmpegInput(projectDir, asset),
      trimStartSeconds: clipFramesToSeconds(clip.sourceStartFrame, timeline.settings.fps),
      trimEndSeconds: clipFramesToSeconds(clip.sourceEndFrame, timeline.settings.fps),
      timelineStartSeconds: clipFramesToSeconds(clip.startFrame, timeline.settings.fps),
      volume: 1,
    });
  }

  return inputs.sort((left, right) => left.timelineStartSeconds - right.timelineStartSeconds);
}

async function runFfmpeg(
  args: string[],
  failureLabel: string,
  options?: {
    signal?: AbortSignal;
    exportExecution?: ActiveMovieExport;
  },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (options?.exportExecution) {
      options.exportExecution.ffmpegProcess = child;
    }

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const handleAbort = () => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    };

    const cleanup = () => {
      options?.signal?.removeEventListener('abort', handleAbort);
      if (options?.exportExecution?.ffmpegProcess === child) {
        options.exportExecution.ffmpegProcess = null;
      }
    };

    options?.signal?.addEventListener('abort', handleAbort, { once: true });

    child.on('error', (error) => {
      cleanup();
      if (options?.signal?.aborted) {
        reject(new MovieExportCancelledError());
        return;
      }
      reject(new Error(`${failureLabel}: ${error.message}`));
    });

    child.on('close', (code) => {
      cleanup();
      if (options?.signal?.aborted) {
        reject(new MovieExportCancelledError());
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }

      const message = stderr.trim() || `ffmpeg exited with code ${String(code)}`;
      reject(new Error(`${failureLabel}: ${message}`));
    });
  });
}

async function mixMovieAudioTrack(
  inputs: MovieAudioMixInput[],
  outputPath: string,
  durationSeconds: number,
  options?: {
    signal?: AbortSignal;
    exportExecution?: ActiveMovieExport;
  },
): Promise<void> {
  if (inputs.length === 0) {
    throw new Error('No movie audio inputs to mix');
  }

  const args: string[] = [];
  const filterParts: string[] = [];

  inputs.forEach((input, index) => {
    args.push('-i', input.input);
    filterParts.push(
      `[${index}:a]atrim=start=${input.trimStartSeconds}:end=${input.trimEndSeconds},` +
      `asetpts=PTS-STARTPTS+${input.timelineStartSeconds}/TB,` +
      `volume=${input.volume}[a${index}]`,
    );
  });

  let finalLabel = inputs.length === 1 ? 'a0' : 'mixed';
  if (inputs.length > 1) {
    const mixInputs = inputs.map((_, index) => `[a${index}]`).join('');
    filterParts.push(`${mixInputs}amix=inputs=${inputs.length}:normalize=0:dropout_transition=0[${finalLabel}]`);
  }

  if (durationSeconds > 0) {
    filterParts.push(`[${finalLabel}]atrim=start=0:end=${durationSeconds},asetpts=PTS-STARTPTS[aout]`);
    finalLabel = 'aout';
  }

  args.push(
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    `[${finalLabel}]`,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-y',
    outputPath,
  );

  await runFfmpeg(args, 'Movie audio mix failed', options);
}

function frameFileName(frame: number): string {
  return `frame-${String(frame + 1).padStart(6, '0')}.png`;
}

function buildMovieRenderEntrySource({
  tempDir,
  projectDir,
  manifest,
  assetUrls,
}: {
  tempDir: string;
  projectDir: string;
  manifest: MovieManifest;
  assetUrls: Record<string, string>;
}): string {
  const timelineImportPath = toModuleImportPath(
    tempDir,
    path.join(projectDir, manifest.timelinePath),
  );
  const runtimeImportPath = toModuleImportPath(
    tempDir,
    path.join(projectDir, manifest.runtimePath),
  );
  const componentsImportPath = toModuleImportPath(
    tempDir,
    path.join(projectDir, manifest.componentsPath),
  );

  return `import React from 'react';
import { createRoot } from 'react-dom/client';
import movieTimeline from ${JSON.stringify(timelineImportPath)};
import { MovieStage } from ${JSON.stringify(runtimeImportPath)};
import { movieReactComponents } from ${JSON.stringify(componentsImportPath)};

declare global {
  interface Window {
    __INTERPRETER_MOVIE_EXPORT?: {
      renderFrame: (frame: number) => Promise<void>;
    };
  }
}

const assetUrls = ${JSON.stringify(assetUrls)};
const container = document.getElementById('root');

if (!container) {
  throw new Error('Movie export container missing');
}

let setFrameExternal: ((frame: number) => void) | null = null;
let pendingResolve: (() => void) | null = null;
let currentFrameValue = 0;

const App: React.FC = () => {
  const [frame, setFrame] = React.useState(0);
  currentFrameValue = frame;

  React.useEffect(() => {
    setFrameExternal = setFrame;
    return () => {
      if (setFrameExternal === setFrame) {
        setFrameExternal = null;
      }
    };
  }, [setFrame]);

  const handleFrameReady = React.useCallback((readyFrame: number) => {
    if (readyFrame !== frame) {
      return;
    }

    const resolve = pendingResolve;
    pendingResolve = null;
    if (!resolve) {
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  }, [frame]);

  return (
    <MovieStage
      timeline={movieTimeline}
      frame={frame}
      isPlaying={false}
      assetUrls={assetUrls}
      components={movieReactComponents}
      mode="render"
      onFrameReady={handleFrameReady}
    />
  );
};

createRoot(container).render(<App />);

window.__INTERPRETER_MOVIE_EXPORT = {
  renderFrame(nextFrame: number) {
    return new Promise<void>((resolve) => {
      pendingResolve = resolve;
      if (!setFrameExternal) {
        resolve();
        return;
      }
      if (nextFrame === currentFrameValue) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const currentResolve = pendingResolve;
            pendingResolve = null;
            currentResolve?.();
          });
        });
        return;
      }
      setFrameExternal(nextFrame);
    });
  },
};
`;
}

async function buildMovieRenderPage({
  tempDir,
  projectDir,
  manifest,
  timeline,
}: {
  tempDir: string;
  projectDir: string;
  manifest: MovieManifest;
  timeline: MovieTimelineDefinition;
}): Promise<string> {
  const assetUrls = Object.fromEntries(
    timeline.assets.map((asset) => [asset.id, resolveMovieAssetBrowserUrl(projectDir, asset)]),
  );
  const entrySource = buildMovieRenderEntrySource({
    tempDir,
    projectDir,
    manifest,
    assetUrls,
  });
  const bundleOutputPath = path.join(tempDir, 'movie-render.js');
  const htmlOutputPath = path.join(tempDir, 'movie-render.html');
  const runtimePackagePaths = getMovieRenderRuntimePackagePaths();

  await esbuild.build({
    stdin: {
      contents: entrySource,
      resolveDir: tempDir,
      sourcefile: 'movie-render-entry.tsx',
      loader: 'tsx',
    },
    absWorkingDir: tempDir,
    bundle: true,
    write: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome118'],
    outfile: bundleOutputPath,
    jsx: 'automatic',
    sourcemap: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    loader: {
      '.png': 'dataurl',
      '.jpg': 'dataurl',
      '.jpeg': 'dataurl',
      '.gif': 'dataurl',
      '.svg': 'dataurl',
      '.webp': 'dataurl',
      '.avif': 'dataurl',
    },
    plugins: [{
      name: 'movie-render-runtime-aliases',
      setup(build) {
        build.onResolve({ filter: /^react$/ }, () => ({ path: runtimePackagePaths.react }));
        build.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: runtimePackagePaths.reactDomClient }));
        build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: runtimePackagePaths.reactJsxRuntime }));
        build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({ path: runtimePackagePaths.reactJsxDevRuntime }));
      },
    }],
  });

  await fs.writeFile(
    htmlOutputPath,
    `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body, #root {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #000;
      }
      body {
        -webkit-font-smoothing: antialiased;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./movie-render.js"></script>
  </body>
</html>
`,
    'utf8',
  );

  return htmlOutputPath;
}

async function waitForMovieRenderRuntime(window: ElectronBrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    `new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        if (window.__INTERPRETER_MOVIE_EXPORT && typeof window.__INTERPRETER_MOVIE_EXPORT.renderFrame === 'function') {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt > ${MOVIE_EXPORT_TIMEOUT_MS}) {
          reject(new Error('Movie export runtime did not initialize'));
          return;
        }
        setTimeout(check, 25);
      };
      check();
    })`,
    true,
  );
}

async function renderMovieFramesWithElectron({
  htmlPath,
  outputDir,
  timeline,
  signal,
  exportExecution,
  onProgress,
}: {
  htmlPath: string;
  outputDir: string;
  timeline: MovieTimelineDefinition;
  signal: AbortSignal;
  exportExecution: ActiveMovieExport;
  onProgress?: (frameIndex: number, totalFrames: number) => void;
}): Promise<void> {
  if (!process.versions.electron) {
    throw new Error('Movie frame rendering requires Electron');
  }

  assertMovieExportNotCancelled(signal);

  const { BrowserWindow } = require('electron') as typeof import('electron');
  const renderWindow = new BrowserWindow({
    show: false,
    width: timeline.settings.width,
    height: timeline.settings.height,
    backgroundColor: '#000000',
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  exportExecution.renderWindow = renderWindow;

  const handleAbort = () => {
    if (!renderWindow.isDestroyed()) {
      renderWindow.destroy();
    }
  };
  signal.addEventListener('abort', handleAbort, { once: true });

  try {
    assertMovieExportNotCancelled(signal);
    await renderWindow.webContents.loadURL(pathToFileURL(htmlPath).toString());
    assertMovieExportNotCancelled(signal);
    await waitForMovieRenderRuntime(renderWindow);
    assertMovieExportNotCancelled(signal);

    for (let frameIndex = 0; frameIndex < timeline.settings.durationInFrames; frameIndex += 1) {
      assertMovieExportNotCancelled(signal);
      await renderWindow.webContents.executeJavaScript(
        `window.__INTERPRETER_MOVIE_EXPORT.renderFrame(${frameIndex})`,
        true,
      );
      assertMovieExportNotCancelled(signal);
      const image = await renderWindow.webContents.capturePage();
      assertMovieExportNotCancelled(signal);
      await fs.writeFile(path.join(outputDir, frameFileName(frameIndex)), image.toPNG());
      onProgress?.(frameIndex + 1, timeline.settings.durationInFrames);
    }
  } catch (error: any) {
    if (signal.aborted) {
      throw new MovieExportCancelledError();
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', handleAbort);
    exportExecution.renderWindow = null;
    if (!renderWindow.isDestroyed()) {
      renderWindow.destroy();
    }
  }
}

export async function createMovieProjectFile(
  parentPath: string,
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const baseName = 'Movie';
    let candidateName = baseName;
    let suffix = 1;

    while (await pathExists(path.join(parentPath, candidateName))) {
      candidateName = `${baseName} (${suffix})`;
      suffix++;
    }

    const containerDir = path.join(parentPath, candidateName);
    const manifestPath = path.join(containerDir, `${candidateName}${MOVIE_MANIFEST_EXTENSION}`);
    const manifest = createMovieManifest(candidateName);
    const timeline = createDefaultMovieTimeline(candidateName);

    await fs.mkdir(path.join(containerDir, manifest.assetsDir), { recursive: true });
    await fs.mkdir(path.join(containerDir, manifest.metadataDir), { recursive: true });
    await fs.mkdir(path.join(containerDir, manifest.rendersDir), { recursive: true });

    await Promise.all([
      fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8'),
      fs.writeFile(path.join(containerDir, manifest.timelinePath), renderMovieTimelineModule(timeline), 'utf-8'),
      fs.writeFile(path.join(containerDir, manifest.componentsPath), renderMovieComponentsModule(), 'utf-8'),
      fs.writeFile(path.join(containerDir, manifest.runtimePath), renderMovieRuntimeModule(), 'utf-8'),
      fs.writeFile(path.join(containerDir, manifest.entryPoint), renderMovieIndexModule(), 'utf-8'),
    ]);

    return { success: true, path: manifestPath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function compileMovieComponentsModule(
  request: MovieCompileComponentsRequest,
): Promise<MovieCompileComponentsResponse> {
  try {
    const manifest = await readMovieManifest(request.manifestPath);
    const projectDir = path.dirname(request.manifestPath);
    const previewEntrySource = createMoviePreviewEntrySource(projectDir, manifest);
    const previewShims = await getMoviePreviewShims();

    const bundle = await esbuild.build({
      stdin: {
        contents: previewEntrySource,
        resolveDir: projectDir,
        sourcefile: 'movie-preview-entry.tsx',
        loader: 'tsx',
      },
      absWorkingDir: projectDir,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      sourcemap: 'inline',
      jsx: 'automatic',
      loader: {
        '.png': 'dataurl',
        '.jpg': 'dataurl',
        '.jpeg': 'dataurl',
        '.gif': 'dataurl',
        '.svg': 'dataurl',
        '.webp': 'dataurl',
        '.avif': 'dataurl',
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
      },
      plugins: [{
        name: 'movie-preview-runtime-shims',
        setup(build) {
          build.onResolve({ filter: /^react$/ }, () => ({
            path: 'movie-preview:react',
            namespace: 'movie-preview-shim',
          }));
          build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({
            path: 'movie-preview:react-jsx-runtime',
            namespace: 'movie-preview-shim',
          }));
          build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({
            path: 'movie-preview:react-jsx-dev-runtime',
            namespace: 'movie-preview-shim',
          }));

          build.onLoad({ filter: /^movie-preview:/, namespace: 'movie-preview-shim' }, (args) => {
            if (args.path === 'movie-preview:react') {
              return { contents: previewShims.react, loader: 'js' };
            }
            if (args.path === 'movie-preview:react-jsx-runtime') {
              return { contents: previewShims.reactJsxRuntime, loader: 'js' };
            }
            if (args.path === 'movie-preview:react-jsx-dev-runtime') {
              return { contents: previewShims.reactJsxDevRuntime, loader: 'js' };
            }
            throw new Error(`Unknown movie preview shim: ${args.path}`);
          });
        },
      }],
    });

    const outputFile = bundle.outputFiles.find((file) => file.path.endsWith('.js')) ?? bundle.outputFiles[0];
    if (!outputFile) {
      throw new Error('Movie preview bundle did not produce an output file');
    }

    return {
      success: true,
      code: outputFile.text,
    };
  } catch (error: any) {
    if (Array.isArray(error?.errors) && error.errors.length > 0) {
      const formatted = await esbuild.formatMessages(error.errors, {
        kind: 'error',
        color: false,
      });
      return {
        success: false,
        error: formatted.join('\n'),
      };
    }

    return {
      success: false,
      error: error?.message || 'Failed to compile movie components',
    };
  }
}

export async function exportMovieProject(
  request: MovieExportRequest,
  onProgress?: (event: MovieExportProgressEvent) => void,
): Promise<MovieExportResponse> {
  const sendProgress = (
    stage: MovieExportProgressEvent['stage'],
    progress: number | null,
    message: string | null,
  ) => {
    onProgress?.({
      exportId: request.exportId,
      manifestPath: request.manifestPath,
      stage,
      progress,
      message,
    });
  };

  let tempDir: string | null = null;
  const exportExecution: ActiveMovieExport = {
    abortController: new AbortController(),
    renderWindow: null,
    ffmpegProcess: null,
  };

  if (activeMovieExports.has(request.exportId)) {
    return {
      success: false,
      error: 'Movie export is already running',
    };
  }

  activeMovieExports.set(request.exportId, exportExecution);

  try {
    const manifest = await readMovieManifest(request.manifestPath);
    const projectDir = path.dirname(request.manifestPath);
    const timelineSource = await fs.readFile(path.join(projectDir, manifest.timelinePath), 'utf-8');
    const timeline = parseMovieTimelineModule(timelineSource);
    const outputPath = request.outputPath
      ? request.outputPath
      : buildDefaultMovieExportPath(request.manifestPath, manifest);
    const { signal } = exportExecution.abortController;

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    tempDir = await fs.mkdtemp(path.join(projectDir, '.interpreter-movie-render-'));
    const framesDir = path.join(tempDir, 'frames');
    const silentVideoPath = path.join(tempDir, 'silent.mp4');
    const mixedAudioPath = path.join(tempDir, 'mixed.m4a');

    await fs.mkdir(framesDir, { recursive: true });
    sendProgress('preparing', 0, 'Preparing movie renderer');

    const htmlPath = await buildMovieRenderPage({
      tempDir,
      projectDir,
      manifest,
      timeline,
    });

    sendProgress('rendering', 0, 'Rendering movie frames');
    await renderMovieFramesWithElectron({
      htmlPath,
      outputDir: framesDir,
      timeline,
      signal,
      exportExecution,
      onProgress: (completedFrames, totalFrames) => {
        sendProgress(
          'rendering',
          (completedFrames / Math.max(1, totalFrames)) * 70,
          `Rendering frame ${completedFrames}/${totalFrames}`,
        );
      },
    });

    assertMovieExportNotCancelled(signal);
    sendProgress('encoding', 72, 'Encoding video track');
    await runFfmpeg([
      '-framerate',
      String(timeline.settings.fps),
      '-i',
      path.join(framesDir, 'frame-%06d.png'),
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-y',
      silentVideoPath,
    ], 'Movie video encode failed', {
      signal,
      exportExecution,
    });

    const audioInputs = collectMovieAudioMixInputs(timeline, projectDir);
    if (audioInputs.length > 0) {
      assertMovieExportNotCancelled(signal);
      sendProgress('encoding', 84, 'Mixing timeline audio');
      await mixMovieAudioTrack(
        audioInputs,
        mixedAudioPath,
        timeline.settings.durationInFrames / timeline.settings.fps,
        {
          signal,
          exportExecution,
        },
      );

      assertMovieExportNotCancelled(signal);
      sendProgress('muxing', 92, 'Muxing MP4');
      await runFfmpeg([
        '-i',
        silentVideoPath,
        '-i',
        mixedAudioPath,
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-shortest',
        '-movflags',
        '+faststart',
        '-y',
        outputPath,
      ], 'Movie mux failed', {
        signal,
        exportExecution,
      });
    } else {
      assertMovieExportNotCancelled(signal);
      await fs.copyFile(silentVideoPath, outputPath);
    }

    sendProgress('complete', 100, 'Export complete');
    return {
      success: true,
      outputPath,
    };
  } catch (error: any) {
    if (isMovieExportCancelled(error)) {
      sendProgress('cancelled', null, 'Export cancelled');
      return {
        success: false,
        cancelled: true,
        error: 'Movie export cancelled',
      };
    }

    sendProgress('error', null, error?.message || 'Failed to export movie');
    return {
      success: false,
      error: error?.message || 'Failed to export movie',
    };
  } finally {
    if (exportExecution.ffmpegProcess && !exportExecution.ffmpegProcess.killed) {
      exportExecution.ffmpegProcess.kill('SIGKILL');
    }
    if (exportExecution.renderWindow && !exportExecution.renderWindow.isDestroyed()) {
      exportExecution.renderWindow.destroy();
    }
    activeMovieExports.delete(request.exportId);
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

export async function cancelMovieExport(
  request: MovieCancelExportRequest,
): Promise<MovieCancelExportResponse> {
  const activeExport = activeMovieExports.get(request.exportId);
  if (!activeExport) {
    return {
      success: false,
      error: 'Movie export is not running',
    };
  }

  if (!activeExport.abortController.signal.aborted) {
    activeExport.abortController.abort();
  }
  if (activeExport.ffmpegProcess && !activeExport.ffmpegProcess.killed) {
    activeExport.ffmpegProcess.kill('SIGKILL');
  }
  if (activeExport.renderWindow && !activeExport.renderWindow.isDestroyed()) {
    activeExport.renderWindow.destroy();
  }

  return { success: true };
}
