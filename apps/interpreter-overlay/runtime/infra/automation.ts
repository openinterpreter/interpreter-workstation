import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mouse, Button, keyboard, Key } from '@nut-tree-fork/nut-js';
import { clipboard } from '../../electron/electron-bridge.js';
import { INTERPRETER_OVERLAY_VISION_MODE as OVERLAY_VISION_MODE } from '../../shared/agent-mode.js';
import type { AutomationPort, BrowserPageElementTarget, NativeCuaAppWindowTarget, NativeCuaElementTarget, NativeCuaPointTarget } from '../../shared/ports.js';
import type { Bounds } from '../../shared/ports.js';
import type { ScrollParams } from '../../shared/types.js';
import { activateWindowAtCoordinates } from './focus-helper.js';
import { getInterpreterOverlayNativeHelperPath } from './native-helper-paths.js';
import {
  callWindowsUiaTool,
  parseWindowsUiaElementId,
  type WindowsUiaWindow,
} from './windows-uia.js';

mouse.config.autoDelayMs = 3;
keyboard.config.autoDelayMs = 3;
mouse.config.mouseSpeed = 10000;

const WINDOW_ACTIVATION_SETTLE_DELAY_MS = 48;
const CLICK_PRESS_DURATION_MS = 42;
const BUTTON_CONFIRM_DELAY_MS = 80;
const RADIO_CONFIRM_DELAY_MS = 12;
const CLICK_SETTLE_DELAY_MS = 8;
const DROPDOWN_OPEN_SETTLE_DELAY_MS = 48;
const MENU_SELECTION_SETTLE_DELAY_MS = 32;
const TYPE_AFTER_CLICK_DELAY_MS = 32;
const TYPE_FOCUSED_START_DELAY_MS = 12;
const TYPE_COMPLETE_SETTLE_DELAY_MS = 0;
const VISION_CLICK_SETTLE_DELAY_MS = 72;
const VISION_TYPE_FOCUSED_START_DELAY_MS = 260;
const VISION_TYPE_BETWEEN_CHARS_DELAY_MS = 16;
const VISION_TYPE_COMPLETE_SETTLE_DELAY_MS = 320;
const VISION_TYPE_COMPLETE_SETTLE_PER_CHAR_MS = 14;
const VISION_TYPE_COMPLETE_SETTLE_MAX_MS = 2200;
const VISION_PASTE_SETTLE_DELAY_MS = 220;
const VISION_PASTE_SETTLE_PER_CHAR_MS = 6;
const VISION_PASTE_SETTLE_MAX_MS = 1800;
const VISION_HOTKEY_COMPLETE_SETTLE_DELAY_MS = 60;
const VISION_TAB_HOTKEY_COMPLETE_SETTLE_DELAY_MS = 240;
const SELECT_ALL_SETTLE_DELAY_MS = 16;
const CLEAR_SELECTED_TEXT_SETTLE_MS = 16;
const SCROLL_SETTLE_DELAY_MS = 32;
const AX_SET_FOCUSED_TEXT_TIMEOUT_MS = 1000;
const WINDOWS_UIA_ELEMENT_ACTION_TIMEOUT_MS = 30_000;
const AUTOMATION_DEBUG_EVENT_LIMIT = 2000;
const EMERGENCY_STOP_CORNER_THRESHOLD_PX = 24;
const EMERGENCY_STOP_POLL_INTERVAL_MS = 16;

export interface AutomationDebugEvent {
  seq: number;
  timeMs: number;
  kind: string;
  details: Record<string, unknown>;
}

export interface AutomationOptions {
  onEmergencyStop?: (position: { x: number; y: number }) => void;
  preferredWindowActivator?: (() => Promise<boolean>) | null;
  nativeCuaExecutor?: {
    click(target: NativeCuaElementTarget): Promise<void>;
    clickPoint?(target: NativeCuaPointTarget): Promise<void>;
    setValue(target: NativeCuaElementTarget, value: string): Promise<void>;
    typeText(target: NativeCuaElementTarget, text: string): Promise<void>;
    typeAppWindowText?(target: NativeCuaAppWindowTarget, text: string): Promise<void>;
    selectOption(target: NativeCuaElementTarget, option: string): Promise<void>;
    scroll(target: NativeCuaElementTarget, direction: ScrollParams['direction'], pages: number): Promise<void>;
    scrollAppWindow?(target: NativeCuaAppWindowTarget, direction: ScrollParams['direction'], pages: number): Promise<void>;
    pressKey?(target: NativeCuaAppWindowTarget, key: string): Promise<void>;
  };
  browserPageExecutor?: {
    click(target: BrowserPageElementTarget): Promise<void>;
    type(target: BrowserPageElementTarget, text: string): Promise<void>;
    select(target: BrowserPageElementTarget, value: string): Promise<void>;
    scroll(target: BrowserPageElementTarget, direction: ScrollParams['direction'], amount: number): Promise<void>;
  };
}

let automationDebugSeq = 0;
const automationDebugTrace: AutomationDebugEvent[] = [];

