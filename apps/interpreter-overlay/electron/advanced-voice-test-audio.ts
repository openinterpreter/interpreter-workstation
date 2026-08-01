import fs from 'node:fs/promises';
import path from 'node:path';

export type AdvancedVoiceTestAudioSegment = {
  dataUrl: string;
  mimeType: string;
  delayAfterMs?: number;
};

export type AdvancedVoiceTestAudioPayload = {
  dataUrl?: string;
  mimeType?: string;
  segments?: AdvancedVoiceTestAudioSegment[];
};

export type AdvancedVoiceTestAudioLoadResult = {
  payload: AdvancedVoiceTestAudioPayload;
  sourcePath: string;
  byteLength: number;
};

type AdvancedVoiceTestAudioEnv = Record<string, string | undefined>;

export function advancedVoiceMimeTypeForPath(audioPath: string): string {
  const extension = path.extname(audioPath).toLowerCase();
  return extension === '.mp3'
    ? 'audio/mpeg'
    : extension === '.m4a'
      ? 'audio/mp4'
      : extension === '.aiff' || extension === '.aif'
        ? 'audio/aiff'
        : 'audio/wav';
}

function dataUrlForAudioPath(audioPath: string, data: Buffer): string {
  return `data:${advancedVoiceMimeTypeForPath(audioPath)};base64,${data.toString('base64')}`;
}

export async function readAdvancedVoiceTestAudioFromEnv(
  env: AdvancedVoiceTestAudioEnv = process.env,
): Promise<AdvancedVoiceTestAudioLoadResult | null> {
  const manifestPath = env.INTERPRETER_OVERLAY_ADVANCED_VOICE_TEST_AUDIO_MANIFEST?.trim();
  if (manifestPath) {
    const absoluteManifestPath = path.resolve(manifestPath);
    const manifest = JSON.parse(await fs.readFile(absoluteManifestPath, 'utf8')) as {
      segments?: Array<{ path?: string; delayAfterMs?: number }>;
    };
    if (!Array.isArray(manifest.segments) || manifest.segments.length === 0) {
      throw new Error('Advanced voice test audio manifest must contain at least one segment.');
    }
    const segments = await Promise.all(manifest.segments.map(async (segment) => {
      if (typeof segment.path !== 'string' || !segment.path.trim()) {
        throw new Error('Advanced voice test audio segment is missing a path.');
      }
      const absolutePath = path.resolve(path.dirname(absoluteManifestPath), segment.path);
      const data = await fs.readFile(absolutePath);
      return {
        dataUrl: dataUrlForAudioPath(absolutePath, data),
        mimeType: advancedVoiceMimeTypeForPath(absolutePath),
        delayAfterMs: Number.isFinite(segment.delayAfterMs) ? Math.max(0, Number(segment.delayAfterMs)) : 0,
      };
    }));
    return {
      payload: { segments },
      sourcePath: absoluteManifestPath,
      byteLength: segments.reduce((sum, segment) => {
        const [, base64 = ''] = segment.dataUrl.split(',');
        return sum + Buffer.byteLength(base64, 'base64');
      }, 0),
    };
  }

  const audioPath = env.INTERPRETER_OVERLAY_ADVANCED_VOICE_TEST_AUDIO_FILE?.trim();
  if (!audioPath) {
    return null;
  }
  const absolutePath = path.resolve(audioPath);
  const data = await fs.readFile(absolutePath);
  const mimeType = advancedVoiceMimeTypeForPath(absolutePath);
  return {
    payload: {
      dataUrl: `data:${mimeType};base64,${data.toString('base64')}`,
      mimeType,
    },
    sourcePath: absolutePath,
    byteLength: data.byteLength,
  };
}
