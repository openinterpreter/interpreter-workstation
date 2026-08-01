/**
 * Terminal Handler
 *
 * PTY session management using node-pty.
 * Supports creating, writing to, resizing, and closing terminal sessions.
 */

import os from 'os';
import { execSync } from 'child_process';
import { broadcastEvent } from './broadcast';
import { getCurrentWorkspace } from '../utils/workspace';

type PtyModule = typeof import('node-pty');
type PtyInstance = import('node-pty').IPty;

let ptyModulePromise: Promise<PtyModule> | null = null;

async function getPtyModule(): Promise<PtyModule> {
  if (!ptyModulePromise) {
    ptyModulePromise = import('node-pty');
  }
  return ptyModulePromise;
}

// Store active PTY sessions with their PIDs
interface SessionInfo {
  pty: PtyInstance;
  pid: number;
}
const sessions = new Map<string, SessionInfo>();

/**
 * Get the default shell for the current platform
 */
function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

/**
 * Create a new terminal session
 */
export async function createSession(cwd?: string): Promise<{ sessionId: string }> {
  const sessionId = `terminal-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const shell = getDefaultShell();
  const pty = await getPtyModule();

  // Default to active workspace if no cwd provided.
  const workingDir = cwd || getCurrentWorkspace() || os.homedir();

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: workingDir,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as { [key: string]: string },
  });

  const pid = ptyProcess.pid;
  sessions.set(sessionId, { pty: ptyProcess, pid });

  // Forward PTY output to frontend
  ptyProcess.onData((data) => {
    broadcastEvent('terminal:data', { sessionId, data });
  });

  // Handle PTY exit
  ptyProcess.onExit(({ exitCode, signal }) => {
    sessions.delete(sessionId);
    broadcastEvent('terminal:exit', { sessionId, exitCode, signal });
  });

  console.log(`[Terminal] Created session ${sessionId} with shell ${shell} in ${workingDir} (PID: ${pid})`);

  return { sessionId };
}

/**
 * Write data to a terminal session (user input)
 */
export async function writeSession(sessionId: string, data: string): Promise<{ success: boolean; error?: string }> {
  const session = sessions.get(sessionId);

  if (!session) {
    return { success: false, error: `Session ${sessionId} not found` };
  }

  session.pty.write(data);
  return { success: true };
}

/**
 * Resize a terminal session
 */
export async function resizeSession(
  sessionId: string,
  cols: number,
  rows: number
): Promise<{ success: boolean; error?: string }> {
  const session = sessions.get(sessionId);

  if (!session) {
    return { success: false, error: `Session ${sessionId} not found` };
  }

  session.pty.resize(cols, rows);
  return { success: true };
}

/**
 * Kill a process tree (the process and all its descendants)
 * This ensures coding agents and all their subprocesses are terminated.
 */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    // Windows: use taskkill /T to terminate the process tree
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // Process may have already exited
    }
  } else {
    // Unix: Use pkill to kill all descendants, then the process itself
    // pkill -P kills all processes with the given parent PID
    // We do this recursively to catch grandchildren

    // First, collect all descendant PIDs using pgrep
    const collectDescendants = (parentPid: number): number[] => {
      try {
        const output = execSync(`pgrep -P ${parentPid}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
        const childPids = output.trim().split('\n').filter(Boolean).map(Number);
        let allDescendants = [...childPids];
        for (const childPid of childPids) {
          allDescendants = allDescendants.concat(collectDescendants(childPid));
        }
        return allDescendants;
      } catch {
        return []; // pgrep returns error if no children found
      }
    };

    const allPids = [pid, ...collectDescendants(pid)];
    console.log(`[Terminal] Killing process tree: ${allPids.join(', ')}`);

    // Send SIGTERM to all processes (reverse order to kill children first)
    for (const p of allPids.reverse()) {
      try {
        process.kill(p, 'SIGTERM');
      } catch {
        // Process may have already exited
      }
    }

    // Force kill after a short delay
    setTimeout(() => {
      for (const p of allPids) {
        try {
          process.kill(p, 'SIGKILL');
        } catch {
          // Process may have already exited
        }
      }
    }, 100);
  }
}

/**
 * Close a terminal session
 */
export async function closeSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
  const session = sessions.get(sessionId);

  if (!session) {
    return { success: false, error: `Session ${sessionId} not found` };
  }

  const { pty: ptyProcess, pid } = session;

  // Kill the entire process tree (shell + all child processes like coding agents)
  console.log(`[Terminal] Killing process tree for session ${sessionId} (PID: ${pid})`);
  killProcessTree(pid);

  // Also call node-pty's kill as a backup
  try {
    ptyProcess.kill();
  } catch {
    // Ignore - process may have already been killed
  }

  sessions.delete(sessionId);

  console.log(`[Terminal] Closed session ${sessionId}`);

  return { success: true };
}

/**
 * Close all terminal sessions (for cleanup on app exit)
 */
export function closeAllSessions(): void {
  for (const [sessionId, session] of sessions) {
    try {
      console.log(`[Terminal] Killing process tree for session ${sessionId} (PID: ${session.pid}) during cleanup`);
      killProcessTree(session.pid);
      session.pty.kill();
      console.log(`[Terminal] Closed session ${sessionId} during cleanup`);
    } catch (e) {
      console.warn(`[Terminal] Error closing session ${sessionId}:`, e);
    }
  }
  sessions.clear();
}
