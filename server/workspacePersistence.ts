import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve as pathResolve } from 'path';
import { homedir } from 'os';
import * as configStore from './configStore';

const CONFIG_DIR = join(homedir(), '.interpreter');
const DEFAULT_WORKSPACE_BASE = 'My Workspace';

/**
 * Find the next available workspace name.
 * If "My Workspace" exists, tries "My Workspace (1)", "My Workspace (2)", etc.
 */
function getNextAvailableWorkspaceName(basePath: string, baseName: string): string {
  // Try the base name first
  if (!existsSync(join(basePath, baseName))) {
    return baseName;
  }

  // Find the next available number
  let counter = 1;
  while (true) {
    const numberedName = `${baseName} (${counter})`;
    if (!existsSync(join(basePath, numberedName))) {
      return numberedName;
    }
    counter++;
    // Safety limit to prevent infinite loop
    if (counter > 1000) {
      throw new Error('Too many workspace folders exist');
    }
  }
}

/**
 * Get the path to sample workspace files (works in both dev and packaged app)
 */
function getSampleWorkspacePath(): string {
  // In packaged app, use process.resourcesPath
  if (process.resourcesPath) {
    const prodPath = join(process.resourcesPath, 'resources', 'sample-workspace');
    if (existsSync(prodPath)) {
      console.log('[WorkspacePersistence] Using production sample path:', prodPath);
      return prodPath;
    }
  }

  // In dev mode, __dirname is dist-electron/electron (compiled output)
  // Need to go up two levels to reach project root where resources/ lives
  const projectRoot = join(dirname(__dirname), '..');
  const devPath = join(projectRoot, 'resources', 'sample-workspace');
  console.log('[WorkspacePersistence] Checking dev sample path:', devPath);
  if (existsSync(devPath)) {
    return devPath;
  }

  // Fallback: try relative to source location (for sidecar/standalone mode)
  const sourcePath = join(dirname(__dirname), 'resources', 'sample-workspace');
  console.log('[WorkspacePersistence] Checking source sample path:', sourcePath);
  if (existsSync(sourcePath)) {
    return sourcePath;
  }

  console.log('[WorkspacePersistence] No sample workspace found at any path');
  return devPath; // Return dev path even if it doesn't exist (will handle gracefully)
}

/**
 * Recursively copy a directory
 */
function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src);

  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function getSampleWorkspaceModifierKey(): string {
  return process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
}

function applySampleWorkspaceTemplate(workspacePath: string): void {
  const welcomeDocPath = join(workspacePath, 'Welcome.md');
  const welcomeDocTemplate = readFileSync(welcomeDocPath, 'utf-8');
  const welcomeDoc = welcomeDocTemplate.split('{{MOD_KEY}}').join(getSampleWorkspaceModifierKey());
  writeFileSync(welcomeDocPath, welcomeDoc, 'utf-8');
}

/**
 * Create the default workspace with sample files for first-time users.
 * Uses "My Workspace" as the name, or "My Workspace (1)", etc. if it already exists.
 */
async function createDefaultWorkspace(): Promise<string | null> {
  const documentsPath = join(homedir(), 'Documents');

  // Make sure Documents exists
  if (!existsSync(documentsPath)) {
    console.log('[WorkspacePersistence] Documents folder does not exist, cannot create default workspace');
    return null;
  }

  try {
    // Get the next available workspace name
    const workspaceName = getNextAvailableWorkspaceName(documentsPath, DEFAULT_WORKSPACE_BASE);
    const workspacePath = join(documentsPath, workspaceName);

    const samplePath = getSampleWorkspacePath();

    if (existsSync(samplePath)) {
      // Copy sample files
      console.log('[WorkspacePersistence] Creating default workspace with samples:', workspacePath);
      copyDirSync(samplePath, workspacePath);
      applySampleWorkspaceTemplate(workspacePath);
    } else {
      // Just create empty folder
      console.log('[WorkspacePersistence] Creating empty default workspace:', workspacePath);
      mkdirSync(workspacePath, { recursive: true });
    }

    return workspacePath;
  } catch (error) {
    console.error('[WorkspacePersistence] Error creating default workspace:', error);
    return null;
  }
}

/**
 * Get the default workspace path.
 * In test mode or browser dev mode (BROWSER_DEV=true), returns test workspace.
 * Otherwise returns Desktop if it exists, then home directory.
 */
function getDefaultWorkspace(): string {
  // In test mode or browser dev mode, use the test workspace
  if (process.env.NODE_ENV === 'test' || process.env.BROWSER_DEV === 'true') {
    const testWorkspacePath = join(process.cwd(), 'tests', 'test-workspace');
    if (existsSync(testWorkspacePath)) {
      console.log('[WorkspacePersistence] Using test workspace:', testWorkspacePath);
      return testWorkspacePath;
    }
  }

  const desktopPath = join(homedir(), 'Desktop');

  if (existsSync(desktopPath)) {
    return desktopPath;
  }

  // Fall back to home directory instead of cwd (which could be inside app bundle when packaged)
  return homedir();
}

