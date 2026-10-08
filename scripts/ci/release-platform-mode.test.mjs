import assert from 'node:assert/strict';
import test from 'node:test';
import { decidePlatformMode } from './release-platform-mode.mjs';

const sha = 'a'.repeat(40);
const context = { runId: '123', sha, attempt: '1' };
const jobs = () => ['Build macos-arm64', 'Build macos-x64', 'Build windows-x64', 'Build linux-x64']
  .map((name, index) => ({ name, id: index + 1, run_id: 123, run_attempt: 1, head_sha: sha,
    status: 'completed', conclusion: 'success', steps: [
      { number: 13, conclusion: 'success' }, { number: 14, conclusion: 'success' },
    ] }));

test('all four successful jobs enable the full release', () => {
  assert.equal(decidePlatformMode(jobs(), context), 'all');
});

test('two packaging failures retain only verified Windows and Linux', () => {
  const source = jobs();
  for (const job of source.slice(0, 2)) {
    job.conclusion = 'failure';
    job.steps[1].conclusion = 'failure';
  }
  assert.equal(decidePlatformMode(source, context), 'windows-linux');
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
  source[0].steps[1].conclusion = 'failure';
  assert.throws(() => decidePlatformMode(source, context));
  source[1].conclusion = 'failure';
  source[1].steps[1].conclusion = 'failure';
  source[1].steps[0].conclusion = 'failure';
  assert.throws(() => decidePlatformMode(source, context));
  source[1].steps[0].conclusion = 'success';
  source[1].run_id = 999;
  assert.throws(() => decidePlatformMode(source, context));
});
