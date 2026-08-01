import { spawn, type ChildProcess } from 'node:child_process';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import type { InputPort } from '../../shared/ports.js';
import { getInterpreterOverlayNativeHelperPath } from './native-helper-paths.js';

interface InputOptions {
  enableGlobalHook?: boolean;
}

type HookBackend = 'none' | 'uiohook' | 'keyboard-monitor';
// The darwin `keyboard-monitor` helper polls CGEventSource state for modifier,
// Esc, and left-mouse drag transitions. Ctrl+Space is handled at the Electron
// layer via globalShortcut (Carbon RegisterEventHotKey), which does not
// require Input Monitoring.
type HookMessage =
  | 'READY'
  | 'CTRL_DOWN'
  | 'CTRL_UP'
  | 'SHIFT_DOWN'
  | 'SHIFT_UP'
  | 'ESC'
  | `MOUSE_DOWN ${number} ${number} ${number}`
  | `MOUSE_MOVE ${number} ${number}`
  | `MOUSE_UP ${number} ${number} ${number}`;
type MouseHookEvent = { x: number; y: number; button?: unknown };
type MousePoint = { x: number; y: number; coordinateSpace?: 'dip' | 'physical' };
type MouseButtonPoint = MousePoint & { button: number };

export interface InputStateSnapshot {
  ctrlHeld: boolean;
  shiftHeld: boolean;
  spaceHeld: boolean;
  ctrlSpaceHeld: boolean;
}

export const DEFAULT_INPUT_STATE: InputStateSnapshot = {
  ctrlHeld: false,
  shiftHeld: false,
  spaceHeld: false,
  ctrlSpaceHeld: false,
};

function isEscapeKeycode(keycode: number): boolean {
  if (keycode === UiohookKey.Escape) {
    return true;
  }

  if (process.platform === 'darwin') {
    return keycode === 53;
  }

  if (process.platform === 'linux') {
    return keycode === 1;
  }

  return false;
}

export type InputTransition =
  | 'CTRL_DOWN'
  | 'CTRL_UP'
  | 'SHIFT_DOWN'
  | 'SHIFT_UP'
  | 'SPACE_DOWN'
  | 'SPACE_UP'
  | 'ESC';

export type InputEffect =
  | 'ctrl-down'
  | 'ctrl-up'
  | 'shift-down'
  | 'shift-up'
  | 'ctrl-space-down'
  | 'ctrl-space-up'
  | 'esc';

export function reduceInputTransition(
  state: InputStateSnapshot,
  transition: InputTransition,
): { nextState: InputStateSnapshot; effects: InputEffect[] } {
  const nextState = { ...state };
  const effects: InputEffect[] = [];

  const setCtrlSpaceHeld = (nextValue: boolean): void => {
    if (nextState.ctrlSpaceHeld === nextValue) {
      return;
    }

    nextState.ctrlSpaceHeld = nextValue;
    effects.push(nextValue ? 'ctrl-space-down' : 'ctrl-space-up');
  };

  switch (transition) {
    case 'CTRL_DOWN':
      if (!nextState.ctrlHeld) {
        nextState.ctrlHeld = true;
        effects.push('ctrl-down');
      }
      if (nextState.spaceHeld) {
        setCtrlSpaceHeld(true);
      }
      break;
    case 'CTRL_UP':
      if (nextState.ctrlHeld) {
        nextState.ctrlHeld = false;
        effects.push('ctrl-up');
      }
      setCtrlSpaceHeld(false);
      break;
    case 'SHIFT_DOWN':
      if (!nextState.shiftHeld) {
        nextState.shiftHeld = true;
        effects.push('shift-down');
      }
      break;
    case 'SHIFT_UP':
      if (nextState.shiftHeld) {
        nextState.shiftHeld = false;
        effects.push('shift-up');
      }
      break;
    case 'SPACE_DOWN':
      if (!nextState.spaceHeld) {
        nextState.spaceHeld = true;
      }
      if (nextState.ctrlHeld) {
        setCtrlSpaceHeld(true);
      }
      break;
    case 'SPACE_UP':
      if (nextState.spaceHeld) {
        nextState.spaceHeld = false;
      }
      setCtrlSpaceHeld(false);
      break;
    case 'ESC':
      effects.push('esc');
      break;
  }

  return { nextState, effects };
}