/**
 * Load the last saved workspace path.
 * For first-time users, creates ~/Documents/My Workspace with sample files.
 * Returns the saved workspace if it exists and is valid.
 * In browser dev mode (BROWSER_DEV=true), always uses the test workspace.
 * Returns null if no workspace is set (e.g., user closed folder).
 */
export async function loadLastWorkspace(): Promise<string | null> {
  // In test mode, use test workspace
  if (process.env.NODE_ENV === 'test') {
    const testWorkspacePath = join(process.cwd(), 'tests', 'test-workspace');
    if (existsSync(testWorkspacePath)) {
      console.log('[WorkspacePersistence] Using test workspace:', testWorkspacePath);
      return testWorkspacePath;
    }
  }

  // In browser dev mode, always use test workspace (ignore saved workspace)
  if (process.env.BROWSER_DEV === 'true') {
    const defaultWorkspace = getDefaultWorkspace();
    console.log('[WorkspacePersistence] Browser dev mode - using:', defaultWorkspace);
    return defaultWorkspace;
  }

  try {
    // Try to read the saved workspace from config
    const savedPath = await configStore.getLastWorkspace();

    if (savedPath) {
      // Use pathResolve instead of normalizePath to preserve Unicode characters
      const resolvedPath = pathResolve(savedPath);

      // Verify the path still exists
      if (existsSync(resolvedPath)) {
        console.log('[WorkspacePersistence] Loaded last workspace:', resolvedPath);
        return resolvedPath;
      } else {
        console.log('[WorkspacePersistence] Last workspace no longer exists:', resolvedPath);
      }
    }
    // If savedPath is null/undefined, continue to fallbacks below
  } catch (error) {
    console.error('[WorkspacePersistence] Error loading last workspace:', error);
  }

  // Fallback 2: Try file-tree-cache.json workspacePath
  const cacheFile = join(CONFIG_DIR, 'file-tree-cache.json');
  if (existsSync(cacheFile)) {
    try {
      const cache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      if (cache.workspacePath && existsSync(cache.workspacePath)) {
        console.log('[WorkspacePersistence] Using workspace from cache:', cache.workspacePath);
        return cache.workspacePath;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Fallback 3: Try recentFolders[0] from config
  try {
    const recentFolders = await configStore.getRecentFolders();
    const recent = recentFolders[0]?.path;
    if (recent && existsSync(recent)) {
      console.log('[WorkspacePersistence] Using most recent folder:', recent);
      return recent;
    }
  } catch {
    // Ignore errors
  }

  // First launch - create default workspace
  console.log('[WorkspacePersistence] No workspace history, creating default workspace');
  const defaultWorkspace = await createDefaultWorkspace();
  if (defaultWorkspace) {
    await configStore.setLastWorkspace(defaultWorkspace);
    return defaultWorkspace;
  }

  // Ultimate fallback to Desktop or home
  const fallbackWorkspace = getDefaultWorkspace();
  console.log('[WorkspacePersistence] Using fallback workspace:', fallbackWorkspace);
  return fallbackWorkspace;
}

/**
 * Save the current workspace path for future sessions.
 */
export async function saveLastWorkspace(workspacePath: string): Promise<void> {
  try {
    await configStore.setLastWorkspace(workspacePath);
    console.log('[WorkspacePersistence] Saved workspace:', workspacePath);
  } catch (error) {
    console.error('[WorkspacePersistence] Error saving workspace:', error);
  }
}

/**
 * Close the current workspace (for the current session only).
 * Does NOT clear lastWorkspace from config - on restart, the last opened folder will reopen.
 * This allows the app to run without a folder open temporarily.
 */
export async function closeWorkspace(): Promise<void> {
  // Don't clear lastWorkspace from config - we want to reopen it on restart
  // The in-memory workspace is already cleared by setCurrentWorkspace(null) in menu.ts
  console.log('[WorkspacePersistence] Workspace closed (session only, will reopen on restart)');
}

/**
 * Create a new workspace folder with sample files.
 * Uses "My Workspace" as the base name, with automatic numbering if needed.
 * Returns the path to the created workspace.
 */
export async function createNewWorkspace(): Promise<string | null> {
  return createDefaultWorkspace();
}

/**
 * Rename a workspace folder and return the new path.
 * @param oldPath The current full path of the workspace
 * @param newName The new folder name (not full path)
 * @returns The new full path, or null if rename failed
 */
export async function renameWorkspace(oldPath: string, newName: string): Promise<string | null> {
  try {
    const { rename } = await import('fs/promises');
    const parentDir = dirname(oldPath);
    const newPath = join(parentDir, newName);

    // Check if the new path already exists
    if (existsSync(newPath)) {
      console.error('[WorkspacePersistence] Cannot rename: destination already exists:', newPath);
      return null;
    }

    await rename(oldPath, newPath);
    console.log('[WorkspacePersistence] Renamed workspace:', oldPath, '->', newPath);
    return newPath;
  } catch (error) {
    console.error('[WorkspacePersistence] Error renaming workspace:', error);
    return null;
  }
}
