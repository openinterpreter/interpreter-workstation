import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { draftPlan, findDraft } from './reconcile-release-draft.mjs';
import { objectState } from './reconcile-immutable-uploads.mjs';

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const script = path.resolve('scripts/ci/reconcile-immutable-uploads.mjs');
const draftScript = path.resolve('scripts/ci/reconcile-release-draft.mjs');
const metadataScript = path.resolve('scripts/ci/write-release-metadata.mjs');
const mockAws = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const a=process.argv.slice(2), root=process.env.MOCK_BUCKET_ROOT;
const value=(key)=>a[a.indexOf(key)+1];
const record=(line)=>fs.appendFileSync(path.join(root,'calls'),line+'\\n');
if(a[0]==='s3api'&&a[1]==='list-objects-v2'){
  const key=value('--prefix'), file=path.join(root,key);
  const contents=fs.existsSync(file)?[{Key:key,Size:fs.statSync(file).size}]:[];
  console.log(JSON.stringify({KeyCount:contents.length,IsTruncated:false,Contents:contents}));
}else if(a[0]==='s3'&&a[1]==='cp'){
  const source=a[2],target=a[3];
  if(source.startsWith('s3://')){
    const key=source.split('/').slice(3).join('/');
    record('GET '+key);
    process.stdout.write(fs.readFileSync(path.join(root,key)));
  }else{
    const key=target.split('/').slice(3).join('/');
    record('PUT '+key); fs.mkdirSync(path.dirname(path.join(root,key)),{recursive:true});
    fs.copyFileSync(source,path.join(root,key));
    const once=path.join(root,'interrupt-once');
    if(fs.existsSync(once)){fs.unlinkSync(once);process.exit(1)}
  }
}else process.exit(2);
`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'release');
  const bin = path.join(root, 'bin');
  await mkdir(directory); await mkdir(bin);
  const files = new Map([['first.AppImage', 'exact first bytes'], ['second.dmg', 'exact second bytes']]);
  const sums = [];
  for (const [name, content] of files) {
    await writeFile(path.join(directory, name), content);
    sums.push(`${digest(content).slice(7)}  ${name}`);
  }
  await writeFile(path.join(directory, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  await writeFile(path.join(bin, 'aws'), mockAws, { mode: 0o755 });
  const bucket = path.join(root, 'bucket'); await mkdir(path.join(bucket, 'releases'), { recursive: true });
  function invoke() {
    return spawnSync(process.execPath, [script, '--bucket', 'fixture', '--prefix', 'releases',
      '--endpoint-url', 'https://fixture.invalid', '--region', 'fixture',
      '--checksums', path.join(directory, 'SHA256SUMS'),
      ...[...files.keys()].map((name) => path.join(directory, name))],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_BUCKET_ROOT: bucket } });
  }
  const calls = async () => readFile(path.join(bucket, 'calls'), 'utf8')
    .then((text) => text.trim().split('\n'), (error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  return { root, directory, bucket, files, invoke, calls };
}

test('partial success preserves matching immutable bytes and uploads only absent payloads', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.bucket, 'releases/first.AppImage'), f.files.get('first.AppImage'));
  assert.equal(f.invoke().status, 0);
  assert.deepEqual((await f.calls()).filter((call) => call.startsWith('PUT')), ['PUT releases/second.dmg']);
  assert.equal(f.invoke().status, 0);
  assert.deepEqual((await f.calls()).filter((call) => call.startsWith('PUT')), ['PUT releases/second.dmg']);
});

test('preflight mismatch fails before any PUT even with another missing payload', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.bucket, 'releases/first.AppImage'), 'x'.repeat(f.files.get('first.AppImage').length));
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /digest\/custody mismatch/);
  assert.deepEqual((await f.calls()).filter((call) => call.startsWith('PUT')), []);
});

test('interrupted PUT reconciles exact committed bytes without replaying it', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.bucket, 'interrupt-once'), '1');
  assert.equal(f.invoke().status, 0);
  assert.equal(f.invoke().status, 0);
  assert.deepEqual((await f.calls()).filter((call) => call.startsWith('PUT')),
    ['PUT releases/first.AppImage', 'PUT releases/second.dmg']);
});

test('draft custody preserves exact assets and fails closed on any mismatch', () => {
  const expected = new Map([['one', { name: 'one', size: 3, digest: digest('one') }],
    ['two', { name: 'two', size: 3, digest: digest('two') }]]);
  const draft = { tag_name: 'v0.2.217', draft: true, target_commitish: 'a'.repeat(40), assets: [expected.get('one')] };
  assert.deepEqual(draftPlan(expected, findDraft([draft], draft.tag_name, draft.target_commitish)).map((a) => a.name), ['two']);
  assert.throws(() => draftPlan(expected, { ...draft, assets: [{ ...expected.get('one'), digest: digest('bad') }] }), /identity mismatch/);
  assert.throws(() => findDraft([{ ...draft, draft: false }], draft.tag_name, draft.target_commitish), /published/);
  assert.throws(() => findDraft([draft], draft.tag_name, 'b'.repeat(40)), /another commit/);
  assert.equal(objectState([], 'releases/one', expected.get('one')), 'missing');
});

test('draft integration preserves matching assets, aborts a mismatch, and resumes an interrupted upload', async (t) => {
  const f = await fixture(t);
  const repo = 'openinterpreter/interpreter-workstation';
  const commit = 'a'.repeat(40);
  const manifest = JSON.stringify({ version: '0.2.217', source: { repository: repo, commit }, build: { runId: '42' } });
  await writeFile(path.join(f.directory, 'RELEASE-MANIFEST.json'), manifest);
  await writeFile(path.join(f.directory, 'RELEASE_NOTES.md'), 'Release notes');
  const names = [...f.files.keys(), 'RELEASE-MANIFEST.json', 'RELEASE_NOTES.md'];
  const entries = [];
  for (const name of names) entries.push(`${digest(await readFile(path.join(f.directory, name))).slice(7)}  ${name}`);
  await writeFile(path.join(f.directory, 'SHA256SUMS'), `${entries.join('\n')}\n`);
  const expected = [];
  for (const name of [...names, 'SHA256SUMS']) {
    const bytes = await readFile(path.join(f.directory, name));
    expected.push({ name, size: bytes.length, digest: digest(bytes) });
  }
  const stateFile = path.join(f.root, 'draft.json');
  const logFile = path.join(f.root, 'gh-calls');
  const state = { tag_name: 'v0.2.217', draft: true, target_commitish: commit, assets: [expected[0]] };
  await writeFile(stateFile, JSON.stringify(state));
  await writeFile(path.join(f.root, 'gh-interrupt'), 'once');
  await writeFile(path.join(f.root, 'bin/gh'), `#!/usr/bin/env node
