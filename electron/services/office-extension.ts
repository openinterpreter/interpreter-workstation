import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, rmSync, createWriteStream, renameSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import https from 'node:https';
import * as Sentry from '@sentry/electron/main';
import { sendTelemetry } from '../../server/telemetry';
import { distributionProductConfig } from '../../shared/productConfig';
import { shouldUpdateOoEditors } from '../utils/officeExtensionUpdate';
import { getCurrentProcessPortCleanupExclusions, killPortProcessSync } from '../utils/ports';
import { assertRequiredFontMetadata, hasRequiredFontMetadata } from './office-extension-font-metadata';
import {
  buildOoEditorsServerEnv,
  isWindowsOoEditorsSpawnPermissionError,
  resolveOoEditorsNodeRuntime,
} from './office-extension-startup';
import {
  ensurePortAvailableForStartup as ensurePortAvailableWithRetries,
  isPortAvailableForDefaultListen,
} from './office-extension-port';
import { gracefulTerminateChild } from './office-extension-shutdown';
import { performUpdateSwap } from './office-extension-update';
import { createOfficeExtensionInstallCoalescer } from './office-extension-install-coalescer';
import {
  classifyOoEditorsExit,
  classifyOoEditorsStderr,
  createOoEditorsExitSuppressionWindow,
  type ChildProcessGoneSignal,
  type OoEditorsExitSuppressionWindow,
} from './office-extension-exit';

const PORT = 38123;
const MAIN_RENDERER_GONE_EXIT_SUPPRESSION_MS = 5_000;
const SECOND_INSTANCE_EXIT_SUPPRESSION_MS = 2_000;
let serverProcess: ChildProcess | null = null;
let startupPromise: Promise<void> | null = null;
let shutdownPromise: Promise<void> | null = null;
let isStarting = false;
let isUpdating = false;
let isShuttingDown = false;
let isAppQuitting = false;
let childProcessGoneSignal: ChildProcessGoneSignal | null = null;
let exitSuppressionWindow: OoEditorsExitSuppressionWindow | null = null;
const runCoalescedInstall = createOfficeExtensionInstallCoalescer();

type JsZipConstructorLike = {
  loadAsync: (archiveData: Buffer) => Promise<{
    files: Record<string, { dir: boolean; async: (type: 'nodebuffer') => Promise<Buffer> }>;
  }>;
};

function resolveJsZipConstructor(moduleNamespace: unknown): JsZipConstructorLike {
  const directCandidate = moduleNamespace as Partial<JsZipConstructorLike> | null | undefined;
  if (typeof directCandidate?.loadAsync === 'function') {
    return directCandidate as JsZipConstructorLike;
  }

  const defaultCandidate = (moduleNamespace as { default?: unknown } | null | undefined)?.default;
  if (typeof (defaultCandidate as Partial<JsZipConstructorLike> | null | undefined)?.loadAsync === 'function') {
    return defaultCandidate as JsZipConstructorLike;
  }

  const nestedDefaultCandidate = (defaultCandidate as { default?: unknown } | null | undefined)?.default;
  if (typeof (nestedDefaultCandidate as Partial<JsZipConstructorLike> | null | undefined)?.loadAsync === 'function') {
    return nestedDefaultCandidate as JsZipConstructorLike;
  }

  throw new Error('Failed to resolve JSZip runtime');
}

function setExitSuppressionWindow(window: OoEditorsExitSuppressionWindow): void {
  if (!exitSuppressionWindow || window.untilMs >= exitSuppressionWindow.untilMs) {
    exitSuppressionWindow = window;
  }
}

app.on('before-quit', () => {
  isAppQuitting = true;
  isShuttingDown = true;
});

app.on('will-quit', () => {
  isAppQuitting = true;
  isShuttingDown = true;
});

export function noteMainWindowRendererGone(nowMs: number = Date.now()): void {
  setExitSuppressionWindow(createOoEditorsExitSuppressionWindow({
    reason: 'main-renderer-gone-cascade',
    nowMs,
    durationMs: MAIN_RENDERER_GONE_EXIT_SUPPRESSION_MS,
  }));
}

export function noteAppChildProcessGone(nowMs: number = Date.now()): void {
  if (process.platform !== 'win32') {
    return;
  }
  childProcessGoneSignal = { timestampMs: nowMs };
}

