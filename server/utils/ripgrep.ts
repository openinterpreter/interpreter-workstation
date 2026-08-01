import { spawn } from 'child_process';
import * as fs from 'fs';
import * as rgPath from '@vscode/ripgrep';

export function resolveRipgrepBinaryPath(ripgrepPath: string): string {
  if (ripgrepPath.includes('app.asar') && !ripgrepPath.includes('app.asar.unpacked')) {
    return ripgrepPath.replace('app.asar', 'app.asar.unpacked');
  }
  return ripgrepPath;
}

export async function validateRipgrepBinary(): Promise<{
  ok: boolean;
  path: string;
  version?: string;
  error?: string;
}> {
  const resolvedPath = resolveRipgrepBinaryPath(rgPath.rgPath);

  if (!fs.existsSync(resolvedPath)) {
    const message = `ripgrep binary not found at: ${resolvedPath}`;
    console.error(`[ripgrep] ${message}`);
    return { ok: false, path: resolvedPath, error: message };
  }

  return new Promise((resolve) => {
    const rg = spawn(resolvedPath, ['--version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });

    let stdout = '';
    rg.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    rg.on('close', (code) => {
      const version = stdout.trim().split('\n')[0] || '';
      if (code === 0 && version) {
        console.log(`[ripgrep] validated: ${resolvedPath} (${version})`);
        resolve({ ok: true, path: resolvedPath, version });
        return;
      }
      const message = `ripgrep exited with code ${code}: ${stdout.trim()}`;
      console.error(`[ripgrep] ${message}`);
      resolve({ ok: false, path: resolvedPath, error: message });
    });

    rg.on('error', (error) => {
      const message = `ripgrep spawn failed: ${error.message}`;
      console.error(`[ripgrep] ${message}`);
      resolve({ ok: false, path: resolvedPath, error: message });
    });
  });
}