const fs=require('fs'), path=require('path'), a=process.argv.slice(2);
const file=process.env.MOCK_GH_STATE, state=JSON.parse(fs.readFileSync(file));
const log=process.env.MOCK_GH_LOG;
if(a[0]==='api') console.log(JSON.stringify(state));
else if(a[0]==='release'&&a[1]==='upload'){
  const target=a[3],bytes=fs.readFileSync(target),name=path.basename(target);
  fs.appendFileSync(log,'UPLOAD '+name+'\\n');
  if(state.assets.some(x=>x.name===name))process.exit(3);
  state.assets.push({name,size:bytes.length,digest:'sha256:'+require('crypto').createHash('sha256').update(bytes).digest('hex')});
  fs.writeFileSync(file,JSON.stringify(state));
  const once=path.join(path.dirname(file),'gh-interrupt');
  if(fs.existsSync(once)){fs.unlinkSync(once);process.exit(1)}
}else process.exit(4);
`, { mode: 0o755 });
  const invoke = () => spawnSync(process.execPath, [draftScript, f.directory], { encoding: 'utf8', env: {
    ...process.env, PATH: `${f.root}/bin:${process.env.PATH}`, MOCK_GH_STATE: stateFile, MOCK_GH_LOG: logFile,
    GITHUB_REPOSITORY: repo, GITHUB_SHA: commit, GITHUB_RUN_ID: '42', RELEASE_TAG: 'v0.2.217', RELEASE_VERSION: '0.2.217',
  } });
  assert.notEqual(invoke().status, 0); // Upload committed but process lost its receipt.
  assert.equal(invoke().status, 0);
  assert.equal(invoke().status, 0);
  const calls = (await readFile(logFile, 'utf8')).trim().split('\n');
  assert.equal(calls.length, expected.length - 1);
  assert.equal(calls.filter((call) => call === `UPLOAD ${expected[1].name}`).length, 1);
  const changed = JSON.parse(await readFile(stateFile, 'utf8'));
  changed.assets[0].digest = digest('mismatch');
  await writeFile(stateFile, JSON.stringify(changed));
  assert.match(invoke().stderr, /identity mismatch/);
  assert.equal((await readFile(logFile, 'utf8')).trim().split('\n').length, calls.length);
});

test('same-run metadata and checksums do not change when the publish attempt increments', async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, RELEASE_VERSION: '0.2.217', GITHUB_REPOSITORY: 'openinterpreter/interpreter-workstation',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '42',
    GITHUB_WORKFLOW: 'Official release', GITHUB_SERVER_URL: 'https://github.com' };
  const first = spawnSync(process.execPath, [metadataScript, f.directory], { encoding: 'utf8', env: { ...env, GITHUB_RUN_ATTEMPT: '1' } });
  assert.equal(first.status, 0, first.stderr);
  const before = await readFile(path.join(f.directory, 'SHA256SUMS'), 'utf8');
  const second = spawnSync(process.execPath, [metadataScript, f.directory], { encoding: 'utf8', env: { ...env, GITHUB_RUN_ATTEMPT: '2' } });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(path.join(f.directory, 'SHA256SUMS'), 'utf8'), before);
});
