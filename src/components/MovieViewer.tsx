import * as ReactModule from 'react';
import * as ReactJsxDevRuntimeModule from 'react/jsx-dev-runtime';
import * as ReactJsxRuntimeModule from 'react/jsx-runtime';
import { canUseHostNativeFileManager } from '../remote/workstationConnection';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  ChevronsLeft,
  ChevronsRight,
  Circle,
  Link2Off,
  Maximize2,
  Mic,
  Monitor,
  Pause,
  Play,
  Plus,
  RefreshCw,
  SkipBack,
  SkipForward,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  MOVIE_EXPORT_BUTTON_ID,
  MOVIE_PLAY_BUTTON_ID,
  MOVIE_RECORD_AT_PLAYHEAD_BUTTON_ID,
  MOVIE_SOURCE_PREVIEW_CLOSE_BUTTON_ID,
  MOVIE_SOURCE_PREVIEW_DELAY_SLIDER_ID,
  MOVIE_SOURCE_PREVIEW_EXPAND_BUTTON_ID,
  MOVIE_SOURCE_PREVIEW_MODAL_ID,
  MOVIE_UNLINK_AUDIO_BUTTON_ID,
  MOVIE_VIEWER_ID,
} from '../../shared/element-ids';
import type { MovieExportProgressEvent, WorkspaceFilesChangedEvent } from '../../electron/ipc/registry';
import { readFile, writeFile } from '../api';
import {
  desktopSources,
  files as filesIpc,
  getFileUrl,
  getPathForFile,
  isAbsolutePath,
  log,
  movie as movieIpc,
  pathBasename,
  pathDirname,
  pathJoin,
  pathNormalize,
  pathStartsWith,
  pathsMatch,
  savePathDialog,
  showContextMenu,
  showItemInFolder,
  type ContextMenuItem,
  type DesktopSourceDescriptor,
  workspace,
} from '@/ipc';
import { cn } from '@/lib/utils';
import { EditorContentSurface, EditorShell, EditorToolbar } from './EditorShell';
import { ResizeHandle } from './ui/resize-handle';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/NativeSelect';
import { Slider } from './ui/slider';
import { Textarea } from './ui/textarea';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { useFileRefresh } from '../hooks/useFileRefresh';
import { useLayoutActions } from '../hooks/useLayout';
import { useResizable } from '../hooks/useResizable';
import { useToast } from '../contexts/ToastContext';
import { resolveFileDragData } from '../utils/fileDragData';
import { MoviePreview, type MoviePreviewStageComponent } from './movie/MoviePreview';
import { MovieTimelineEditor } from './movie/MovieTimelineEditor';
import { analyzeMovieAssetFile, classifyMovieAssetKind, getMovieAssetAbsolutePath } from '@/lib/movie/media';
import {
  insertMovieAssetAtPlayhead,
  removeMovieClip,
  setMoviePlayheadFrame,
  unlinkMovieClipAudio,
  updateMovieAssetEntry,
  updateMovieClipMetadata,
  updateMovieClipStyle,
  updateMovieClipTiming,
} from '@/lib/movie/timeline';
import {
  parseMovieTimelineModule,
  renderMovieTimelineModule,
} from '../../shared/movie-scaffold';
import {
  type MovieAsset,
  type MovieAssetMetadata,
  type MovieClip,
  type MovieJsonObject,
  type MovieManifest,
  type MovieTimelineDefinition,
} from '../../shared/movie-schema';

declare global {
  interface Window {
    __INTERPRETER_MOVIE_PREVIEW?: {
      react: typeof ReactModule;
      reactJsxRuntime: typeof ReactJsxRuntimeModule;
      reactJsxDevRuntime: typeof ReactJsxDevRuntimeModule;
    };
  }
}

interface MovieViewerProps {
  filePath: string;
  refreshKey?: number;
}

interface ResolvedMovieProject {
  manifestPath: string;
  manifest: MovieManifest;
  projectDir: string;
  assetsDir: string;
  metadataDir: string;
  rendersDir: string;
  timelinePath: string;
  componentsPath: string;
  runtimePath: string;
  entryPointPath: string;
}

type VideoSourceKind = 'camera' | 'screen';
type MovieComponentRegistry = Record<string, React.ComponentType<Record<string, unknown>>>;

interface VideoSourceOption {
  key: string;
  kind: VideoSourceKind;
  label: string;
  cameraDeviceId?: string;
  desktopSourceId?: string;
  thumbnailDataUrl?: string | null;
}

interface AudioSourceOption {
  key: string;
  label: string;
  deviceId: string;
}

interface RecorderVideoInput {
  id: string;
  selectedSourceKey: string | null;
  connectedSourceKey: string | null;
  stream: MediaStream | null;
  isConnecting: boolean;
}

interface WavCaptureSession {
  stop: () => Promise<ArrayBuffer>;
  abort: () => Promise<void>;
}

interface BufferedPreviewFrame {
  capturedAtMs: number;
  bitmap: ImageBitmap;
}

interface ActiveVideoRecording {
  inputId: string;
  recorder: MediaRecorder;
  outputPath: string;
  stopPromise: Promise<{ path: string }>;
}

interface ActiveRecordingSession {
  startedAt: number;
  startFrame: number;
  stem: string;
  videoRecordings: ActiveVideoRecording[];
  audioCapture: WavCaptureSession | null;
  audioOutputPath: string | null;
}

const MP4_MIME_TYPES = [
  'video/mp4;codecs=h264,aac',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
] as const;
const MAX_SOURCE_PREVIEW_DELAY_SECONDS = 20;
const SOURCE_PREVIEW_DELAY_CAPTURE_INTERVAL_MS = 200;
const SOURCE_PREVIEW_DELAY_PAINT_INTERVAL_MS = 100;
const SOURCE_PREVIEW_DELAY_CAPTURE_MAX_WIDTH = 640;

function formatPreviewDelaySeconds(value: number): string {
  return `${value.toFixed(1)}s`;
}

function drawContainedFrame(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): void {
  context.fillStyle = '#000';
  context.fillRect(0, 0, targetWidth, targetHeight);

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return;
  }

  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  const x = Math.round((targetWidth - drawWidth) / 2);
  const y = Math.round((targetHeight - drawHeight) / 2);
  context.drawImage(source, x, y, drawWidth, drawHeight);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createStableId(prefix: string): string {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${randomPart}`;
}

function createVideoInput(selectedSourceKey: string | null): RecorderVideoInput {
  return {
    id: createStableId('movie-video-input'),
    selectedSourceKey,
    connectedSourceKey: null,
    stream: null,
    isConnecting: false,
  };
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.onended = null;
    track.stop();
  }
}

function isKeyboardEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  return Boolean(
    element.closest(
      'input, textarea, select, button, [role="textbox"], [role="button"], [role="slider"], [contenteditable="true"]',
    ),
  );
}

function chooseMp4MimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') {
    return null;
  }
  for (const candidate of MP4_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

function sanitizeMovieExportFilename(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'movie';
}

function buildSuggestedMovieExportPath(project: ResolvedMovieProject): string {
  return pathJoin(
    project.projectDir,
    project.manifest.rendersDir,
    `${sanitizeMovieExportFilename(project.manifest.name)}-${Date.now()}.mp4`,
  );
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function createCaptureStem(now = new Date()): string {
  return `capture-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) {
    return '00:00';
  }

  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutesPart = Math.floor(seconds / 60);
  const secondsPart = seconds % 60;
  const hoursPart = Math.floor(minutesPart / 60);

  if (hoursPart > 0) {
    return `${pad(hoursPart)}:${pad(minutesPart % 60)}:${pad(secondsPart)}`;
  }

  return `${pad(minutesPart)}:${pad(secondsPart)}`;
}

function formatFrameTime(frame: number, fps: number): string {
  return formatDuration(frame / fps);
}

function flattenFloat32(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const combined = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const channelCount = Math.max(1, channels.length);
  const frameCount = channels[0]?.length ?? 0;
  const bitsPerSample = 16;
  const blockAlign = channelCount * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let writeOffset = 44;
  for (let sampleIndex = 0; sampleIndex < frameCount; sampleIndex += 1) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const sample = channels[channelIndex]?.[sampleIndex] ?? 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(writeOffset, pcm, true);
      writeOffset += 2;
    }
  }

  return buffer;
}

async function startWavCapture(stream: MediaStream): Promise<WavCaptureSession> {
  const audioContext = new window.AudioContext();
  await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const trackSettings = stream.getAudioTracks()[0]?.getSettings();
  const requestedChannels = typeof trackSettings?.channelCount === 'number' ? trackSettings.channelCount : 1;
  const channelCount = Math.max(1, Math.min(2, requestedChannels));
  const chunks = Array.from({ length: channelCount }, () => [] as Float32Array[]);
  const processor = audioContext.createScriptProcessor(4096, channelCount, channelCount);
  const sink = audioContext.createGain();
  sink.gain.value = 0;
  let active = true;

  processor.onaudioprocess = (event) => {
    if (!active) return;
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      chunks[channelIndex].push(new Float32Array(event.inputBuffer.getChannelData(channelIndex)));
    }
  };

  source.connect(processor);
  processor.connect(sink);
  sink.connect(audioContext.destination);

  const finalize = async (keepData: boolean): Promise<ArrayBuffer> => {
    active = false;
    processor.disconnect();
    source.disconnect();
    sink.disconnect();

    const flattenedChannels = keepData
      ? chunks.map((channelChunks) => flattenFloat32(channelChunks))
      : [new Float32Array(0)];
    const sampleRate = audioContext.sampleRate;
    await audioContext.close();
    return encodeWav(flattenedChannels, sampleRate);
  };

  return {
    stop: () => finalize(true),
    abort: async () => {
      await finalize(false);
    },
  };
}

function resolveProjectFilePath(project: ResolvedMovieProject, targetPath: string): string {
  return isAbsolutePath(targetPath) ? targetPath : pathJoin(project.projectDir, targetPath);
}

function getMovieClipById(timeline: MovieTimelineDefinition | null, clipId: string | null): MovieClip | null {
  if (!timeline || !clipId) {
    return null;
  }

  for (const track of timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) {
      return clip;
    }
  }

  return null;
}

function getMovieAssetForClip(
  timeline: MovieTimelineDefinition | null,
  clip: MovieClip | null,
): MovieAsset | null {
  if (!timeline || !clip || clip.kind === 'react') {
    return null;
  }

  return timeline.assets.find((asset) => asset.id === clip.assetId) ?? null;
}

function normalizeDroppedPaths(paths: string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of paths) {
    if (!value) continue;
    const normalized = pathNormalize(value);
    unique.set(normalized, normalized);
  }
  return [...unique.values()];
}

function extractDroppedMediaPaths(event: React.DragEvent): string[] {
  const collected: string[] = [];

  const resolvedDragData = resolveFileDragData(event.dataTransfer);
  if (resolvedDragData) {
    collected.push(resolvedDragData.filePath);
  }

  const textData = event.dataTransfer.getData('text/plain');
  if (textData && isAbsolutePath(textData)) {
    collected.push(textData);
  }

  for (const file of Array.from(event.dataTransfer.files)) {
    const filePath = getPathForFile(file);
    if (filePath) {
      collected.push(filePath);
    }
  }

  return normalizeDroppedPaths(collected).filter((candidate) => classifyMovieAssetKind(candidate) !== null);
}

function findExistingMovieAsset(
  timeline: MovieTimelineDefinition,
  projectDir: string,
  absolutePath: string,
): MovieAsset | null {
  for (const asset of timeline.assets) {
    if (pathsMatch(getMovieAssetAbsolutePath(asset, projectDir), absolutePath)) {
      return asset;
    }
  }

  return null;
}