export class Input implements InputPort {
  private ctrlDownCallbacks: Array<() => void> = [];
  private ctrlUpCallbacks: Array<() => void> = [];
  private shiftDownCallbacks: Array<() => void> = [];
  private shiftUpCallbacks: Array<() => void> = [];
  private ctrlSpaceDownCallbacks: Array<() => void> = [];
  private ctrlSpaceUpCallbacks: Array<() => void> = [];
  private escCallbacks: Array<() => void> = [];
  private pasteShortcutCallbacks: Array<() => void> = [];
  private submitShortcutCallbacks: Array<() => void> = [];
  private mouseDownCallbacks: Array<(point: MouseButtonPoint) => void> = [];
  private mouseMoveCallbacks: Array<(point: MousePoint) => void> = [];
  private mouseUpCallbacks: Array<(point: MouseButtonPoint) => void> = [];
  private state: InputStateSnapshot = { ...DEFAULT_INPUT_STATE };
  private pasteShortcutHeld = false;
  private submitShortcutHeld = false;
  private readonly enableGlobalHook: boolean;
  private backend: HookBackend = 'none';
  private hookProcess: ChildProcess | null = null;
  private hookReady = false;
  private hookStdoutBuffer = '';
  private readonly keydownHandler = (event: { keycode: number }) => {
    const { keycode } = event;

    if (keycode === UiohookKey.Ctrl || keycode === UiohookKey.CtrlRight) {
      this.applyTransition('CTRL_DOWN');
    }

    if (keycode === UiohookKey.Shift || keycode === UiohookKey.ShiftRight) {
      this.applyTransition('SHIFT_DOWN');
    }

    if (keycode === UiohookKey.Space) {
      this.applyTransition('SPACE_DOWN');
    }

    if (isEscapeKeycode(keycode)) {
      this.applyTransition('ESC');
    }

    if (keycode === UiohookKey.V && this.state.ctrlHeld && !this.pasteShortcutHeld) {
      this.pasteShortcutHeld = true;
      this.fireCallbacks(this.pasteShortcutCallbacks);
    }

    if (
      (keycode === UiohookKey.Enter || keycode === UiohookKey.NumpadEnter)
      && !this.state.shiftHeld
      && !this.submitShortcutHeld
    ) {
      this.submitShortcutHeld = true;
      this.fireCallbacks(this.submitShortcutCallbacks);
    }
  };
  private readonly keyupHandler = (event: { keycode: number }) => {
    const { keycode } = event;

    if (keycode === UiohookKey.Ctrl || keycode === UiohookKey.CtrlRight) {
      this.applyTransition('CTRL_UP');
    }

    if (keycode === UiohookKey.Shift || keycode === UiohookKey.ShiftRight) {
      this.applyTransition('SHIFT_UP');
    }

    if (keycode === UiohookKey.Space) {
      this.applyTransition('SPACE_UP');
    }

    if (keycode === UiohookKey.V) {
      this.pasteShortcutHeld = false;
    }

    if (keycode === UiohookKey.Enter || keycode === UiohookKey.NumpadEnter) {
      this.submitShortcutHeld = false;
    }
  };
  private readonly mouseDownHandler = (event: MouseHookEvent) => {
    this.fireMouseDownCallbacks({
      x: event.x,
      y: event.y,
      button: typeof event.button === 'number' ? event.button : 0,
    });
  };
  private readonly mouseMoveHandler = (event: { x: number; y: number }) => {
    this.fireMouseMoveCallbacks({
      x: event.x,
      y: event.y,
    });
  };
  private readonly mouseUpHandler = (event: MouseHookEvent) => {
    this.fireMouseUpCallbacks({
      x: event.x,
      y: event.y,
      button: typeof event.button === 'number' ? event.button : 0,
    });
  };

