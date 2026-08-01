import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  downloadTranscriptionModelTool,
  transcribeAudioTool,
} from './transcribeTools';

const execFileAsync = promisify(execFile);

let tempRoot = '';
let originalInstallRoot: string | undefined;
let originalFakeDownload: string | undefined;
let originalFakeTranscript: string | undefined;

function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function generateMacSpeechWav(outputPath: string): Promise<void> {
  const aiffPath = path.join(path.dirname(outputPath), 'generated-speech.aiff');
  const phrase = 'Hello Interpreter. This is a local transcription test.';

  await execFileAsync('/usr/bin/say', [
    '-o',
    aiffPath,
    phrase,
  ]);
  await execFileAsync('/usr/bin/afconvert', [
    '-f',
    'WAVE',
    '-d',
    'LEI16@16000',
    aiffPath,
    outputPath,
  ]);
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function generateWindowsSpeechWav(outputPath: string): Promise<void> {
  const phrase = 'Hello Interpreter. This is a local transcription test.';
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$synth.SetOutputToWaveFile(${powershellLiteral(outputPath)})`,
    `$synth.Speak(${powershellLiteral(phrase)})`,
    '$synth.Dispose()',
  ].join('; ');

  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);
}

async function generateSpeechWav(outputPath: string): Promise<void> {
  if (process.platform === 'darwin') {
    await generateMacSpeechWav(outputPath);
    return;
  }
  if (process.platform === 'win32') {
    await generateWindowsSpeechWav(outputPath);
    return;
  }
  throw new Error('Live transcribe test currently generates speech fixtures on macOS and Windows only.');
}

describe('builtin-transcribe live local transcription', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'builtin-transcribe-live-'));
    originalInstallRoot = process.env.TEST_TRANSCRIBE_INSTALL_ROOT;
    originalFakeDownload = process.env.TEST_TRANSCRIBE_FAKE_DOWNLOAD;
    originalFakeTranscript = process.env.TEST_TRANSCRIBE_FAKE_TRANSCRIPT;
    process.env.TEST_TRANSCRIBE_INSTALL_ROOT = path.join(tempRoot, 'user-data-local-transcribe');
    delete process.env.TEST_TRANSCRIBE_FAKE_DOWNLOAD;
    delete process.env.TEST_TRANSCRIBE_FAKE_TRANSCRIPT;
  });

  afterAll(async () => {
    if (originalInstallRoot === undefined) {
      delete process.env.TEST_TRANSCRIBE_INSTALL_ROOT;
    } else {
      process.env.TEST_TRANSCRIBE_INSTALL_ROOT = originalInstallRoot;
    }
    if (originalFakeDownload === undefined) {
      delete process.env.TEST_TRANSCRIBE_FAKE_DOWNLOAD;
    } else {
      process.env.TEST_TRANSCRIBE_FAKE_DOWNLOAD = originalFakeDownload;
    }
    if (originalFakeTranscript === undefined) {
      delete process.env.TEST_TRANSCRIBE_FAKE_TRANSCRIPT;
    } else {
      process.env.TEST_TRANSCRIBE_FAKE_TRANSCRIPT = originalFakeTranscript;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('downloads tiny.en and transcribes generated speech', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      console.warn('Skipping live transcribe test: generated speech fixture currently requires macOS or Windows.');
      return;
    }

    const wavPath = path.join(tempRoot, 'generated-speech.wav');
    await generateSpeechWav(wavPath);
    expect(existsSync(wavPath)).toBe(true);

    const downloadResult = await downloadTranscriptionModelTool.handler({
      model: process.env.TRANSCRIBE_LIVE_MODEL ?? 'tiny.en',
    });
    expect(downloadResult.isError).not.toBe(true);

    const transcribeResult = await transcribeAudioTool.handler({
      audioPath: wavPath,
      model: process.env.TRANSCRIBE_LIVE_MODEL ?? 'tiny.en',
    });
    expect(transcribeResult.isError).not.toBe(true);

    const payload = JSON.parse(transcribeResult.content[0]?.text ?? '{}') as {
      transcript?: string;
    };
    const normalizedTranscript = normalizeTranscript(payload.transcript ?? '');

    expect(normalizedTranscript).toContain('hello');
    expect(normalizedTranscript).toContain('interpreter');
    expect(normalizedTranscript).toContain('local');
    expect(normalizedTranscript).toContain('test');
  }, 10 * 60 * 1000);
});