function truncateDebugText(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function recordAutomationDebugEvent(kind: string, details: Record<string, unknown> = {}): void {
  automationDebugTrace.push({
    seq: ++automationDebugSeq,
    timeMs: Date.now(),
    kind,
    details,
  });
  if (automationDebugTrace.length > AUTOMATION_DEBUG_EVENT_LIMIT) {
    automationDebugTrace.splice(0, automationDebugTrace.length - AUTOMATION_DEBUG_EVENT_LIMIT);
  }
}

export function getAutomationDebugTrace(): AutomationDebugEvent[] {
  return automationDebugTrace.slice();
}

export function resetAutomationDebugTrace(): void {
  automationDebugTrace.length = 0;
  automationDebugSeq = 0;
}

function isEmergencyStopPosition(position: { x: number; y: number }): boolean {
  return position.x <= EMERGENCY_STOP_CORNER_THRESHOLD_PX
    && position.y <= EMERGENCY_STOP_CORNER_THRESHOLD_PX;
}

function createEmergencyStopError(position: { x: number; y: number }): Error {
  const error = new Error(
    `Interpreter Overlay emergency stop triggered at screen origin (${Math.round(position.x)}, ${Math.round(position.y)}).`,
  );
  error.name = 'InterpreterOverlayEmergencyStopError';
  return error;
}

export class Automation implements AutomationPort {
  private visionActionQueue: Promise<void> = Promise.resolve();
  private readonly onEmergencyStop: ((position: { x: number; y: number }) => void) | null;
  private readonly nativeCuaExecutor: AutomationOptions['nativeCuaExecutor'] | null;
  private readonly browserPageExecutor: AutomationOptions['browserPageExecutor'] | null;
  private preferredWindowActivator: (() => Promise<boolean>) | null;
  private emergencyStopPosition: { x: number; y: number } | null = null;
  private emergencyStopMonitorSerial = 0;

  constructor(options: AutomationOptions = {}) {
    this.onEmergencyStop = options.onEmergencyStop ?? null;
    this.nativeCuaExecutor = options.nativeCuaExecutor ?? null;
    this.browserPageExecutor = options.browserPageExecutor ?? null;
    this.preferredWindowActivator = options.preferredWindowActivator ?? null;
  }

  setPreferredWindowActivator(activator: (() => Promise<boolean>) | null): void {
    this.preferredWindowActivator = activator;
  }

  private async activateInteractionWindow(
    centerPx: { x: number; y: number },
    reason: string,
  ): Promise<boolean> {
    if (this.preferredWindowActivator) {
      try {
        const activated = await this.preferredWindowActivator();
        console.log('[Automation] Preferred window activation result:', activated);
        recordAutomationDebugEvent('window-activation', {
          centerPx,
          activated,
          reason,
          source: 'preferred-window',
        });
        return activated;
      } catch (error) {
        console.warn('[Automation] Preferred window activation failed, falling back to coordinate activation:', error);
        recordAutomationDebugEvent('window-activation-error', {
          centerPx,
          reason,
          source: 'preferred-window',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const activated = await activateWindowAtCoordinates(centerPx.x, centerPx.y);
    console.log('[Automation] Window activation result:', activated);
    recordAutomationDebugEvent('window-activation', {
      centerPx,
      activated,
      reason,
      source: 'coordinate',
    });
    return activated;
  }

  private async runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    if (!OVERLAY_VISION_MODE) {
      const stopMonitoring = this.startEmergencyStopMonitor();
      try {
        await this.assertEmergencyStopNotTriggered();
        return await operation();
      } finally {
        stopMonitoring();
      }
    }

    let release!: () => void;
    const nextTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const priorTurn = this.visionActionQueue;
    this.visionActionQueue = priorTurn.then(() => nextTurn, () => nextTurn);
    await priorTurn;
    const stopMonitoring = this.startEmergencyStopMonitor();
    try {
      await this.assertEmergencyStopNotTriggered();
      return await operation();
    } finally {
      stopMonitoring();
      release();
    }
  }

  private startEmergencyStopMonitor(): () => void {
    this.emergencyStopPosition = null;
    const serial = ++this.emergencyStopMonitorSerial;
    const interval = setInterval(() => {
      void this.checkEmergencyStopPosition().catch((error) => {
        recordAutomationDebugEvent('emergency-stop-monitor-error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, EMERGENCY_STOP_POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      if (this.emergencyStopMonitorSerial === serial) {
        this.emergencyStopPosition = null;
      }
    };
  }

  private triggerEmergencyStop(position: { x: number; y: number }): void {
    if (this.emergencyStopPosition) {
      return;
    }

    this.emergencyStopPosition = { x: position.x, y: position.y };
    console.warn('[Automation] Emergency stop triggered at screen origin', this.emergencyStopPosition);
    recordAutomationDebugEvent('emergency-stop-triggered', {
      position: this.emergencyStopPosition,
      thresholdPx: EMERGENCY_STOP_CORNER_THRESHOLD_PX,
    });
    this.onEmergencyStop?.(this.emergencyStopPosition);
  }

  private async checkEmergencyStopPosition(): Promise<void> {
    if (this.emergencyStopPosition) {
      return;
    }

    const position = await mouse.getPosition();
    if (isEmergencyStopPosition(position)) {
      this.triggerEmergencyStop(position);
    }
  }

  private async assertEmergencyStopNotTriggered(): Promise<void> {
    await this.checkEmergencyStopPosition();
    if (this.emergencyStopPosition) {
      throw createEmergencyStopError(this.emergencyStopPosition);
    }
  }

  private async waitWithEmergencyStop(delayMs: number): Promise<void> {
    if (delayMs <= 0) {
      await this.assertEmergencyStopNotTriggered();
      return;
    }

    const deadline = Date.now() + delayMs;
    while (Date.now() < deadline) {
      await this.assertEmergencyStopNotTriggered();
      const remainingMs = deadline - Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.min(EMERGENCY_STOP_POLL_INTERVAL_MS, remainingMs)));
    }

    await this.assertEmergencyStopNotTriggered();
  }

  private async waitForMousePosition(target: { x: number; y: number }): Promise<{ x: number; y: number }> {
    const tolerance = OVERLAY_VISION_MODE ? 2 : 1;
    const deadline = Date.now() + (OVERLAY_VISION_MODE ? 350 : 150);

    while (true) {
      await this.assertEmergencyStopNotTriggered();
      const position = await mouse.getPosition();
      if (
        Math.abs(position.x - target.x) <= tolerance
        && Math.abs(position.y - target.y) <= tolerance
      ) {
        return position;
      }
      if (Date.now() >= deadline) {
        return position;
      }
      await this.waitWithEmergencyStop(8);
    }
  }

  async click(
    centerPx: { x: number; y: number },
    interactionKind: 'default' | 'button' | 'menuitem' | 'radio' | 'checkbox' | 'dropdown-option' = 'default',
    interactionText?: string,
    targetBounds?: Bounds | null,
  ): Promise<void> {
    return this.runSerialized(() => this.performClick(centerPx, interactionKind, interactionText, targetBounds ?? null));
  }

  async clickElement(
    elementId: string,
    interactionKind: 'default' | 'button' | 'menuitem' | 'radio' | 'checkbox' | 'dropdown-option' = 'default',
    interactionText?: string,
    centerPx?: { x: number; y: number } | null,
    referenceWindowBounds?: Bounds | null,
  ): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('Element-id click automation is only implemented for Windows UIA.');
    }
    return this.runSerialized(async () => {
      const target = parseWindowsUiaElementId(elementId);
      if (!target) {
        throw new Error(`Invalid Windows UIA element id: ${elementId}`);
      }
      recordAutomationDebugEvent('uia-click-start', {
        elementId,
        interactionKind,
        interactionText: interactionText ? truncateDebugText(interactionText) : null,
        centerPx: centerPx ?? null,
      });
      const args: Record<string, unknown> = {
        window_id: target.windowId,
        element_index: target.elementIndex,
        view_mode: 'interactive',
        max_elements: 5000,
      };
      await callWindowsUiaTool('click', args, WINDOWS_UIA_ELEMENT_ACTION_TIMEOUT_MS);
      recordAutomationDebugEvent('uia-click-complete', {
        elementId,
        centerPx: centerPx ?? null,
        path: 'windows-uia-element-click',
      });
      await this.waitWithEmergencyStop(CLICK_SETTLE_DELAY_MS);
    });
  }

  async clickNativeCuaElement(target: NativeCuaElementTarget): Promise<void> {
    if (!this.nativeCuaExecutor) {
      throw new Error('Native CUA overlay execution is unavailable.');
    }
    return this.runSerialized(async () => {
      await this.nativeCuaExecutor!.click(target);
    });
  }

  async clickNativeCuaPoint(target: NativeCuaPointTarget): Promise<void> {
    if (!this.nativeCuaExecutor?.clickPoint) {
      throw new Error('Native CUA overlay point-click execution is unavailable.');
    }
    return this.runSerialized(async () => {
      await this.nativeCuaExecutor!.clickPoint!(target);
    });
  }

  async typeAt(
    centerPx: { x: number; y: number },
    text: string,
    clearFirst = false,
    targetBounds?: Bounds | null,
  ): Promise<void> {
    return this.runSerialized(async () => {
      console.log('[Automation] Typing at:', centerPx, 'text length:', text.length, 'clear first:', clearFirst);
      recordAutomationDebugEvent('type-at-start', {
        centerPx,
        textLength: text.length,
        textPreview: truncateDebugText(text),
        clearFirst,
      });
      await this.performClick(centerPx, 'default', undefined, targetBounds ?? null);
      await this.waitWithEmergencyStop(
        OVERLAY_VISION_MODE ? VISION_TYPE_FOCUSED_START_DELAY_MS : TYPE_AFTER_CLICK_DELAY_MS,
      );
      const beforeTypeSnapshotPath = await this.captureDebugSnapshot(centerPx, 'type', 'before', targetBounds ?? null);
      if (clearFirst) {
        await this.clearFocusedText();
      }
      await this.typeTextBlocking(text);
      const afterTypeSnapshotPath = await this.captureDebugSnapshot(centerPx, 'type', 'after', targetBounds ?? null);
      console.log('[Automation] Type completed via keyboard.type()');
      recordAutomationDebugEvent('type-at-complete', {
        centerPx,
        textLength: text.length,
        textPreview: truncateDebugText(text),
        clearFirst,
        beforeTypeSnapshotPath,
        afterTypeSnapshotPath,
      });
      await this.waitWithEmergencyStop(
        OVERLAY_VISION_MODE ? this.getVisionTypeCompleteSettleDelayMs(text.length) : TYPE_COMPLETE_SETTLE_DELAY_MS,
      );
    });
  }

  async typeElement(
    elementId: string,
    text: string,
    clearFirst = false,
    centerPx?: { x: number; y: number } | null,
    referenceWindowBounds?: Bounds | null,
  ): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('Element-id text automation is only implemented for Windows UIA.');
    }
    return this.runSerialized(async () => {
      const target = parseWindowsUiaElementId(elementId);
      if (!target) {
        throw new Error(`Invalid Windows UIA element id: ${elementId}`);
      }
      recordAutomationDebugEvent('uia-type-start', {
        elementId,
        textLength: text.length,
        textPreview: truncateDebugText(text),
        clearFirst,
        centerPx: centerPx ?? null,
      });
      await callWindowsUiaTool('type_text', {
        window_id: target.windowId,
        element_index: target.elementIndex,
        text,
        value: text,
        bring_to_foreground: true,
        view_mode: 'interactive',
        max_elements: 5000,
      }, WINDOWS_UIA_ELEMENT_ACTION_TIMEOUT_MS);
      recordAutomationDebugEvent('uia-type-complete', {
        elementId,
        textLength: text.length,
        textPreview: truncateDebugText(text),
        clearFirst,
        centerPx: centerPx ?? null,
        path: 'windows-uia-type-text',
      });
      await this.waitWithEmergencyStop(TYPE_COMPLETE_SETTLE_DELAY_MS);
    });
  }

  async setNativeCuaElementValue(target: NativeCuaElementTarget, value: string): Promise<void> {
    if (!this.nativeCuaExecutor) {
      throw new Error('Native CUA overlay execution is unavailable.');
    }
    return this.runSerialized(async () => {
      await this.nativeCuaExecutor!.setValue(target, value);
    });
  }

  async typeNativeCuaElementText(target: NativeCuaElementTarget, text: string): Promise<void> {
    if (!this.nativeCuaExecutor) {
      throw new Error('Native CUA overlay execution is unavailable.');
    }
    return this.runSerialized(async () => {
      await this.nativeCuaExecutor!.typeText(target, text);
    });
  }

  async typeNativeCuaAppWindowText(target: NativeCuaAppWindowTarget, text: string): Promise<void> {
    if (!this.nativeCuaExecutor?.typeAppWindowText) {
      throw new Error('Native CUA app-window text execution is unavailable.');
    }
    return this.runSerialized(async () => {
      await this.nativeCuaExecutor!.typeAppWindowText!(target, text);
    });
  }

  async selectNativeCuaElementOption(target: NativeCuaElementTarget, option: string): Promise<void> {
    if (!this.nativeCuaExecutor) {
      throw new Error('Native CUA overlay execution is unavailable.');
    }
    return this.runSerialized(async () => {
      await this.nativeCuaExecutor!.selectOption(target, option);
    });
  }

  async scrollNativeCuaElement(target: NativeCuaElementTarget, direction: ScrollParams['direction'], pages: number): Promise<void> {
    if (!this.nativeCuaExecutor) {
      throw new Error('Native CUA overlay execution is unavailable.');
    }
    return this.runSerialized(async () => {
      await this.nativeCuaExecutor!.scroll(target, direction, pages);
    });
  }

  async scrollNativeCuaAppWindow(target: NativeCuaAppWindowTarget, direction: ScrollParams['direction'], pages: number): Promise<void> {
    if (!this.nativeCuaExecutor?.scrollAppWindow) {
      throw new Error('Native CUA app-window scroll execution is unavailable.');
    }
    return this.runSerialized(async () => {
      await this.nativeCuaExecutor!.scrollAppWindow!(target, direction, pages);
    });
  }

  async pressNativeCuaKey(target: NativeCuaAppWindowTarget, key: string): Promise<void> {
    if (!this.nativeCuaExecutor?.pressKey) {
      throw new Error('Native CUA overlay key execution is unavailable.');
    }
    return this.runSerialized(async () => {
      await this.nativeCuaExecutor!.pressKey!(target, key);
    });
  }

  async clickBrowserPageElement(target: BrowserPageElementTarget): Promise<void> {
    if (!this.browserPageExecutor) {
      throw new Error('Browser page overlay execution is unavailable.');
    }
    return this.runSerialized(() => this.browserPageExecutor!.click(target));
  }

  async typeBrowserPageElement(target: BrowserPageElementTarget, text: string): Promise<void> {
    if (!this.browserPageExecutor) {
      throw new Error('Browser page overlay execution is unavailable.');
    }
    return this.runSerialized(() => this.browserPageExecutor!.type(target, text));
  }

  async selectBrowserPageElementOption(target: BrowserPageElementTarget, value: string): Promise<void> {
    if (!this.browserPageExecutor) {
      throw new Error('Browser page overlay execution is unavailable.');
    }
    return this.runSerialized(() => this.browserPageExecutor!.select(target, value));
  }

  async scrollBrowserPageElement(target: BrowserPageElementTarget, direction: ScrollParams['direction'], amount: number): Promise<void> {
    if (!this.browserPageExecutor) {
      throw new Error('Browser page overlay execution is unavailable.');
    }
    return this.runSerialized(() => this.browserPageExecutor!.scroll(target, direction, amount));
  }

  async selectOptionElement(
    elementId: string,
    optionText: string,
    centerPx?: { x: number; y: number } | null,
    targetBounds?: Bounds | null,
  ): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('Element-id option selection is only implemented for Windows UIA.');
    }
    return this.runSerialized(async () => {
      const target = parseWindowsUiaElementId(elementId);
      if (!target) {
        throw new Error(`Invalid Windows UIA element id: ${elementId}`);
      }
      recordAutomationDebugEvent('uia-select-option-start', {
        elementId,
        optionText: truncateDebugText(optionText),
        centerPx: centerPx ?? null,
      });
      try {
        await callWindowsUiaTool('select_option', {
          window_id: target.windowId,
          element_index: target.elementIndex,
          option_text: optionText,
          view_mode: 'interactive',
          max_elements: 5000,
        }, WINDOWS_UIA_ELEMENT_ACTION_TIMEOUT_MS);
        recordAutomationDebugEvent('uia-select-option-complete', {
          elementId,
          optionText: truncateDebugText(optionText),
          method: 'windows-uia-select-option',
          path: 'windows-uia-select-option',
        });
        await this.waitWithEmergencyStop(CLICK_SETTLE_DELAY_MS);
        return;
      } catch (error) {
        recordAutomationDebugEvent('uia-select-option-failed', {
          elementId,
          optionText: truncateDebugText(optionText),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await callWindowsUiaTool('select_option', {
          window_id: target.windowId,
          element_index: target.elementIndex,
          option_text: optionText,
          view_mode: 'interactive',
          max_elements: 5000,
          bring_to_foreground: true,
      }, WINDOWS_UIA_ELEMENT_ACTION_TIMEOUT_MS);
      recordAutomationDebugEvent('uia-select-option-complete', {
        elementId,
        optionText: truncateDebugText(optionText),
        method: 'windows-uia-select-option',
        path: 'windows-uia-select-option',
      });
      await this.waitWithEmergencyStop(CLICK_SETTLE_DELAY_MS);
    });
  }

  async typeFocused(
    text: string,
    clearFirst = false,
    centerPx?: { x: number; y: number } | null,
    targetBounds?: Bounds | null,
    preferClipboard = true,
  ): Promise<void> {
    return this.runSerialized(async () => {
      console.log('[Automation] Typing into focused control, text length:', text.length, 'clear first:', clearFirst);
      recordAutomationDebugEvent('type-focused-start', {
        textLength: text.length,
        textPreview: truncateDebugText(text),
        clearFirst,
        centerPx: centerPx ?? null,
      });
      await this.waitWithEmergencyStop(
        OVERLAY_VISION_MODE ? VISION_TYPE_FOCUSED_START_DELAY_MS : TYPE_FOCUSED_START_DELAY_MS,
      );
      const beforeTypeSnapshotPath = centerPx
        ? await this.captureDebugSnapshot(centerPx, 'type-focused', 'before', targetBounds ?? null)
        : null;
      if (clearFirst) {
        await this.clearFocusedText();
      }
      await this.typeTextBlocking(text, preferClipboard);
      const afterTypeSnapshotPath = centerPx
        ? await this.captureDebugSnapshot(centerPx, 'type-focused', 'after', targetBounds ?? null)
        : null;
      console.log('[Automation] Focused type completed');
      recordAutomationDebugEvent('type-focused-complete', {
        textLength: text.length,
        textPreview: truncateDebugText(text),
        clearFirst,
        centerPx: centerPx ?? null,
        beforeTypeSnapshotPath,
        afterTypeSnapshotPath,
      });
      await this.waitWithEmergencyStop(
        OVERLAY_VISION_MODE ? this.getVisionTypeCompleteSettleDelayMs(text.length) : TYPE_COMPLETE_SETTLE_DELAY_MS,
      );
    });
  }

  async setFocusedText(text: string): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return false;
    }

    try {
      const result = execFileSync(
        getInterpreterOverlayNativeHelperPath('ax-set-focused-text'),
        [text],
        {
          encoding: 'utf-8',
          timeout: AX_SET_FOCUSED_TEXT_TIMEOUT_MS,
        },
      ).trim();
      console.log('[Automation] AX focused text set result:', result);
      recordAutomationDebugEvent('ax-set-focused-text', {
        textLength: text.length,
        textPreview: truncateDebugText(text),
        result,
      });
      return result === 'ok';
    } catch (error) {
      console.warn('[Automation] Failed to set focused text via AX:', error);
      recordAutomationDebugEvent('ax-set-focused-text-failed', {
        textLength: text.length,
        textPreview: truncateDebugText(text),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async pressHotkey(hotkey: string, centerPx?: { x: number; y: number } | null): Promise<void> {
    return this.runSerialized(async () => {
      const platformHotkey = this.coerceHotkeyForPlatform(hotkey);
      const normalizedHotkey = platformHotkey.trim().toLowerCase();
      if (centerPx) {
        const activated = await activateWindowAtCoordinates(centerPx.x, centerPx.y);
        console.log('[Automation] Hotkey window activation result:', activated);
        recordAutomationDebugEvent('window-activation', {
          centerPx,
          activated,
          reason: OVERLAY_VISION_MODE ? 'vision-mode-prehotkey-activation' : 'hotkey',
        });
        await this.waitWithEmergencyStop(WINDOW_ACTIVATION_SETTLE_DELAY_MS);
      }
      if (OVERLAY_VISION_MODE && process.platform === 'darwin') {
        const tokens = platformHotkey
          .split('+')
          .map((token) => token.trim().toLowerCase())
          .filter(Boolean);
        const executedViaAppleScript = this.tryRunMacHotkeyViaAppleScript(tokens);
        if (executedViaAppleScript) {
          recordAutomationDebugEvent('hotkey-start', {
            hotkey: platformHotkey,
            requestedHotkey: hotkey,
            path: 'osascript',
            centerPx: centerPx ?? null,
          });
          recordAutomationDebugEvent('hotkey-complete', {
            hotkey: platformHotkey,
            requestedHotkey: hotkey,
            path: 'osascript',
          });
          await this.waitWithEmergencyStop(
            normalizedHotkey === 'tab' || normalizedHotkey === 'shift+tab'
              ? VISION_TAB_HOTKEY_COMPLETE_SETTLE_DELAY_MS
              : VISION_HOTKEY_COMPLETE_SETTLE_DELAY_MS,
          );
          return;
        }
      }
      const { modifiers, key } = this.parseHotkey(platformHotkey);
      recordAutomationDebugEvent('hotkey-start', {
        hotkey: platformHotkey,
        requestedHotkey: hotkey,
        modifiers,
        key,
        centerPx: centerPx ?? null,
      });

      for (const mod of modifiers) {
        await keyboard.pressKey(mod);
      }

      await keyboard.pressKey(key);
      await keyboard.releaseKey(key);

      for (const mod of modifiers.reverse()) {
        await keyboard.releaseKey(mod);
      }
      recordAutomationDebugEvent('hotkey-complete', {
        hotkey: platformHotkey,
        requestedHotkey: hotkey,
      });
      await this.waitWithEmergencyStop(
        OVERLAY_VISION_MODE
          ? (normalizedHotkey === 'tab' || normalizedHotkey === 'shift+tab'
              ? VISION_TAB_HOTKEY_COMPLETE_SETTLE_DELAY_MS
              : VISION_HOTKEY_COMPLETE_SETTLE_DELAY_MS)
          : 0,
      );
    });
  }

  async scroll(
    centerPx: { x: number; y: number },
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number,
  ): Promise<void> {
    return this.runSerialized(async () => {
      const steps = OVERLAY_VISION_MODE
        ? Math.max(1, Math.round(Math.abs(amount)))
        : Math.max(1, Math.round(Math.abs(amount)));
      console.log('[Automation] Scrolling at:', centerPx, `direction=${direction}`, `amount=${steps}`);
      recordAutomationDebugEvent('scroll-start', {
        centerPx,
        direction,
        amount: steps,
      });

      await this.activateInteractionWindow(
        centerPx,
        OVERLAY_VISION_MODE ? 'vision-mode-prescroll-activation' : 'scroll',
      );
      await this.waitWithEmergencyStop(WINDOW_ACTIVATION_SETTLE_DELAY_MS);

      const originalPosition = await mouse.getPosition();
      await mouse.setPosition({ x: centerPx.x, y: centerPx.y });
      const positionedMouse = await this.waitForMousePosition({ x: centerPx.x, y: centerPx.y });
      const beforeSnapshotPath = await this.captureDebugSnapshot(centerPx, `scroll-${direction}`, 'before');

      switch (direction) {
        case 'up':
          await mouse.scrollUp(steps);
          break;
        case 'down':
          await mouse.scrollDown(steps);
          break;
        case 'left':
          await mouse.scrollLeft(steps);
          break;
        case 'right':
          await mouse.scrollRight(steps);
          break;
      }

      await this.waitWithEmergencyStop(SCROLL_SETTLE_DELAY_MS);
      const afterSnapshotPath = await this.captureDebugSnapshot(centerPx, `scroll-${direction}`, 'after');
      await mouse.setPosition(originalPosition);
      recordAutomationDebugEvent('scroll-complete', {
        centerPx,
        positionedMouse,
        direction,
        amount: steps,
        beforeSnapshotPath,
        afterSnapshotPath,
      });
      console.log('[Automation] Scroll completed');
    });
  }

  async scrollElement(
    elementId: string,
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number,
  ): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('Element-id scroll automation is only implemented for Windows UIA.');
    }
    return this.runSerialized(async () => {
      const target = parseWindowsUiaElementId(elementId);
      if (!target) {
        throw new Error(`Invalid Windows UIA element id: ${elementId}`);
      }
      const steps = Math.max(1, Math.round(Math.abs(amount)));
      recordAutomationDebugEvent('uia-scroll-start', {
        elementId,
        direction,
        amount: steps,
      });
      await callWindowsUiaTool('scroll', {
        window_id: target.windowId,
        element_index: target.elementIndex,
        direction,
        amount: steps,
      });
      recordAutomationDebugEvent('uia-scroll-complete', {
        elementId,
        direction,
        amount: steps,
      });
      await this.waitWithEmergencyStop(SCROLL_SETTLE_DELAY_MS);
    });
  }

  private async performClick(
    centerPx: { x: number; y: number },
    interactionKind: 'default' | 'button' | 'menuitem' | 'radio' | 'checkbox' | 'dropdown-option' = 'default',
    interactionText?: string,
    targetBounds?: Bounds | null,
  ): Promise<void> {
    console.log('[Automation] Clicking at:', centerPx, interactionKind === 'default' ? '' : `(${interactionKind})`);
    recordAutomationDebugEvent('click-start', {
      centerPx,
      interactionKind,
      interactionText: interactionText ? truncateDebugText(interactionText) : null,
    });

    if (interactionKind === 'default' || interactionKind === 'button' || interactionKind === 'radio' || interactionKind === 'checkbox') {
      await this.activateInteractionWindow(
        centerPx,
        OVERLAY_VISION_MODE ? 'vision-mode-preclick-activation' : 'default',
      );
      await this.waitWithEmergencyStop(WINDOW_ACTIVATION_SETTLE_DELAY_MS);
    } else {
      recordAutomationDebugEvent('window-activation-skipped', {
        centerPx,
        interactionKind,
        reason: 'preserve-open-menu-focus',
      });
    }

    const originalPosition = await mouse.getPosition();
    await mouse.setPosition({ x: centerPx.x, y: centerPx.y });
    const positionedMouse = await this.waitForMousePosition({ x: centerPx.x, y: centerPx.y });
    const beforeSnapshotPath = await this.captureDebugSnapshot(centerPx, interactionKind, 'before', targetBounds ?? null);

    if (interactionKind === 'menuitem' || interactionKind === 'dropdown-option') {
      await mouse.pressButton(Button.LEFT);
      await this.waitWithEmergencyStop(CLICK_PRESS_DURATION_MS);
      await mouse.releaseButton(Button.LEFT);
      await this.waitWithEmergencyStop(MENU_SELECTION_SETTLE_DELAY_MS);
      recordAutomationDebugEvent('menu-selection-complete', {
        centerPx,
        positionedMouse,
        interactionKind,
        interactionText: interactionText ? truncateDebugText(interactionText) : null,
        originalPosition,
        beforeSnapshotPath,
      });
    } else {
      // NOTE(victor): Keep default clicks on explicit down/up primitives instead
      // of mouse.click().
      //
      // Evidence:
      // - https://open-interpreter.sentry.io/issues/7343925105/ (ELECTRON-4J)
      //   and https://open-interpreter.sentry.io/issues/7346591049/ (ELECTRON-4N)
      //   are the native fatal macOS groups closed by PR #1151, mirrored by
      //   openinterpreter/iworkstation-issues#1098, #1099, #1170, #1254, #1286,
      //   #1301, #1317, #1378, #1383, #1442, #1504, #1507, #1525, #1575, #1589,
      //   #1597, #1601, #1677, #1691, and #1705.
      // - Those native fatal macOS events include js_native_api_v8.cc
      //   FunctionCallbackWrapper frames after ui.click breadcrumbs, with #1098,
      //   #1099, #1301, #1378, and #1507 reporting
      //   "Napi::Error: A boolean was expected".
      // - In @nut-tree-fork/nut-js@4.2.6, MouseClass.click() delegates to the
      //   libnut provider's click(), which calls libnut.mouseClick(button). The
      //   same provider's pressButton()/releaseButton() call
      //   libnut.mouseToggle("down"|"up", button), avoiding that native path.
      await mouse.pressButton(Button.LEFT);
      await this.waitWithEmergencyStop(CLICK_PRESS_DURATION_MS);
      await mouse.releaseButton(Button.LEFT);
      recordAutomationDebugEvent('mouse-click', {
        centerPx,
        positionedMouse,
        interactionKind,
        originalPosition,
        beforeSnapshotPath,
      });

      if (interactionKind === 'radio') {
        await this.waitWithEmergencyStop(RADIO_CONFIRM_DELAY_MS);
        await keyboard.pressKey(Key.Space);
        await keyboard.releaseKey(Key.Space);
        console.log('[Automation] Radio confirmed via Space key');
        recordAutomationDebugEvent('radio-space-confirm', {
          centerPx,
        });
      } else if (interactionKind === 'button') {
        await this.waitWithEmergencyStop(BUTTON_CONFIRM_DELAY_MS);
        await this.activateInteractionWindow(
          centerPx,
          OVERLAY_VISION_MODE ? 'vision-mode-button-confirm-activation' : 'button-confirm',
        );
        await this.waitWithEmergencyStop(BUTTON_CONFIRM_DELAY_MS);
        await keyboard.pressKey(Key.Space);
        await keyboard.releaseKey(Key.Space);
        console.log('[Automation] Button confirmed via Space key');
        recordAutomationDebugEvent('button-space-confirm', {
          centerPx,
        });
      }
    }

    await this.waitWithEmergencyStop(OVERLAY_VISION_MODE ? VISION_CLICK_SETTLE_DELAY_MS : CLICK_SETTLE_DELAY_MS);
    const afterSnapshotPath = await this.captureDebugSnapshot(centerPx, interactionKind, 'after', targetBounds ?? null);
    recordAutomationDebugEvent('click-complete', {
      centerPx,
      interactionKind,
      afterSnapshotPath,
    });

    await mouse.setPosition(originalPosition);
    console.log('[Automation] Click completed');
  }

  private async selectMenuOptionViaKeyboard(
    interactionText: string,
    interactionKind: 'menuitem' | 'dropdown-option',
    centerPx: { x: number; y: number },
  ): Promise<void> {
    console.log('[Automation] Selecting menu option via keyboard typeahead:', interactionText);
    recordAutomationDebugEvent('menu-selection-start', {
      centerPx,
      interactionKind,
      interactionText: truncateDebugText(interactionText),
    });
    await this.typeTextBlocking(interactionText, false);
    await this.waitWithEmergencyStop(MENU_SELECTION_SETTLE_DELAY_MS);
    await keyboard.pressKey(Key.Enter);
    await keyboard.releaseKey(Key.Enter);
    recordAutomationDebugEvent('menu-selection-enter', {
      centerPx,
      interactionKind,
      interactionText: truncateDebugText(interactionText),
    });
    await this.waitWithEmergencyStop(MENU_SELECTION_SETTLE_DELAY_MS);
  }

  private parseHotkey(hotkey: string): { modifiers: Key[]; key: Key } {
    const tokens = hotkey.split('+').map((token) => token.trim().toLowerCase());
    const modifiers: Key[] = [];
    let key: Key | null = null;

    for (const token of tokens) {
      const mapped = this.mapToken(token);
      if (!mapped) {
        throw new Error(`Unrecognized hotkey token: "${token}". Cannot execute hotkey "${hotkey}".`);
      }
      if (mapped.isModifier) {
        modifiers.push(mapped.value);
      } else {
        key = mapped.value;
      }
    }

    if (key === null) {
      throw new Error(`No key specified in hotkey: "${hotkey}"`);
    }

    return { modifiers, key };
  }

  private coerceHotkeyForPlatform(hotkey: string): string {
    if (process.platform === 'darwin') {
      return hotkey;
    }

    const tokens = hotkey
      .split('+')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);
    if (!tokens.some((token) => token === 'cmd' || token === 'command' || token === 'meta')) {
      return hotkey;
    }

    return tokens
      .map((token) => (
        token === 'cmd' || token === 'command' || token === 'meta'
          ? 'ctrl'
          : token
      ))
      .join('+');
  }

  private getVisionTypeCompleteSettleDelayMs(textLength: number): number {
    return Math.min(
      VISION_TYPE_COMPLETE_SETTLE_MAX_MS,
      VISION_TYPE_COMPLETE_SETTLE_DELAY_MS + Math.max(0, textLength) * VISION_TYPE_COMPLETE_SETTLE_PER_CHAR_MS,
    );
  }

  private async typeTextBlocking(text: string, preferClipboard = true): Promise<void> {
    if (!OVERLAY_VISION_MODE) {
      if (process.platform === 'win32') {
        const pasted = preferClipboard ? await this.tryPasteTextViaClipboard(text) : false;
        if (pasted) {
          return;
        }
      }
      await keyboard.type(text);
      return;
    }

    if (process.platform === 'darwin') {
      const pasted = await this.tryPasteTextViaClipboard(text);
      if (pasted) {
        return;
      }
    }

    const graphemes = Array.from(text);
    recordAutomationDebugEvent('type-blocking-loop-start', {
      textLength: graphemes.length,
      textPreview: truncateDebugText(text),
      betweenCharsDelayMs: VISION_TYPE_BETWEEN_CHARS_DELAY_MS,
    });

    for (const grapheme of graphemes) {
      await this.assertEmergencyStopNotTriggered();
      await keyboard.type(grapheme);
      if (VISION_TYPE_BETWEEN_CHARS_DELAY_MS > 0) {
        await this.waitWithEmergencyStop(VISION_TYPE_BETWEEN_CHARS_DELAY_MS);
      }
    }

    recordAutomationDebugEvent('type-blocking-loop-complete', {
      textLength: graphemes.length,
      textPreview: truncateDebugText(text),
    });
  }

  private async tryPasteTextViaClipboard(text: string): Promise<boolean> {
    if (process.platform === 'win32') {
      return this.tryPasteTextViaElectronClipboard(text, Key.LeftControl, 'Ctrl+V');
    }
    if (process.platform !== 'darwin') {
      return false;
    }

    let originalClipboardText: string | null = null;
    let clipboardReadSucceeded = false;

    try {
      originalClipboardText = execFileSync('pbpaste', [], {
        encoding: 'utf-8',
        timeout: 1000,
      });
      clipboardReadSucceeded = true;
    } catch (error) {
      recordAutomationDebugEvent('clipboard-read-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      execFileSync('pbcopy', [], {
        input: text,
        encoding: 'utf-8',
        timeout: 1000,
      });
      recordAutomationDebugEvent('clipboard-paste-start', {
        textLength: text.length,
        textPreview: truncateDebugText(text),
        clipboardReadSucceeded,
      });
      if (!this.tryRunMacHotkeyViaAppleScript(['cmd', 'v'])) {
        await keyboard.pressKey(Key.LeftCmd);
        await keyboard.pressKey(Key.V);
        await keyboard.releaseKey(Key.V);
        await keyboard.releaseKey(Key.LeftCmd);
      }
      await this.waitWithEmergencyStop(
        Math.min(
          VISION_PASTE_SETTLE_MAX_MS,
          VISION_PASTE_SETTLE_DELAY_MS + Math.max(0, text.length) * VISION_PASTE_SETTLE_PER_CHAR_MS,
        ),
      );
      recordAutomationDebugEvent('clipboard-paste-complete', {
        textLength: text.length,
        textPreview: truncateDebugText(text),
      });
      return true;
    } catch (error) {
      recordAutomationDebugEvent('clipboard-paste-failed', {
        textLength: text.length,
        textPreview: truncateDebugText(text),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      if (clipboardReadSucceeded && originalClipboardText != null) {
        try {
          execFileSync('pbcopy', [], {
            input: originalClipboardText,
            encoding: 'utf-8',
            timeout: 1000,
          });
          recordAutomationDebugEvent('clipboard-restore-complete', {});
        } catch (error) {
          recordAutomationDebugEvent('clipboard-restore-failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private async tryPasteTextViaElectronClipboard(
    text: string,
    modifierKey: Key,
    shortcut: string,
  ): Promise<boolean> {
    let originalClipboardText: string | null = null;
    let clipboardReadSucceeded = false;

    try {
      originalClipboardText = clipboard.readText();
      clipboardReadSucceeded = true;
    } catch (error) {
      recordAutomationDebugEvent('clipboard-read-failed', {
        shortcut,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let modifierPressed = false;
    let vPressed = false;
    try {
      clipboard.writeText(text);
      recordAutomationDebugEvent('clipboard-paste-start', {
        shortcut,
        textLength: text.length,
        textPreview: truncateDebugText(text),
        clipboardReadSucceeded,
      });
      await keyboard.pressKey(modifierKey);
      modifierPressed = true;
      await this.waitWithEmergencyStop(18);
      await keyboard.pressKey(Key.V);
      vPressed = true;
      await this.waitWithEmergencyStop(18);
      await keyboard.releaseKey(Key.V);
      vPressed = false;
      await keyboard.releaseKey(modifierKey);
      modifierPressed = false;
      await this.waitWithEmergencyStop(
        Math.min(
          VISION_PASTE_SETTLE_MAX_MS,
          VISION_PASTE_SETTLE_DELAY_MS + Math.max(0, text.length) * VISION_PASTE_SETTLE_PER_CHAR_MS,
        ),
      );
      recordAutomationDebugEvent('clipboard-paste-complete', {
        shortcut,
        textLength: text.length,
        textPreview: truncateDebugText(text),
      });
      return true;
    } catch (error) {
      recordAutomationDebugEvent('clipboard-paste-failed', {
        shortcut,
        textLength: text.length,
        textPreview: truncateDebugText(text),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      if (vPressed) {
        try {
          await keyboard.releaseKey(Key.V);
        } catch {}
      }
      if (modifierPressed) {
        try {
          await keyboard.releaseKey(modifierKey);
        } catch {}
      }
      if (clipboardReadSucceeded && originalClipboardText != null) {
        try {
          clipboard.writeText(originalClipboardText);
          recordAutomationDebugEvent('clipboard-restore-complete', { shortcut });
        } catch (error) {
          recordAutomationDebugEvent('clipboard-restore-failed', {
            shortcut,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private async clearFocusedText(): Promise<void> {
    recordAutomationDebugEvent('clear-focused-start', {});
    await this.selectAllFocusedText();
    recordAutomationDebugEvent('clear-focused-complete', {});
  }

  private async selectAllFocusedText(): Promise<void> {
    const selectAllModifier = process.platform === 'darwin' ? Key.LeftCmd : Key.LeftControl;
    const selectAllShortcut = process.platform === 'darwin' ? 'Cmd+A' : 'Ctrl+A';
    recordAutomationDebugEvent('select-all-start', {
      shortcut: selectAllShortcut,
    });
    if (OVERLAY_VISION_MODE && process.platform === 'darwin' && this.tryRunMacHotkeyViaAppleScript(['cmd', 'a'])) {
      recordAutomationDebugEvent('select-all-complete', {
        shortcut: 'Cmd+A',
        path: 'osascript',
      });
      await this.waitWithEmergencyStop(SELECT_ALL_SETTLE_DELAY_MS);
      await keyboard.pressKey(Key.Backspace);
      await keyboard.releaseKey(Key.Backspace);
      recordAutomationDebugEvent('clear-focused-backspace', {});
      await this.waitWithEmergencyStop(CLEAR_SELECTED_TEXT_SETTLE_MS);
      return;
    }
    await keyboard.pressKey(selectAllModifier);
    await this.waitWithEmergencyStop(18);
    await keyboard.pressKey(Key.A);
    await this.waitWithEmergencyStop(18);
    await keyboard.releaseKey(Key.A);
    await keyboard.releaseKey(selectAllModifier);
    recordAutomationDebugEvent('select-all-complete', {
      shortcut: selectAllShortcut,
    });
    await this.waitWithEmergencyStop(SELECT_ALL_SETTLE_DELAY_MS);
    await keyboard.pressKey(Key.Backspace);
    await keyboard.releaseKey(Key.Backspace);
    recordAutomationDebugEvent('clear-focused-backspace', {});
    await this.waitWithEmergencyStop(CLEAR_SELECTED_TEXT_SETTLE_MS);
  }

  private mapToken(token: string): { isModifier: boolean; value: Key } | null {
    const value = token.toLowerCase();

    if (value === 'ctrl' || value === 'control') return { isModifier: true, value: Key.LeftControl };
    if (value === 'cmd' || value === 'command' || value === 'meta') return { isModifier: true, value: Key.LeftCmd };
    if (value === 'alt' || value === 'option') return { isModifier: true, value: Key.LeftAlt };
    if (value === 'shift') return { isModifier: true, value: Key.LeftShift };

    if (value === 'escape' || value === 'esc') return { isModifier: false, value: Key.Escape };
    if (value === 'enter' || value === 'return') return { isModifier: false, value: Key.Enter };
    if (value === 'space') return { isModifier: false, value: Key.Space };
    if (value === 'tab') return { isModifier: false, value: Key.Tab };
    if (value === 'backspace') return { isModifier: false, value: Key.Backspace };
    if (value === 'delete') return { isModifier: false, value: Key.Delete };

    if (value === 'up' || value === 'arrowup') return { isModifier: false, value: Key.Up };
    if (value === 'down' || value === 'arrowdown') return { isModifier: false, value: Key.Down };
    if (value === 'left' || value === 'arrowleft') return { isModifier: false, value: Key.Left };
    if (value === 'right' || value === 'arrowright') return { isModifier: false, value: Key.Right };

    if (value === 'f1') return { isModifier: false, value: Key.F1 };
    if (value === 'f2') return { isModifier: false, value: Key.F2 };
    if (value === 'f3') return { isModifier: false, value: Key.F3 };
    if (value === 'f4') return { isModifier: false, value: Key.F4 };
    if (value === 'f5') return { isModifier: false, value: Key.F5 };
    if (value === 'f6') return { isModifier: false, value: Key.F6 };
    if (value === 'f7') return { isModifier: false, value: Key.F7 };
    if (value === 'f8') return { isModifier: false, value: Key.F8 };
    if (value === 'f9') return { isModifier: false, value: Key.F9 };
    if (value === 'f10') return { isModifier: false, value: Key.F10 };
    if (value === 'f11') return { isModifier: false, value: Key.F11 };
    if (value === 'f12') return { isModifier: false, value: Key.F12 };

    if (value.length === 1) {
      const upperChar = value.toUpperCase();
      const keyValue = (Key as unknown as Record<string, Key | undefined>)[upperChar];
      if (keyValue !== undefined) return { isModifier: false, value: keyValue };
      if (value >= '0' && value <= '9') {
        const numKey = (Key as unknown as Record<string, Key | undefined>)[`Num${value}`];
        if (numKey !== undefined) return { isModifier: false, value: numKey };
      }
    }

    return null;
  }

  private tryRunMacHotkeyViaAppleScript(tokens: string[]): boolean {
    const modifiers = tokens.filter((token) => ['cmd', 'command', 'meta', 'ctrl', 'control', 'alt', 'option', 'shift'].includes(token));
    const primary = tokens.find((token) => !['cmd', 'command', 'meta', 'ctrl', 'control', 'alt', 'option', 'shift'].includes(token));
    if (!primary) {
      return false;
    }

    const modifierClauses = modifiers
      .map((token) => {
        switch (token) {
          case 'cmd':
          case 'command':
          case 'meta':
            return 'command down';
          case 'ctrl':
          case 'control':
            return 'control down';
          case 'alt':
          case 'option':
            return 'option down';
          case 'shift':
            return 'shift down';
          default:
            return null;
        }
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    const keyCode = this.getMacAppleScriptKeyCode(primary);
    let statement: string | null = null;
    if (keyCode != null) {
      statement = `key code ${keyCode}`;
    } else if (primary.length === 1 && /[a-z0-9]/i.test(primary)) {
      const escaped = primary.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      statement = `keystroke "${escaped}"`;
    }

    if (!statement) {
      return false;
    }

    const usingClause = modifierClauses.length > 0 ? ` using {${modifierClauses.join(', ')}}` : '';
    const script = `tell application "System Events" to ${statement}${usingClause}`;

    try {
      execFileSync('osascript', ['-e', script], {
        encoding: 'utf-8',
        timeout: 1500,
      });
      return true;
    } catch (error) {
      recordAutomationDebugEvent('hotkey-applescript-failed', {
        tokens,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private getMacAppleScriptKeyCode(token: string): number | null {
    switch (token) {
      case 'tab':
        return 48;
      case 'enter':
      case 'return':
        return 36;
      case 'esc':
      case 'escape':
        return 53;
      case 'backspace':
        return 51;
      case 'delete':
        return 117;
      case 'up':
      case 'arrowup':
        return 126;
      case 'down':
      case 'arrowdown':
        return 125;
      case 'left':
      case 'arrowleft':
        return 123;
      case 'right':
      case 'arrowright':
        return 124;
      case 'space':
        return 49;
      default:
        return null;
    }
  }

  private async captureDebugSnapshot(
    centerPx: { x: number; y: number },
    interactionKind: string,
    phase: 'before' | 'after',
    targetBounds: Bounds | null = null,
  ): Promise<string | null> {
    const outputDir = process.env.INTERPRETER_OVERLAY_ACTION_DEBUG_DIR;
    if (!outputDir || process.platform !== 'darwin') {
      return null;
    }

    try {
      fs.mkdirSync(outputDir, { recursive: true });
      const defaultWidth = 560;
      const defaultHeight = 360;
      const paddingX = 120;
      const paddingY = 100;
      const width = targetBounds
        ? Math.max(defaultWidth, Math.round(targetBounds.width + paddingX * 2))
        : defaultWidth;
      const height = targetBounds
        ? Math.max(defaultHeight, Math.round(targetBounds.height + paddingY * 2))
        : defaultHeight;
      const originX = targetBounds ? targetBounds.x + targetBounds.width / 2 : centerPx.x;
      const originY = targetBounds ? targetBounds.y + targetBounds.height / 2 : centerPx.y;
      const left = Math.max(0, Math.round(originX - width / 2));
      const top = Math.max(0, Math.round(originY - height / 2));
      const fileName = `${Date.now()}-${interactionKind}-${phase}-${Math.round(centerPx.x)}x${Math.round(centerPx.y)}.png`;
      const targetPath = path.join(outputDir, fileName);
      execFileSync('screencapture', ['-x', '-R', `${left},${top},${width},${height}`, targetPath], {
        encoding: 'utf-8',
        timeout: 1500,
      });
      console.log(`[Automation] Saved debug snapshot: ${targetPath}`);
      return targetPath;
    } catch (error) {
      console.warn('[Automation] Failed to save debug snapshot:', error);
      recordAutomationDebugEvent('debug-snapshot-failed', {
        centerPx,
        interactionKind,
        phase,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