export function noteSecondInstanceHandoff(nowMs: number = Date.now()): void {
  if (process.platform !== 'win32') {
    return;
  }

  setExitSuppressionWindow(createOoEditorsExitSuppressionWindow({
    reason: 'second-instance-handoff',
    nowMs,
    durationMs: SECOND_INSTANCE_EXIT_SUPPRESSION_MS,
  }));
}

const OO_EDITORS_LOG_BUFFER_MAX = 100; // lines
let ooEditorsStdoutBuffer: string[] = [];
let ooEditorsStderrBuffer: string[] = [];

function pushToLogBuffer(buffer: string[], line: string): void {
  const truncated = line.length > 1000 ? line.slice(0, 1000) + '...[truncated]' : line;
  buffer.push(truncated);
  if (buffer.length > OO_EDITORS_LOG_BUFFER_MAX) {
    buffer.shift();
  }
}

type OoEditorsEventLevel = 'info' | 'warning' | 'error';

function trackOoEditorsEvent(
  message: string,
  level: OoEditorsEventLevel,
  data?: Record<string, unknown>
): void {
  Sentry.addBreadcrumb({
    category: 'oo-editors',
    message,
    level,
    data,
  });

  // Only emit telemetry for errors — lifecycle breadcrumbs stay in Sentry to
  // avoid the per-session noise that made oo_editors_lifecycle the #1 volume
  // event without telling us anything useful.
  if (level !== 'error') return;
  sendTelemetry('error', {
    event: 'oo_editors_error',
    message,
    ...data,
  }, { tag: 'oo-editors' }).catch(() => {});
}

type Arch = 'darwin-arm64' | 'darwin-x64' | 'windows-x64';

function getArch(): Arch {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  if (platform === 'win32') {
    return 'windows-x64';
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

const DOCUMENT_ENGINE_RELEASE_REPOSITORY =
  distributionProductConfig.documentEngine.releaseRepository.trim();
const GITHUB_RELEASES_URL = DOCUMENT_ENGINE_RELEASE_REPOSITORY
  ? `https://api.github.com/repos/${DOCUMENT_ENGINE_RELEASE_REPOSITORY}/releases/latest`
  : '';

const ARCH_ASSET_PATTERNS: Record<string, string[]> = {
  'darwin-arm64': ['darwin-arm64', 'macos-arm64', 'mac-arm64'],
  'darwin-x64':   ['darwin-x64', 'darwin-amd64', 'macos-x64', 'mac-x64'],
  'windows-x64':  ['windows-x64', 'windows-amd64', 'win64'],
};

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  assets: GitHubReleaseAsset[];
}

async function fetchLatestGitHubRelease(): Promise<GitHubRelease | null> {
  if (!GITHUB_RELEASES_URL) {
    return null;
  }
  let response: Response;
  try {
    response = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Interpreter-OfficeExtension-Installer',
      },
    });
  } catch (error) {
    console.warn('[OfficeExtension] GitHub release fetch failed (network):', error);
    return null;
  }

  if (response.status === 403) {
    console.warn('[OfficeExtension] GitHub API rate limited (403), will retry on next check');
    return null;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 404) {
      throw new Error('GitHub release not found (404) -- check repo visibility and release status');
    }
    throw new Error(`GitHub API error (${response.status}): ${body}`);
  }

  return await response.json() as GitHubRelease;
}

function findAssetForArch(assets: GitHubReleaseAsset[], arch: Arch): GitHubReleaseAsset | null {
  const patterns = ARCH_ASSET_PATTERNS[arch];
  if (!patterns) return null;
  for (const asset of assets) {
    const nameLower = asset.name.toLowerCase();
    if (patterns.some(p => nameLower.includes(p))) return asset;
  }
  return null;
}

function getOoEditorsDir(): string {
  return join(
    app.getPath('userData'),
    distributionProductConfig.documentEngine.installDirectoryName,
  );
}

function getServerScriptPath(): string {
  return join(getOoEditorsDir(), 'server.js');
}

function getFontDataDir(): string {
  return join(app.getPath('userData'), 'office-extension-fontdata');
}

export function isOoEditorsInstalled(): boolean {
  const serverScript = getServerScriptPath();
  return existsSync(serverScript);
}

