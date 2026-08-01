import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { smartTurnServiceTestUtils } from './smartTurnService';

const originalCwd = process.cwd();
const originalResourcesPath = process.resourcesPath;
const createdRoots: string[] = [];

function makeRoot(name: string): string {
  const root = path.join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  createdRoots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeSmartTurnModel(root: string): string {
  const modelPath = path.join(root, 'smart-turn', 'smart-turn-v3.2-cpu.onnx');
  mkdirSync(path.dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, 'test-model');
  return modelPath;
}

afterEach(() => {
  process.chdir(originalCwd);
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('smartTurnServiceTestUtils.resolveModelPath', () => {
  test('uses Electron process.resourcesPath for packaged extra resources', () => {
    const cwdRoot = makeRoot('smart-turn-cwd');
    const resourcesRoot = makeRoot('smart-turn-resources');
    const expectedModelPath = writeSmartTurnModel(resourcesRoot);

    process.chdir(cwdRoot);
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = resourcesRoot;

    expect(smartTurnServiceTestUtils.resolveModelPath()).toBe(expectedModelPath);
  });
});
