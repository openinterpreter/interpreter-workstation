import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('scripts/ci/select-ubuntu-apt-mirror.sh');
const workflow = await readFile('.github/workflows/release.yml', 'utf8');

test('release uses the scoped mirror selector only for Linux package installation', () => {
  assert.match(workflow, /name: Install Linux package dependencies\s+if: matrix\.os == 'linux'\s+run: \|\s+bash scripts\/ci\/select-ubuntu-apt-mirror\.sh\s+sudo apt-get update/);
});

test('selector changes only the unavailable Azure host and is idempotent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ubuntu-mirror-fixture-'));
  try {
    const file = path.join(directory, 'apt-mirrors.txt');
    const before = 'http://azure.archive.ubuntu.com/ubuntu/\nhttps://security.ubuntu.com/ubuntu/\n';
    await writeFile(file, before);
    execFileSync('bash', [script, file]);
    const after = await readFile(file, 'utf8');
    assert.equal(after, before.replace('azure.archive.ubuntu.com', 'archive.ubuntu.com'));
    execFileSync('bash', [script, file]);
    assert.equal(await readFile(file, 'utf8'), after);
    execFileSync('bash', [script, path.join(directory, 'absent')]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