export async function getInstalledOoEditorsVersion(): Promise<string | null> {
  const packagePath = join(getOoEditorsDir(), 'package.json');
  if (!existsSync(packagePath)) {
    return null;
  }

  try {
    const raw = await readFile(packagePath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch (error) {
    console.warn('[OfficeExtension] Failed to read installed version:', error);
    return null;
  }
}

export async function getLatestOoEditorsVersion(): Promise<string | null> {
  try {
    const release = await fetchLatestGitHubRelease();
    if (!release) return null;

    const version = release.tag_name?.trim();
    if (!version) {
      console.warn('[OfficeExtension] GitHub release missing tag_name');
      return null;
    }

    return version;
  } catch (error) {
    console.warn('[OfficeExtension] Failed to fetch latest version:', error);
    return null;
  }
}

export interface InstallProgress {
  stage: 'downloading' | 'extracting' | 'configuring' | 'complete' | 'error';
  bytesDownloaded?: number;
  totalBytes?: number;
  message?: string;
  error?: string;
}

interface InstallOptions {
  targetDir?: string;
  emitProgress?: boolean;
}

function emitProgress(progress: InstallProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('office-extension:install-progress', progress);
  }
}

export async function installOoEditors(options: InstallOptions = {}): Promise<void> {
  if (!DOCUMENT_ENGINE_RELEASE_REPOSITORY) {
    throw new Error(
      'No compatible document engine is configured for this distribution. Configure one in product.json or use code-and-skills document workflows.',
    );
  }
  const ooEditorsDir = options.targetDir ?? getOoEditorsDir();
  return runCoalescedInstall(ooEditorsDir, async () => {
    const arch = getArch();
    const zipPath = join(app.getPath('temp'), `oo-editors-${arch}.zip`);
    const progress = options.emitProgress !== false ? emitProgress : () => {};

    try {
      if (!existsSync(ooEditorsDir)) {
        mkdirSync(ooEditorsDir, { recursive: true });
      }

      const release = await fetchLatestGitHubRelease();
      if (!release) {
        throw new Error('GitHub release unavailable (transient -- rate limit or network), try again later');
      }

      const asset = findAssetForArch(release.assets, arch);
      if (!asset) {
        const available = release.assets.map(a => a.name).join(', ');
        throw new Error(`No oo-editors asset for ${arch} in release ${release.tag_name} (available: ${available})`);
      }

      progress({ stage: 'downloading', bytesDownloaded: 0, totalBytes: asset.size });

      const downloadUrl = asset.browser_download_url;
      console.log(`[OfficeExtension] Downloading ${asset.name} (${asset.size} bytes) from GitHub release ${release.tag_name}`);

      await downloadToFile(downloadUrl, zipPath, {
        method: 'GET',
        onProgress: progress,
      });

      progress({ stage: 'extracting', message: 'Extracting files...' });
      console.log(`[OfficeExtension] Extracting to ${ooEditorsDir}`);

      await extractZip(zipPath, ooEditorsDir);

      progress({ stage: 'configuring', message: 'Configuring...' });

      try {
        rmSync(zipPath);
      } catch {}

      progress({ stage: 'complete', message: 'Installation complete' });
      console.log('[OfficeExtension] Installation complete');
      trackOoEditorsEvent('Install complete', 'info', { arch, targetDir: ooEditorsDir });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      progress({ stage: 'error', error: errorMessage });
      console.error('[OfficeExtension] Installation failed:', error);
      trackOoEditorsEvent('Install failed', 'error', { error: errorMessage });

      try {
        rmSync(zipPath);
      } catch {}

      throw error;
    }
  });
}

function swapOoEditorsDir(stagingDir: string, targetDir: string): void {
  const backupDir = `${targetDir}.bak`;
  if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
  if (existsSync(targetDir)) renameSync(targetDir, backupDir);

  try {
    renameSync(stagingDir, targetDir);
    if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(backupDir)) try { renameSync(backupDir, targetDir); } catch {}
    throw error;
  }
}

function isBusySwapError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EBUSY'
  );
}

function getStagingDir(): string {
  return join(app.getPath('userData'), 'oo-editors-staging');
}

