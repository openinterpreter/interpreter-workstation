import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolCallResponse } from '../../toolTypes';

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

function summarizeWindowsUiaArgs(args: Record<string, unknown>): string {
  const summary: Record<string, unknown> = {};
  for (const key of ['pid', 'window_id', 'automation_id', 'element_index', 'x', 'y', 'key', 'direction', 'path', 'app', 'window_style', 'bring_to_foreground', 'view_mode', 'max_depth', 'max_elements', 'progid', 'connect', 'action', 'member', 'query']) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      summary[key] = args[key];
    }
  }
  if (typeof args.text === 'string') summary.text_chars = args.text.length;
  if (typeof args.value === 'string') summary.value_chars = args.value.length;
  return JSON.stringify(summary);
}

function summarizeWindowsUiaStdout(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as {
      ok?: unknown;
      tool?: unknown;
      data?: Record<string, unknown>;
      error?: Record<string, unknown>;
    };
    const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
    const error = parsed.error && typeof parsed.error === 'object' ? parsed.error : {};
    const summary: Record<string, unknown> = {
      ok: parsed.ok,
      tool: parsed.tool,
    };
    for (const key of ['action', 'pid', 'window_id', 'automation_id', 'rendered', 'overlay_pid', 'real_cursor_moved', 'activity_kind', 'was_foreground', 'is_foreground', 'progid', 'alias', 'member']) {
      if (Object.prototype.hasOwnProperty.call(data, key)) summary[key] = data[key];
    }
    if (typeof data.activity_text === 'string') summary.activity_text_chars = data.activity_text.length;
    if (typeof error.code === 'string') summary.error_code = error.code;
    return JSON.stringify(summary);
  } catch {
    return JSON.stringify({ stdout_chars: stdout.length });
  }
}

async function killProcessTree(pid: number | undefined): Promise<void> {
  if (typeof pid !== 'number') return;
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
    pending.reject(error ?? new Error('Windows Computer Use daemon stopped.'));
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
    if (newlineIndex < 0) return;
    const rawLine = daemon.stdoutBuffer.slice(0, newlineIndex).trim();
    daemon.stdoutBuffer = daemon.stdoutBuffer.slice(newlineIndex + 1);
    if (!rawLine) continue;

    let response: WindowsUiaDaemonResponse;
    try {
      response = JSON.parse(rawLine) as WindowsUiaDaemonResponse;
    } catch {
      continue;
    }

    const pending = daemon.pending.get(response.id);
    if (!pending) continue;
    daemon.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve({ stdout: response.stdout ?? '', stderr: response.stderr ?? '' });
    } else {
      pending.reject(new Error(response.stderr || 'Windows Computer Use daemon request failed.'));
    }
  }
}

function startWindowsUiaDaemon(scriptPath: string): WindowsUiaDaemon {
  if (windowsUiaDaemon && windowsUiaDaemon.scriptPath === scriptPath && !windowsUiaDaemon.child.killed) {
    return windowsUiaDaemon;
  }

  console.log(`[WINDOWS_CUA] phase=daemon_start script=${JSON.stringify(scriptPath)}`);
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
    console.warn(`[WINDOWS_CUA] phase=daemon_exit code=${code ?? 'none'} signal=${signal ?? 'none'} stderr=${JSON.stringify(daemon.stderrBuffer.trim().slice(0, 500))}`);
    resetWindowsUiaDaemon(
      daemon,
      new Error(`Windows Computer Use daemon exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}): ${daemon.stderrBuffer.trim()}`),
    );
  });
  process.once('exit', () => {
    if (!child.killed) child.kill();
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
      reject(new Error(`Windows Computer Use timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    daemon.pending.set(id, { resolve, reject, timer });
    const stdin = daemon.child.stdin;
    if (!stdin) {
      daemon.pending.delete(id);
      clearTimeout(timer);
      reject(new Error('Windows Computer Use daemon stdin is not available.'));
      return;
    }
    stdin.write(`${payload}\n`, 'utf8', (error: Error | null | undefined) => {
      if (!error) return;
      daemon.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });
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
    throw new Error(`Windows Computer Use script not found. Checked: ${candidates.join(', ')}`);
  }
  return found;
}

export async function callWindowsCuaDriverTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolCallResponse> {
  const scriptPath = resolveWindowsUiaScript();
  const startedAt = Date.now();
  console.log(`[WINDOWS_CUA] phase=start tool=${toolName} args=${summarizeWindowsUiaArgs(args ?? {})}`);
  try {
    const { stdout, stderr } = await callWindowsUiaDaemon(scriptPath, toolName, args, 30_000);
    console.log(`[WINDOWS_CUA] phase=result tool=${toolName} ok=true durationMs=${Date.now() - startedAt} result=${summarizeWindowsUiaStdout(stdout)}`);
    const text = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    return {
      content: [{ type: 'text', text }],
    };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const details = [err.stdout?.trim(), err.stderr?.trim(), err.message].filter(Boolean).join('\n');
    console.warn(`[WINDOWS_CUA] phase=result tool=${toolName} ok=false durationMs=${Date.now() - startedAt} error=${JSON.stringify(details.slice(0, 500))}`);
    return {
      content: [{ type: 'text', text: details }],
      isError: true,
    };
  }
}