  constructor(options: InputOptions = {}) {
    this.enableGlobalHook = options.enableGlobalHook ?? true;

    if (this.enableGlobalHook) {
      this.startGlobalHook();
    }
  }

  onCtrlDown(cb: () => void): void {
    this.ctrlDownCallbacks.push(cb);
  }

  onCtrlUp(cb: () => void): void {
    this.ctrlUpCallbacks.push(cb);
  }

  onShiftDown(cb: () => void): void {
    this.shiftDownCallbacks.push(cb);
  }

  onShiftUp(cb: () => void): void {
    this.shiftUpCallbacks.push(cb);
  }

  onCtrlSpaceDown(cb: () => void): void {
    this.ctrlSpaceDownCallbacks.push(cb);
  }

  onCtrlSpaceUp(cb: () => void): void {
    this.ctrlSpaceUpCallbacks.push(cb);
  }

  onEsc(cb: () => void): void {
    this.escCallbacks.push(cb);
  }

  onPasteShortcut(cb: () => void): void {
    this.pasteShortcutCallbacks.push(cb);
  }

  onSubmitShortcut(cb: () => void): void {
    this.submitShortcutCallbacks.push(cb);
  }

  onMouseDown(cb: (point: MouseButtonPoint) => void): void {
    this.mouseDownCallbacks.push(cb);
  }

  onMouseMove(cb: (point: MousePoint) => void): void {
    this.mouseMoveCallbacks.push(cb);
  }

  onMouseUp(cb: (point: MouseButtonPoint) => void): void {
    this.mouseUpCallbacks.push(cb);
  }

  dispose(): void {
    if (this.backend === 'keyboard-monitor') {
      const processToStop = this.hookProcess;
      this.hookProcess = null;
      this.hookReady = false;
      this.hookStdoutBuffer = '';
      if (processToStop && !processToStop.killed) {
        processToStop.kill();
      }
    }

    if (this.backend === 'uiohook') {
      uIOhook.off('keydown', this.keydownHandler);
      uIOhook.off('keyup', this.keyupHandler);
      uIOhook.off('mousedown', this.mouseDownHandler);
      uIOhook.off('mousemove', this.mouseMoveHandler);
      uIOhook.off('mouseup', this.mouseUpHandler);
      uIOhook.stop();
    }

    this.backend = 'none';
    this.state = { ...DEFAULT_INPUT_STATE };
    this.pasteShortcutHeld = false;
    this.submitShortcutHeld = false;
  }

  private startGlobalHook(): void {
    if (process.platform === 'darwin') {
      this.startKeyboardMonitor();
      return;
    }

    try {
      uIOhook.on('keydown', this.keydownHandler);
      uIOhook.on('keyup', this.keyupHandler);
      uIOhook.on('mousedown', this.mouseDownHandler);
      uIOhook.on('mousemove', this.mouseMoveHandler);
      uIOhook.on('mouseup', this.mouseUpHandler);
      uIOhook.start();
      this.backend = 'uiohook';
    } catch (error) {
      uIOhook.off('keydown', this.keydownHandler);
      uIOhook.off('keyup', this.keyupHandler);
      uIOhook.off('mousedown', this.mouseDownHandler);
      uIOhook.off('mousemove', this.mouseMoveHandler);
      uIOhook.off('mouseup', this.mouseUpHandler);
      this.backend = 'none';
      console.warn(
        '[Input] global keyboard hook unavailable; overlay hotkey will continue through Electron globalShortcut:',
        error,
      );
    }
  }

