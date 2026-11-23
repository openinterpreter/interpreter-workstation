import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { draftPlan, findDraft, observeCreatedDraft } from './reconcile-release-draft.mjs';
import { listAllPages, objectState } from './reconcile-immutable-uploads.mjs';
import { snapshotId, verifyRestored } from './reconcile-release-metadata.mjs';

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const script = path.resolve('scripts/ci/reconcile-immutable-uploads.mjs');
const draftScript = path.resolve('scripts/ci/reconcile-release-draft.mjs');
const metadataScript = path.resolve('scripts/ci/write-release-metadata.mjs');
const reconcileMetadataScript = path.resolve('scripts/ci/reconcile-release-metadata.mjs');
const mockAws = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const a=process.argv.slice(2), root=process.env.MOCK_BUCKET_ROOT;
const value=(key)=>a[a.indexOf(key)+1];
const record=(line)=>fs.appendFileSync(path.join(root,'calls'),line+'\\n');
if(a[0]==='s3api'&&a[1]==='list-objects-v2'){
  const key=value('--prefix'), file=path.join(root,key);
  if(!a.includes('--no-paginate')){console.log(JSON.stringify({Contents:[]}));process.exit(0)}
  const once=path.join(root,'incomplete-listing-once');
  if(fs.existsSync(once)){fs.unlinkSync(once);console.log('{}');process.exit(0)}
  if(fs.existsSync(path.join(root,'incomplete-listing-always'))){console.log('{}');process.exit(0)}
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

test('metadata snapshot is unique, live, and bound to the same run', () => {
  const artifact = { id: 123, name: 'official-release-metadata', expired: false, workflow_run: { id: 42 } };
  assert.equal(snapshotId([], '42'), null);
  assert.equal(snapshotId([artifact], '42'), 123);
  assert.throws(() => snapshotId([artifact, artifact], '42'), /Duplicate/);
  assert.throws(() => snapshotId([{ ...artifact, expired: true }], '42'), /custody mismatch/);
  assert.throws(() => snapshotId([artifact], '43'), /custody mismatch/);
});

test('restored release metadata requires all original bytes and exact source/run custody', async (t) => {
  const f = await fixture(t);
  const repository = 'openinterpreter/interpreter-workstation';
  const commit = 'a'.repeat(40);
  await writeFile(path.join(f.directory, 'SBOM.spdx.json'), '{"packages":[]}');
  const manifest = JSON.stringify({ version: '0.2.219', source: { repository, commit }, build: { runId: '42' } });
  await writeFile(path.join(f.directory, 'RELEASE-MANIFEST.json'), manifest);
  const entries = [...f.files.keys(), 'SBOM.spdx.json', 'RELEASE-MANIFEST.json'];
  await writeFile(path.join(f.directory, 'SHA256SUMS'),
    `${(await Promise.all(entries.map(async (name) =>
      `${digest(await readFile(path.join(f.directory, name))).slice(7)}  ${name}`))).join('\n')}\n`);
  await verifyRestored(f.directory, '42', repository, commit, '0.2.219');
  await assert.rejects(verifyRestored(f.directory, '43', repository, commit, '0.2.219'), /identity mismatch/);
  await writeFile(path.join(f.directory, 'SBOM.spdx.json'), '{"packages":[1]}');
  await assert.rejects(verifyRestored(f.directory, '42', repository, commit, '0.2.219'), /checksum mismatch/);
});

test('publish retry restores first-attempt metadata and rejects changed installer bytes', async (t) => {
  const f = await fixture(t);
  const snapshot = path.join(f.root, 'snapshot');
  await mkdir(snapshot);
  const gh = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const a=process.argv.slice(2), root=process.env.MOCK_META_SNAPSHOT;
if(a[0]==='api'){
  const exists=fs.existsSync(path.join(root,'SHA256SUMS'));
  console.log(JSON.stringify({total_count:exists?1:0,artifacts:exists?[{id:123,name:'official-release-metadata',expired:false,workflow_run:{id:42}}]:[]}));
}else if(a[0]==='run'&&a[1]==='download'){
  const destination=a[a.indexOf('-D')+1];
  for(const name of ['SBOM.spdx.json','RELEASE-MANIFEST.json','SHA256SUMS'])fs.copyFileSync(path.join(root,name),path.join(destination,name));
}else process.exit(2);
`;
  await writeFile(path.join(f.root, 'bin/gh'), gh, { mode: 0o755 });
  await writeFile(path.join(f.directory, 'SBOM.spdx.json'), '{"created":"first"}');
  const output = path.join(f.root, 'output');
  const env = { ...process.env, PATH: `${f.root}/bin:${process.env.PATH}`, MOCK_META_SNAPSHOT: snapshot,
    GITHUB_REPOSITORY: 'openinterpreter/interpreter-workstation', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '42', RELEASE_VERSION: '0.2.219', GITHUB_REF: 'refs/heads/main', GITHUB_OUTPUT: output };
  const invoke = () => spawnSync(process.execPath, [reconcileMetadataScript, f.directory], { env, encoding: 'utf8' });
  assert.equal(invoke().status, 0);
  assert.match(await readFile(output, 'utf8'), /created=true/);
  for (const name of ['SBOM.spdx.json', 'RELEASE-MANIFEST.json', 'SHA256SUMS']) {
    await copyFile(path.join(f.directory, name), path.join(snapshot, name));
  }
  await writeFile(path.join(f.directory, 'SBOM.spdx.json'), '{"created":"retry"}');
  assert.equal(invoke().status, 0);
  assert.equal(await readFile(path.join(f.directory, 'SBOM.spdx.json'), 'utf8'), '{"created":"first"}');
  assert.match(await readFile(output, 'utf8'), /created=false/);
  await writeFile(path.join(f.directory, 'second.dmg'), 'changed installer');
  assert.match(invoke().stderr, /checksum mismatch/);
});

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

test('transient incomplete listing retries reads; persistent incomplete listing never uploads', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.bucket, 'incomplete-listing-once'), '1');
  assert.equal(f.invoke().status, 0);
  const before = (await f.calls()).filter((call) => call.startsWith('PUT')).length;
  await writeFile(path.join(f.bucket, 'incomplete-listing-always'), '1');
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Incomplete immutable object listing/);
  assert.equal((await f.calls()).filter((call) => call.startsWith('PUT')).length, before);
});

test('raw listing follows bounded continuation and rejects incomplete or duplicate pages', async () => {
  const key = 'releases/Interpreter-arm64-0.2.220.dmg';
  const opts = { bucket: 'fixture', 'endpoint-url': 'https://fixture.invalid', region: 'fixture' };
  const queried = [];
  const execute = async (args) => {
    queried.push(args);
    const next = args.includes('--continuation-token');
    return { code: 0, output: JSON.stringify(next
      ? { IsTruncated: false, KeyCount: 1, Contents: [{ Key: key, Size: 3 }] }
      : { IsTruncated: true, KeyCount: 1, Contents: [{ Key: `${key}.blockmap`, Size: 2 }],
        NextContinuationToken: 'opaque' }) };
  };
  assert.equal((await listAllPages(opts, key, execute)).length, 2);
  assert.equal(queried.length, 2);
  assert.ok(queried.every((args) => args.includes('--no-paginate')));
  assert.ok(queried[1].includes('--continuation-token'));
  await assert.rejects(listAllPages(opts, key, async () =>
    ({ code: 0, output: JSON.stringify({ IsTruncated: true, KeyCount: 0 }) })), /Incomplete/);
  await assert.rejects(listAllPages(opts, key, async () =>
    ({ code: 0, output: JSON.stringify({ IsTruncated: false, KeyCount: 1, Contents: [] }) })), /Incomplete/);
  await assert.rejects(listAllPages(opts, key, async () =>
    ({ code: 0, output: JSON.stringify({ IsTruncated: true, KeyCount: 0,
      NextContinuationToken: 'same' }) })), /Incomplete/);
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

test('new draft becomes visible only after bounded exact-identity reads', async () => {
  const commit = 'a'.repeat(40);
  const draft = { tag_name: 'v0.2.217', draft: true, target_commitish: commit, assets: [] };
  let reads = 0;
  const waits = [];
  const observed = await observeCreatedDraft(() => (++reads < 4 ? [] : [draft]), draft.tag_name, commit,
    { attempts: 5, intervalMs: 10, wait: async (ms) => { waits.push(ms); } });
  assert.equal(observed, draft);
  assert.equal(reads, 4);
  assert.deepEqual(waits, [10, 10, 10]);
});

test('draft visibility exhaustion never treats absence as permission to create again', async () => {
  let reads = 0;
  await assert.rejects(observeCreatedDraft(() => { reads++; return []; }, 'v0.2.217', 'a'.repeat(40),
    { attempts: 3, wait: async () => {} }), /not observable after 3 bounded reads/);
  assert.equal(reads, 3);
});

test('draft identity conflict and read failure abort without another observation', async () => {
  const commit = 'a'.repeat(40);
  let reads = 0;
  const wrong = { tag_name: 'v0.2.217', draft: true, target_commitish: 'b'.repeat(40), assets: [] };
  await assert.rejects(observeCreatedDraft(() => { reads++; return [wrong]; }, wrong.tag_name, commit,
    { wait: async () => { throw new Error('must not wait'); } }), /another commit/);
  assert.equal(reads, 1);
  await assert.rejects(observeCreatedDraft(() => { throw new Error('read failed'); }, wrong.tag_name, commit,
    { wait: async () => { throw new Error('must not wait'); } }), /read failed/);
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