function LiveVideoMonitor({
  source,
  stream,
  mode = 'card',
  delaySeconds = 0,
  onExpand,
  expandButtonId,
}: {
  source: VideoSourceOption | null;
  stream: MediaStream | null;
  mode?: 'card' | 'expanded';
  delaySeconds?: number;
  onExpand?: (() => void) | null;
  expandButtonId?: string;
}) {
  "use no memo";

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const delayedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferedFramesRef = useRef<BufferedPreviewFrame[]>([]);
  const hasPreviewImage = Boolean(source?.thumbnailDataUrl);
  const isExpanded = mode === 'expanded';
  const requestedDelayMs = Math.round(delaySeconds * 1000);
  const [bufferedDelayMs, setBufferedDelayMs] = useState(0);
  const shouldBufferDelayedPreview = isExpanded && Boolean(stream);
  const shouldShowDelayedPreview = shouldBufferDelayedPreview && requestedDelayMs > 0;
  const isDelayBuffering = shouldShowDelayedPreview && bufferedDelayMs + SOURCE_PREVIEW_DELAY_CAPTURE_INTERVAL_MS < requestedDelayMs;
  const statusLabel = stream
    ? (shouldShowDelayedPreview ? `delay ${formatPreviewDelaySeconds(delaySeconds)}` : 'live')
    : hasPreviewImage ? 'preview' : 'idle';
  const emptyStateTitle = source ? 'No live preview' : 'No source selected';
  const emptyStateDescription = source
    ? 'Preview this source before recording.'
    : 'Choose a source to preview it here.';

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!stream) {
      video.pause();
      video.srcObject = null;
      return;
    }

    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    void video.play().catch(() => {});

    return () => {
      video.pause();
      video.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    if (!shouldBufferDelayedPreview) {
      for (const frame of bufferedFramesRef.current) {
        frame.bitmap.close();
      }
      bufferedFramesRef.current = [];
      setBufferedDelayMs(0);
      return;
    }

    const video = videoRef.current;
    if (!video) {
      return;
    }

    const captureCanvas = document.createElement('canvas');
    const captureContext = captureCanvas.getContext('2d', { alpha: false });
    if (!captureContext) {
      return;
    }

    let disposed = false;
    let captureInFlight = false;

    const pruneFrames = (nowMs: number) => {
      const cutoffMs = nowMs - ((MAX_SOURCE_PREVIEW_DELAY_SECONDS * 1000) + SOURCE_PREVIEW_DELAY_CAPTURE_INTERVAL_MS * 3);
      while (bufferedFramesRef.current[0] && bufferedFramesRef.current[0].capturedAtMs < cutoffMs) {
        bufferedFramesRef.current.shift()?.bitmap.close();
      }
    };

    const updateBufferedDelay = (nowMs: number) => {
      const oldestFrame = bufferedFramesRef.current[0];
      setBufferedDelayMs(oldestFrame ? Math.max(0, nowMs - oldestFrame.capturedAtMs) : 0);
    };

    const captureFrame = async () => {
      if (disposed || captureInFlight) {
        return;
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0) {
        updateBufferedDelay(performance.now());
        return;
      }

      captureInFlight = true;
      try {
        const nowMs = performance.now();
        const captureScale = Math.min(1, SOURCE_PREVIEW_DELAY_CAPTURE_MAX_WIDTH / video.videoWidth);
        const captureWidth = Math.max(2, Math.round(video.videoWidth * captureScale));
        const captureHeight = Math.max(2, Math.round(video.videoHeight * captureScale));
        if (captureCanvas.width !== captureWidth || captureCanvas.height !== captureHeight) {
          captureCanvas.width = captureWidth;
          captureCanvas.height = captureHeight;
        }
        captureContext.drawImage(video, 0, 0, captureWidth, captureHeight);
        const bitmap = await createImageBitmap(captureCanvas);
        if (disposed) {
          bitmap.close();
          return;
        }
        bufferedFramesRef.current.push({
          capturedAtMs: nowMs,
          bitmap,
        });
        pruneFrames(nowMs);
        updateBufferedDelay(nowMs);
      } catch {
        updateBufferedDelay(performance.now());
      } finally {
        captureInFlight = false;
      }
    };

    const captureIntervalId = window.setInterval(() => {
      void captureFrame();
    }, SOURCE_PREVIEW_DELAY_CAPTURE_INTERVAL_MS);
    void captureFrame();

    return () => {
      disposed = true;
      window.clearInterval(captureIntervalId);
      for (const frame of bufferedFramesRef.current) {
        frame.bitmap.close();
      }
      bufferedFramesRef.current = [];
      setBufferedDelayMs(0);
    };
  }, [shouldBufferDelayedPreview, stream]);

  useEffect(() => {
    if (!shouldShowDelayedPreview) {
      const delayedCanvas = delayedCanvasRef.current;
      const context = delayedCanvas?.getContext('2d');
      if (delayedCanvas && context) {
        context.clearRect(0, 0, delayedCanvas.width, delayedCanvas.height);
      }
      return;
    }

    const delayedCanvas = delayedCanvasRef.current;
    const context = delayedCanvas?.getContext('2d');
    if (!delayedCanvas || !context) {
      return;
    }

    let disposed = false;

    const paintFrame = () => {
      if (disposed) {
        return;
      }

      const bounds = delayedCanvas.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(bounds.width * (window.devicePixelRatio || 1)));
      const nextHeight = Math.max(1, Math.round(bounds.height * (window.devicePixelRatio || 1)));
      if (delayedCanvas.width !== nextWidth || delayedCanvas.height !== nextHeight) {
        delayedCanvas.width = nextWidth;
        delayedCanvas.height = nextHeight;
      }

      const frames = bufferedFramesRef.current;
      const nowMs = performance.now();
      const targetCaptureTimeMs = nowMs - requestedDelayMs;
      let selectedFrame = frames[0] ?? null;
      for (let index = frames.length - 1; index >= 0; index -= 1) {
        const candidate = frames[index];
        if (candidate.capturedAtMs <= targetCaptureTimeMs) {
          selectedFrame = candidate;
          break;
        }
      }

      if (!selectedFrame) {
        context.fillStyle = '#000';
        context.fillRect(0, 0, delayedCanvas.width, delayedCanvas.height);
        return;
      }

      drawContainedFrame(
        context,
        selectedFrame.bitmap,
        selectedFrame.bitmap.width,
        selectedFrame.bitmap.height,
        delayedCanvas.width,
        delayedCanvas.height,
      );
    };

    const paintIntervalId = window.setInterval(paintFrame, SOURCE_PREVIEW_DELAY_PAINT_INTERVAL_MS);
    paintFrame();

    return () => {
      disposed = true;
      window.clearInterval(paintIntervalId);
    };
  }, [requestedDelayMs, shouldShowDelayedPreview]);

  return (
    <div className={cn('space-y-2', isExpanded && 'flex h-full min-h-0 flex-col')}>
      <div className={cn(
        'flex items-center justify-between gap-3 text-white/48',
        isExpanded ? 'text-ui-sm' : 'text-ui-xs',
      )}>
        <div className="min-w-0 truncate">{source?.label ?? 'No video source selected'}</div>
        <div className="shrink-0">{statusLabel}</div>
      </div>

      <div
        className={cn(
          'relative overflow-hidden bg-black',
          isExpanded ? 'h-full min-h-0 rounded-[18px]' : 'aspect-[16/9] rounded-[12px]',
        )}
      >
        {onExpand ? (
          <div className="absolute right-3 top-3 z-10">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              id={expandButtonId}
              data-testid={expandButtonId}
              className="border border-white/12 bg-black/50 text-white/82 backdrop-blur-sm hover:bg-black/68 hover:text-white"
              onClick={onExpand}
              aria-label={`Expand preview for ${source?.label ?? 'video input'}`}
              title="Expand preview"
            >
              <Maximize2 className="size-4" />
            </Button>
          </div>
        ) : null}

        {stream ? (
          <video
            ref={videoRef}
            className={cn(
              'absolute inset-0 h-full w-full',
              shouldShowDelayedPreview && 'pointer-events-none opacity-0',
              isExpanded ? 'object-contain' : 'object-cover',
            )}
            autoPlay
            muted
            playsInline
          />
        ) : source?.thumbnailDataUrl ? (
          <img
            src={source.thumbnailDataUrl}
            alt=""
            className={cn(
              'absolute inset-0 h-full w-full opacity-80',
              isExpanded ? 'object-contain' : 'object-cover',
            )}
          />
        ) : null}

        {shouldShowDelayedPreview ? (
          <canvas
            ref={delayedCanvasRef}
            className="absolute inset-0 h-full w-full"
            aria-hidden="true"
          />
        ) : null}

        {isDelayBuffering ? (
          <div className="absolute bottom-4 left-4 rounded-full border border-white/12 bg-black/68 px-3 py-1.5 text-ui-xs text-white/74 backdrop-blur-sm">
            Buffering {formatPreviewDelaySeconds(Math.min(delaySeconds, bufferedDelayMs / 1000))} of {formatPreviewDelaySeconds(delaySeconds)}
          </div>
        ) : null}

        {!stream && !hasPreviewImage ? (
          <div className={cn(
            'absolute inset-0 flex items-center justify-center px-6 text-center',
            isExpanded ? 'bg-black/58' : 'bg-black/44',
          )}>
            <div>
              <div className="text-ui-sm font-medium text-white/84">{emptyStateTitle}</div>
              <div className="mt-1 text-ui-xs leading-5 text-white/50">{emptyStateDescription}</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function MovieViewer({ filePath, refreshKey = 0 }: MovieViewerProps) {
  "use no memo";

  const { setLeftSidebarOpen, setLeftSidebarTab } = useLayoutActions();
  const { showToast } = useToast();

  const [project, setProject] = useState<ResolvedMovieProject | null>(null);
  const [timeline, setTimeline] = useState<MovieTimelineDefinition | null>(null);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [assetMetadataById, setAssetMetadataById] = useState<Record<string, MovieAssetMetadata>>({});
  const [reactComponents, setReactComponents] = useState<MovieComponentRegistry>({});
  const [previewStageComponent, setPreviewStageComponent] = useState<MoviePreviewStageComponent | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [componentPreviewError, setComponentPreviewError] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [isProjectLoading, setIsProjectLoading] = useState(true);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playheadFrame, setPlayheadFrame] = useState(0);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [pixelsPerFrame, setPixelsPerFrame] = useState(2.4);
  const [utilityPanelWidth, setUtilityPanelWidth] = useState(308);
  const [layoutViewportSize, setLayoutViewportSize] = useState({ width: 0, height: 0 });
  const [hasUserResizedPreview, setHasUserResizedPreview] = useState(false);
  const [hasUserResizedUtility, setHasUserResizedUtility] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [metadataDraft, setMetadataDraft] = useState('{}');
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<{
    exportId: string | null;
    isRunning: boolean;
    isCancelling: boolean;
    message: string | null;
    progress: number | null;
    outputPath: string | null;
  }>({
    exportId: null,
    isRunning: false,
    isCancelling: false,
    message: null,
    progress: null,
    outputPath: null,
  });

  const [videoSources, setVideoSources] = useState<VideoSourceOption[]>([]);
  const [audioSources, setAudioSources] = useState<AudioSourceOption[]>([]);
  const [videoInputs, setVideoInputs] = useState<RecorderVideoInput[]>([createVideoInput(null)]);
  const [expandedVideoInputId, setExpandedVideoInputId] = useState<string | null>(null);
  const [expandedVideoPreviewDelaySeconds, setExpandedVideoPreviewDelaySeconds] = useState(0);
  const [selectedAudioSourceKey, setSelectedAudioSourceKey] = useState<string | null>(null);
  const [connectedAudioSourceKey, setConnectedAudioSourceKey] = useState<string | null>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [isConnectingAudio, setIsConnectingAudio] = useState(false);
  const [isRefreshingSources, setIsRefreshingSources] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isStoppingRecording, setIsStoppingRecording] = useState(false);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const {
    height: previewPanelHeight,
    setHeight: setPreviewPanelHeight,
    handleMouseDown: handlePreviewResizeMouseDown,
  } = useResizable({
    initialHeight: 460,
    minHeight: 220,
    maxHeight: Math.max(240, layoutViewportSize.height - 320),
    direction: 'down',
  });

  const disposedRef = useRef(false);
  const movieViewerRef = useRef<HTMLDivElement | null>(null);
  const layoutViewportRef = useRef<HTMLDivElement | null>(null);
  const projectRef = useRef<ResolvedMovieProject | null>(null);
  const timelineRef = useRef<MovieTimelineDefinition | null>(null);
  const playheadFrameRef = useRef(0);
  const persistTimerRef = useRef<number | null>(null);
  const persistQueuedTimelineRef = useRef<MovieTimelineDefinition | null>(null);
  const persistQueuedVersionRef = useRef(0);
  const persistFlushedVersionRef = useRef(0);
  const persistInFlightRef = useRef(false);
  const persistManifestPathRef = useRef<string | null>(null);
  const lastSavedTimelineSourceRef = useRef<string | null>(null);
  const videoSourcesRef = useRef<VideoSourceOption[]>([]);
  const audioSourcesRef = useRef<AudioSourceOption[]>([]);
  const videoInputsRef = useRef<RecorderVideoInput[]>(videoInputs);
  const videoConnectTokensRef = useRef<Record<string, number>>({});
  const audioConnectTokenRef = useRef(0);
  const audioStreamRef = useRef<MediaStream | null>(audioStream);
  const connectedAudioSourceKeyRef = useRef<string | null>(connectedAudioSourceKey);
  const recordingSessionRef = useRef<ActiveRecordingSession | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const previewPlaybackFrameRef = useRef<number | null>(null);
  const previewPlaybackAnchorRef = useRef<{ startedAt: number; startFrame: number } | null>(null);
  const utilityResizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const resizeState = utilityResizeStateRef.current;
      if (!resizeState) {
        return;
      }

      const maxWidth = Math.max(280, layoutViewportSize.width - 420);
      const nextWidth = resizeState.startWidth + (resizeState.startX - event.clientX);
      setUtilityPanelWidth(clampNumber(nextWidth, 280, maxWidth));
    };

    const stopResize = () => {
      if (!utilityResizeStateRef.current) {
        return;
      }

      utilityResizeStateRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', stopResize);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', stopResize);
      stopResize();
    };
  }, [layoutViewportSize.width]);

  useEffect(() => {
    const layoutViewport = layoutViewportRef.current;
    if (!layoutViewport) {
      return;
    }

    let frameId: number | null = null;

    const scheduleViewportSizeUpdate = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const nextWidth = layoutViewport.clientWidth;
        const nextHeight = layoutViewport.clientHeight;

        setLayoutViewportSize((current) => {
          if (current.width === nextWidth && current.height === nextHeight) {
            return current;
          }

          return {
            width: nextWidth,
            height: nextHeight,
          };
        });
      });
    };

    const observer = new ResizeObserver(scheduleViewportSizeUpdate);
    observer.observe(layoutViewport);
    window.addEventListener('resize', scheduleViewportSizeUpdate);
    scheduleViewportSizeUpdate();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleViewportSizeUpdate);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [Boolean(timeline)]);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);

  useEffect(() => {
    playheadFrameRef.current = playheadFrame;
  }, [playheadFrame]);

  useEffect(() => {
    videoSourcesRef.current = videoSources;
  }, [videoSources]);

  useEffect(() => {
    audioSourcesRef.current = audioSources;
  }, [audioSources]);

  useEffect(() => {
    videoInputsRef.current = videoInputs;
  }, [videoInputs]);

  useEffect(() => {
    audioStreamRef.current = audioStream;
  }, [audioStream]);

  useEffect(() => {
    connectedAudioSourceKeyRef.current = connectedAudioSourceKey;
  }, [connectedAudioSourceKey]);

  useEffect(() => {
    window.__INTERPRETER_MOVIE_PREVIEW = {
      react: ReactModule,
      reactJsxRuntime: ReactJsxRuntimeModule,
      reactJsxDevRuntime: ReactJsxDevRuntimeModule,
    };
  }, []);

  const selectedClip = useMemo(
    () => getMovieClipById(timeline, selectedClipId),
    [timeline, selectedClipId],
  );

  const readyVideoCount = useMemo(
    () => videoInputs.filter((input) => Boolean(input.stream && input.connectedSourceKey)).length,
    [videoInputs],
  );

  const videoSourceItems = useMemo(
    () => videoSources.map((source) => ({ value: source.key, label: source.label })),
    [videoSources],
  );

  const audioSourceItems = useMemo(
    () => audioSources.map((source) => ({ value: source.key, label: source.label })),
    [audioSources],
  );

  const videoSourceMap = useMemo(() => {
    const mapping = new Map<string, VideoSourceOption>();
    for (const source of videoSources) {
      mapping.set(source.key, source);
    }
    return mapping;
  }, [videoSources]);
  const expandedVideoInput = useMemo(
    () => (expandedVideoInputId ? videoInputs.find((input) => input.id === expandedVideoInputId) ?? null : null),
    [expandedVideoInputId, videoInputs],
  );
  const expandedVideoSource = useMemo(
    () => (
      expandedVideoInput?.selectedSourceKey
        ? videoSourceMap.get(expandedVideoInput.selectedSourceKey) ?? null
        : null
    ),
    [expandedVideoInput, videoSourceMap],
  );
  const expandedVideoPreviewDescription = useMemo(() => {
    if (expandedVideoInput?.stream && expandedVideoInput.connectedSourceKey === expandedVideoInput.selectedSourceKey) {
      return 'Live preview of the selected source.';
    }
    if (expandedVideoSource?.thumbnailDataUrl) {
      return 'Still preview of the selected source.';
    }
    if (expandedVideoSource) {
      return 'Connect this source to see a live feed before recording.';
    }
    return 'Choose a source, then preview it here before recording.';
  }, [expandedVideoInput, expandedVideoSource]);
  const expandedVideoDelayLabel = useMemo(
    () => formatPreviewDelaySeconds(expandedVideoPreviewDelaySeconds),
    [expandedVideoPreviewDelaySeconds],
  );

  useEffect(() => {
    if (expandedVideoInputId && !videoInputs.some((input) => input.id === expandedVideoInputId)) {
      setExpandedVideoInputId(null);
      setExpandedVideoPreviewDelaySeconds(0);
    }
  }, [expandedVideoInputId, videoInputs]);

  const movieFilename = pathBasename(filePath);

  const projectDurationLabel = timeline
    ? formatFrameTime(timeline.settings.durationInFrames, timeline.settings.fps)
    : '00:00';
  const previewAspectRatio = timeline
    ? timeline.settings.width / timeline.settings.height
    : 16 / 9;
  const utilityPanelMinWidth = 280;
  const utilityPanelMaxWidth = Math.max(utilityPanelMinWidth, layoutViewportSize.width - 420);
  const autoUtilityPanelWidth = clampNumber(
    Math.round(layoutViewportSize.width * 0.28),
    utilityPanelMinWidth,
    Math.min(420, utilityPanelMaxWidth),
  );
  const resolvedUtilityPanelWidth = hasUserResizedUtility
    ? clampNumber(utilityPanelWidth, utilityPanelMinWidth, utilityPanelMaxWidth)
    : autoUtilityPanelWidth;
  const previewPanelMinHeight = 220;
  const previewPanelMaxHeight = Math.max(previewPanelMinHeight, layoutViewportSize.height - 390);
  const autoPreviewPanelHeight = clampNumber(
    Math.round(layoutViewportSize.height * 0.38),
    previewPanelMinHeight,
    Math.min(460, previewPanelMaxHeight),
  );
  const resolvedPreviewPanelHeight = hasUserResizedPreview
    ? clampNumber(previewPanelHeight, previewPanelMinHeight, previewPanelMaxHeight)
    : autoPreviewPanelHeight;
  const previewMaxWidth = Math.max(
    320,
    Math.min(1100, Math.floor(resolvedPreviewPanelHeight * previewAspectRatio)),
  );
  const transportStepFrames = Math.max(1, Math.round(timeline?.settings.fps ?? 1));

  useEffect(() => {
    const nextHeight = hasUserResizedPreview
      ? clampNumber(previewPanelHeight, previewPanelMinHeight, previewPanelMaxHeight)
      : autoPreviewPanelHeight;

    if (Math.abs(nextHeight - previewPanelHeight) > 1) {
      setPreviewPanelHeight(nextHeight);
    }
  }, [
    autoPreviewPanelHeight,
    hasUserResizedPreview,
    previewPanelHeight,
    previewPanelMaxHeight,
    previewPanelMinHeight,
    setPreviewPanelHeight,
  ]);

  useEffect(() => {
    const nextWidth = hasUserResizedUtility
      ? clampNumber(utilityPanelWidth, utilityPanelMinWidth, utilityPanelMaxWidth)
      : autoUtilityPanelWidth;

    if (Math.abs(nextWidth - utilityPanelWidth) > 1) {
      setUtilityPanelWidth(nextWidth);
    }
  }, [
    autoUtilityPanelWidth,
    hasUserResizedUtility,
    utilityPanelWidth,
    utilityPanelMaxWidth,
    utilityPanelMinWidth,
  ]);

  const hydrateTimelineAssets = useCallback(async (
    nextProject: ResolvedMovieProject,
    nextTimeline: MovieTimelineDefinition,
  ) => {
    const nextAssetUrls: Record<string, string> = {};
    const nextMetadataMap: Record<string, MovieAssetMetadata> = {};

    await Promise.all(nextTimeline.assets.map(async (asset) => {
      try {
        nextAssetUrls[asset.id] = await getFileUrl(getMovieAssetAbsolutePath(asset, nextProject.projectDir));
      } catch (error: any) {
        log('WARN', '[MovieViewer] Failed to resolve asset URL', {
          assetId: asset.id,
          assetPath: asset.path,
          error: error?.message || String(error),
        });
      }

      const metadataAbsolutePath = resolveProjectFilePath(nextProject, asset.metadataPath);
      try {
        const metadataResult = await readFile(metadataAbsolutePath);
        nextMetadataMap[asset.id] = JSON.parse(metadataResult.content) as MovieAssetMetadata;
      } catch (error: any) {
        log('WARN', '[MovieViewer] Failed to load asset metadata', {
          assetId: asset.id,
          metadataPath: metadataAbsolutePath,
          error: error?.message || String(error),
        });
      }
    }));

    if (disposedRef.current) return;
    setAssetUrls(nextAssetUrls);
    setAssetMetadataById(nextMetadataMap);
  }, []);

  const loadReactComponents = useCallback(async (nextProject: ResolvedMovieProject) => {
    setComponentPreviewError(null);

    const result = await movieIpc.compileComponents({
      manifestPath: nextProject.manifestPath,
    });

    if (!result.success || !result.code) {
      if (!disposedRef.current) {
        setReactComponents({});
        setPreviewStageComponent(null);
        setComponentPreviewError(result.error || 'Failed to compile movie components');
      }
      return;
    }

    const bundleUrl = URL.createObjectURL(new Blob([result.code], { type: 'text/javascript' }));
    try {
      const module = await import(/* @vite-ignore */ bundleUrl);
      const registry = (module.movieReactComponents ?? {}) as MovieComponentRegistry;
      const stageComponent = (module.MovieStage ?? null) as MoviePreviewStageComponent | null;
      if (!stageComponent) {
        throw new Error('Movie runtime bundle is missing MovieStage');
      }
      if (!disposedRef.current) {
        setReactComponents(registry);
        setPreviewStageComponent(() => stageComponent);
      }
    } catch (error: any) {
      if (!disposedRef.current) {
        setReactComponents({});
        setPreviewStageComponent(null);
        setComponentPreviewError(error?.message || 'Failed to load movie components preview');
      }
    } finally {
      URL.revokeObjectURL(bundleUrl);
    }
  }, []);

  const loadProject = useCallback(async () => {
    setProjectError(null);
    setIsProjectLoading(true);
    setIsPreviewPlaying(false);
    setPreviewStageComponent(null);

    try {
      const manifestResult = await readFile(filePath);
      const manifest = JSON.parse(manifestResult.content) as MovieManifest;

      if (manifest.version !== 2) {
        throw new Error(`Unsupported .movie manifest version: ${String(manifest.version)}`);
      }

      const projectDir = pathDirname(filePath);
      const nextProject: ResolvedMovieProject = {
        manifestPath: filePath,
        manifest,
        projectDir,
        assetsDir: pathJoin(projectDir, manifest.assetsDir),
        metadataDir: pathJoin(projectDir, manifest.metadataDir),
        rendersDir: pathJoin(projectDir, manifest.rendersDir),
        timelinePath: pathJoin(projectDir, manifest.timelinePath),
        componentsPath: pathJoin(projectDir, manifest.componentsPath),
        runtimePath: pathJoin(projectDir, manifest.runtimePath),
        entryPointPath: pathJoin(projectDir, manifest.entryPoint),
      };

      const timelineSource = await readFile(nextProject.timelinePath);
      const nextTimeline = parseMovieTimelineModule(timelineSource.content);

      if (disposedRef.current) return;

      persistManifestPathRef.current = nextProject.manifestPath;
      persistQueuedTimelineRef.current = nextTimeline;
      persistQueuedVersionRef.current = 0;
      persistFlushedVersionRef.current = 0;
      lastSavedTimelineSourceRef.current = timelineSource.content;
      projectRef.current = nextProject;
      timelineRef.current = nextTimeline;
      playheadFrameRef.current = nextTimeline.playheadFrame;

      setProject(nextProject);
      setTimeline(nextTimeline);
      setPlayheadFrame(nextTimeline.playheadFrame);

      await Promise.all([
        hydrateTimelineAssets(nextProject, nextTimeline),
        loadReactComponents(nextProject),
      ]);
    } catch (error: any) {
      if (!disposedRef.current) {
        setProject(null);
        setTimeline(null);
        setReactComponents({});
        setPreviewStageComponent(null);
        setProjectError(error?.message || 'Failed to load movie project');
      }
    } finally {
      if (!disposedRef.current) {
        setIsProjectLoading(false);
      }
    }
  }, [filePath, hydrateTimelineAssets, loadReactComponents]);

  const flushTimelinePersistence = useCallback(async () => {
    if (persistInFlightRef.current) {
      return;
    }

    const activeProject = projectRef.current;
    if (!activeProject) {
      return;
    }

    persistInFlightRef.current = true;

    try {
      while (
        !disposedRef.current
        && projectRef.current
        && persistFlushedVersionRef.current < persistQueuedVersionRef.current
      ) {
        const currentProject = projectRef.current;
        const queuedTimeline = persistQueuedTimelineRef.current;
        const queuedVersion = persistQueuedVersionRef.current;
        const queuedManifestPath = persistManifestPathRef.current;

        if (
          !queuedTimeline
          || !queuedManifestPath
          || !currentProject
          || !pathsMatch(currentProject.manifestPath, queuedManifestPath)
        ) {
          break;
        }

        const timelineForDisk = setMoviePlayheadFrame(queuedTimeline, playheadFrameRef.current);

        if (
          disposedRef.current
          || queuedVersion !== persistQueuedVersionRef.current
          || !projectRef.current
          || !pathsMatch(projectRef.current.manifestPath, queuedManifestPath)
        ) {
          continue;
        }

        const nextTimelineSource = renderMovieTimelineModule(timelineForDisk);
        lastSavedTimelineSourceRef.current = nextTimelineSource;
        await writeFile(currentProject.timelinePath, nextTimelineSource);
        persistFlushedVersionRef.current = queuedVersion;
      }
    } catch (error: any) {
      if (!disposedRef.current) {
        const message = error?.message || 'Failed to save movie timeline';
        setProjectError(message);
        showToast(message, 'error', 4200);
      }
    } finally {
      persistInFlightRef.current = false;

      if (
        !disposedRef.current
        && projectRef.current
        && persistFlushedVersionRef.current < persistQueuedVersionRef.current
      ) {
        void flushTimelinePersistence();
      }
    }
  }, [showToast]);

  const persistTimeline = useCallback((
    nextTimeline: MovieTimelineDefinition,
    immediate = false,
  ) => {
    if (!projectRef.current) {
      return;
    }

    persistQueuedTimelineRef.current = nextTimeline;
    persistManifestPathRef.current = projectRef.current.manifestPath;
    persistQueuedVersionRef.current += 1;

    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }

    if (immediate) {
      void flushTimelinePersistence();
      return;
    }

    persistTimerRef.current = window.setTimeout(() => {
      void flushTimelinePersistence();
    }, 180);
  }, [flushTimelinePersistence]);

  const commitTimeline = useCallback((
    nextTimeline: MovieTimelineDefinition,
    options?: {
      immediatePersist?: boolean;
      selectedClipId?: string | null;
    },
  ) => {
    timelineRef.current = nextTimeline;
    setTimeline(nextTimeline);
    persistTimeline(nextTimeline, options?.immediatePersist);

    if (options && 'selectedClipId' in options) {
      setSelectedClipId(options.selectedClipId ?? null);
    }
  }, [persistTimeline]);

  const setManualPlayhead = useCallback((frame: number) => {
    const currentTimeline = timelineRef.current;
    if (!currentTimeline) return;

    const clamped = Math.max(0, Math.min(frame, currentTimeline.settings.durationInFrames));

    if (isPreviewPlaying) {
      previewPlaybackAnchorRef.current = {
        startedAt: performance.now(),
        startFrame: clamped,
      };
    }

    playheadFrameRef.current = clamped;
    setPlayheadFrame(clamped);

    const nextTimeline = setMoviePlayheadFrame(currentTimeline, clamped);
    commitTimeline(nextTimeline);
  }, [commitTimeline, isPreviewPlaying]);

  const refreshTimelineFromDisk = useCallback(async () => {
    const activeProject = projectRef.current;
    if (!activeProject) return;

    try {
      const source = await readFile(activeProject.timelinePath);
      if (source.content === lastSavedTimelineSourceRef.current) {
        return;
      }

      const nextTimeline = parseMovieTimelineModule(source.content);
      if (disposedRef.current) return;

      lastSavedTimelineSourceRef.current = source.content;
      timelineRef.current = nextTimeline;
      playheadFrameRef.current = nextTimeline.playheadFrame;
      setIsPreviewPlaying(false);
      setTimeline(nextTimeline);
      setPlayheadFrame(nextTimeline.playheadFrame);
      await hydrateTimelineAssets(activeProject, nextTimeline);
    } catch (error: any) {
      if (!disposedRef.current) {
        setProjectError(error?.message || 'Failed to refresh movie timeline');
      }
    }
  }, [hydrateTimelineAssets]);

  const refreshAssetPresentation = useCallback(async () => {
    const activeProject = projectRef.current;
    const currentTimeline = timelineRef.current;
    if (!activeProject || !currentTimeline) return;
    await hydrateTimelineAssets(activeProject, currentTimeline);
  }, [hydrateTimelineAssets]);

  const persistAssetMetadata = useCallback(async (
    activeProject: ResolvedMovieProject,
    asset: MovieAsset,
    metadata: MovieAssetMetadata,
  ) => {
    const metadataAbsolutePath = resolveProjectFilePath(activeProject, asset.metadataPath);
    await writeFile(metadataAbsolutePath, `${JSON.stringify(metadata, null, 2)}\n`);
  }, []);

  const ingestMediaPaths = useCallback(async (
    sourcePaths: string[],
    options: {
      sourceMode: MovieAsset['sourceMode'];
      placement: 'sequence' | 'parallel';
      startFrame: number;
      successMessage?: string;
    },
  ) => {
    const activeProject = projectRef.current;
    const currentTimeline = timelineRef.current;
    if (!activeProject || !currentTimeline) {
      return;
    }

    const normalizedSourcePaths = normalizeDroppedPaths(sourcePaths).filter((candidate) => classifyMovieAssetKind(candidate) !== null);
    if (normalizedSourcePaths.length === 0) {
      return;
    }

    let nextTimeline = currentTimeline;
    let insertionFrame = options.startFrame;
    const createdClipIds: string[] = [];

    for (const absolutePath of normalizedSourcePaths) {
      const existingAsset = findExistingMovieAsset(
        nextTimeline,
        activeProject.projectDir,
        absolutePath,
      );

      const asset = existingAsset ?? (await (async () => {
        const analysis = await analyzeMovieAssetFile({
          absoluteFilePath: absolutePath,
          projectDir: activeProject.projectDir,
          metadataDir: activeProject.metadataDir,
          fps: nextTimeline.settings.fps,
          sourceMode: options.sourceMode,
        });
        await persistAssetMetadata(activeProject, analysis.asset, analysis.metadata);
        return analysis.asset;
      })());

      if (!existingAsset) {
        nextTimeline = updateMovieAssetEntry(nextTimeline, asset);
      }

      const inserted = insertMovieAssetAtPlayhead(
        nextTimeline,
        asset,
        options.placement === 'parallel' ? options.startFrame : insertionFrame,
      );

      nextTimeline = inserted.timeline;
      createdClipIds.push(...inserted.createdClipIds);

      if (options.placement === 'sequence') {
        insertionFrame += asset.durationInFrames;
      }
    }

    commitTimeline(nextTimeline, {
      immediatePersist: true,
      selectedClipId: createdClipIds[0] ?? null,
    });
    await hydrateTimelineAssets(activeProject, nextTimeline);

    if (options.successMessage) {
      showToast(options.successMessage, 'success', 3200);
    }
  }, [commitTimeline, hydrateTimelineAssets, persistAssetMetadata, showToast]);

  const refreshSources = useCallback(async () => {
    setIsRefreshingSources(true);
    setCaptureError(null);

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const nextVideoSources: VideoSourceOption[] = [];
      const nextAudioSources: AudioSourceOption[] = [];
      let cameraIndex = 1;
      let audioIndex = 1;

      for (const device of devices) {
        if (device.kind === 'videoinput') {
          nextVideoSources.push({
            key: `camera:${device.deviceId}`,
            kind: 'camera',
            label: device.label?.trim() || `Camera ${cameraIndex}`,
            cameraDeviceId: device.deviceId,
          });
          cameraIndex += 1;
        } else if (device.kind === 'audioinput') {
          nextAudioSources.push({
            key: `audio:${device.deviceId}`,
            label: device.label?.trim() || `Audio ${audioIndex}`,
            deviceId: device.deviceId,
          });
          audioIndex += 1;
        }
      }

      const screenResult = await desktopSources.list({
        types: ['screen'],
        thumbnailSize: { width: 640, height: 360 },
      });

      nextVideoSources.push(...screenResult.sources.map((source: DesktopSourceDescriptor, index) => ({
        key: `screen:${source.id}`,
        kind: 'screen' as const,
        label: source.name?.trim() || `Screen ${index + 1}`,
        desktopSourceId: source.id,
        thumbnailDataUrl: source.thumbnailDataUrl,
      })));

      for (const input of videoInputsRef.current) {
        if (input.connectedSourceKey && !nextVideoSources.some((source) => source.key === input.connectedSourceKey)) {
          stopStream(input.stream);
        }
      }

      if (
        connectedAudioSourceKeyRef.current
        && !nextAudioSources.some((source) => source.key === connectedAudioSourceKeyRef.current)
      ) {
        stopStream(audioStreamRef.current);
        setAudioStream(null);
        setConnectedAudioSourceKey(null);
      }

      setVideoSources(nextVideoSources);
      setAudioSources(nextAudioSources);
      setVideoInputs((current) => {
        const fallbackSourceKey = nextVideoSources[0]?.key ?? null;
        const nextInputs = current.length > 0 ? current : [createVideoInput(fallbackSourceKey)];
        return nextInputs.map((input, index) => {
          const selectedSourceKey = input.selectedSourceKey && nextVideoSources.some((source) => source.key === input.selectedSourceKey)
            ? input.selectedSourceKey
            : nextVideoSources[index]?.key ?? fallbackSourceKey;
          const keepConnection = Boolean(
            input.connectedSourceKey
            && nextVideoSources.some((source) => source.key === input.connectedSourceKey),
          );

          return {
            ...input,
            selectedSourceKey,
            connectedSourceKey: keepConnection ? input.connectedSourceKey : null,
            stream: keepConnection ? input.stream : null,
            isConnecting: false,
          };
        });
      });
      setSelectedAudioSourceKey((current) => (
        current && nextAudioSources.some((source) => source.key === current)
          ? current
          : nextAudioSources[0]?.key ?? null
      ));
    } catch (error: any) {
      const message = error?.message || 'Failed to refresh capture sources';
      if (!disposedRef.current) {
        setCaptureError(message);
      }
      showToast(message, 'error', 4200);
    } finally {
      if (!disposedRef.current) {
        setIsRefreshingSources(false);
      }
    }
  }, [showToast]);

  const disconnectVideoInput = useCallback((inputId: string) => {
    videoConnectTokensRef.current[inputId] = (videoConnectTokensRef.current[inputId] ?? 0) + 1;
    const previousStream = videoInputsRef.current.find((input) => input.id === inputId)?.stream ?? null;
    stopStream(previousStream);
    setVideoInputs((current) => current.map((input) => (
      input.id === inputId
        ? { ...input, stream: null, connectedSourceKey: null, isConnecting: false }
        : input
    )));
  }, []);

  const connectVideoInput = useCallback(async (inputId: string) => {
    const input = videoInputsRef.current.find((candidate) => candidate.id === inputId);
    const selectedSource = videoSourcesRef.current.find((candidate) => candidate.key === input?.selectedSourceKey);
    if (!input || !selectedSource) {
      return;
    }

    const token = (videoConnectTokensRef.current[inputId] ?? 0) + 1;
    videoConnectTokensRef.current[inputId] = token;
    setCaptureError(null);
    setVideoInputs((current) => current.map((candidate) => (
      candidate.id === inputId ? { ...candidate, isConnecting: true } : candidate
    )));

    try {
      let stream: MediaStream;

      if (selectedSource.kind === 'camera') {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            deviceId: { exact: selectedSource.cameraDeviceId! },
          },
        });
      } else {
        const desktopConstraints = {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: selectedSource.desktopSourceId!,
            maxFrameRate: 30,
          },
        } as unknown as MediaTrackConstraints;

        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: desktopConstraints,
        });
      }

      if (disposedRef.current || videoConnectTokensRef.current[inputId] !== token) {
        stopStream(stream);
        return;
      }

      const previousStream = videoInputsRef.current.find((candidate) => candidate.id === inputId)?.stream ?? null;
      stopStream(previousStream);

      for (const track of stream.getTracks()) {
        track.onended = () => {
          if (disposedRef.current) return;
          disconnectVideoInput(inputId);
        };
      }

      setVideoInputs((current) => current.map((candidate) => (
        candidate.id === inputId
          ? {
            ...candidate,
            stream,
            connectedSourceKey: selectedSource.key,
            isConnecting: false,
          }
          : candidate
      )));
    } catch (error: any) {
      if (disposedRef.current || videoConnectTokensRef.current[inputId] !== token) {
        return;
      }

      const message = error?.message || `Failed to connect ${selectedSource.label}`;
      setVideoInputs((current) => current.map((candidate) => (
        candidate.id === inputId
          ? { ...candidate, stream: null, connectedSourceKey: null, isConnecting: false }
          : candidate
      )));
      setCaptureError(message);
      showToast(message, 'error', 4200);
    }
  }, [disconnectVideoInput, showToast]);

  const disconnectAudioInput = useCallback(() => {
    audioConnectTokenRef.current += 1;
    stopStream(audioStreamRef.current);
    setAudioStream(null);
    setConnectedAudioSourceKey(null);
    setIsConnectingAudio(false);
  }, []);

  const connectAudioInput = useCallback(async () => {
    const selectedSource = audioSourcesRef.current.find((candidate) => candidate.key === selectedAudioSourceKey);
    if (!selectedSource) {
      return;
    }

    const token = audioConnectTokenRef.current + 1;
    audioConnectTokenRef.current = token;
    setCaptureError(null);
    setIsConnectingAudio(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          deviceId: { exact: selectedSource.deviceId },
        },
      });

      if (disposedRef.current || audioConnectTokenRef.current !== token) {
        stopStream(stream);
        return;
      }

      stopStream(audioStreamRef.current);
      for (const track of stream.getTracks()) {
        track.onended = () => {
          if (disposedRef.current) return;
          disconnectAudioInput();
        };
      }

      setAudioStream(stream);
      setConnectedAudioSourceKey(selectedSource.key);
      setIsConnectingAudio(false);
    } catch (error: any) {
      if (disposedRef.current || audioConnectTokenRef.current !== token) {
        return;
      }

      const message = error?.message || `Failed to connect ${selectedSource.label}`;
      setIsConnectingAudio(false);
      setAudioStream(null);
      setConnectedAudioSourceKey(null);
      setCaptureError(message);
      showToast(message, 'error', 4200);
    }
  }, [disconnectAudioInput, selectedAudioSourceKey, showToast]);

  const startRecording = useCallback(async () => {
    if (isRecording || isStoppingRecording) {
      return;
    }

    const activeProject = projectRef.current;
    if (!activeProject) {
      showToast('Movie project is not loaded yet.', 'error', 3600);
      return;
    }

    const liveInputs = videoInputsRef.current.filter((input) => input.stream && input.connectedSourceKey);
    if (liveInputs.length === 0) {
      showToast('Preview at least one video source before recording.', 'error', 4200);
      return;
    }

    const mimeType = chooseMp4MimeType();
    if (!mimeType) {
      showToast('This machine does not support MP4 recording through MediaRecorder.', 'error', 5200);
      return;
    }

    const stem = createCaptureStem();
    const session: ActiveRecordingSession = {
      startedAt: Date.now(),
      startFrame: playheadFrameRef.current,
      stem,
      videoRecordings: [],
      audioCapture: null,
      audioOutputPath: null,
    };

    try {
      liveInputs.forEach((input, index) => {
        const source = videoSourcesRef.current.find((candidate) => candidate.key === input.connectedSourceKey);
        const suffix = source?.kind === 'screen' ? 'screen' : 'camera';
        const outputPath = pathJoin(activeProject.assetsDir, `${stem}-${suffix}-${index + 1}.mp4`);
        const chunks: BlobPart[] = [];
        const recorder = new MediaRecorder(input.stream!, { mimeType });
        const stopPromise = new Promise<{ path: string }>((resolve, reject) => {
          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
              chunks.push(event.data);
            }
          };
          recorder.onerror = (event: Event & { error?: DOMException }) => {
            reject(new Error(event.error?.message || 'Video recording failed'));
          };
          recorder.onstop = async () => {
            try {
              const blob = new Blob(chunks, { type: mimeType });
              const buffer = await blob.arrayBuffer();
              await filesIpc.writeBinary(outputPath, buffer);
              resolve({ path: outputPath });
            } catch (error) {
              reject(error as Error);
            }
          };
        });

        recorder.start();
        session.videoRecordings.push({
          inputId: input.id,
          recorder,
          outputPath,
          stopPromise,
        });
      });

      if (audioStreamRef.current && connectedAudioSourceKeyRef.current) {
        session.audioCapture = await startWavCapture(audioStreamRef.current);
        session.audioOutputPath = pathJoin(activeProject.assetsDir, `${stem}-audio.wav`);
      }

      recordingSessionRef.current = session;
      setCaptureError(null);
      setRecordingElapsedMs(0);
      setIsRecording(true);
    } catch (error: any) {
      for (const recording of session.videoRecordings) {
        if (recording.recorder.state !== 'inactive') {
          recording.recorder.stop();
        }
      }
      if (session.audioCapture) {
        await session.audioCapture.abort().catch(() => {});
      }
      recordingSessionRef.current = null;
      setIsRecording(false);
      const message = error?.message || 'Failed to start recording';
      setCaptureError(message);
      showToast(message, 'error', 4200);
    }
  }, [isRecording, isStoppingRecording, showToast]);

  const stopRecording = useCallback(async () => {
    const session = recordingSessionRef.current;
    if (!session || isStoppingRecording) {
      return;
    }

    setIsStoppingRecording(true);

    try {
      for (const recording of session.videoRecordings) {
        if (recording.recorder.state !== 'inactive') {
          recording.recorder.stop();
        }
      }

      const videoResultsPromise = Promise.all(session.videoRecordings.map((recording) => recording.stopPromise));
      const audioResultPromise = (async () => {
        if (!session.audioCapture || !session.audioOutputPath) {
          return null;
        }

        const buffer = await session.audioCapture.stop();
        await filesIpc.writeBinary(session.audioOutputPath, buffer);
        return { path: session.audioOutputPath };
      })();

      const [videoResults, audioResult] = await Promise.all([videoResultsPromise, audioResultPromise]);
      const recordedPaths = [...videoResults.map((result) => result.path), ...(audioResult ? [audioResult.path] : [])];

      await ingestMediaPaths(recordedPaths, {
        sourceMode: 'managed',
        placement: 'parallel',
        startFrame: session.startFrame,
        successMessage: audioResult
          ? `Saved ${videoResults.length} MP4 file${videoResults.length === 1 ? '' : 's'} and 1 audio file at the playhead.`
          : `Saved ${videoResults.length} MP4 file${videoResults.length === 1 ? '' : 's'} at the playhead.`,
      });
    } catch (error: any) {
      const message = error?.message || 'Failed to save recording';
      if (!disposedRef.current) {
        setCaptureError(message);
      }
      showToast(message, 'error', 4200);
    } finally {
      recordingSessionRef.current = null;
      if (!disposedRef.current) {
        setIsRecording(false);
        setIsStoppingRecording(false);
        setRecordingElapsedMs(0);
      }
    }
  }, [ingestMediaPaths, isStoppingRecording, showToast]);

  const togglePreviewPlayback = useCallback(() => {
    const currentTimeline = timelineRef.current;
    if (!currentTimeline) return;

    if (isPreviewPlaying) {
      setIsPreviewPlaying(false);
      const pausedTimeline = setMoviePlayheadFrame(currentTimeline, playheadFrameRef.current);
      commitTimeline(pausedTimeline);
      return;
    }

    const startingFrame = playheadFrameRef.current >= currentTimeline.settings.durationInFrames
      ? 0
      : playheadFrameRef.current;
    playheadFrameRef.current = startingFrame;
    setPlayheadFrame(startingFrame);
    previewPlaybackAnchorRef.current = {
      startedAt: performance.now(),
      startFrame: startingFrame,
    };
    setIsPreviewPlaying(true);
  }, [commitTimeline, isPreviewPlaying]);

  const handleExport = useCallback(async () => {
    if (!projectRef.current || exportState.isRunning) {
      return;
    }

    const activeProject = projectRef.current;
    const suggestedOutputPath = buildSuggestedMovieExportPath(activeProject);
    const saveResult = await savePathDialog({
      title: 'Export movie',
      buttonLabel: 'Export MP4',
      defaultPath: suggestedOutputPath,
      filters: [
        {
          name: 'MP4 Video',
          extensions: ['mp4'],
        },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return;
    }

    const exportId = createStableId('movie-export');
    setExportState({
      exportId,
      isRunning: true,
      isCancelling: false,
      message: `Preparing export to ${pathBasename(saveResult.filePath)}`,
      progress: null,
      outputPath: saveResult.filePath,
    });

    await flushTimelinePersistence();

    const result = await movieIpc.exportProject({
      exportId,
      manifestPath: activeProject.manifestPath,
      outputPath: saveResult.filePath,
    });

    if (result.cancelled) {
      setExportState({
        exportId: null,
        isRunning: false,
        isCancelling: false,
        message: 'Export cancelled',
        progress: null,
        outputPath: saveResult.filePath,
      });
      showToast('Movie export cancelled', 'info', 3200);
      return;
    }

    if (!result.success || !result.outputPath) {
      const message = result.error || 'Failed to export movie';
      setExportState({
        exportId: null,
        isRunning: false,
        isCancelling: false,
        message,
        progress: null,
        outputPath: saveResult.filePath,
      });
      showToast(message, 'error', 5200);
      return;
    }

    setExportState({
      exportId: null,
      isRunning: false,
      isCancelling: false,
      message: 'Export complete',
      progress: 100,
      outputPath: result.outputPath,
    });
    showToast(`Exported MP4 to ${pathBasename(result.outputPath)}`, 'success', 4200);
  }, [exportState.isRunning, flushTimelinePersistence, showToast]);

  const handleCancelExport = useCallback(async () => {
    if (!exportState.isRunning || !exportState.exportId || exportState.isCancelling) {
      return;
    }

    setExportState((current) => ({
      ...current,
      isCancelling: true,
      message: 'Stopping export…',
    }));

    const result = await movieIpc.cancelExport({
      exportId: exportState.exportId,
    });

    if (!result.success) {
      const message = result.error || 'Failed to stop export';
      setExportState((current) => ({
        ...current,
        isCancelling: false,
        message,
      }));
      showToast(message, 'error', 4200);
    }
  }, [exportState.exportId, exportState.isCancelling, exportState.isRunning, showToast]);

  useEffect(() => {
    void loadProject();
  }, [filePath, refreshKey, loadProject]);

  useEffect(() => {
    void refreshSources();

    const handleDeviceChange = () => {
      void refreshSources();
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [refreshSources]);

  useEffect(() => {
    if (!timeline) {
      setSelectedClipId(null);
      return;
    }

    const allClips = timeline.tracks.flatMap((track) => track.clips);
    if (selectedClipId && allClips.some((clip) => clip.id === selectedClipId)) {
      return;
    }

    setSelectedClipId(allClips[0]?.id ?? null);
  }, [timeline, selectedClipId]);

  useEffect(() => {
    if (!selectedClip) {
      setMetadataDraft('{}');
      setMetadataError(null);
      return;
    }

    setMetadataDraft(JSON.stringify(selectedClip.metadata ?? {}, null, 2));
    setMetadataError(null);
  }, [selectedClip?.id]);

  useEffect(() => {
    if (!timeline || !isPreviewPlaying) {
      if (previewPlaybackFrameRef.current !== null) {
        window.cancelAnimationFrame(previewPlaybackFrameRef.current);
        previewPlaybackFrameRef.current = null;
      }
      previewPlaybackAnchorRef.current = null;
      return;
    }

    if (!previewPlaybackAnchorRef.current) {
      previewPlaybackAnchorRef.current = {
        startedAt: performance.now(),
        startFrame: playheadFrameRef.current,
      };
    }

    const durationInFrames = timeline.settings.durationInFrames;
    const fps = timeline.settings.fps;

    const step = () => {
      const anchor = previewPlaybackAnchorRef.current;
      if (!anchor || disposedRef.current) {
        return;
      }

      const elapsedMs = performance.now() - anchor.startedAt;
      const nextFrame = Math.min(
        durationInFrames,
        anchor.startFrame + Math.floor((elapsedMs * fps) / 1000),
      );

      if (nextFrame !== playheadFrameRef.current) {
        playheadFrameRef.current = nextFrame;
        setPlayheadFrame(nextFrame);
      }

      if (nextFrame >= durationInFrames) {
        setIsPreviewPlaying(false);
        const currentTimeline = timelineRef.current;
        if (currentTimeline) {
          const completedTimeline = setMoviePlayheadFrame(currentTimeline, durationInFrames);
          commitTimeline(completedTimeline);
        }
        return;
      }

      previewPlaybackFrameRef.current = window.requestAnimationFrame(step);
    };

    previewPlaybackFrameRef.current = window.requestAnimationFrame(step);

    return () => {
      if (previewPlaybackFrameRef.current !== null) {
        window.cancelAnimationFrame(previewPlaybackFrameRef.current);
        previewPlaybackFrameRef.current = null;
      }
    };
  }, [commitTimeline, isPreviewPlaying, timeline]);

  useEffect(() => {
    const unsubscribe = movieIpc.onExportProgress((event: MovieExportProgressEvent) => {
      setExportState((current) => {
        if (
          !projectRef.current
          || !pathsMatch(event.manifestPath, projectRef.current.manifestPath)
          || !current.exportId
          || current.exportId !== event.exportId
        ) {
          return current;
        }

        return {
          ...current,
          isRunning: !(event.stage === 'complete' || event.stage === 'cancelled' || event.stage === 'error'),
          isCancelling: current.isCancelling && event.stage !== 'cancelled',
          message: event.message,
          progress: event.progress,
        };
      });
    });

    return unsubscribe;
  }, []);

  useFileRefresh(filePath, () => {
    void loadProject();
  });

  useEffect(() => {
    if (!project) {
      return;
    }

    const handleRefreshEvent = async (changedPath: string) => {
      if (pathsMatch(changedPath, project.timelinePath)) {
        await refreshTimelineFromDisk();
        return;
      }
      if (pathsMatch(changedPath, project.componentsPath) || pathsMatch(changedPath, project.runtimePath)) {
        await loadReactComponents(project);
        return;
      }
      if (
        pathStartsWith(changedPath, project.metadataDir)
        || (timelineRef.current?.assets.some((asset) => pathsMatch(getMovieAssetAbsolutePath(asset, project.projectDir), changedPath)) ?? false)
      ) {
        await refreshAssetPresentation();
      }
    };

    const unsubscribeWorkspace = workspace.onFilesChanged((event: WorkspaceFilesChangedEvent) => {
      if (!event.path) return;
      void handleRefreshEvent(event.path);
    });

    const unsubscribeFiles = filesIpc.onRefreshed((event: { filePath: string }) => {
      void handleRefreshEvent(event.filePath);
    });

    return () => {
      unsubscribeWorkspace();
      unsubscribeFiles();
    };
  }, [project, loadReactComponents, refreshAssetPresentation, refreshTimelineFromDisk]);

  useEffect(() => {
    if (!isRecording) {
      if (recordingTimerRef.current !== null) {
        window.clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      return;
    }

    const startedAt = recordingSessionRef.current?.startedAt ?? Date.now();
    setRecordingElapsedMs(Date.now() - startedAt);
    recordingTimerRef.current = window.setInterval(() => {
      setRecordingElapsedMs(Date.now() - startedAt);
    }, 250);

    return () => {
      if (recordingTimerRef.current !== null) {
        window.clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    };
  }, [isRecording]);

  useEffect(() => {
    return () => {
      disposedRef.current = true;
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
      if (previewPlaybackFrameRef.current !== null) {
        window.cancelAnimationFrame(previewPlaybackFrameRef.current);
      }
      if (recordingTimerRef.current !== null) {
        window.clearInterval(recordingTimerRef.current);
      }
      for (const input of videoInputsRef.current) {
        stopStream(input.stream);
      }
      stopStream(audioStreamRef.current);
      if (recordingSessionRef.current?.audioCapture) {
        void recordingSessionRef.current.audioCapture.abort().catch(() => {});
      }
    };
  }, []);

  const applyClipTimingPatch = useCallback((clipId: string, patch: {
    startFrame?: number;
    sourceStartFrame?: number;
    sourceEndFrame?: number;
    trackId?: string;
  }, options?: {
    baseTimeline?: MovieTimelineDefinition;
  }) => {
    const currentTimeline = options?.baseTimeline ?? timelineRef.current;
    if (!currentTimeline) return;
    const nextTimeline = updateMovieClipTiming(currentTimeline, clipId, patch);
    commitTimeline(nextTimeline, { selectedClipId: clipId });
  }, [commitTimeline]);

  const applyMetadataDraft = useCallback(() => {
    const currentTimeline = timelineRef.current;
    const currentClip = getMovieClipById(currentTimeline, selectedClipId);
    if (!currentTimeline || !currentClip) {
      return;
    }

    try {
      const parsed = JSON.parse(metadataDraft) as Record<string, unknown>;
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('Metadata must be a JSON object');
      }

      const nextTimeline = updateMovieClipMetadata(currentTimeline, currentClip.id, parsed as MovieJsonObject);
      setMetadataError(null);
      commitTimeline(nextTimeline, { selectedClipId: currentClip.id });
    } catch (error: any) {
      setMetadataError(error?.message || 'Invalid metadata JSON');
    }
  }, [commitTimeline, metadataDraft, selectedClipId]);

  const handleUnlinkAudio = useCallback(() => {
    const currentTimeline = timelineRef.current;
    const currentClip = getMovieClipById(currentTimeline, selectedClipId);
    if (!currentTimeline || !currentClip) return;
    const nextTimeline = unlinkMovieClipAudio(currentTimeline, currentClip.id);
    commitTimeline(nextTimeline, { immediatePersist: true, selectedClipId: currentClip.id });
  }, [commitTimeline, selectedClipId]);

  const handleDeleteSelectedClip = useCallback(() => {
    const currentTimeline = timelineRef.current;
    const currentClip = getMovieClipById(currentTimeline, selectedClipId);
    if (!currentTimeline || !currentClip) {
      return;
    }

    const nextTimeline = removeMovieClip(currentTimeline, currentClip.id);
    commitTimeline(nextTimeline, { immediatePersist: true, selectedClipId: null });
  }, [commitTimeline, selectedClipId]);

  const handleClipContextMenu = useCallback(async (
    _event: React.MouseEvent<HTMLDivElement>,
    clip: MovieClip,
  ) => {
    const activeProject = projectRef.current;
    const currentTimeline = timelineRef.current;
    const asset = getMovieAssetForClip(currentTimeline, clip);
    if (!activeProject || !asset) {
      return;
    }

    const assetPath = getMovieAssetAbsolutePath(asset, activeProject.projectDir);
    const workspaceResult = await workspace.get();
    const currentWorkspacePath = workspaceResult.workspace;
    const canRevealInExplorer = Boolean(
      currentWorkspacePath
      && pathStartsWith(assetPath, currentWorkspacePath),
    );
    const items: ContextMenuItem[] = [
      { label: 'Reveal in Explorer', action: 'reveal-in-explorer', disabled: !canRevealInExplorer },
    ];
    if (canUseHostNativeFileManager()) {
      items.push({ label: 'Reveal in Finder', action: 'reveal-in-finder' });
    }

    const action = await showContextMenu(items, 'movie_viewer');
    if (action === 'reveal-in-explorer' && canRevealInExplorer) {
      setLeftSidebarTab('explorer');
      setLeftSidebarOpen(true);
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('reveal-in-explorer', {
          detail: { path: assetPath },
        }));
      }, 60);
      return;
    }
    if (action === 'reveal-in-finder') {
      await showItemInFolder(assetPath);
    }
  }, [setLeftSidebarOpen, setLeftSidebarTab]);

  const updateStyleNumber = useCallback((
    key: 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity' | 'blur' | 'zIndex',
    rawValue: string,
  ) => {
    const currentTimeline = timelineRef.current;
    const currentClip = getMovieClipById(currentTimeline, selectedClipId);
    if (!currentTimeline || !currentClip || (currentClip.kind !== 'video' && currentClip.kind !== 'react')) {
      return;
    }

    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) {
      return;
    }

    const nextTimeline = updateMovieClipStyle(currentTimeline, currentClip.id, {
      [key]: key === 'opacity'
        ? Math.max(0, Math.min(1, numericValue))
        : numericValue,
    });
    commitTimeline(nextTimeline, { selectedClipId: currentClip.id });
  }, [commitTimeline, selectedClipId]);

  const updateCropNumber = useCallback((
    key: 'left' | 'top' | 'right' | 'bottom',
    rawValue: string,
  ) => {
    const currentTimeline = timelineRef.current;
    const currentClip = getMovieClipById(currentTimeline, selectedClipId);
    if (!currentTimeline || !currentClip || currentClip.kind !== 'video') {
      return;
    }

    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) {
      return;
    }

    const nextTimeline = updateMovieClipStyle(currentTimeline, currentClip.id, {
      crop: {
        ...currentClip.style.crop,
        [key]: numericValue,
      },
    });
    commitTimeline(nextTimeline, { selectedClipId: currentClip.id });
  }, [commitTimeline, selectedClipId]);

  const updateAudioVolume = useCallback((rawValue: string) => {
    const currentTimeline = timelineRef.current;
    const currentClip = getMovieClipById(currentTimeline, selectedClipId);
    if (!currentTimeline || !currentClip || currentClip.kind !== 'audio') {
      return;
    }

    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) {
      return;
    }

    const nextTimeline: MovieTimelineDefinition = {
      ...currentTimeline,
      tracks: currentTimeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => (
          clip.id === currentClip.id && clip.kind === 'audio'
            ? { ...clip, volume: Math.max(0, Math.min(2, numericValue)) }
            : clip
        )),
      })),
    };
    commitTimeline(nextTimeline, { selectedClipId: currentClip.id });
  }, [commitTimeline, selectedClipId]);

  const handlePreviewResizeStart = useCallback((event: React.MouseEvent) => {
    setHasUserResizedPreview(true);
    handlePreviewResizeMouseDown(event);
  }, [handlePreviewResizeMouseDown]);

  const handleUtilityResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setHasUserResizedUtility(true);
    utilityResizeStateRef.current = {
      startX: event.clientX,
      startWidth: resolvedUtilityPanelWidth,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [resolvedUtilityPanelWidth]);
  const handleMovieKeyboardShortcut = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (isKeyboardEditableTarget(event.target)) {
      return;
    }

    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      togglePreviewPlayback();
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setManualPlayhead(playheadFrameRef.current - (event.shiftKey ? transportStepFrames : 1));
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setManualPlayhead(playheadFrameRef.current + (event.shiftKey ? transportStepFrames : 1));
      return;
    }

    if ((event.key === 'Backspace' || event.key === 'Delete') && selectedClipId) {
      event.preventDefault();
      handleDeleteSelectedClip();
    }
  }, [handleDeleteSelectedClip, selectedClipId, setManualPlayhead, togglePreviewPlayback, transportStepFrames]);

  if (!timeline) {
    return (
      <EditorShell>
        <EditorContentSurface scroll={false}>
          <div
            id={MOVIE_VIEWER_ID}
            data-testid={MOVIE_VIEWER_ID}
            className="flex h-full items-center justify-center px-8 text-center"
          >
            <div>
              <div className="text-ui-base font-medium text-white/88">
                {isProjectLoading ? 'Loading movie project...' : 'Movie project unavailable'}
              </div>
              {projectError ? (
                <div className="mt-2 text-ui-sm text-white/54">{projectError}</div>
              ) : null}
            </div>
          </div>
        </EditorContentSurface>
      </EditorShell>
    );
  }

  const jumpToStart = () => {
    setManualPlayhead(0);
  };
  const jumpBackward = () => {
    setManualPlayhead(playheadFrameRef.current - transportStepFrames);
  };
  const jumpForward = () => {
    setManualPlayhead(playheadFrameRef.current + transportStepFrames);
  };
  const jumpToEnd = () => {
    setManualPlayhead(timeline.settings.durationInFrames);
  };

  return (
    <EditorShell>
      <EditorToolbar justify="between" className="gap-3 px-4 py-2 text-ui-xs" style={{ minHeight: 'var(--unit-height)' }}>
        <div className="min-w-0">
          <span className="block truncate text-ui-sm font-medium text-[var(--oa-text-strong)]">{movieFilename}</span>
        </div>

        <Button
          id={MOVIE_EXPORT_BUTTON_ID}
          data-testid={MOVIE_EXPORT_BUTTON_ID}
          variant={exportState.isRunning ? 'destructive' : 'outline'}
          size="sm"
          onClick={() => void (exportState.isRunning ? handleCancelExport() : handleExport())}
          disabled={exportState.isCancelling}
        >
          {exportState.isRunning
            ? <Square className="size-4" />
            : <Upload className="size-4" />}
          <span>
            {exportState.isRunning
              ? (exportState.isCancelling ? 'Stopping Export…' : 'Stop Export')
              : 'Export MP4'}
          </span>
        </Button>
      </EditorToolbar>

      <EditorContentSurface scroll={false} className="min-h-0">
        <div ref={layoutViewportRef} className="h-full min-h-0">
          <div
            ref={movieViewerRef}
            id={MOVIE_VIEWER_ID}
            data-testid={MOVIE_VIEWER_ID}
            className="relative h-full min-h-0 overflow-hidden p-3 outline-none"
            tabIndex={0}
            onKeyDown={handleMovieKeyboardShortcut}
            onPointerDownCapture={(event) => {
              if (isKeyboardEditableTarget(event.target)) {
                return;
              }

              movieViewerRef.current?.focus({ preventScroll: true });
            }}
            onDragEnter={(event) => {
              if (extractDroppedMediaPaths(event).length > 0) {
                setDropActive(true);
              }
            }}
            onDragOver={(event) => {
              const droppedPaths = extractDroppedMediaPaths(event);
              if (droppedPaths.length === 0) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'link';
              setDropActive(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                return;
              }
              setDropActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDropActive(false);
              const droppedPaths = extractDroppedMediaPaths(event);
              if (droppedPaths.length === 0) {
                return;
              }
              void ingestMediaPaths(droppedPaths, {
                sourceMode: 'reference',
                placement: 'sequence',
                startFrame: playheadFrameRef.current,
                successMessage: `Referenced ${droppedPaths.length} dragged media file${droppedPaths.length === 1 ? '' : 's'} at the playhead.`,
              }).catch((error: any) => {
                showToast(error?.message || 'Failed to add dropped files', 'error', 4200);
              });
            }}
          >
            <div
              className="grid h-full min-h-0 min-w-0 gap-0 overflow-hidden"
              style={{ gridTemplateColumns: `minmax(0, 1fr) ${resolvedUtilityPanelWidth}px` }}
            >
            <div
              data-testid="movie-main-column"
              className="flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden pr-5"
            >
              {(projectError || captureError || componentPreviewError) ? (
                <div className="flex flex-col gap-2">
                  {[projectError, captureError, componentPreviewError].filter(Boolean).map((message) => (
                    <div
                      key={message}
                      className="rounded-[10px] px-3 py-2 text-ui-sm text-[var(--oa-danger)]"
                      style={{
                        background: 'var(--oa-danger-soft)',
                        border: 'var(--border-width) solid var(--oa-danger-border)',
                      }}
                    >
                      {message}
                    </div>
                  ))}
                </div>
              ) : null}

              <section
                className="flex min-h-0 shrink-0 flex-col rounded-[14px] p-3"
                style={{
                  border: 'var(--border-width) solid var(--oa-border)',
                  background: 'var(--oa-bg-subtle)',
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={jumpToStart}>
                      <ChevronsLeft className="size-4" />
                      <span>Start</span>
                    </Button>
                    <Button variant="outline" size="sm" onClick={jumpBackward}>
                      <SkipBack className="size-4" />
                      <span>-1s</span>
                    </Button>
                    <Button
                      id={MOVIE_PLAY_BUTTON_ID}
                      data-testid={MOVIE_PLAY_BUTTON_ID}
                      variant="default"
                      size="sm"
                      onClick={togglePreviewPlayback}
                    >
                      {isPreviewPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
                      <span>{isPreviewPlaying ? 'Pause' : 'Play'}</span>
                    </Button>
                    <Button variant="outline" size="sm" onClick={jumpForward}>
                      <SkipForward className="size-4" />
                      <span>+1s</span>
                    </Button>
                    <Button variant="outline" size="sm" onClick={jumpToEnd}>
                      <ChevronsRight className="size-4" />
                      <span>End</span>
                    </Button>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-[var(--oa-text-muted)]">
                    <span>{formatFrameTime(playheadFrame, timeline.settings.fps)}</span>
                    <span>{playheadFrame}f / {projectDurationLabel}</span>
                  </div>
                </div>

                <div
                  data-testid="movie-preview-panel"
                  className="mt-3 flex items-center justify-center overflow-hidden rounded-[12px] bg-black"
                  style={{ height: resolvedPreviewPanelHeight }}
                >
                  <MoviePreview
                    timeline={timeline}
                    frame={playheadFrame}
                    isPlaying={isPreviewPlaying}
                    assetUrls={assetUrls}
                    reactComponents={reactComponents}
                    stageComponent={previewStageComponent}
                    className="w-full rounded-[12px]"
                    style={{ maxWidth: previewMaxWidth }}
                  />
                </div>

                <div className="mt-3" style={{ borderTop: 'var(--border-width) solid var(--oa-border)' }}>
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-2 pt-3 text-ui-xs text-[var(--oa-text-muted)]">
                    <span>Playhead</span>
                    <span>{formatFrameTime(playheadFrame, timeline.settings.fps)}</span>
                  </div>
                  <Slider
                    value={[playheadFrame]}
                    max={timeline.settings.durationInFrames}
                    min={0}
                    step={1}
                    onValueChange={(values) => {
                      const nextValue = values[0] ?? 0;
                      setManualPlayhead(nextValue);
                    }}
                  />
                </div>
              </section>

              <ResizeHandle
                onMouseDown={handlePreviewResizeStart}
                orientation="horizontal"
                showBorder
                className="items-center bg-transparent"
                style={{ height: 12 }}
              />

              <section
                data-testid="movie-timeline-panel"
                className="min-h-0 flex-1 overflow-hidden rounded-[14px]"
                style={{
                  minHeight: 220,
                  border: 'var(--border-width) solid var(--oa-border)',
                  background: 'var(--oa-bg-subtle)',
                }}
              >
                <div
                  className="flex flex-wrap items-center justify-between gap-4 px-3 py-2"
                  style={{ borderBottom: 'var(--border-width) solid var(--oa-border)' }}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-[var(--oa-text-muted)]">
                    <span className="font-medium text-[var(--oa-text-strong)]">Timeline</span>
                    <span>{timeline.tracks.length} tracks</span>
                  </div>

                  <div className="flex w-full max-w-[260px] items-center gap-3">
                    <span className="shrink-0 text-ui-xs text-[var(--oa-text-muted)]">Zoom</span>
                    <Slider
                      value={[pixelsPerFrame]}
                      min={1}
                      max={6}
                      step={0.2}
                      onValueChange={(values) => {
                        setPixelsPerFrame(values[0] ?? 2.4);
                      }}
                    />
                  </div>
                </div>

                <div className="min-h-0 h-full overflow-auto">
                  <MovieTimelineEditor
                    timeline={timeline}
                    assetMetadataById={assetMetadataById}
                    selectedClipId={selectedClipId}
                    playheadFrame={playheadFrame}
                    pixelsPerFrame={pixelsPerFrame}
                    onSelectClip={setSelectedClipId}
                    onSetPlayheadFrame={setManualPlayhead}
                    onCompleteDrag={() => {
                      void flushTimelinePersistence();
                    }}
                    onUpdateClipTiming={applyClipTimingPatch}
                    onClipContextMenu={handleClipContextMenu}
                  />
                </div>
              </section>
            </div>

            <div className="relative min-h-0 overflow-hidden">
              <div className="absolute inset-y-0 left-0 ml-[-6px] flex">
                <ResizeHandle
                  onMouseDown={handleUtilityResizeStart}
                  orientation="vertical"
                  showBorder
                  className="flex justify-center bg-transparent"
                  style={{ width: 12 }}
                />
              </div>

              <div
                data-testid="movie-utility-column"
                className="h-full min-h-0 overflow-x-hidden overflow-y-auto pl-5"
              >
                <div className="flex flex-col gap-3 pb-4">
                  <section
                    className="order-2 rounded-[14px] p-3"
                    style={{
                      border: 'var(--border-width) solid var(--oa-border)',
                      background: 'var(--oa-bg-subtle)',
                    }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-ui-sm font-medium text-[var(--oa-text-strong)]">Recorder</div>
                        <div className="mt-1 text-ui-xs text-[var(--oa-text-muted)]">
                          {readyVideoCount} video ready · {audioStream ? 'audio ready' : 'audio optional'} · {isRecording ? formatDuration(recordingElapsedMs / 1000) : 'idle'}
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void refreshSources()}
                          disabled={isRefreshingSources || isRecording || isStoppingRecording}
                        >
                          <RefreshCw className={cn('size-4', isRefreshingSources && 'animate-spin')} />
                          <span>Sources</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const defaultSourceKey = videoSourcesRef.current[0]?.key ?? null;
                            setVideoInputs((current) => [...current, createVideoInput(defaultSourceKey)]);
                          }}
                          disabled={isRecording || isStoppingRecording}
                        >
                          <Plus className="size-4" />
                          <span>Add Input</span>
                        </Button>
                      </div>
                    </div>

                    <div className="mt-3">
                      {isRecording ? (
                        <Button
                          id={MOVIE_RECORD_AT_PLAYHEAD_BUTTON_ID}
                          data-testid={MOVIE_RECORD_AT_PLAYHEAD_BUTTON_ID}
                          variant="destructive"
                          size="lg"
                          className="w-full"
                          onClick={() => void stopRecording()}
                          disabled={isStoppingRecording}
                        >
                          <Square className="size-4" />
                          <span>{isStoppingRecording ? 'Saving take…' : 'Stop Recording'}</span>
                        </Button>
                      ) : (
                        <Button
                          id={MOVIE_RECORD_AT_PLAYHEAD_BUTTON_ID}
                          data-testid={MOVIE_RECORD_AT_PLAYHEAD_BUTTON_ID}
                          variant="default"
                          size="lg"
                          className="w-full"
                          onClick={() => void startRecording()}
                          disabled={readyVideoCount === 0 || isProjectLoading}
                        >
                          <Circle className="size-4 fill-current" />
                          <span>Record</span>
                        </Button>
                      )}
                      <div className="mt-2 text-ui-xs text-[var(--oa-text-muted)]">
                        Starts at {formatFrameTime(playheadFrame, timeline.settings.fps)} and saves recorded files into <code>assets/</code>.
                      </div>
                    </div>

                    <div className="mt-4 space-y-3" style={{ borderTop: 'var(--border-width) solid var(--oa-border)' }}>
                    {videoInputs.map((input, index) => {
                      const source = input.selectedSourceKey ? videoSourceMap.get(input.selectedSourceKey) ?? null : null;
                      const isLive = Boolean(input.stream && input.connectedSourceKey === input.selectedSourceKey);

                      return (
                        <div
                          key={input.id}
                          className="rounded-[12px] bg-[var(--oa-surface-center)] p-3 first:mt-3"
                          style={{ border: 'var(--border-width) solid var(--oa-border)' }}
                        >
                          <div className="flex items-center justify-between gap-3 text-ui-xs text-[var(--oa-text-muted)]">
                            <span>Video Input {index + 1}</span>
                            <span>{isLive ? 'Live' : 'Idle'}</span>
                          </div>

                          <div className="mt-2 flex flex-col gap-2">
                            <NativeSelect
                              value={input.selectedSourceKey ?? undefined}
                              onValueChange={(value) => {
                                videoConnectTokensRef.current[input.id] = (videoConnectTokensRef.current[input.id] ?? 0) + 1;
                                stopStream(input.stream);
                                setVideoInputs((current) => current.map((candidate) => (
                                  candidate.id === input.id
                                    ? {
                                      ...candidate,
                                      selectedSourceKey: value,
                                      connectedSourceKey: null,
                                      stream: null,
                                      isConnecting: false,
                                    }
                                    : candidate
                                )));
                              }}
                              items={videoSourceItems}
                              placeholder={videoSources.length > 0 ? 'Choose video source' : 'No video sources found'}
                              className="w-full justify-between"
                              disabled={videoSources.length === 0 || isRecording}
                            />
                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void connectVideoInput(input.id)}
                                disabled={!input.selectedSourceKey || input.isConnecting || isRecording}
                              >
                                {input.isConnecting ? <RefreshCw className="size-4 animate-spin" /> : source?.kind === 'screen' ? <Monitor className="size-4" /> : <Camera className="size-4" />}
                                <span>{isLive ? 'Reconnect' : 'Preview'}</span>
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  disconnectVideoInput(input.id);
                                  setVideoInputs((current) => (
                                    current.length <= 1
                                      ? [createVideoInput(videoSourcesRef.current[0]?.key ?? null)]
                                      : current.filter((candidate) => candidate.id !== input.id)
                                  ));
                                }}
                                disabled={isRecording || isStoppingRecording}
                              >
                                <Square className="size-4" />
                                <span>Remove</span>
                              </Button>
                            </div>
                          </div>

                          <div className="mt-2">
                            <LiveVideoMonitor
                              source={source}
                              stream={input.stream}
                              onExpand={() => {
                                setExpandedVideoInputId(input.id);
                                setExpandedVideoPreviewDelaySeconds(0);
                              }}
                              expandButtonId={MOVIE_SOURCE_PREVIEW_EXPAND_BUTTON_ID(input.id)}
                            />
                          </div>
                        </div>
                      );
                    })}
                    </div>

                    <div className="mt-4 pt-4" style={{ borderTop: 'var(--border-width) solid var(--oa-border)' }}>
                      <div className="flex items-center justify-between gap-3 text-ui-xs text-[var(--oa-text-muted)]">
                        <span>Audio</span>
                        <span>{audioStream ? 'Ready' : 'Idle'}</span>
                      </div>

                      <div className="mt-2 space-y-2">
                        <NativeSelect
                          value={selectedAudioSourceKey ?? undefined}
                          onValueChange={(value) => {
                            disconnectAudioInput();
                            setSelectedAudioSourceKey(value);
                          }}
                          items={audioSourceItems}
                          placeholder={audioSources.length > 0 ? 'Choose audio source' : 'No audio sources found'}
                          className="w-full justify-between"
                          disabled={audioSources.length === 0 || isRecording}
                        />
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void connectAudioInput()}
                            disabled={!selectedAudioSourceKey || isConnectingAudio || isRecording}
                          >
                            {isConnectingAudio ? <RefreshCw className="size-4 animate-spin" /> : <Mic className="size-4" />}
                            <span>{audioStream ? 'Reconnect Audio' : 'Connect Audio'}</span>
                          </Button>
                          {audioStream ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={disconnectAudioInput}
                              disabled={isRecording || isStoppingRecording}
                            >
                              <Square className="size-4" />
                              <span>Disconnect</span>
                            </Button>
                          ) : null}
                        </div>
                        <div className="text-ui-xs leading-5 text-[var(--oa-text-muted)]">
                          {audioStream
                            ? audioSources.find((source) => source.key === connectedAudioSourceKey)?.label ?? 'Connected source'
                            : 'Connect an audio source if you want a separate editable audio file.'}
                        </div>
                      </div>
                    </div>
                  </section>

                  {selectedClip ? (
                    <section
                      data-testid="movie-inspector-panel"
                      className="order-1 rounded-[14px] p-3"
                      style={{
                        border: 'var(--border-width) solid var(--oa-border)',
                        background: 'var(--oa-bg-subtle)',
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-ui-sm font-medium text-[var(--oa-text-strong)]">{selectedClip.label}</div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-ui-xs text-[var(--oa-text-muted)]">
                            <span>{selectedClip.kind}</span>
                            <span>start {formatFrameTime(selectedClip.startFrame, timeline.settings.fps)}</span>
                            <span>in {formatFrameTime(selectedClip.sourceStartFrame, timeline.settings.fps)}</span>
                            <span>out {formatFrameTime(selectedClip.sourceEndFrame, timeline.settings.fps)}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          {((selectedClip.kind === 'video' && selectedClip.linkedAudioClipId) || (selectedClip.kind === 'audio' && selectedClip.linkedVideoClipId)) ? (
                            <Button
                              id={MOVIE_UNLINK_AUDIO_BUTTON_ID}
                              data-testid={MOVIE_UNLINK_AUDIO_BUTTON_ID}
                              variant="outline"
                              size="sm"
                              onClick={handleUnlinkAudio}
                            >
                              <Link2Off className="size-4" />
                              <span>Unlink Audio</span>
                            </Button>
                          ) : null}
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleDeleteSelectedClip}
                          >
                            <Trash2 className="size-4" />
                            <span>
                              {((selectedClip.kind === 'video' && selectedClip.linkedAudioClipId) || (selectedClip.kind === 'audio' && selectedClip.linkedVideoClipId))
                                ? 'Delete Linked Clips'
                                : 'Delete Clip'}
                            </span>
                          </Button>
                        </div>
                      </div>

                      <div className="mt-3 grid gap-4">
                        <div className="space-y-3">
                          {selectedClip.kind === 'audio' ? (
                            <div className="space-y-2">
                              <label className="text-ui-xs text-[var(--oa-text-muted)]">Audio volume</label>
                              <Input
                                type="number"
                                step="0.05"
                                min="0"
                                max="2"
                                value={selectedClip.volume}
                                onChange={(event) => updateAudioVolume(event.target.value)}
                              />
                            </div>
                          ) : null}

                          {(selectedClip.kind === 'video' || selectedClip.kind === 'react') ? (
                            <div className="space-y-3">
                              <div className="grid grid-cols-2 gap-2">
                                <Input type="number" value={selectedClip.style.x} onChange={(event) => updateStyleNumber('x', event.target.value)} placeholder="X" />
                                <Input type="number" value={selectedClip.style.y} onChange={(event) => updateStyleNumber('y', event.target.value)} placeholder="Y" />
                                <Input type="number" value={selectedClip.style.width} onChange={(event) => updateStyleNumber('width', event.target.value)} placeholder="Width" />
                                <Input type="number" value={selectedClip.style.height} onChange={(event) => updateStyleNumber('height', event.target.value)} placeholder="Height" />
                                <Input type="number" step="0.05" min="0" max="1" value={selectedClip.style.opacity} onChange={(event) => updateStyleNumber('opacity', event.target.value)} placeholder="Opacity" />
                                <Input type="number" step="1" min="0" value={selectedClip.style.blur} onChange={(event) => updateStyleNumber('blur', event.target.value)} placeholder="Blur" />
                              </div>

                              {selectedClip.kind === 'video' ? (
                                <div className="grid grid-cols-2 gap-2">
                                  <Input type="number" step="0.01" value={selectedClip.style.crop.left} onChange={(event) => updateCropNumber('left', event.target.value)} placeholder="Crop left" />
                                  <Input type="number" step="0.01" value={selectedClip.style.crop.top} onChange={(event) => updateCropNumber('top', event.target.value)} placeholder="Crop top" />
                                  <Input type="number" step="0.01" value={selectedClip.style.crop.right} onChange={(event) => updateCropNumber('right', event.target.value)} placeholder="Crop right" />
                                  <Input type="number" step="0.01" value={selectedClip.style.crop.bottom} onChange={(event) => updateCropNumber('bottom', event.target.value)} placeholder="Crop bottom" />
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-3">
                            <label className="text-ui-xs text-[var(--oa-text-muted)]">Clip metadata</label>
                            <Button variant="ghost" size="sm" onClick={applyMetadataDraft}>
                              <Upload className="size-4" />
                              <span>Apply</span>
                            </Button>
                          </div>
                          <Textarea
                            value={metadataDraft}
                            onChange={(event) => setMetadataDraft(event.target.value)}
                            onBlur={applyMetadataDraft}
                            className="min-h-[180px] font-mono text-ui-sm"
                          />
                          {metadataError ? (
                            <div className="text-ui-xs text-[var(--oa-danger)]">{metadataError}</div>
                          ) : null}
                        </div>
                      </div>
                    </section>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

            {dropActive ? (
              <div className="pointer-events-none absolute inset-4 z-20 flex items-center justify-center rounded-[16px] border border-dashed border-amber-200/50 bg-[rgba(25,18,8,0.72)] backdrop-blur-sm">
                <div className="text-center">
                  <div className="text-ui-base font-medium text-amber-50">Drop media to reference it here</div>
                  <div className="mt-1 text-ui-sm text-amber-100/70">Dropped files stay where they are. Recordings still save into `assets/`.</div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <AlertDialog
          open={expandedVideoInputId !== null}
          onOpenChange={(open) => {
            if (!open) {
              setExpandedVideoInputId(null);
              setExpandedVideoPreviewDelaySeconds(0);
            }
          }}
        >
          <AlertDialogContent
            id={MOVIE_SOURCE_PREVIEW_MODAL_ID}
            data-testid={MOVIE_SOURCE_PREVIEW_MODAL_ID}
            size="lg"
            className="grid h-[min(88vh,960px)] w-[min(92vw,1400px)] max-w-[min(92vw,1400px)] grid-rows-[auto_1fr_auto] gap-0 overflow-hidden p-0"
          >
            <AlertDialogHeader
              className="gap-2 px-6 pb-5 pt-5 sm:px-7 sm:pb-6 sm:pt-6"
              style={{
                background:
                  'linear-gradient(180deg, color-mix(in srgb, var(--oa-bg-subtle) 32%, transparent) 0%, transparent 68%)',
              }}
            >
              <AlertDialogTitle className="text-[18px] leading-6">
                {expandedVideoSource?.label ?? 'Source preview'}
              </AlertDialogTitle>
              <AlertDialogDescription className="max-w-[42rem]">
                {expandedVideoPreviewDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="min-h-0 px-5 pb-5 sm:px-6 sm:pb-6">
              <div
                className="h-full min-h-0 rounded-[20px] p-3"
                style={{
                  border:
                    'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 76%, transparent)',
                  background:
                    'linear-gradient(180deg, color-mix(in srgb, var(--oa-surface-center) 92%, transparent) 0%, color-mix(in srgb, var(--oa-bg-subtle) 58%, black 42%) 100%)',
                }}
              >
                <LiveVideoMonitor
                  source={expandedVideoSource}
                  stream={expandedVideoInput?.stream ?? null}
                  mode="expanded"
                  delaySeconds={expandedVideoPreviewDelaySeconds}
                />
              </div>
            </div>

            <div
              className="flex items-center justify-between gap-5 px-6 pb-5 pt-4 sm:px-7 sm:pb-6"
              style={{
                borderTop:
                  'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 68%, transparent)',
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3 text-ui-xs text-[var(--oa-text-muted)]">
                  <span>Preview delay</span>
                  <span className="shrink-0 text-[var(--oa-text-strong)]">{expandedVideoDelayLabel}</span>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <Slider
                    id={MOVIE_SOURCE_PREVIEW_DELAY_SLIDER_ID}
                    data-testid={MOVIE_SOURCE_PREVIEW_DELAY_SLIDER_ID}
                    value={[expandedVideoPreviewDelaySeconds]}
                    min={0}
                    max={MAX_SOURCE_PREVIEW_DELAY_SECONDS}
                    step={0.5}
                    disabled={!expandedVideoInput?.stream}
                    className="flex-1"
                    onValueChange={(values) => {
                      setExpandedVideoPreviewDelaySeconds(values[0] ?? 0);
                    }}
                  />
                </div>
                <div className="mt-2 text-ui-xs text-[var(--oa-text-muted)]">
                  {expandedVideoInput?.stream
                    ? 'Delay the live preview by 0 to 20 seconds.'
                    : 'Connect a live source to use the preview delay.'}
                </div>
              </div>

              <AlertDialogCancel
                id={MOVIE_SOURCE_PREVIEW_CLOSE_BUTTON_ID}
                data-testid={MOVIE_SOURCE_PREVIEW_CLOSE_BUTTON_ID}
                size="sm"
                className="shrink-0"
              >
                Close preview
              </AlertDialogCancel>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      </EditorContentSurface>
    </EditorShell>
  );
}
