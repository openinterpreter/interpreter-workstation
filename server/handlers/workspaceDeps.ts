export {
  getCurrentWorkspace,
  resolveWorkspacePath,
  setCurrentWorkspace,
} from '../utils/workspace';
export {
  createNewWorkspace,
  closeWorkspace,
  saveLastWorkspace,
} from '../workspacePersistence';
export { addRecentFolder } from '../configStore';
export { broadcastEvent } from './broadcast';
export {
  getCurrentWindowSessionKey,
  listWindowSessions,
  updateWindowSessionWorkspace,
} from '../utils/windowSessions';
export {
  bindWindowSessionWorkspace,
  clearGlobalWorkspaceWatch,
  initializeGlobalWorkspaceWatch,
} from '../workspaceWatchRegistry';
export { onWorkspaceChanged } from './skills';
