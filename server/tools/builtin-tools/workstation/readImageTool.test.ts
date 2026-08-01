import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readImageTool } from './readImageTool';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })),
  );
});

describe('readImageTool', () => {
  test('requires the calling agent model config', async () => {
    const result = await readImageTool.handler({ path: 'image.png' }, {
      workspace: '/tmp',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('model configuration');
  });

  test('rejects non-image input before starting a vision turn', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'read-image-tool-'));
    tempDirectories.push(directory);
    await writeFile(path.join(directory, 'not-image.png'), 'not an image');

    const result = await readImageTool.handler({ path: 'not-image.png' }, {
      workspace: directory,
      modelConfig: {
        provider: 'openai-oauth',
        modelId: 'gpt-test',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unsupported image format');
  });
});