async function downloadOoEditorsToStaging(): Promise<string> {
  const stagingDir = getStagingDir();

  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  await installOoEditors({ targetDir: stagingDir, emitProgress: false });

  // Validate staging dir has required files
  if (!existsSync(join(stagingDir, 'server.js')) || !existsSync(join(stagingDir, 'package.json'))) {
    throw new Error('Extracted oo-editors is missing required files');
  }

  return stagingDir;
}

export async function checkForOoEditorsUpdate(): Promise<void> {
  if (isUpdating || !isOoEditorsInstalled()) return;

  const installedVersion = await getInstalledOoEditorsVersion();
  if (!installedVersion) {
    console.warn('[OfficeExtension] Installed version missing, skipping update check');
    return;
  }

  const latestVersion = await getLatestOoEditorsVersion();
  if (!latestVersion) return;

  let shouldUpdate = false;
  try {
    shouldUpdate = shouldUpdateOoEditors(installedVersion, latestVersion);
  } catch (error) {
    console.warn('[OfficeExtension] Version check failed:', error);
    return;
  }

  if (!shouldUpdate) return;

  isUpdating = true;
  console.log(`[OfficeExtension] Updating oo-editors from ${installedVersion} to ${latestVersion}`);
  trackOoEditorsEvent('Update available', 'info', { from: installedVersion, to: latestVersion });

  try {
    // Download and validate BEFORE stopping server
    const stagingDir = await downloadOoEditorsToStaging();

    await performUpdateSwap({
      getStartupPromise: () => startupPromise,
      hasServerProcess: () => !!serverProcess,
      isStarting: () => isStarting,
      isServerRunning: isOfficeExtensionRunning,
      maxSwapAttempts: 3,
      recoverFromSwapError: async (error, attempt, maxAttempts) => {
        if (process.platform !== 'win32' || !isBusySwapError(error)) {
          return false;
        }

        console.warn(`[OfficeExtension] Update swap failed with EBUSY (attempt ${attempt}/${maxAttempts}), killing oo-editors port before retry`);
        trackOoEditorsEvent('Update swap EBUSY', 'warning', { attempt, maxAttempts });

        await killProcessOnPort(PORT);
        return true;
      },
      shutdown: async () => {
        trackOoEditorsEvent('Shutting down for update', 'info', { from: installedVersion, to: latestVersion });
        await shutdownOfficeExtension();
      },
      swap: () => {
        swapOoEditorsDir(stagingDir, getOoEditorsDir());
        console.log('[OfficeExtension] oo-editors update complete');
        trackOoEditorsEvent('Update complete', 'info', { from: installedVersion, to: latestVersion });
      },
      restart: ensureOfficeExtensionRunning,
    });
  } catch (error) {
    console.error('[OfficeExtension] oo-editors update failed:', error);
    trackOoEditorsEvent('Update failed', 'error', { error: error instanceof Error ? error.message : 'Unknown error' });
  } finally {
    isUpdating = false;
  }
}

interface DownloadOptions {
  method?: 'GET' | 'POST';
  body?: string;
  onProgress: (progress: InstallProgress) => void;
}

