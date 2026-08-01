// NOTE(victor): bun shares one module cache across all test files in a single
// process. Never mock.module() this file in tests -- it replaces getToolManager
// globally and breaks every other test that calls it (bun #6024). Use
// setToolManager({...} as any) instead, which mutates _toolManager in-place.

import type { ToolManager } from './toolManager';

let _toolManager: ToolManager | null = null;

export function setToolManager(tm: ToolManager): void {
  _toolManager = tm;
}

export function getToolManager(): ToolManager {
  if (!_toolManager) {
    throw new Error('ToolManager not initialized. This should not happen during normal operation.');
  }
  return _toolManager;
}
