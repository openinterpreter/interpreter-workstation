import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  downloadTranscriptionModelTool,
  listTranscriptionModelsTool,
  transcribeAudioTool,
} from './transcribeTools';
import { setCurrentWorkspace } from '../../../utils/workspace';

let tempRoot = '';
const originalInstallRoot = process.env.TEST_TRANSCRIBE_INSTALL_ROOT;
const originalFakeDownload = process.env.TEST_TRANSCRIBE_FAKE_DOWNLOAD;
const originalFakeTranscript = process.env.TEST_TRANSCRIBE_FAKE_TRANSCRIPT;

describe('builtin-transcribe tools', () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'builtin-transcribe-test-'));
    process.env.TEST_TRANSCRIBE_INSTALL_ROOT = tempRoot;
    process.env.TEST_TRANSCRIBE_FAKE_DOWNLOAD = '1';
    delete process.env.TEST_TRANSCRIBE_FAKE_TRANSCRIPT;
  });

  afterEach(async () => {
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
    setCurrentWorkspace(null);
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('lists model tradeoffs and install state', async () => {
    const result = await listTranscriptionModelsTool.handler({});
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      installRoot: string;
      models: Array<{ id: string; installed: boolean; sizeMb: number; language: string }>;
    };

    expect(payload.installRoot).toBe(tempRoot);
    expect(payload.models.some((model) => model.id === 'tiny.en' && model.sizeMb === 87)).toBe(true);
    expect(payload.models.every((model) => model.installed === false)).toBe(true);
  });

  test('refuses transcription until the selected model is downloaded', async () => {
    const audioPath = path.join(tempRoot, 'sample.mp3');
    const result = await transcribeAudioTool.handler({ audioPath, model: 'tiny.en' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('download_model');
    expect(result.content[0]?.text).toContain('tiny.en');
  });

  test('downloads the selected model app-side and transcribes with it', async () => {
    const downloadResult = await downloadTranscriptionModelTool.handler({ model: 'tiny.en' });
    const downloadPayload = JSON.parse(downloadResult.content[0]?.text ?? '{}') as {
      installed: boolean;
      model: string;
      executablePath: string;
    };
    const manifestPath = path.join(tempRoot, 'models', 'tiny.en', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { sha256: string };

    expect(downloadPayload.installed).toBe(true);
    expect(downloadPayload.model).toBe('tiny.en');
    expect(downloadPayload.executablePath).toContain('whisper-tiny.en');
    expect(manifest.sha256).toBe('0e8d17c72d3fd259d4ac761dd9f8f3a30ad21affb818c1aaf17f63945254f25a');

    process.env.TEST_TRANSCRIBE_FAKE_TRANSCRIPT = 'hello from local whisper';
    const outputPath = path.join(tempRoot, 'transcript.txt');
    const transcribeResult = await transcribeAudioTool.handler({
      audioPath: path.join(tempRoot, 'sample.mp3'),
      model: 'tiny.en',
      outputPath,
    });
    const transcribePayload = JSON.parse(transcribeResult.content[0]?.text ?? '{}') as {
      transcript: string;
      outputPath: string;
    };

    expect(transcribePayload.transcript).toBe('hello from local whisper');
    expect(transcribePayload.outputPath).toBe(outputPath);
    expect(await readFile(outputPath, 'utf-8')).toBe(`hello from local whisper${os.EOL}`);
  });

  test('resolves transcription paths against the agent workspace context', async () => {
    await downloadTranscriptionModelTool.handler({ model: 'tiny.en' });
    process.env.TEST_TRANSCRIBE_FAKE_TRANSCRIPT = 'scoped transcript';

    const globalWorkspacePath = await mkdtemp(path.join(os.tmpdir(), 'builtin-transcribe-global-'));
    const agentWorkspacePath = await mkdtemp(path.join(os.tmpdir(), 'builtin-transcribe-agent-'));
    setCurrentWorkspace(globalWorkspacePath);

    try {
      const result = await transcribeAudioTool.handler(
        {
          audioPath: 'sample.mp3',
          model: 'tiny.en',
          outputPath: 'transcript.txt',
        },
        { workspace: agentWorkspacePath },
      );
      const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
        audioPath: string;
        outputPath: string;
      };

      expect(result.isError).not.toBe(true);
      expect(payload.audioPath).toBe(path.join(agentWorkspacePath, 'sample.mp3'));
      expect(payload.outputPath).toBe(path.join(agentWorkspacePath, 'transcript.txt'));
      expect(await readFile(path.join(agentWorkspacePath, 'transcript.txt'), 'utf-8'))
        .toBe(`scoped transcript${os.EOL}`);
    } finally {
      await rm(globalWorkspacePath, { recursive: true, force: true });
      await rm(agentWorkspacePath, { recursive: true, force: true });
    }
  });
});
