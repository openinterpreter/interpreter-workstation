import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('scripts/ci/diagnose-release-object-list.mjs');
const workflow = await readFile('.github/workflows/release-object-list-diagnostic.yml', 'utf8');

test('diagnostic is exact-key, read-only, App-only, and production-scoped', () => {
  assert.match(workflow, /github.actor == 'interpreterwork-automation\[bot\]'/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /inputs.confirm == 'diagnose-0\.2\.219'/);
  assert.match(workflow, /environment: production-release/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write|gh release|s3 cp|put-object|delete-object/);
});

test('diagnostic distinguishes incomplete empty listing, bounded pages, and exact HEAD', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'release-list-diagnostic-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const mock = `#!/usr/bin/env node
const a=process.argv.slice(2), fs=require('fs');
fs.appendFileSync(process.env.MOCK_CALLS,a.join(' ')+'\\n');
if(a[1]==='head-object'){console.error('An error occurred (404) when calling the HeadObject operation: Not Found');process.exit(254)}
if(a[1]==='list-objects-v2'){
  if(!a.includes('--no-paginate')){console.log(JSON.stringify({Contents:[]}));process.exit(0)}
  const next=a.includes('--continuation-token');
  console.log(JSON.stringify(next?{IsTruncated:false,KeyCount:0,Contents:[]}:
    {IsTruncated:true,KeyCount:0,NextContinuationToken:'opaque'}));
}else process.exit(3);
`;
  await writeFile(path.join(folder, 'aws'), mock, { mode: 0o755 });
  const calls = path.join(folder, 'calls');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: {
    ...process.env, PATH: `${folder}:${process.env.PATH}`, MOCK_CALLS: calls,
    AWS_ENDPOINT_URL: 'https://fixture.invalid', AWS_REGION: 'fixture',
    AWS_ACCESS_KEY_ID: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture',
  } });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.pages.length, 2);
  assert.equal(summary.automatic.keyCountPresent, false);
  assert.equal(summary.pages[0].continuationPresent, true);
  assert.equal(summary.pages[1].keyCount, 0);
  assert.equal(summary.head.error, '404');
  const requests = (await readFile(calls, 'utf8')).trim().split('\n');
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => !/put-object|delete-object|s3 cp/.test(request)));
});
