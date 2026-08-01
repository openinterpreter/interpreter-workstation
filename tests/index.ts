/**
 * Exportable test utilities for external test suites
 *
 * Usage in external tests:
 *
 * ```typescript
 * import {
 *   configureTests,
 *   createExternalConfig,
 *   test,
 *   expect,
 *   clearUserConfig,
 *   waitForAppReady,
 *   recordTest,
 * } from 'interpreter/tests';
 *
 * // Configure for external use
 * configureTests(createExternalConfig(
 *   '/path/to/agent',      // Where the Electron app is built
 *   '/path/to/agent-tasks' // Where test outputs go
 * ));
 * ```
 */

// Configuration
export {
  configureTests,
  getTestConfig,
  resetTestConfig,
  createExternalConfig,
  type TestConfig,
} from './test-config';

// Playwright fixtures
export { test, expect, UI_TEXT, TIMEOUTS } from './fixtures';
export type { Page } from '@playwright/test';

// Helper utilities
export {
  clearUserConfig,
  takeScreenshot,
  setupPageLogging,
  waitForAppReady,
  clearLayoutState,
} from './helpers';

// Recording and logging
export { recordTest, getTestRunDir, getTestLogPath } from './test-recorder';

// Electron instance management
export { ElectronInstanceManager } from './electron-instance';

// Selectors (type-safe test IDs)
export { sel, testId } from './selectors';
export { ELEMENT_IDS } from '../shared/element-ids';
export type { StaticElementId, ElementIdKey } from '../shared/element-ids';
