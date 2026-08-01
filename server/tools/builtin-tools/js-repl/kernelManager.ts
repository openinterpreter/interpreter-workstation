// Manages persistent js_repl Node kernels for the builtin-js-repl tool server.
// Each kernel is a long-lived `node --experimental-vm-modules kernel.cjs` child
// speaking JSON lines over stdio. Top-level bindings persist across tool calls
// because the kernel process itself persists; one kernel per session key.
//
// NOTE(vendored): Protocol and lifecycle ported from the openai/codex js_repl
// manager (codex-rs/core/src/tools/js_repl/mod.rs at commit ac8c9fc49) after
// upstream removed the feature; nested `run_tool` dispatch is intentionally
// unsupported in this app build.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveBundledJsReplRuntimeDir,
  resolveElectronRunAsNodeBinary,
  usesElectronRunAsNode,
} from '../../../utils/bundledRuntimePaths';
import { getSandboxDir } from '../../../utils/sandboxManager';

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 10 * 60_000;
// The kernel enforces timeout_ms itself and answers with a state-preserving
// error. The host timer only backstops a wedged kernel event loop (for example
// a CPU-bound cell), where SIGKILL is the only way out.
const KERNEL_UNRESPONSIVE_GRACE_MS = 5_000;
const KERNEL_IDLE_TTL_MS = 30 * 60_000;
const IDLE_SWEEP_INTERVAL_MS = 60_000;
const STDERR_TAIL_LINE_LIMIT = 20;
const STDERR_TAIL_LINE_MAX_CHARS = 512;

const EMITTED_IMAGE_MIME_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface JsReplExecResult {
  output: string;
  imagePaths: string[];
}

type KernelToHostMessage =
  | { type: 'exec_result'; id: string; ok: boolean; output: string; error?: string | null }
  | { type: 'run_tool'; id: string; exec_id: string; tool_name: string; arguments: string }
  | { type: 'emit_image'; id: string; exec_id: string; image_url: string; detail?: string | null };

interface PendingExec {
  resolve: (result: JsReplExecResult) => void;
  reject: (error: Error) => void;
  imagePaths: string[];
  timer: NodeJS.Timeout;
}

class JsReplKernel {
  private child: ChildProcess | null = null;
  private readonly pendingExecs = new Map<string, PendingExec>();
  private readonly stderrTail: string[] = [];
  private execQueue: Promise<unknown> = Promise.resolve();
  private execCounter = 0;
  private imageCounter = 0;
  private tmpDir: string | null = null;
  lastUsedAt = Date.now();

  constructor(
    private readonly key: string,
    private readonly cwd: string,
  ) {}