async function downloadToFile(url: string, destPath: string, options: DownloadOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = url.startsWith('https:') ? https : http;
    const isPost = options.method === 'POST';

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https:') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Accept': '*/*',
        'User-Agent': 'Interpreter-OfficeExtension-Installer',
        ...(isPost && options.body && {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body)
        })
      }
    };

    const req = client.request(reqOptions, (res) => {
      console.log(`[OfficeExtension] Response status: ${res.statusCode}`);

      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) {
          reject(new Error('Redirect without location header'));
          return;
        }
        console.log(`[OfficeExtension] Following redirect to: ${redirectUrl}`);
        downloadToFile(redirectUrl, destPath, { ...options, method: 'GET', body: undefined }).then(resolve, reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => reject(new Error(`HTTP error ${res.statusCode}: ${body}`)));
        return;
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      const fileStream = createWriteStream(destPath);

      res.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        options.onProgress({ stage: 'downloading', bytesDownloaded: downloadedBytes, totalBytes });
      });

      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`[OfficeExtension] Download complete: ${downloadedBytes} bytes`);
        resolve();
      });
      fileStream.on('error', (err) => {
        fileStream.close();
        reject(err);
      });
    });

    req.on('error', (err) => {
      console.error('[OfficeExtension] Request error:', err);
      reject(err);
    });
    if (isPost && options.body) req.write(options.body);
    req.end();
  });
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      const ditto = spawn('ditto', ['-xk', zipPath, destDir]);

      ditto.on('error', (err) => {
        reject(new Error(`Failed to spawn ditto: ${err.message}`));
      });

      ditto.on('exit', (code) => {
        if (code === 0) {
          console.log('[OfficeExtension] Extraction complete');
          resolve();
        } else {
          reject(new Error(`ditto exited with code ${code}`));
        }
      });
    });
  } else {
    const JSZipModule = await import('jszip');
    const JSZip = resolveJsZipConstructor(JSZipModule);
    const fs = await import('fs/promises');

    const zipData = await fs.readFile(zipPath);
    const zip = await JSZip.loadAsync(zipData);

    const fileNames = Object.keys(zip.files);
    for (const relativePath of fileNames) {
      const zipEntry = zip.files[relativePath];
      const fullPath = join(destDir, relativePath);

      if (zipEntry.dir) {
        await fs.mkdir(fullPath, { recursive: true });
      } else {
        const dir = join(fullPath, '..');
        await fs.mkdir(dir, { recursive: true });
        const content = await zipEntry.async('nodebuffer');
        await fs.writeFile(fullPath, content);
      }
    }

    console.log('[OfficeExtension] Extraction complete (JSZip)');
  }
}

export async function uninstallOoEditors(): Promise<void> {
  const ooEditorsDir = getOoEditorsDir();

  if (serverProcess) {
    trackOoEditorsEvent('Shutting down for uninstall', 'info');
    await shutdownOfficeExtension();
  }

  if (existsSync(ooEditorsDir)) {
    rmSync(ooEditorsDir, { recursive: true, force: true });
    console.log(`[OfficeExtension] Removed: ${ooEditorsDir}`);
  }

  const fontDataDir = getFontDataDir();
  if (existsSync(fontDataDir)) {
    rmSync(fontDataDir, { recursive: true, force: true });
    console.log(`[OfficeExtension] Removed font data: ${fontDataDir}`);
  }
}

async function killProcessOnPort(
  port: number,
  options: { waitForPortReleaseMs?: number } = {}
): Promise<void> {
  try {
    killPortProcessSync(port, {
      excludePids: getCurrentProcessPortCleanupExclusions(),
    });
    const waitForPortReleaseMs = options.waitForPortReleaseMs ?? 1000;
    if (waitForPortReleaseMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitForPortReleaseMs));
    }
  } catch (error) {
    console.log(`[OfficeExtension] Could not kill process on port ${port}`);
  }
}

async function ensurePortAvailableForStartup(port: number): Promise<void> {
  const maxAttempts = 3;
  await ensurePortAvailableWithRetries(
    port,
    {
      checkPort: isPortAvailableForDefaultListen,
      killBeforeCheck: true,
      killProcessOnPort,
      onPortConflict: (attempt, attempts) => {
        console.log(`[OfficeExtension] Port ${port} in use (attempt ${attempt}/${attempts}), attempting to free it...`);
        trackOoEditorsEvent('Port conflict detected', 'warning', { port, attempt, maxAttempts: attempts });
      },
    },
    maxAttempts
  );
}

export async function isOfficeExtensionRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`http://localhost:${PORT}/healthcheck`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const text = await response.text();
      return text.includes('true');
    }
    return false;
  } catch {
    return false;
  }
}

