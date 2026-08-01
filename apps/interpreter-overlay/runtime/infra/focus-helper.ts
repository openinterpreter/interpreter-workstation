import { execFileSync } from 'node:child_process';
import { getInterpreterOverlayNativeHelperPath } from './native-helper-paths.js';

function getFocusWindowBinaryPath(): string {
  return getInterpreterOverlayNativeHelperPath('focus-window');
}

export async function activateWindowAtCoordinates(x: number, y: number): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return true;
  }

  try {
    const result = execFileSync(
      getFocusWindowBinaryPath(),
      [Math.round(x).toString(), Math.round(y).toString()],
      {
        encoding: 'utf-8',
        timeout: 1000,
        env: {
          ...process.env,
          INTERPRETER_OVERLAY_EXCLUDED_PID: String(process.pid),
        },
      },
    ).trim();

    console.log(`[FocusHelper] Result: ${result}`);
    return result.startsWith('activated');
  } catch (error) {
    console.error('[FocusHelper] Failed to activate window:', error);
    return false;
  }
}