  async execute(code: string, timeoutMs: number | undefined): Promise<JsReplExecResult> {
    this.lastUsedAt = Date.now();
    // Serialize execs per kernel: the kernel evaluates one cell at a time and
    // binding persistence assumes ordered cells.
    const run = this.execQueue.then(() => this.executeNow(code, timeoutMs));
    this.execQueue = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.lastUsedAt = Date.now();
    }
  }

  private async executeNow(code: string, timeoutMs: number | undefined): Promise<JsReplExecResult> {
    const child = this.ensureChild();
    const id = `exec-${++this.execCounter}`;
    const effectiveTimeoutMs = Math.min(
      Math.max(1, Math.floor(timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS)),
      MAX_EXEC_TIMEOUT_MS,
    );

    const result = new Promise<JsReplExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExecs.delete(id);
        // The kernel's own soft timeout should have answered by now; reaching
        // this backstop means its event loop is wedged, so kill and reset.
        this.kill();
        reject(new Error(
          `js_repl did not respond within ${effectiveTimeoutMs + KERNEL_UNRESPONSIVE_GRACE_MS}ms (timeout_ms ${effectiveTimeoutMs} plus grace); the kernel was unresponsive, so it was reset and top-level bindings were cleared. Rerun your request.`,
        ));
      }, effectiveTimeoutMs + KERNEL_UNRESPONSIVE_GRACE_MS);
      this.pendingExecs.set(id, { resolve, reject, imagePaths: [], timer });
    });

    this.writeMessage(child, { type: 'exec', id, code, timeout_ms: effectiveTimeoutMs });
    return result;
  }

  reset(): boolean {
    const hadKernel = this.child !== null;
    this.kill();
    return hadKernel;
  }

  isIdleSince(cutoffMs: number): boolean {
    return this.pendingExecs.size === 0 && this.lastUsedAt < cutoffMs;
  }

  kill(): void {
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill('SIGKILL');
    }
    const tmpDir = this.tmpDir;
    this.tmpDir = null;
    if (tmpDir) {
      fs.rm(tmpDir, { recursive: true, force: true }, () => undefined);
    }
    this.rejectAllPending(new Error('js_repl kernel was reset'));
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }

    const runtimeDir = resolveBundledJsReplRuntimeDir();
    const kernelPath = path.join(runtimeDir, 'kernel', 'kernel.cjs');
    const nodeBinary = resolveElectronRunAsNodeBinary();
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interpreter-js-repl-'));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INTERPRETER_JS_TMP_DIR: this.tmpDir,
      INTERPRETER_JS_REPL_NODE_MODULE_DIRS: runtimeDir,
      INTERPRETER_THREAD_ID: this.key,
      HOME: process.env.HOME ?? os.homedir(),
    };
    if (usesElectronRunAsNode(nodeBinary)) {
      env.ELECTRON_RUN_AS_NODE = '1';
    }

    const child = spawn(nodeBinary, ['--experimental-vm-modules', kernelPath], {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderrTail.length = 0;

    console.log(`[js-repl] kernel started key=${this.key} pid=${child.pid} cwd=${this.cwd}`);

    createInterface({ input: child.stdout! }).on('line', (line) => {
      this.handleKernelLine(child, line);
    });
    createInterface({ input: child.stderr! }).on('line', (line) => {
      this.stderrTail.push(line.slice(0, STDERR_TAIL_LINE_MAX_CHARS));
      if (this.stderrTail.length > STDERR_TAIL_LINE_LIMIT) {
        this.stderrTail.shift();
      }
    });

    child.once('exit', (exitCode, signal) => {
      // An intentional kill() already cleared this.child and rejected pendings;
      // only an unexpected exit of the live child should fail in-flight execs.
      if (this.child !== child) {
        return;
      }
      this.child = null;
      const tail = this.stderrTail.join(' | ');
      if (this.pendingExecs.size > 0) {
        console.warn(`[js-repl] kernel exited mid-exec key=${this.key} exitCode=${exitCode} signal=${signal} stderrTail=${JSON.stringify(tail)}`);
      }
      this.rejectAllPending(new Error(
        `js_repl kernel exited unexpectedly (exitCode=${exitCode ?? 'null'}, signal=${signal ?? 'null'})${tail ? `; stderr tail: ${tail}` : ''}. The kernel restarts on the next call; top-level bindings were cleared.`,
      ));
    });
    child.once('error', (error) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.rejectAllPending(new Error(`js_repl kernel failed to start: ${error.message}`));
    });

    return child;
  }

  private handleKernelLine(child: ChildProcess, line: string): void {
    let message: KernelToHostMessage;
    try {
      message = JSON.parse(line) as KernelToHostMessage;
    } catch {
      console.warn(`[js-repl] ignoring non-JSON kernel stdout line key=${this.key} line=${JSON.stringify(line.slice(0, 200))}`);
      return;
    }

    if (message.type === 'exec_result') {
      const pending = this.pendingExecs.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingExecs.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve({ output: message.output, imagePaths: pending.imagePaths });
      } else {
        pending.reject(new Error(message.error || 'js_repl execution failed'));
      }
      return;
    }

    if (message.type === 'run_tool') {
      this.writeMessage(child, {
        type: 'run_tool_result',
        id: message.id,
        ok: false,
        error: 'interpreter.tool(...) is not available in this app; run other Interpreter tools through the interpreter-app CLI from shell instead.',
      });
      return;
    }

    if (message.type === 'emit_image') {
      let savedPath: string | null = null;
      let error: string | null = null;
      try {
        savedPath = this.saveEmittedImage(message.image_url);
        this.pendingExecs.get(message.exec_id)?.imagePaths.push(savedPath);
      } catch (saveError) {
        error = saveError instanceof Error ? saveError.message : String(saveError);
      }
      this.writeMessage(child, {
        type: 'emit_image_result',
        id: message.id,
        ok: error === null,
        error,
      });
      return;
    }
  }

  private saveEmittedImage(imageUrl: string): string {
    if (!imageUrl.toLowerCase().startsWith('data:')) {
      throw new Error('interpreter.emitImage only accepts data URLs');
    }
    const commaIndex = imageUrl.indexOf(',');
    if (commaIndex === -1) {
      throw new Error('interpreter.emitImage expected a valid image data URL');
    }
    const mimeType = imageUrl.slice(5, commaIndex).split(';')[0].toLowerCase();
    const extension = EMITTED_IMAGE_MIME_TYPES[mimeType];
    if (!extension) {
      throw new Error('interpreter.emitImage only supports image/png, image/jpeg, image/webp, or image/gif');
    }
    const bytes = Buffer.from(imageUrl.slice(commaIndex + 1), 'base64');
    if (bytes.length === 0) {
      throw new Error('interpreter.emitImage expected non-empty image data');
    }
    const filename = `js-repl-image-${process.pid}-${Date.now()}-${++this.imageCounter}.${extension}`;
    const sandboxDir = getSandboxDir();
    fs.mkdirSync(sandboxDir, { recursive: true });
    const savedPath = path.join(sandboxDir, filename);
    fs.writeFileSync(savedPath, bytes);
    return savedPath;
  }

  private writeMessage(child: ChildProcess, message: Record<string, unknown>): void {
    child.stdin?.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        console.warn(`[js-repl] failed to write to kernel key=${this.key}: ${error.message}`);
      }
    });
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingExecs.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingExecs.clear();
  }
}

