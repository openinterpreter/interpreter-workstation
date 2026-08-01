/**
 * Interpreter Server
 *
 * Provides tools for querying and controlling the Interpreter UI.
 * Tools use the workstationService for direct access to the Electron main process.
 */

import type { BuiltinServerDefinition } from '../../builtinTools';
import { getContextTool } from './getContextTool';
import { getLayoutTool } from './getLayoutTool';
import { setLayoutTool } from './setLayoutTool';
import { getSelectionTool } from './getSelectionTool';
import { closeTabTool } from './closeTabTool';
import { refreshFileTool } from './refreshFileTool';
import { settingsGetTool } from './settingsGetTool';
import { settingsSetTool } from './settingsSetTool';
import { usageGetTool } from './usageGetTool';
import { vaultTool } from './vaultTool';
import { showInFolderTool } from './showInFolderTool';
import {
  customInstructionsGetTool,
  customInstructionsSetTool,
} from './customInstructionsTool';
import { wholeComputerStateGetTool } from './wholeComputerStateTool';
import { browserTabActivateTool } from './browserTabActivateTool';
import { browserPageInspectTool } from './browserPageInspectTool';
import { browserPageTraceTool } from './browserPageTraceTool';
import { browserPageClickTool } from './browserPageClickTool';
import { browserPageTypeTool } from './browserPageTypeTool';
import { browserPageSelectTool } from './browserPageSelectTool';
import { browserPageScrollTool } from './browserPageScrollTool';
import { readImageTool } from './readImageTool';

export const interpreterServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-interpreter',
  name: 'Interpreter',
  description: 'Query and control the Interpreter app UI',
  isBuiltin: true,
  tools: [
    getContextTool,
    getLayoutTool,
    setLayoutTool,
    getSelectionTool,
    closeTabTool,
    refreshFileTool,
    showInFolderTool,
    vaultTool,
    settingsGetTool,
    settingsSetTool,
    customInstructionsGetTool,
    customInstructionsSetTool,
    wholeComputerStateGetTool,
    readImageTool,
    browserTabActivateTool,
    browserPageInspectTool,
    browserPageTraceTool,
    browserPageClickTool,
    browserPageTypeTool,
    browserPageSelectTool,
    browserPageScrollTool,
    usageGetTool,
  ],
  resources: [],
  prompts: [],
};
