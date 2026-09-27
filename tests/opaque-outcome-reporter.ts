import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase } from '@playwright/test/reporter';

export type OpaqueOutcome = {
  schema: 1;
  completed: boolean;
  runnerSucceeded: boolean;
  counts: { total: number; passed: number; failed: number; skipped: number; flaky: number };
  failedIds: string[];
  truncated: boolean;
};

const MAX_TESTS = 10_000;
const MAX_IDS = 128;
const ID = /^[a-f0-9]{32}$/;

/** Only counts and one-way opaque identifiers leave the test runner. */
export function outcomeForTests(tests: readonly Pick<TestCase, 'id' | 'outcome'>[], completed: boolean, runnerSucceeded = false): OpaqueOutcome {
  if (tests.length > MAX_TESTS) throw new Error('E2E outcome exceeds bounded test count');
  const counts = { total: tests.length, passed: 0, failed: 0, skipped: 0, flaky: 0 };
  const failedIds: string[] = [];
  for (const test of tests) {
    const outcome = test.outcome();
    if (outcome === 'unexpected') {
      counts.failed++;
      if (failedIds.length < MAX_IDS) {
        failedIds.push(createHash('sha256').update('workstation-e2e-v1\0').update(test.id).digest('hex').slice(0, 32));
      }
    } else if (outcome === 'flaky') counts.flaky++;
    else if (outcome === 'skipped') counts.skipped++;
    else if (outcome === 'expected') counts.passed++;
    else throw new Error('Unknown E2E outcome');
  }
  failedIds.sort();
  const result: OpaqueOutcome = { schema: 1, completed, runnerSucceeded, counts, failedIds, truncated: counts.failed > MAX_IDS };
  validateOutcome(result);
  return result;
}

export function validateOutcome(value: unknown): asserts value is OpaqueOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid E2E outcome');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'completed,counts,failedIds,runnerSucceeded,schema,truncated' ||
      v.schema !== 1 || typeof v.completed !== 'boolean' || typeof v.runnerSucceeded !== 'boolean' ||
      (v.runnerSucceeded && !v.completed) || typeof v.truncated !== 'boolean' ||
      !v.counts || typeof v.counts !== 'object' || Array.isArray(v.counts)) throw new Error('Invalid E2E outcome schema');
  const counts = v.counts as Record<string, unknown>;
  if (Object.keys(counts).sort().join(',') !== 'failed,flaky,passed,skipped,total' ||
      Object.values(counts).some(n => !Number.isSafeInteger(n) || (n as number) < 0) ||
      (counts.total as number) > MAX_TESTS ||
      counts.total !== (counts.failed as number) + (counts.flaky as number) +
        (counts.passed as number) + (counts.skipped as number)) throw new Error('Invalid E2E outcome counts');
  if (!Array.isArray(v.failedIds) || v.failedIds.length > MAX_IDS ||
      v.failedIds.length !== Math.min(counts.failed as number, MAX_IDS) ||
      v.failedIds.some(id => typeof id !== 'string' || !ID.test(id)) ||
      new Set(v.failedIds).size !== v.failedIds.length ||
      v.truncated !== ((counts.failed as number) > MAX_IDS)) throw new Error('Invalid E2E outcome IDs');
}

export default class OpaqueOutcomeReporter implements Reporter {
  private suite: Suite | undefined;

  onBegin(_config: FullConfig, suite: Suite): void { this.suite = suite; }

  onEnd(result: FullResult): void {
    const destination = process.env.INTERPRETER_E2E_OUTCOME_FILE;
    if (!destination) return;
    if (!this.suite) throw new Error('E2E test suite was not initialized');
    const outcome = outcomeForTests(this.suite.allTests(), result.status === 'passed' || result.status === 'failed', result.status === 'passed');
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.writing`;
    writeFileSync(temporary, `${JSON.stringify(outcome)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, destination);
  }
}
