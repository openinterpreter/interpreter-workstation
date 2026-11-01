import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSimpleAssetRevision, stopSimpleAssetWatchersForTest } from './simpleAssetRevision';

const projects: string[] = [];

afterEach(() => {
  stopSimpleAssetWatchersForTest();
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

test('detects public asset replacement without a source-file change', async () => {
  const project = mkdtempSync(join(tmpdir(), 'interpreter-assets-'));
  projects.push(project);
  const publicDir = join(project, 'public');
  mkdirSync(publicDir);
  const asset = join(publicDir, 'photo.png');
  writeFileSync(asset, 'before');
  const oldTime = statSync(asset).mtime;
  expect(await getSimpleAssetRevision(project)).toBe(0);
  writeFileSync(asset, 'after');
  utimesSync(asset, oldTime, oldTime);
  const deadline = Date.now() + 2_000;
  while ((await getSimpleAssetRevision(project)) === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(await getSimpleAssetRevision(project)).toBeGreaterThan(0);
});
