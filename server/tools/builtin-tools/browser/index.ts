import type { BuiltinServerDefinition } from '../../builtinTools';
import { getTabStateTool } from './getTabStateTool';
import { takeScreenshotTool } from './takeScreenshotTool';
import { navigateTool } from './navigateTool';
import { goBackTool } from './goBackTool';
import { goForwardTool } from './goForwardTool';
import { reloadTool } from './reloadTool';
import { readPageTool } from './readPageTool';
import { clickTool } from './clickTool';
import { formInputTool } from './formInputTool';

/**
 * Normalize a browser tab ID by stripping the browser:// protocol prefix if present.
 * Browser mentions serialize with browser:// protocol (e.g., browser://UUID) to help
 * agents distinguish them from file paths, but the browser service expects raw UUIDs.
 */
export function normalizeBrowserId(tabId: string): string {
  if (tabId.startsWith('browser://')) {
    return tabId.slice('browser://'.length);
  }
  return tabId;
}

export {
  getTabStateTool,
  takeScreenshotTool,
  navigateTool,
  goBackTool,
  goForwardTool,
  reloadTool,
  readPageTool,
  clickTool,
  formInputTool,
};

export const browserServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-browser',
  name: 'Browser',
  description: 'Browser tab content interaction tools (tab management moved to workstation)',
  isBuiltin: true,
  tools: [
    getTabStateTool,
    takeScreenshotTool,
    navigateTool,
    goBackTool,
    goForwardTool,
    reloadTool,
    readPageTool,
    clickTool,
    formInputTool,
  ],
  resources: [],
  prompts: []
};
