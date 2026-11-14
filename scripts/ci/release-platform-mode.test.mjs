import assert from 'node:assert/strict';
import test from 'node:test';
import { decidePlatformMode } from './release-platform-mode.mjs';

const sha = 'a'.repeat(40);
const context = { runId: '123', sha, attempt: '1' };
const jobs = () => ['Build macos-arm64', 'Build macos-x64', 'Build windows-x64', 'Build linux-x64']
  .map((name, index) => ({ name, id: index + 1, run_id: 123, run_attempt: 1, head_sha: sha,
    status: 'completed', conclusion: 'success', steps: [
      { number: 13, name: 'Patch electron-builder temporary keychain authentication', conclusion: 'success' },
      { number: 14, name: 'Prepare the passwordless macOS signing certificate', conclusion: 'success' },
      { number: 15, name: 'Build signed and notarized macOS package', conclusion: 'success' },
    ] }));

test('all four successful jobs enable the full release', () => {
  assert.equal(decidePlatformMode(jobs(), context), 'all');
});

test('two packaging failures retain only verified Windows and Linux', () => {
  const source = jobs();
  for (const job of source.slice(0, 2)) {
    job.conclusion = 'failure';
    job.steps[2].conclusion = 'failure';
  }
  assert.equal(decidePlatformMode(source, context), 'windows-linux');
});

test('explicit Windows/Linux run verifies exactly its current-run build jobs without starting macOS', () => {
  const source = jobs().slice(2);
  assert.equal(decidePlatformMode(source, { ...context, requestedMode: 'windows-linux' }), 'windows-linux');
  assert.throws(() => decidePlatformMode(jobs(), { ...context, requestedMode: 'windows-linux' }));
  source[0].conclusion = 'failure';
  assert.throws(() => decidePlatformMode(source, { ...context, requestedMode: 'windows-linux' }));
  source[0].conclusion = 'success';
  source[1].head_sha = 'b'.repeat(40);
  assert.throws(() => decidePlatformMode(source, { ...context, requestedMode: 'windows-linux' }));
  assert.throws(() => decidePlatformMode(source, { ...context, requestedMode: '' }));
});

test('missing or failed Windows/Linux jobs never publish', () => {
  const source = jobs();
  assert.throws(() => decidePlatformMode(source.slice(1), context));
  source[2].conclusion = 'failure';
  assert.throws(() => decidePlatformMode(source, context));
});

test('other macOS failures, cancellations and mismatched run identities fail closed', () => {
  const source = jobs();
  source[0].conclusion = 'failure';
  source[0].steps[2].conclusion = 'failure';
  assert.throws(() => decidePlatformMode(source, context));
  source[1].conclusion = 'failure';
  source[1].steps[2].conclusion = 'failure';
  source[1].steps[1].conclusion = 'failure';
  assert.throws(() => decidePlatformMode(source, context));
  source[1].steps[1].conclusion = 'success';
  source[1].run_id = 999;
  assert.throws(() => decidePlatformMode(source, context));
});

test('fallback recognizes an extra successful setup step without relaxing package-only failure', () => {
  const source = jobs();
  for (const job of source.slice(0, 2)) {
    job.conclusion = 'failure';
    job.steps.splice(1, 0, { number: 14, name: 'Additional setup', conclusion: 'success' });
    job.steps[2].number = 15;
    job.steps[3].number = 16;
    job.steps[3].conclusion = 'failure';
  }
  assert.equal(decidePlatformMode(source, context), 'windows-linux');
  source[0].steps[1].conclusion = 'failure';
  assert.throws(() => decidePlatformMode(source, context));
});

test('fallback refuses ambiguous or missing named macOS steps', () => {
  const source = jobs();
  for (const job of source.slice(0, 2)) {
    job.conclusion = 'failure';
    job.steps[2].conclusion = 'failure';
  }
  source[0].steps[2].name = 'Unexpected failure';
  assert.throws(() => decidePlatformMode(source, context));
  source[0].steps[2].name = source[0].steps[1].name;
  assert.throws(() => decidePlatformMode(source, context));
});