const kernels = new Map<string, JsReplKernel>();
let idleSweepTimer: NodeJS.Timeout | null = null;
let exitCleanupRegistered = false;

function ensureLifecycleHooks(): void {
  if (!idleSweepTimer) {
    idleSweepTimer = setInterval(() => {
      const cutoff = Date.now() - KERNEL_IDLE_TTL_MS;
      for (const [key, kernel] of kernels) {
        if (kernel.isIdleSince(cutoff)) {
          console.log(`[js-repl] stopping idle kernel key=${key}`);
          kernel.kill();
          kernels.delete(key);
        }
      }
    }, IDLE_SWEEP_INTERVAL_MS);
    idleSweepTimer.unref();
  }
  if (!exitCleanupRegistered) {
    exitCleanupRegistered = true;
    process.once('exit', () => {
      for (const kernel of kernels.values()) {
        kernel.kill();
      }
      kernels.clear();
    });
  }
}

/** Stable kernel key: one persistent kernel per agent thread. */
export function jsReplKernelKey(context: { threadId?: string; agentId?: string } | undefined): string {
  return context?.threadId ?? context?.agentId ?? 'default';
}

export async function executeInJsReplKernel(params: {
  key: string;
  cwd: string;
  code: string;
  timeoutMs?: number;
}): Promise<JsReplExecResult> {
  ensureLifecycleHooks();
  let kernel = kernels.get(params.key);
  if (!kernel) {
    kernel = new JsReplKernel(params.key, params.cwd);
    kernels.set(params.key, kernel);
  }
  return await kernel.execute(params.code, params.timeoutMs);
}

/** Returns true when a running kernel existed for this key. */
export function resetJsReplKernel(key: string): boolean {
  const kernel = kernels.get(key);
  if (!kernel) {
    return false;
  }
  const hadKernel = kernel.reset();
  kernels.delete(key);
  return hadKernel;
}

export function shutdownAllJsReplKernelsForTest(): void {
  for (const kernel of kernels.values()) {
    kernel.kill();
  }
  kernels.clear();
}