async function generateFontMetadata(ooEditorsDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('[OfficeExtension] Generating font metadata...');

    const fontDataDir = getFontDataDir();
    if (!existsSync(fontDataDir)) {
      mkdirSync(fontDataDir, { recursive: true });
      console.log(`[OfficeExtension] Created font data directory: ${fontDataDir}`);
    }

    const scriptPath = join(ooEditorsDir, 'scripts', 'generate_office_fonts.js');
    if (!existsSync(scriptPath)) {
      reject(new Error(`Font generation script is missing: ${scriptPath}`));
      return;
    }

    const nodeRuntime = resolveOoEditorsNodeRuntime({});
    const nodeEnv = buildOoEditorsServerEnv(process.env, {
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      port: PORT,
      fontDataDir,
    });

    const generateProcess = spawn(nodeRuntime.binaryPath, [scriptPath], {
      cwd: nodeRuntime.cwd,
      env: nodeEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    generateProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`[font generation]: ${data.toString().trim()}`);
    });

    generateProcess.stderr?.on('data', (data: Buffer) => {
      console.warn(`[font generation error]: ${data.toString().trim()}`);
    });

    generateProcess.on('error', (error: Error) => {
      console.error('[OfficeExtension] Failed to spawn font generation process:', error);
      reject(new Error(`Failed to generate fonts: ${error.message}`));
    });

    generateProcess.on('exit', (code: number | null) => {
      if (code !== 0) {
        console.error(`[OfficeExtension] Font generation failed with code ${code}`);
        reject(new Error(`Font generation exited with code ${code}`));
        return;
      }

      try {
        assertRequiredFontMetadata(fontDataDir);
        console.log('[OfficeExtension] Font metadata generated successfully');
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function waitForServerReady(maxAttempts: number, delayMs: number): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, delayMs));

    if (await isOfficeExtensionRunning()) {
      return;
    }

    if (i % 5 === 0) {
      console.log(`[OfficeExtension] Waiting for server... (${i * delayMs / 1000}s elapsed)`);
    }
  }

  throw new Error('oo-editors server failed to start within expected time');
}

