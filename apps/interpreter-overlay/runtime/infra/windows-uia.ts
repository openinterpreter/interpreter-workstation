import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface WindowsUiaElementTarget {
  windowId: string;
  elementIndex: number;
  nativeHandle?: number;
}

export interface WindowsUiaToolEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
    suggestion?: string;
  };
}

export interface WindowsUiaWindow {
  app_name?: string;
  pid: number;
  title: string;
  window_id: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

export interface WindowsUiaElementSummary {
  element_index: number;
  native_handle?: number | null;
  role: string;
  name?: string | null;
  automation_id?: string | null;
  value?: string | null;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  states?: string[];
}

export interface WindowsUiaWindowState {
  app?: string;
  pid: number;
  title: string;
  window_id: string;
  bounds?: WindowsUiaWindow['bounds'];
  tree_markdown?: string;
  elements: WindowsUiaElementSummary[];
}

type WindowsUiaProcessResult = {
  stdout: string;
  stderr: string;
};

type WindowsUiaDaemonResponse = WindowsUiaProcessResult & {
  id: string;
  ok: boolean;
};

type WindowsUiaPendingRequest = {
  resolve: (result: WindowsUiaProcessResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WindowsUiaDaemon = {
  child: ChildProcess;
  nextId: number;
  pending: Map<string, WindowsUiaPendingRequest>;
  scriptPath: string;
  stdoutBuffer: string;
  stderrBuffer: string;
};

let windowsUiaDaemon: WindowsUiaDaemon | null = null;

export function makeWindowsUiaElementId(windowId: string, elementIndex: number, nativeHandle?: number | null): string {
  if (typeof nativeHandle === 'number' && Number.isFinite(nativeHandle) && nativeHandle > 0) {
    return `winuia:${windowId}:${elementIndex}:${Math.trunc(nativeHandle)}`;
  }
  return `winuia:${windowId}:${elementIndex}`;
}

export function parseWindowsUiaElementId(elementId: string): WindowsUiaElementTarget | null {
  const match = /^winuia:([^:]+):(\d+)(?::(\d+))?$/.exec(elementId);
  if (!match) {
    return null;
  }

  return {
    windowId: match[1],
    elementIndex: Number(match[2]),
    nativeHandle: match[3] ? Number(match[3]) : undefined,
  };
}

function resolveWindowsUiaScript(): string {
  const envScript = process.env.INTERPRETER_WINDOWS_UIA_SCRIPT?.trim();
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const candidates = [
    envScript || null,
    path.join(process.cwd(), 'server', 'tools', 'builtin-tools', 'cua-driver', 'windows-uia.ps1'),
    resourcesPath ? path.join(resourcesPath, 'cua-driver', 'windows-uia.ps1') : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Windows UIA script not found. Checked: ${candidates.join(', ')}`);
  }
  return found;
}

function protectedWindowsPidsEnv(): string {
  const pids = new Set<number>();
  if (Number.isInteger(process.pid) && process.pid > 0) {
    pids.add(process.pid);
  }
  const extra = process.env.INTERPRETER_COMPUTER_USE_PROTECTED_PIDS ?? '';
  for (const part of extra.split(',')) {
    const parsed = Number(part.trim());
    if (Number.isInteger(parsed) && parsed > 0) {
      pids.add(parsed);
    }
  }
  return Array.from(pids).join(',');
}

async function killProcessTree(pid: number | undefined): Promise<void> {
  if (typeof pid !== 'number') {
    return;
  }
  await new Promise<void>((resolve) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
}

function resetWindowsUiaDaemon(daemon: WindowsUiaDaemon, error?: Error): void {
  if (windowsUiaDaemon === daemon) {
    windowsUiaDaemon = null;
  }
  for (const pending of daemon.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error ?? new Error('Windows UIA daemon stopped.'));
  }
  daemon.pending.clear();
}

function unrefNodeStream(stream: unknown): void {
  const maybeUnref = stream as { unref?: () => void } | null | undefined;
  maybeUnref?.unref?.();
}

function parseDaemonStdout(daemon: WindowsUiaDaemon, chunk: string): void {
  daemon.stdoutBuffer += chunk;
  while (true) {
    const newlineIndex = daemon.stdoutBuffer.indexOf('\n');
    if (newlineIndex < 0) {
      return;
    }

    const rawLine = daemon.stdoutBuffer.slice(0, newlineIndex).trim();
    daemon.stdoutBuffer = daemon.stdoutBuffer.slice(newlineIndex + 1);
    if (!rawLine) {
      continue;
    }

    let response: WindowsUiaDaemonResponse;
    try {
      response = JSON.parse(rawLine) as WindowsUiaDaemonResponse;
    } catch {
      continue;
    }

    const pending = daemon.pending.get(response.id);
    if (!pending) {
      continue;
    }
    daemon.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve({ stdout: response.stdout ?? '', stderr: response.stderr ?? '' });
    } else {
      pending.reject(new Error(response.stderr || 'Windows UIA daemon request failed.'));
    }
  }
}

function startWindowsUiaDaemon(scriptPath: string): WindowsUiaDaemon {
  if (windowsUiaDaemon && windowsUiaDaemon.scriptPath === scriptPath && !windowsUiaDaemon.child.killed) {
    return windowsUiaDaemon;
  }

  const child = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-STA',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '__driver_daemon',
    '{}',
  ], {
    env: {
      ...process.env,
      INTERPRETER_COMPUTER_USE_PROTECTED_PIDS: protectedWindowsPidsEnv(),
      INTERPRETER_WINDOWS_UIA_CURSOR_OVERLAY: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const daemon: WindowsUiaDaemon = {
    child,
    nextId: 1,
    pending: new Map(),
    scriptPath,
    stdoutBuffer: '',
    stderrBuffer: '',
  };
  windowsUiaDaemon = daemon;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.unref();
  unrefNodeStream(child.stdin);
  unrefNodeStream(child.stdout);
  unrefNodeStream(child.stderr);
  child.stdout.on('data', (chunk) => parseDaemonStdout(daemon, chunk.toString()));
  child.stderr.on('data', (chunk) => {
    daemon.stderrBuffer = `${daemon.stderrBuffer}${chunk.toString()}`.slice(-8192);
  });
  child.on('error', (error) => resetWindowsUiaDaemon(daemon, error));
  child.on('exit', (code, signal) => {
    resetWindowsUiaDaemon(
      daemon,
      new Error(`Windows UIA daemon exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}): ${daemon.stderrBuffer.trim()}`),
    );
  });
  process.once('exit', () => {
    if (!child.killed) {
      child.kill();
    }
  });

  return daemon;
}

async function callWindowsUiaDaemon(
  scriptPath: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<WindowsUiaProcessResult> {
  const daemon = startWindowsUiaDaemon(scriptPath);
  const id = String(daemon.nextId++);
  const payload = JSON.stringify({ id, tool: toolName, args: args ?? {} });

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      daemon.pending.delete(id);
      void killProcessTree(daemon.child.pid);
      reject(new Error(`Windows UIA ${toolName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    daemon.pending.set(id, { resolve, reject, timer });

    const stdin = daemon.child.stdin;
    if (!stdin) {
      daemon.pending.delete(id);
      clearTimeout(timer);
      reject(new Error('Windows UIA daemon stdin is not available.'));
      return;
    }

    stdin.write(`${payload}\n`, 'utf8', (error: Error | null | undefined) => {
      if (!error) {
        return;
      }
      daemon.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });
}

function parseWindowsUiaEnvelope<T>(toolName: string, stdout: string, stderr: string): T {
  const jsonStart = stdout.indexOf('{');
  const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
  if (!jsonText.trim()) {
    throw new Error(`Windows UIA ${toolName} returned no JSON envelope. stderr=${stderr.trim() || '<empty>'}`);
  }
  let envelope: WindowsUiaToolEnvelope<T>;
  try {
    envelope = JSON.parse(jsonText) as WindowsUiaToolEnvelope<T>;
  } catch (error) {
    const preview = jsonText.slice(0, 500).replace(/\s+/g, ' ').trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Windows UIA ${toolName} returned invalid JSON envelope: ${message}. stdout=${preview || '<empty>'} stderr=${stderr.trim() || '<empty>'}`);
  }
  if (!envelope.ok) {
    throw new Error(envelope.error?.message ?? `Windows UIA ${toolName} failed.`);
  }
  return envelope.data as T;
}

export async function callWindowsUiaTool<T = unknown>(
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<T> {
  const scriptPath = resolveWindowsUiaScript();
  const { stdout, stderr } = await callWindowsUiaDaemon(scriptPath, toolName, args, timeoutMs);
  return parseWindowsUiaEnvelope<T>(toolName, stdout, stderr);
}
