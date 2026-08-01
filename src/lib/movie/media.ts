import {
  createMovieAssetMetadata,
  createMovieId,
  type MovieAsset,
  type MovieAssetKind,
  type MovieAssetMetadata,
  type MovieAssetSourceMode,
  type MovieWaveform,
} from '../../../shared/movie-schema';
import {
  files,
  getFileUrl,
  pathBasename,
  pathJoin,
  pathRelative,
} from '@/ipc';

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi']);
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'aac', 'm4a', 'opus', 'flac', 'aiff']);

function getLowercaseExtension(filePath: string): string {
  const basename = pathBasename(filePath);
  const parts = basename.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

export function classifyMovieAssetKind(filePath: string): MovieAssetKind | null {
  const extension = getLowercaseExtension(filePath);
  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return 'audio';
  }
  return null;
}

export function getMovieAssetAbsolutePath(asset: MovieAsset, projectDir: string): string {
  return asset.sourceMode === 'managed' ? pathJoin(projectDir, asset.path) : asset.path;
}

function durationSecondsToFrames(durationSeconds: number, fps: number): number {
  return Math.max(1, Math.round(durationSeconds * fps));
}

async function readMediaElementMetadata(
  fileUrl: string,
  kind: MovieAssetKind,
): Promise<{
  durationSeconds: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}> {
  if (kind === 'video') {
    const element = document.createElement('video');
    element.preload = 'metadata';
    element.src = fileUrl;
    element.playsInline = true;
    element.muted = true;

    return await new Promise((resolve, reject) => {
      element.onloadeddata = () => {
        let hasAudio = false;
        const mediaElement = element as HTMLVideoElement & {
          audioTracks?: { length: number };
          captureStream?: () => MediaStream;
          mozCaptureStream?: () => MediaStream;
          mozHasAudio?: boolean;
          webkitAudioDecodedByteCount?: number;
        };

        if (typeof mediaElement.mozHasAudio === 'boolean') {
          hasAudio = mediaElement.mozHasAudio;
        } else if (typeof mediaElement.audioTracks?.length === 'number') {
          hasAudio = mediaElement.audioTracks.length > 0;
        } else {
          try {
            const captureStream = mediaElement.captureStream?.bind(mediaElement)
              ?? mediaElement.mozCaptureStream?.bind(mediaElement);
            const stream = captureStream?.();
            if (stream) {
              hasAudio = stream.getAudioTracks().length > 0;
              for (const track of stream.getTracks()) {
                track.stop();
              }
            }
          } catch {
            hasAudio = false;
          }

          if (!hasAudio) {
            hasAudio = Number(mediaElement.webkitAudioDecodedByteCount ?? 0) > 0;
          }
        }

        resolve({
          durationSeconds: Number.isFinite(element.duration) ? element.duration : 0,
          width: element.videoWidth || null,
          height: element.videoHeight || null,
          hasAudio,
        });
      };
      element.onerror = () => reject(new Error('Failed to load video metadata'));
    });
  }

  const element = document.createElement('audio');
  element.preload = 'metadata';
  element.src = fileUrl;

  return await new Promise((resolve, reject) => {
    element.onloadedmetadata = () => {
      resolve({
        durationSeconds: Number.isFinite(element.duration) ? element.duration : 0,
        width: null,
        height: null,
        hasAudio: true,
      });
    };
    element.onerror = () => reject(new Error('Failed to load audio metadata'));
  });
}

async function decodeAudioWaveform(
  filePath: string,
  sampleCount = 160,
): Promise<MovieWaveform | null> {
  const response = await files.readBinary(filePath);
  const buffer = response.buffer.slice(0) as ArrayBuffer;
  const audioContext = new window.AudioContext();

  try {
    const audioBuffer = await audioContext.decodeAudioData(buffer);
    const totalSamples = audioBuffer.length;
    if (totalSamples === 0) {
      return null;
    }

    const bucketSize = Math.max(1, Math.floor(totalSamples / sampleCount));
    const peaks: number[] = [];
    let maxPeak = 0;

    for (let bucketIndex = 0; bucketIndex < sampleCount; bucketIndex += 1) {
      const start = bucketIndex * bucketSize;
      const end = Math.min(totalSamples, start + bucketSize);
      let peak = 0;

      for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
        const channel = audioBuffer.getChannelData(channelIndex);
        for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
          const magnitude = Math.abs(channel[sampleIndex] ?? 0);
          if (magnitude > peak) {
            peak = magnitude;
          }
        }
      }

      peaks.push(peak);
      maxPeak = Math.max(maxPeak, peak);
    }

    const normalized = maxPeak > 0 ? peaks.map((peak) => peak / maxPeak) : peaks;
    return {
      sampleCount: normalized.length,
      samples: normalized,
    };
  } catch {
    return null;
  } finally {
    await audioContext.close().catch(() => {});
  }
}

export async function analyzeMovieAssetFile({
  absoluteFilePath,
  projectDir,
  metadataDir,
  fps,
  sourceMode,
}: {
  absoluteFilePath: string;
  projectDir: string;
  metadataDir: string;
  fps: number;
  sourceMode: MovieAssetSourceMode;
}): Promise<{
  asset: MovieAsset;
  metadata: MovieAssetMetadata;
}> {
  const kind = classifyMovieAssetKind(absoluteFilePath);
  if (!kind) {
    throw new Error(`Unsupported movie asset type: ${absoluteFilePath}`);
  }

  const fileUrl = await getFileUrl(absoluteFilePath);
  const mediaMetadata = await readMediaElementMetadata(fileUrl, kind);
  const waveform = kind === 'audio'
    ? await decodeAudioWaveform(absoluteFilePath)
    : null;
  const assetId = createMovieId('movie-asset');
  const metadataFilePath = pathJoin(metadataDir, `${assetId}.json`);
  const timelinePath = sourceMode === 'managed'
    ? pathRelative(projectDir, absoluteFilePath)
    : absoluteFilePath;

  const asset: MovieAsset = {
    id: assetId,
    kind,
    label: pathBasename(absoluteFilePath),
    sourceMode,
    path: timelinePath,
    sourceUrl: sourceMode === 'reference' ? fileUrl : '',
    metadataPath: pathRelative(projectDir, metadataFilePath),
    durationInFrames: durationSecondsToFrames(mediaMetadata.durationSeconds, fps),
    durationSeconds: mediaMetadata.durationSeconds,
    width: mediaMetadata.width,
    height: mediaMetadata.height,
    hasAudio: kind === 'audio' ? true : mediaMetadata.hasAudio,
    createdAt: Date.now(),
  };

  const metadata = createMovieAssetMetadata(assetId);
  metadata.durationSeconds = asset.durationSeconds;
  metadata.durationInFrames = asset.durationInFrames;
  metadata.width = asset.width;
  metadata.height = asset.height;
  metadata.hasAudio = asset.hasAudio;
  metadata.waveform = waveform;

  return { asset, metadata };
}
