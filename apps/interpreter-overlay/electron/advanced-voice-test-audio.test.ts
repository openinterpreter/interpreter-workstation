import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  advancedVoiceMimeTypeForPath,
  readAdvancedVoiceTestAudioFromEnv,
} from './advanced-voice-test-audio';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'advanced-voice-test-audio-'));
  tempDirs.push(dir);
  return dir;
}

function base64Bytes(dataUrl: string): Buffer {
  const [, base64 = ''] = dataUrl.split(',');
  return Buffer.from(base64, 'base64');
}

describe('advanced voice test audio loader', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  test('loads a synthesized audio manifest as realtime-ready data URL segments', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'first.wav'), Buffer.from([1, 2, 3, 4]));
    await fs.writeFile(path.join(dir, 'second.mp3'), Buffer.from([5, 6]));
    const manifestPath = path.join(dir, 'advanced-voice-audio.json');
    await fs.writeFile(manifestPath, JSON.stringify({
      segments: [
        { path: 'first.wav', delayAfterMs: 25 },
        { path: './second.mp3', delayAfterMs: -10 },
      ],
    }));

    const result = await readAdvancedVoiceTestAudioFromEnv({
      INTERPRETER_OVERLAY_ADVANCED_VOICE_TEST_AUDIO_MANIFEST: manifestPath,
      INTERPRETER_OVERLAY_ADVANCED_VOICE_TEST_AUDIO_FILE: undefined,
    });

    expect(result?.sourcePath).toBe(manifestPath);
    expect(result?.byteLength).toBe(6);
    expect(result?.payload.segments?.map((segment) => segment.mimeType)).toEqual(['audio/wav', 'audio/mpeg']);
    expect(result?.payload.segments?.map((segment) => segment.delayAfterMs)).toEqual([25, 0]);
    expect(base64Bytes(result?.payload.segments?.[0]?.dataUrl ?? '')).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(base64Bytes(result?.payload.segments?.[1]?.dataUrl ?? '')).toEqual(Buffer.from([5, 6]));
  });

  test('loads a single test audio file when no manifest is configured', async () => {
    const dir = await makeTempDir();
    const audioPath = path.join(dir, 'spoken.m4a');
    await fs.writeFile(audioPath, Buffer.from([9, 8, 7]));

    const result = await readAdvancedVoiceTestAudioFromEnv({
      INTERPRETER_OVERLAY_ADVANCED_VOICE_TEST_AUDIO_MANIFEST: undefined,
      INTERPRETER_OVERLAY_ADVANCED_VOICE_TEST_AUDIO_FILE: audioPath,
    });

    expect(result).toEqual({
      sourcePath: audioPath,
      byteLength: 3,
      payload: {
        mimeType: 'audio/mp4',
        dataUrl: `data:audio/mp4;base64,${Buffer.from([9, 8, 7]).toString('base64')}`,
      },
    });
  });

  test('fails loudly for malformed manifests', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'advanced-voice-audio.json');
    await fs.writeFile(manifestPath, JSON.stringify({ segments: [{ delayAfterMs: 1 }] }));

    await expect(readAdvancedVoiceTestAudioFromEnv({
      INTERPRETER_OVERLAY_ADVANCED_VOICE_TEST_AUDIO_MANIFEST: manifestPath,
      INTERPRETER_OVERLAY_ADVANCED_VOICE_TEST_AUDIO_FILE: undefined,
    })).rejects.toThrow('Advanced voice test audio segment is missing a path.');
  });

  test('maps supported audio file extensions to realtime media types', () => {
    expect(advancedVoiceMimeTypeForPath('voice.wav')).toBe('audio/wav');
    expect(advancedVoiceMimeTypeForPath('voice.mp3')).toBe('audio/mpeg');
    expect(advancedVoiceMimeTypeForPath('voice.m4a')).toBe('audio/mp4');
    expect(advancedVoiceMimeTypeForPath('voice.aiff')).toBe('audio/aiff');
  });
});