  private startKeyboardMonitor(): void {
    const child = spawn(getInterpreterOverlayNativeHelperPath('keyboard-monitor'), [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer) => {
      this.handleHookStdout(chunk.toString('utf8'));
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const output = chunk.toString('utf8').trim();
      if (output) {
        console.error(`[Input] keyboard monitor: ${output}`);
      }
    });

    child.on('error', (error) => {
      console.error('[Input] keyboard monitor failed:', error);
    });

    child.on('exit', (code, signal) => {
      if (this.hookProcess !== child) {
        return;
      }

      this.hookProcess = null;
      this.hookReady = false;
      this.hookStdoutBuffer = '';
      this.backend = 'none';

      if (code !== 0 && signal !== 'SIGTERM') {
        console.error(`[Input] keyboard monitor exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      }
    });

    this.hookProcess = child;
    this.backend = 'keyboard-monitor';
  }

  private handleHookStdout(chunk: string): void {
    this.hookStdoutBuffer += chunk;

    let newlineIndex = this.hookStdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.hookStdoutBuffer.slice(0, newlineIndex).trim();
      this.hookStdoutBuffer = this.hookStdoutBuffer.slice(newlineIndex + 1);

      if (line) {
        this.handleHookMessage(line as HookMessage);
      }

      newlineIndex = this.hookStdoutBuffer.indexOf('\n');
    }
  }

  private handleHookMessage(message: HookMessage): void {
    if (message === 'READY') {
      this.hookReady = true;
      console.log('[Input] keyboard monitor ready');
      return;
    }

    if (!this.hookReady) {
      return;
    }

    if (message === 'CTRL_DOWN') {
      this.applyTransition('CTRL_DOWN');
      return;
    }

    if (message === 'CTRL_UP') {
      this.applyTransition('CTRL_UP');
      return;
    }

    if (message === 'SHIFT_DOWN') {
      this.applyTransition('SHIFT_DOWN');
      return;
    }

    if (message === 'SHIFT_UP') {
      this.applyTransition('SHIFT_UP');
      return;
    }

    if (message === 'ESC') {
      this.applyTransition('ESC');
      return;
    }

    const parts = message.split(' ');
    const eventName = parts[0];
    if (eventName === 'MOUSE_DOWN' || eventName === 'MOUSE_UP') {
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const button = Number(parts[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(button)) {
        return;
      }

      if (eventName === 'MOUSE_DOWN') {
        this.fireMouseDownCallbacks({ x, y, button, coordinateSpace: 'dip' });
      } else {
        this.fireMouseUpCallbacks({ x, y, button, coordinateSpace: 'dip' });
      }
      return;
    }

    if (eventName === 'MOUSE_MOVE') {
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }

      this.fireMouseMoveCallbacks({ x, y, coordinateSpace: 'dip' });
    }
  }

  private applyTransition(transition: InputTransition): void {
    const { nextState, effects } = reduceInputTransition(this.state, transition);
    this.state = nextState;

    for (const effect of effects) {
      switch (effect) {
        case 'ctrl-down':
          this.fireCallbacks(this.ctrlDownCallbacks);
          break;
        case 'ctrl-up':
          this.fireCallbacks(this.ctrlUpCallbacks);
          break;
        case 'shift-down':
          this.fireCallbacks(this.shiftDownCallbacks);
          break;
        case 'shift-up':
          this.fireCallbacks(this.shiftUpCallbacks);
          break;
        case 'ctrl-space-down':
          this.fireCallbacks(this.ctrlSpaceDownCallbacks);
          break;
        case 'ctrl-space-up':
          this.fireCallbacks(this.ctrlSpaceUpCallbacks);
          break;
        case 'esc':
          this.fireCallbacks(this.escCallbacks);
          break;
      }
    }
  }

  private fireCallbacks(callbacks: Array<() => void>): void {
    for (const cb of callbacks) {
      try {
        cb();
      } catch (error) {
        console.error('Error in keyboard callback:', error);
      }
    }
  }

  private fireMouseDownCallbacks(point: MouseButtonPoint): void {
    for (const cb of this.mouseDownCallbacks) {
      try {
        cb(point);
      } catch (error) {
        console.error('Error in mouse down callback:', error);
      }
    }
  }

  private fireMouseMoveCallbacks(point: MousePoint): void {
    for (const cb of this.mouseMoveCallbacks) {
      try {
        cb(point);
      } catch (error) {
        console.error('Error in mouse move callback:', error);
      }
    }
  }

  private fireMouseUpCallbacks(point: MouseButtonPoint): void {
    for (const cb of this.mouseUpCallbacks) {
      try {
        cb(point);
      } catch (error) {
        console.error('Error in mouse up callback:', error);
      }
    }
  }
}
