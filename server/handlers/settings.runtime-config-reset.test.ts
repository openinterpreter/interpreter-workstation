import { afterEach, beforeEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetRuntimeConfigFiles } from './settings';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('resetRuntimeConfigFiles', () => {
  let testHome = '';
  let interpreterConfigPath = '';
  let runtimeConfigPath = '';

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'runtime-config-reset-'));
    interpreterConfigPath = join(testHome, '.interpreter', 'config.json');
    runtimeConfigPath = join(testHome, 'codex-home', 'config.toml');
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  test('removes ~/.interpreter/config.json and codex-home/config.toml when present', async () => {
    await mkdir(join(testHome, '.interpreter'), { recursive: true });
    await mkdir(join(testHome, 'codex-home'), { recursive: true });
    await writeFile(interpreterConfigPath, '{"foo":"bar"}', 'utf8');
    await writeFile(runtimeConfigPath, 'model = "gpt-5.2"\n', 'utf8');

    const result = await resetRuntimeConfigFiles({
      interpreterConfigPath,
      runtimeConfigTomlPath: runtimeConfigPath,
    });

    assert.equal(result.success, true);
    const interpreterConfigResult = result.files.find((entry) => entry.id === 'interpreterConfigJson');
    const runtimeConfigResult = result.files.find((entry) => entry.id === 'runtimeConfigToml');
    assert(interpreterConfigResult);
    assert(runtimeConfigResult);
    assert.equal(interpreterConfigResult.existed, true);
    assert.equal(interpreterConfigResult.removed, true);
    assert.equal(runtimeConfigResult.existed, true);
    assert.equal(runtimeConfigResult.removed, true);
    assert.equal(await exists(interpreterConfigPath), false);
    assert.equal(await exists(runtimeConfigPath), false);
  });

  test('reports success when target files are already absent', async () => {
    const result = await resetRuntimeConfigFiles({
      interpreterConfigPath,
      runtimeConfigTomlPath: runtimeConfigPath,
    });

    assert.equal(result.success, true);
    assert.equal(result.files.length, 2);
    for (const file of result.files) {
      assert.equal(file.existed, false);
      assert.equal(file.removed, false);
      assert.equal(file.error, undefined);
    }
  });
});
