import { beforeEach, describe, expect, test } from 'bun:test';

import {
  getCurrentRuntimeLogFilePath,
  initializeRuntimeLogFilePath,
  resetCurrentRuntimeLogFilePath,
  setCurrentRuntimeLogFilePath,
} from './runtimeLogFile';

describe('runtimeLogFile', () => {
  beforeEach(() => {
    initializeRuntimeLogFilePath('/tmp/default-session.log');
  });

  test('tracks the initialized runtime log file path', () => {
    expect(getCurrentRuntimeLogFilePath()).toBe('/tmp/default-session.log');
  });

  test('returns the active redirected runtime log path after updates', () => {
    setCurrentRuntimeLogFilePath('/tmp/per-test.log');

    expect(getCurrentRuntimeLogFilePath()).toBe('/tmp/per-test.log');
  });

  test('resets back to the initialized runtime log path', () => {
    setCurrentRuntimeLogFilePath('/tmp/per-test.log');
    resetCurrentRuntimeLogFilePath();

    expect(getCurrentRuntimeLogFilePath()).toBe('/tmp/default-session.log');
  });
});
