/** A real project capability, never a fabricated directory check or native IPC fallback. */
import type { ProjectFiles } from './project';

export type BrowserProjectFiles = {
  isDirectory: (projectPath: string) => Promise<boolean>;
};

/** Adapt a bound OPFS/in-memory ProjectFiles instance without using desktop IPC. */
export function projectFilesWorkspaceCapability(projectId: string, files: ProjectFiles): BrowserProjectFiles {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId) || typeof files?.list !== 'function')
    throw new Error('Invalid browser project files capability');
  const boundPath = `browser-project:${projectId}`;
  return {
    isDirectory: async (path) => {
      if (path !== boundPath) return false;
      // A real operation against the bound project; storage failure propagates.
      await files.list();
      return true;
    },
  };
}

export type BrowserProjectWorkspaceHost = Readonly<{
  workspacePath: string;
  projectFiles: BrowserProjectFiles;
}>;

/** Never resolve a different project or desktop path through a browser capability. */
export async function resolveBrowserProjectWorkspace(host: BrowserProjectWorkspaceHost,
  workspacePath: string | null | undefined): Promise<string> {
  if (workspacePath !== host.workspacePath || !/^browser-project:[a-zA-Z0-9_-]{1,64}$/.test(host.workspacePath))
    throw new Error('Browser project workspace does not match the active project');
  if (!(await host.projectFiles.isDirectory(host.workspacePath)))
    throw new Error('Browser project workspace is unavailable');
  return host.workspacePath;
}
