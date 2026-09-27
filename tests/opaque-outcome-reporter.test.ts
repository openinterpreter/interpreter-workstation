import { expect, test } from 'bun:test';
import { annotationForOutcome } from '../scripts/ci/emit-e2e-outcome';
import { outcomeForTests, validateOutcome } from './opaque-outcome-reporter';

const testCase = (id: string, status: 'expected' | 'unexpected' | 'flaky' | 'skipped') =>
  ({ id, outcome: () => status });

test('only closed counts and opaque IDs are emitted, with no test prose', () => {
  const outcome = outcomeForTests([
    testCase('dangerous title\n::error::secret', 'unexpected'),
    testCase('ordinary', 'expected'), testCase('retry', 'flaky'), testCase('skip', 'skipped'),
  ], true, false);
  expect(outcome.counts).toEqual({ total: 4, passed: 1, failed: 1, skipped: 1, flaky: 1 });
  expect(outcome.failedIds).toHaveLength(1);
  expect(outcome.failedIds[0]).toMatch(/^[a-f0-9]{32}$/);
  const annotation = annotationForOutcome(outcome);
  expect(annotation).not.toContain('dangerous');
  expect(annotation).not.toContain('secret');
  expect(annotation).not.toContain('\n');
});

test('more than 128 failures are counted but IDs are bounded', () => {
  const outcome = outcomeForTests(Array.from({ length: 130 }, (_, i) => testCase(`case-${i}`, 'unexpected')), false);
  expect(outcome.counts.failed).toBe(130);
  expect(outcome.failedIds).toHaveLength(128);
  expect(outcome.truncated).toBe(true);
  validateOutcome(outcome);
});

test('untrusted schema extensions or arbitrary strings cannot reach annotations', () => {
  const valid = outcomeForTests([testCase('case', 'unexpected')], true);
  for (const invalid of [
    { ...valid, message: 'raw failure' },
    { ...valid, failedIds: ['::error::hello'] },
    { ...valid, counts: { ...valid.counts, passed: -1 } },
    { ...valid, counts: { ...valid.counts, extra: 1 } },
    { ...valid, completed: false, runnerSucceeded: true },
  ]) expect(() => annotationForOutcome(invalid)).toThrow('Invalid E2E outcome');
});
