import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

mock.module('./voiceExtensionElectronBridge', () => ({
  app: {
    getPath: () => path.join(os.tmpdir(), 'voice-extension-test-user-data'),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

const { voiceExtensionTestUtils } = await import('./voice-extension');

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'voice-extension-test-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function startRedirectLoopServer(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start redirect loop server');
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/loop`,
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

describe('voiceExtensionTestUtils.hasMoonshineAssets', () => {
  test('requires an install marker, not just model file existence', async () => {
    const installRoot = await createTempDir();

    for (const relativePath of [
      'model/base/quantized/encoder_model.onnx',
      'model/base/quantized/decoder_model_merged.onnx',
    ]) {
      const filePath = path.join(installRoot, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, 'model-bytes');
    }

    expect(voiceExtensionTestUtils.hasMoonshineAssets(installRoot)).toBe(false);

    await writeFile(
      path.join(installRoot, voiceExtensionTestUtils.MOONSHINE_INSTALL_MARKER),
      JSON.stringify({ completedAt: '2026-03-24T00:00:00.000Z' }),
      'utf-8',
    );

    expect(voiceExtensionTestUtils.hasMoonshineAssets(installRoot)).toBe(true);
  });
});

describe('voiceExtensionTestUtils.downloadToFile', () => {
  test('caps redirect loops and preserves an existing good file', async () => {
    const tempDir = await createTempDir();
    const outputPath = path.join(tempDir, 'encoder_model.onnx');
    await writeFile(outputPath, 'good-model');

    const { server, url } = await startRedirectLoopServer();

    try {
      await expect(voiceExtensionTestUtils.downloadToFile(url, outputPath)).rejects.toThrow(
        `Failed to download ${url}: too many redirects`,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    expect(await readFile(outputPath, 'utf-8')).toBe('good-model');
    expect(fs.existsSync(`${outputPath}.download`)).toBe(false);
  });
});
