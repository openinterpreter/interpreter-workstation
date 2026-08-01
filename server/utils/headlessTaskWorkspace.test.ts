import { describe, expect, test } from 'bun:test';

import {
  getHeadlessTaskCliWorkspaceError,
  getProgrammaticTaskWorkspaceError,
  HEADLESS_TASK_CLI_WORKSPACE_ERROR,
  HEADLESS_TASK_WORKSPACE_ERROR,
  normalizeHeadlessTaskWorkspace,
} from './headlessTaskWorkspace';

describe('headlessTaskWorkspace', () => {
  test('normalizes explicit workspace values', () => {
    expect(normalizeHeadlessTaskWorkspace('  /tmp/worker-workspace  ')).toBe('/tmp/worker-workspace');
    expect(normalizeHeadlessTaskWorkspace('   ')).toBeUndefined();
    expect(normalizeHeadlessTaskWorkspace(undefined)).toBeUndefined();
  });

  test('requires workspace for headless programmatic tasks', () => {
    expect(getProgrammaticTaskWorkspaceError('headless', undefined)).toBe(
      HEADLESS_TASK_WORKSPACE_ERROR,
    );
    expect(getProgrammaticTaskWorkspaceError('headed', undefined)).toBeNull();
    expect(getProgrammaticTaskWorkspaceError('headless', '/tmp/worker-workspace')).toBeNull();
  });

  test('requires workspace for headless CLI runs', () => {
    expect(getHeadlessTaskCliWorkspaceError(undefined)).toBe(
      HEADLESS_TASK_CLI_WORKSPACE_ERROR,
    );
    expect(getHeadlessTaskCliWorkspaceError('/tmp/worker-workspace')).toBeNull();
  });
});
