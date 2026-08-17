import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile('.github/workflows/release.yml', 'utf8');
const electronBuilderConfig = await readFile('electron-builder.yml', 'utf8');

function section(start, end) {
  const startIndex = workflow.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing workflow section: ${start}`);
  const endIndex = end ? workflow.indexOf(end, startIndex + start.length) : workflow.length;
  assert.notEqual(endIndex, -1, `Missing workflow boundary: ${end}`);
  return workflow.slice(startIndex, endIndex);
}

test('official release is dispatched only by InterpreterWork from main', () => {
  const authorize = section('  authorize:', '  verify:');
  assert.match(authorize, /github\.actor == 'interpreterwork'/);
  assert.match(authorize, /github\.ref == 'refs\/heads\/main'/);
  assert.match(authorize, /inputs\.confirm == 'release'/);
});

test('publishing authority is not exposed at job scope', () => {
  const publish = section('  publish:');
  const envStart = publish.indexOf('    env:');
  const stepsStart = publish.indexOf('    steps:', envStart);
  assert.ok(envStart >= 0 && stepsStart > envStart);
  const jobEnvironment = publish.slice(envStart, stepsStart);
  assert.doesNotMatch(jobEnvironment, /\$\{\{ secrets\./);
  assert.doesNotMatch(jobEnvironment, /GH_TOKEN:/);

  assert.equal((publish.match(/AWS_ACCESS_KEY_ID:/g) ?? []).length, 2);
  assert.equal((publish.match(/AWS_SECRET_ACCESS_KEY:/g) ?? []).length, 2);
  assert.equal((publish.match(/GH_TOKEN:/g) ?? []).length, 2);
});

test('the GitHub read token is scoped to dependency installation', () => {
  const verify = section('  verify:', '  build:');
  const build = section('  build:', '  publish:');

  assert.doesNotMatch(verify.slice(0, verify.indexOf('    steps:')), /GITHUB_TOKEN:/);
  assert.doesNotMatch(build.slice(0, build.indexOf('    steps:')), /GITHUB_TOKEN:/);
  assert.equal((verify.match(/GITHUB_TOKEN:/g) ?? []).length, 1);
  assert.equal((build.match(/GITHUB_TOKEN:/g) ?? []).length, 1);
});

test('installed clients discover a release only after GitHub publication', () => {
  const publish = section('  publish:');
  const payloads = publish.indexOf('Upload immutable payloads to the public Supabase bucket');
  const github = publish.indexOf('Publish the GitHub release');
  const manifests = publish.indexOf('Publish auto-update manifests last');

  assert.ok(payloads >= 0 && github > payloads && manifests > github);
  assert.equal(publish.indexOf('Publish the GitHub release', github + 1), -1);
});

test('release packaging does not rebuild N-API native dependencies', () => {
  assert.match(electronBuilderConfig, /^npmRebuild: false$/m);
});