async function doStartupOoEditors(): Promise<void> {
  isShuttingDown = false;
  exitSuppressionWindow = null;
  childProcessGoneSignal = null;
  try {
    console.log('[OfficeExtension] Starting oo-editors server...');

    // NOTE(victor): Retry with delay - filesystem may not be synced immediately after ditto extraction
    let installed = isOoEditorsInstalled();
    if (!installed) {
      console.log('[OfficeExtension] First check failed, waiting 500ms and retrying...');
      await new Promise(resolve => setTimeout(resolve, 500));
      installed = isOoEditorsInstalled();
    }
    if (!installed) {
      throw new Error('oo-editors is not installed');
    }

    const ooEditorsDir = getOoEditorsDir();
    const serverScript = getServerScriptPath();

    console.log(`[OfficeExtension] Server script: ${serverScript}`);

    const fontDataDir = getFontDataDir();
    if (!existsSync(fontDataDir)) {
      mkdirSync(fontDataDir, { recursive: true });
      console.log(`[OfficeExtension] Created font data directory: ${fontDataDir}`);
    }

    if (!hasRequiredFontMetadata(fontDataDir)) {
      console.log('[OfficeExtension] Required font metadata missing, generating...');
      await generateFontMetadata(ooEditorsDir);
    } else {
      console.log('[OfficeExtension] Required font metadata already exists');
    }

    await ensurePortAvailableForStartup(PORT);

    console.log(`[OfficeExtension] Starting server: ${serverScript}`);

    const nodeRuntime = resolveOoEditorsNodeRuntime({});
    const serverEnv = buildOoEditorsServerEnv(process.env, {
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      port: PORT,
      fontDataDir,
    });

    serverProcess = spawn(nodeRuntime.binaryPath, [serverScript], {
      cwd: nodeRuntime.cwd,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    trackOoEditorsEvent(`Spawned PID ${serverProcess.pid}`, 'info', {
      pid: serverProcess.pid,
      script: serverScript,
      cwd: nodeRuntime.cwd,
      nodeBinary: nodeRuntime.binaryPath,
    });

    serverProcess.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      console.log(`[oo-editors]: ${msg}`);
      pushToLogBuffer(ooEditorsStdoutBuffer, msg);
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      console.warn(`[oo-editors error]: ${msg}`);
      pushToLogBuffer(ooEditorsStderrBuffer, msg);
      const stderrDecision = classifyOoEditorsStderr(msg);
      switch (stderrDecision.action) {
        case 'capture':
          Sentry.captureMessage(`oo-editors stderr: ${msg}`, 'error');
          trackOoEditorsEvent('Stderr error', 'error', {
            stderr: msg,
            reason: stderrDecision.reason,
          });
          break;
        case 'breadcrumb':
          trackOoEditorsEvent('Suppressed stderr noise', 'warning', {
            stderr: msg,
            reason: stderrDecision.reason,
          });
          break;
        case 'ignore':
          break;
      }
    });

    serverProcess.on('error', (error: Error) => {
      const isWindowsPermissionError = isWindowsOoEditorsSpawnPermissionError(error);
      console.error('[OfficeExtension] Server process error:', error);
      if (!isWindowsPermissionError) {
        Sentry.captureException(error, { tags: { process: 'oo-editors' } });
      }
      trackOoEditorsEvent('Process error', isWindowsPermissionError ? 'warning' : 'error', {
        error: error.message,
        code: (error as NodeJS.ErrnoException).code ?? null,
        reason: isWindowsPermissionError ? 'windows-runtime-spawn-denied' : 'unexpected-process-error',
      });
      startupPromise = null;
    });

    serverProcess.on('exit', (code: number | null, signal: string | null) => {
      console.log(`[OfficeExtension] Server process exited with code: ${code}, signal: ${signal}`);
      const nowMs = Date.now();
      const exitDecision = classifyOoEditorsExit({
        code,
        isShuttingDown,
        isAppQuitting,
        childProcessGoneSignal,
        nowMs,
        suppressionWindow: exitSuppressionWindow,
        stdout: ooEditorsStdoutBuffer.join('\n'),
        stderr: ooEditorsStderrBuffer.join('\n'),
      });
      if (exitDecision.shouldCapture) {
        Sentry.captureMessage(`oo-editors exited with code ${code}`, {
          level: 'error',
          extra: {
            exitCode: code,
            signal,
            stdout: ooEditorsStdoutBuffer.join('\n'),
            stderr: ooEditorsStderrBuffer.join('\n'),
          },
        });
        trackOoEditorsEvent('Non-zero exit', 'error', {
          exitCode: code,
          signal,
          stdoutTail: ooEditorsStdoutBuffer.slice(-10).join('\n'),
          stderrTail: ooEditorsStderrBuffer.slice(-10).join('\n'),
        });
      } else if (code !== null && code !== 0) {
        trackOoEditorsEvent('Suppressed non-zero exit', 'info', {
          reason: exitDecision.reason,
          exitCode: code,
          signal,
          isShuttingDown,
          isAppQuitting,
          suppressionWindow: exitSuppressionWindow,
          nowMs,
        });
      }
      isShuttingDown = false;
      ooEditorsStdoutBuffer = [];
      ooEditorsStderrBuffer = [];
      serverProcess = null;
      startupPromise = null;
      isStarting = false;
      exitSuppressionWindow = null;
      childProcessGoneSignal = null;
    });

    await waitForServerReady(30, 1000);
    console.log('[OfficeExtension] oo-editors server is ready');

    const runningVersion = await getInstalledOoEditorsVersion();
    if (runningVersion) {
      Sentry.setTag('oo-editors.version', runningVersion);
    }

    trackOoEditorsEvent('Startup success', 'info', { pid: serverProcess?.pid, version: runningVersion });
    exitSuppressionWindow = null;

  } catch (error) {
    console.error('[OfficeExtension] Failed to start oo-editors server:', error);
    trackOoEditorsEvent('Startup failed', 'error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    startupPromise = null;
    throw error;
  }
}

export async function ensureOfficeExtensionRunning(): Promise<void> {
  if (shutdownPromise) {
    await shutdownPromise;
  }

  if (startupPromise) {
    return startupPromise;
  }

  if (isStarting) {
    await new Promise(resolve => setTimeout(resolve, 100));
    return ensureOfficeExtensionRunning();
  }

  isStarting = true;

  try {
    if (await isOfficeExtensionRunning()) {
      console.log('[OfficeExtension] Already running');
      isStarting = false;
      return;
    }

    console.log('[OfficeExtension] Starting oo-editors backend');
    startupPromise = doStartupOoEditors();
    try {
      await startupPromise;
    } finally {
      isStarting = false;
    }

    return startupPromise;
  } catch (error) {
    isStarting = false;
    throw error;
  }
}

export async function shutdownOfficeExtension(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  if (!serverProcess) {
    return;
  }

  const child = serverProcess;
  const pid = child.pid;

  shutdownPromise = (async () => {
    console.log('[OfficeExtension] Shutting down oo-editors server...');
    isShuttingDown = true;
    trackOoEditorsEvent('Shutdown initiated', 'info', { pid });

    try {
      if (pid) {
        trackOoEditorsEvent(`Sending SIGTERM to PID ${pid}`, 'info', { pid });
        console.log(`[OfficeExtension] Sending SIGTERM to child PID ${pid}`);
        child.kill('SIGTERM');
      }
    } catch (error) {
      console.warn('[OfficeExtension] Error killing server process:', error);
    }

    const termination = await gracefulTerminateChild(child, {
      termTimeoutMs: 1500,
      killTimeoutMs: 1000,
    });

    if (termination.exitedAfterTerm && pid) {
      trackOoEditorsEvent(`Child PID ${pid} exited after SIGTERM`, 'info', { pid });
    }

    if (termination.sentSigkill && pid) {
      trackOoEditorsEvent(`Sent SIGKILL to PID ${pid}`, 'warning', { pid });
      console.log(`[OfficeExtension] Sent SIGKILL to PID ${pid}`);
    } else if (!termination.exitedAfterTerm && pid) {
      trackOoEditorsEvent(`SIGKILL not sent for PID ${pid} (already exited or signal failed)`, 'info', { pid });
    }

    serverProcess = null;
    ooEditorsStdoutBuffer = [];
    ooEditorsStderrBuffer = [];
    startupPromise = null;
    isStarting = false;
    isShuttingDown = false;
  })().finally(() => {
    shutdownPromise = null;
  });

  return shutdownPromise;
}

export async function convertFile(request: any, outputPath?: string): Promise<any> {
  console.log('[OfficeExtension] Convert file request:', {
    filetype: request.filetype,
    outputtype: request.outputtype,
    key: request.key,
    title: request.title,
    filePath: request.filePath || request.url,
    outputPath: outputPath
  });

  const requestWithOutput = outputPath ? { ...request, outputPath } : request;

  try {
    const response = await makeRequest(`http://localhost:${PORT}/converter`, 'POST', requestWithOutput);
    console.log('[OfficeExtension] Conversion response:', response);

    if (!response || typeof response !== 'object') {
      throw new Error('Invalid response from conversion service: not an object');
    }

    if (response.error && response.error !== 0) {
      console.error('[OfficeExtension] Conversion error:', response.error);
      return response;
    }

    if (outputPath) {
      if (response.success) {
        console.log('[OfficeExtension] File converted and saved to:', response.outputPath);
        return response;
      } else {
        console.error('[OfficeExtension] Failed to save converted file:', response.details);
        throw new Error(response.details || 'Failed to save converted file');
      }
    }

    if (!response.url) {
      console.error('[OfficeExtension] No URL in response:', response);
      throw new Error('Conversion response missing URL');
    }

    console.log('[OfficeExtension] Conversion successful, file URL:', response.url);
    return response;
  } catch (error) {
    console.error('[OfficeExtension] Conversion failed:', error);
    throw new Error(`Failed to convert file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function downloadFile(url: string): Promise<Buffer> {
  console.log('[OfficeExtension] Download file:', url);

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = url.startsWith('https:') ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https:') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Accept': '*/*',
        'User-Agent': 'Interpreter-OfficeExtension-Converter'
      }
    };

    const req = client.request(options, (res) => {
      console.log('[OfficeExtension] Download response status:', res.statusCode);

      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log('[OfficeExtension] Following redirect to:', res.headers.location);
        downloadFile(res.headers.location).then(resolve, reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP error! status: ${res.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];

      res.on('data', (chunk) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        console.log('[OfficeExtension] Downloaded file size:', buffer.length, 'bytes');
        resolve(buffer);
      });

      res.on('error', (error) => {
        console.error('[OfficeExtension] Response error:', error);
        reject(error);
      });
    });

    req.on('error', (error) => {
      console.error('[OfficeExtension] Request error:', error);
      reject(error);
    });

    req.end();
  });
}

function makeRequest(url: string, method: string, data?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = url.startsWith('https:') ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    const req = client.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP error! status: ${res.statusCode}: ${responseData}`));
        } else {
          try {
            resolve(JSON.parse(responseData));
          } catch {
            resolve(responseData);
          }
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

export function getOfficeExtensionPort(): number {
  return PORT;
}
