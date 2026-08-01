import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MENU_LABEL = 'Ask Interpreter to Edit This';
const WINDOWS_VERB = 'AskInterpreterAboutSelection';
const MAC_FINDER_SYNC_BUNDLE_ID = 'interpreter.finder-sync';

export interface ShellIntegrationOptions {
  executablePath: string;
  platform: NodeJS.Platform;
}

export async function ensureShellIntegrationInstalled(options: ShellIntegrationOptions): Promise<void> {
  if (options.platform === 'win32') {
    await ensureWindowsExplorerIntegration(options.executablePath);
    return;
  }

  if (options.platform === 'darwin') {
    await ensureMacFinderSyncExtensionEnabled();
  }
}

async function ensureWindowsExplorerIntegration(executablePath: string): Promise<void> {
  const command = `"${executablePath}" --ask "%1" %*`;
  const icon = `"${executablePath}",0`;
  const shellKeys = [
    String.raw`HKCU\Software\Classes\*\shell\${WINDOWS_VERB}`,
    String.raw`HKCU\Software\Classes\Directory\shell\${WINDOWS_VERB}`,
    String.raw`HKCU\Software\Classes\Folder\shell\${WINDOWS_VERB}`,
  ];

  for (const shellKey of shellKeys) {
    await regAdd(shellKey, '/ve', MENU_LABEL);
    await regAdd(shellKey, '/v', 'MUIVerb', MENU_LABEL);
    await regAdd(shellKey, '/v', 'Icon', icon);
    await regAdd(shellKey, '/v', 'MultiSelectModel', 'Player');
    await regAdd(`${shellKey}\\command`, '/ve', command);
  }
}

async function regAdd(key: string, valueMode: '/ve' | '/v', ...args: string[]): Promise<void> {
  const regArgs = ['add', key, valueMode, ...args, '/f'];
  if (valueMode === '/v') {
    regArgs.splice(4, 0, '/d');
  } else {
    regArgs.splice(3, 0, '/d');
  }
  await execFileAsync('reg.exe', regArgs, { windowsHide: true });
}

async function ensureMacFinderSyncExtensionEnabled(): Promise<void> {
  await execFileAsync('/usr/bin/pluginkit', ['-e', 'use', '-i', MAC_FINDER_SYNC_BUNDLE_ID]);
}
