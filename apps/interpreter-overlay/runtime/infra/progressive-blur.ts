import { spawn, type ChildProcess } from 'node:child_process';
import { INTERPRETER_OVERLAY_STRIP_RATIO } from '../../shared/layout.js';
import { getInterpreterOverlayNativeHelperPath } from './native-helper-paths.js';

type ProgressiveBlurProcessFactory = (
  command: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess;

function getProgressiveBlurBinaryPath(): string {
  return getInterpreterOverlayNativeHelperPath('progressive-blur');
}

function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? String(error.code) : '';
  if (code === 'EPIPE') {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\bEPIPE\b|broken pipe/i.test(message);
}

export type ProgressiveBlurLifecycleEventType =
  | 'ready'
  | 'show-command'
  | 'shown'
  | 'hide-command'
  | 'hidden'
  | 'launch-failed'
  | 'exited';

export interface ProgressiveBlurLifecycleEvent {
  type: ProgressiveBlurLifecycleEventType;
  at: number;
  ready: boolean;
  visible: boolean;
  commandId?: number | null;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}

export interface ProgressiveBlurDebugState {
  supported: boolean;
  ready: boolean;
  visible: boolean;
  lastEventType: ProgressiveBlurLifecycleEventType | null;
  lastEventAt: number | null;
  readyAt: number | null;
  lastShowCommandAt: number | null;
  lastShownAt: number | null;
  lastHideCommandAt: number | null;
  lastHiddenAt: number | null;
  lastLaunchFailedAt: number | null;
  lastLaunchFailedError: string | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

interface ProgressiveBlurOptions {
  onLifecycleEvent?: ((event: ProgressiveBlurLifecycleEvent) => void) | null;
  platform?: NodeJS.Platform;
  getBinaryPath?: () => string;
  spawnProcess?: ProgressiveBlurProcessFactory;
}

export class ProgressiveBlur {
  private readonly onLifecycleEvent: ((event: ProgressiveBlurLifecycleEvent) => void) | null;
  private readonly platform: NodeJS.Platform;
  private readonly getBinaryPath: () => string;
  private readonly spawnProcess: ProgressiveBlurProcessFactory;
  private process: ChildProcess | null = null;
  private isReady = false;
  private isVisible = false;
  private stdoutBuffer = '';
  private pendingCommands: string[] = [];
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private desiredVisible = false;
  private lastVisibilityCommandId = 0;
  private lastSentVisibilityCommand: boolean | null = null;
  private readonly debugState: ProgressiveBlurDebugState = {
    supported: process.platform === 'darwin',
    ready: false,
    visible: false,
    lastEventType: null,
    lastEventAt: null,
    readyAt: null,
    lastShowCommandAt: null,
    lastShownAt: null,
    lastHideCommandAt: null,
    lastHiddenAt: null,
    lastLaunchFailedAt: null,
    lastLaunchFailedError: null,
    exitCode: null,
    exitSignal: null,
  };

  constructor(options: ProgressiveBlurOptions = {}) {
    this.onLifecycleEvent = options.onLifecycleEvent ?? null;
    this.platform = options.platform ?? process.platform;
    this.getBinaryPath = options.getBinaryPath ?? getProgressiveBlurBinaryPath;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.debugState.supported = this.platform === 'darwin';
  }

  getDebugState(): ProgressiveBlurDebugState {
    return { ...this.debugState };
  }

  start(): Promise<void> {
    if (this.platform !== 'darwin') {
      return Promise.resolve();
    }

    if (this.process) {
      if (this.isReady) {
        return Promise.resolve();
      }
      if (this.readyPromise) {
        return this.readyPromise;
      }
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    if (this.process) {
      return this.readyPromise;
    }

    const child = this.spawnProcess(this.getBinaryPath(), [INTERPRETER_OVERLAY_STRIP_RATIO.toString()], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk) => {
      if (this.process !== child) {
        return;
      }
      this.handleStdout(chunk.toString());
    });

    child.stderr?.on('data', (chunk) => {
      if (this.process !== child) {
        return;
      }
      const output = chunk.toString().trim();
      if (output) {
        console.error(`[ProgressiveBlur] ${output}`);
      }
    });

    child.stdin?.on('error', (error) => {
      if (this.handleCommandWriteError(error, child)) {
        return;
      }
      console.error('[ProgressiveBlur] stdin error:', error);
    });

    child.on('exit', (code, signal) => {
      if (this.process !== child) {
        return;
      }
      console.log(`[ProgressiveBlur] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.emitLifecycleEvent('exited', { code, signal });
      if (!this.isReady) {
        this.rejectReady?.(new Error(`Progressive blur exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
      }
      this.clearProcessState();
    });

    child.on('error', (error) => {
      if (this.process !== child) {
        return;
      }
      console.error('[ProgressiveBlur] failed to launch:', error);
      this.emitLifecycleEvent('launch-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.rejectReady?.(error instanceof Error ? error : new Error(String(error)));
      this.clearProcessState();
    });

    this.process = child;
    return this.readyPromise;
  }

  show(): void {
    if (this.platform !== 'darwin') {
      return;
    }

    this.desiredVisible = true;
    void this.start().catch((error) => {
      console.error('[ProgressiveBlur] failed to prepare for show:', error);
    });
    this.syncDesiredVisibility();
  }

  hide(): void {
    if (this.platform !== 'darwin') {
      return;
    }

    this.desiredVisible = false;
    this.syncDesiredVisibility();
  }

  dispose(): void {
    if (this.platform !== 'darwin' || !this.process) {
      return;
    }

    const processToClose = this.process;
    this.sendCommand('exit');

    setTimeout(() => {
      if (this.process === processToClose) {
        processToClose.kill();
      }
    }, 250);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (line) {
        console.log(`[ProgressiveBlur] ${line}`);
        if (line === 'ready') {
          this.isReady = true;
          this.emitLifecycleEvent('ready');
          this.resolveReady?.();
          this.resolveReady = null;
          this.rejectReady = null;
          this.flushPendingCommands();
          continue;
        }

        const [eventType, commandIdToken] = line.split(/\s+/, 2);
        const parsedCommandId = commandIdToken ? Number.parseInt(commandIdToken, 10) : Number.NaN;
        const commandId = Number.isFinite(parsedCommandId) ? parsedCommandId : null;

        if (eventType === 'shown') {
          if (commandId !== null && commandId < this.lastVisibilityCommandId) {
            continue;
          }
          if (!this.desiredVisible) {
            console.warn(`[ProgressiveBlur] stale shown ${commandId ?? 'null'} while hidden was desired; reissuing hide`);
            this.isVisible = true;
            this.debugState.visible = true;
            this.lastSentVisibilityCommand = true;
            this.syncDesiredVisibility();
            continue;
          }
          this.emitLifecycleEvent('shown', { commandId });
          continue;
        }

        if (eventType === 'hidden') {
          if (commandId !== null && commandId < this.lastVisibilityCommandId) {
            continue;
          }
          if (this.desiredVisible) {
            console.warn(`[ProgressiveBlur] stale hidden ${commandId ?? 'null'} while visible was desired; reissuing show`);
            this.isVisible = false;
            this.debugState.visible = false;
            this.lastSentVisibilityCommand = false;
            this.syncDesiredVisibility();
            continue;
          }
          this.emitLifecycleEvent('hidden', { commandId });
        }
      }

      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private flushPendingCommands(): void {
    if (!this.process?.stdin || !this.isReady) {
      return;
    }

    const commands = this.pendingCommands;
    this.pendingCommands = [];

    for (const command of commands) {
      if (!this.writeCommand(command)) {
        return;
      }
    }
  }

  private sendCommand(command: string): void {
    if (!this.process?.stdin) {
      return;
    }

    if (!this.isReady) {
      this.pendingCommands.push(command);
      return;
    }

    this.writeCommand(command);
  }

  private writeCommand(command: string): boolean {
    const processToWrite = this.process;
    const stdin = processToWrite?.stdin;
    if (!stdin) {
      return false;
    }

    if (stdin.destroyed || stdin.writableEnded) {
      this.handleCommandWriteError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), processToWrite);
      return false;
    }

    try {
      stdin.write(`${command}\n`);
      return true;
    } catch (error) {
      if (this.handleCommandWriteError(error, processToWrite)) {
        return false;
      }
      throw error;
    }
  }

  private handleCommandWriteError(error: unknown, processToClose: ChildProcess | null = this.process): boolean {
    if (!isBrokenPipeError(error)) {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ProgressiveBlur] helper stdin closed while writing command: ${message}`);
    processToClose?.kill();
    if (processToClose !== this.process) {
      return true;
    }
    this.rejectReady?.(error instanceof Error ? error : new Error(message));
    this.clearProcessState();
    return true;
  }

  private clearProcessState(): void {
    this.process = null;
    this.isReady = false;
    this.isVisible = false;
    this.debugState.ready = false;
    this.debugState.visible = false;
    this.stdoutBuffer = '';
    this.pendingCommands = [];
    this.lastSentVisibilityCommand = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  private syncDesiredVisibility(): void {
    if (this.platform !== 'darwin') {
      return;
    }

    if (!this.desiredVisible && !this.process) {
      return;
    }

    if (this.lastSentVisibilityCommand === this.desiredVisible) {
      return;
    }

    this.lastSentVisibilityCommand = this.desiredVisible;
    const commandId = ++this.lastVisibilityCommandId;
    const command = this.desiredVisible ? 'show' : 'hide';
    this.emitLifecycleEvent(this.desiredVisible ? 'show-command' : 'hide-command', { commandId });
    this.sendCommand(`${command} ${commandId}`);
  }

  private emitLifecycleEvent(
    type: ProgressiveBlurLifecycleEventType,
    extras: Partial<Pick<ProgressiveBlurLifecycleEvent, 'code' | 'signal' | 'error' | 'commandId'>> = {},
  ): void {
    const at = Date.now();

    switch (type) {
      case 'ready':
        this.debugState.readyAt = at;
        this.debugState.lastLaunchFailedAt = null;
        this.debugState.lastLaunchFailedError = null;
        break;
      case 'show-command':
        this.debugState.lastShowCommandAt = at;
        break;
      case 'shown':
        this.isVisible = true;
        this.debugState.lastShownAt = at;
        break;
      case 'hide-command':
        this.debugState.lastHideCommandAt = at;
        break;
      case 'hidden':
        this.isVisible = false;
        this.debugState.lastHiddenAt = at;
        break;
      case 'launch-failed':
        this.debugState.lastLaunchFailedAt = at;
        this.debugState.lastLaunchFailedError = extras.error ?? null;
        break;
      case 'exited':
        this.isVisible = false;
        this.debugState.exitCode = extras.code ?? null;
        this.debugState.exitSignal = extras.signal ?? null;
        break;
    }

    this.debugState.ready = this.isReady || type === 'ready';
    if (type === 'exited' || type === 'launch-failed') {
      this.debugState.ready = false;
    }
    this.debugState.visible = this.isVisible;
    this.debugState.lastEventType = type;
    this.debugState.lastEventAt = at;

    this.onLifecycleEvent?.({
      type,
      at,
      ready: this.debugState.ready,
      visible: this.debugState.visible,
      ...extras,
    });
  }
}
