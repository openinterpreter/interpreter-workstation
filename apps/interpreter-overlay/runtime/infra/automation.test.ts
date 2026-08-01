import { describe, expect, it } from 'bun:test';
import { mouse, keyboard, Button, Key } from '@nut-tree-fork/nut-js';
import { Automation } from './automation.js';
import type { NativeCuaAppWindowTarget, NativeCuaElementTarget, NativeCuaPointTarget } from '../../shared/ports.js';

describe('Automation hotkey parsing', () => {
  it('treats esc as a valid primary key', () => {
    const automation = new Automation() as Automation & {
      parseHotkey(hotkey: string): { modifiers: Key[]; key: Key };
    };

    expect(automation.parseHotkey('esc')).toEqual({
      modifiers: [],
      key: Key.Escape,
    });
  });

  it('confirms menuitem selections via keyboard typeahead and enter', async () => {
    const automation = new Automation() as Automation & {
      selectMenuOptionViaKeyboard(
        interactionText: string,
        interactionKind: 'menuitem' | 'dropdown-option',
        centerPx: { x: number; y: number },
      ): Promise<void>;
      typeTextBlocking(text: string): Promise<void>;
      waitWithEmergencyStop(delayMs: number): Promise<void>;
    };

    const typed: string[] = [];
    const keyCalls: Array<{ method: 'press' | 'release'; key: Key }> = [];
    const originalTypeTextBlocking = automation.typeTextBlocking.bind(automation);
    const originalWaitWithEmergencyStop = automation.waitWithEmergencyStop.bind(automation);
    const originalPressKey = keyboard.pressKey.bind(keyboard);
    const originalReleaseKey = keyboard.releaseKey.bind(keyboard);

    automation.typeTextBlocking = async (text: string) => {
      typed.push(text);
    };
    automation.waitWithEmergencyStop = async () => {};
    keyboard.pressKey = (async (key: Key) => {
      keyCalls.push({ method: 'press', key });
    }) as typeof keyboard.pressKey;
    keyboard.releaseKey = (async (key: Key) => {
      keyCalls.push({ method: 'release', key });
    }) as typeof keyboard.releaseKey;

    try {
      await automation.selectMenuOptionViaKeyboard('e', 'menuitem', { x: 10, y: 20 });
    } finally {
      automation.typeTextBlocking = originalTypeTextBlocking;
      automation.waitWithEmergencyStop = originalWaitWithEmergencyStop;
      keyboard.pressKey = originalPressKey;
      keyboard.releaseKey = originalReleaseKey;
    }

    expect(typed).toEqual(['e']);
    expect(keyCalls).toEqual([
      { method: 'press', key: Key.Enter },
      { method: 'release', key: Key.Enter },
    ]);
  });

  it('uses explicit button down and up for default clicks', async () => {
    const automation = new Automation() as Automation & {
      performClick(
        centerPx: { x: number; y: number },
        interactionKind?: 'default' | 'button' | 'menuitem' | 'radio' | 'checkbox' | 'dropdown-option',
        interactionText?: string,
        targetBounds?: null,
      ): Promise<void>;
      activateInteractionWindow(centerPx: { x: number; y: number }, reason: string): Promise<boolean>;
      waitWithEmergencyStop(delayMs: number): Promise<void>;
      waitForMousePosition(target: { x: number; y: number }): Promise<{ x: number; y: number }>;
      captureDebugSnapshot(
        centerPx: { x: number; y: number },
        interactionKind: string,
        phase: 'before' | 'after',
        targetBounds?: null,
      ): Promise<string | null>;
    };

    const mouseCalls: Array<{ method: 'click' | 'press' | 'release' | 'set'; button?: Button; point?: { x: number; y: number } }> = [];
    const originalGetPosition = mouse.getPosition.bind(mouse);
    const originalSetPosition = mouse.setPosition.bind(mouse);
    const originalClick = mouse.click.bind(mouse);
    const originalPressButton = mouse.pressButton.bind(mouse);
    const originalReleaseButton = mouse.releaseButton.bind(mouse);
    const originalActivateInteractionWindow = automation.activateInteractionWindow.bind(automation);
    const originalWaitWithEmergencyStop = automation.waitWithEmergencyStop.bind(automation);
    const originalWaitForMousePosition = automation.waitForMousePosition.bind(automation);
    const originalCaptureDebugSnapshot = automation.captureDebugSnapshot.bind(automation);

    mouse.getPosition = (async () => ({ x: 1, y: 2 })) as typeof mouse.getPosition;
    mouse.setPosition = (async (point: { x: number; y: number }) => {
      mouseCalls.push({ method: 'set', point });
      return mouse;
    }) as typeof mouse.setPosition;
    mouse.click = (async (button: Button) => {
      mouseCalls.push({ method: 'click', button });
      return mouse;
    }) as typeof mouse.click;
    mouse.pressButton = (async (button: Button) => {
      mouseCalls.push({ method: 'press', button });
      return mouse;
    }) as typeof mouse.pressButton;
    mouse.releaseButton = (async (button: Button) => {
      mouseCalls.push({ method: 'release', button });
      return mouse;
    }) as typeof mouse.releaseButton;
    automation.activateInteractionWindow = async () => true;
    automation.waitWithEmergencyStop = async () => {};
    automation.waitForMousePosition = async (target) => target;
    automation.captureDebugSnapshot = async () => null;

    try {
      await automation.performClick({ x: 10, y: 20 });
    } finally {
      mouse.getPosition = originalGetPosition;
      mouse.setPosition = originalSetPosition;
      mouse.click = originalClick;
      mouse.pressButton = originalPressButton;
      mouse.releaseButton = originalReleaseButton;
      automation.activateInteractionWindow = originalActivateInteractionWindow;
      automation.waitWithEmergencyStop = originalWaitWithEmergencyStop;
      automation.waitForMousePosition = originalWaitForMousePosition;
      automation.captureDebugSnapshot = originalCaptureDebugSnapshot;
    }

    expect(mouseCalls).toEqual([
      { method: 'set', point: { x: 10, y: 20 } },
      { method: 'press', button: Button.LEFT },
      { method: 'release', button: Button.LEFT },
      { method: 'set', point: { x: 1, y: 2 } },
    ]);
  });

  it('does not press enter after clicking a dropdown option', async () => {
    const automation = new Automation() as Automation & {
      performClick(
        centerPx: { x: number; y: number },
        interactionKind?: 'default' | 'button' | 'menuitem' | 'radio' | 'checkbox' | 'dropdown-option',
        interactionText?: string,
        targetBounds?: null,
      ): Promise<void>;
      waitWithEmergencyStop(delayMs: number): Promise<void>;
      waitForMousePosition(target: { x: number; y: number }): Promise<{ x: number; y: number }>;
      captureDebugSnapshot(
        centerPx: { x: number; y: number },
        interactionKind: string,
        phase: 'before' | 'after',
        targetBounds?: null,
      ): Promise<string | null>;
    };

    const mouseCalls: Array<{ method: 'press' | 'release' | 'set'; button?: Button; point?: { x: number; y: number } }> = [];
    const keyCalls: Array<{ method: 'press' | 'release'; key: Key }> = [];
    const originalGetPosition = mouse.getPosition.bind(mouse);
    const originalSetPosition = mouse.setPosition.bind(mouse);
    const originalPressButton = mouse.pressButton.bind(mouse);
    const originalReleaseButton = mouse.releaseButton.bind(mouse);
    const originalPressKey = keyboard.pressKey.bind(keyboard);
    const originalReleaseKey = keyboard.releaseKey.bind(keyboard);
    const originalWaitWithEmergencyStop = automation.waitWithEmergencyStop.bind(automation);
    const originalWaitForMousePosition = automation.waitForMousePosition.bind(automation);
    const originalCaptureDebugSnapshot = automation.captureDebugSnapshot.bind(automation);

    mouse.getPosition = (async () => ({ x: 1, y: 2 })) as typeof mouse.getPosition;
    mouse.setPosition = (async (point: { x: number; y: number }) => {
      mouseCalls.push({ method: 'set', point });
      return mouse;
    }) as typeof mouse.setPosition;
    mouse.pressButton = (async (button: Button) => {
      mouseCalls.push({ method: 'press', button });
      return mouse;
    }) as typeof mouse.pressButton;
    mouse.releaseButton = (async (button: Button) => {
      mouseCalls.push({ method: 'release', button });
      return mouse;
    }) as typeof mouse.releaseButton;
    keyboard.pressKey = (async (key: Key) => {
      keyCalls.push({ method: 'press', key });
    }) as typeof keyboard.pressKey;
    keyboard.releaseKey = (async (key: Key) => {
      keyCalls.push({ method: 'release', key });
    }) as typeof keyboard.releaseKey;
    automation.waitWithEmergencyStop = async () => {};
    automation.waitForMousePosition = async (target) => target;
    automation.captureDebugSnapshot = async () => null;

    try {
      await automation.performClick({ x: 10, y: 20 }, 'dropdown-option', 'Business owners policy');
    } finally {
      mouse.getPosition = originalGetPosition;
      mouse.setPosition = originalSetPosition;
      mouse.pressButton = originalPressButton;
      mouse.releaseButton = originalReleaseButton;
      keyboard.pressKey = originalPressKey;
      keyboard.releaseKey = originalReleaseKey;
      automation.waitWithEmergencyStop = originalWaitWithEmergencyStop;
      automation.waitForMousePosition = originalWaitForMousePosition;
      automation.captureDebugSnapshot = originalCaptureDebugSnapshot;
    }

    expect(mouseCalls).toEqual([
      { method: 'set', point: { x: 10, y: 20 } },
      { method: 'press', button: Button.LEFT },
      { method: 'release', button: Button.LEFT },
      { method: 'set', point: { x: 1, y: 2 } },
    ]);
    expect(keyCalls).toEqual([]);
  });

  it('completes native CUA primitives without an added settle delay', async () => {
    const calls: string[] = [];
    const automation = new Automation({
      nativeCuaExecutor: {
        click: async () => {
          calls.push('click');
        },
        clickPoint: async () => {
          calls.push('click-point');
        },
        setValue: async () => {
          calls.push('set-value');
        },
        typeText: async () => {
          calls.push('type-text');
        },
        typeAppWindowText: async () => {
          calls.push('type-window-text');
        },
        selectOption: async () => {
          calls.push('select-option');
        },
        scroll: async () => {
          calls.push('scroll');
        },
        scrollAppWindow: async () => {
          calls.push('scroll-window');
        },
        pressKey: async () => {
          calls.push('press-key');
        },
      },
    }) as Automation & {
      waitWithEmergencyStop(delayMs: number): Promise<void>;
    };

    const originalWaitWithEmergencyStop = automation.waitWithEmergencyStop.bind(automation);
    automation.waitWithEmergencyStop = async (delayMs: number) => {
      calls.push(`settle:${delayMs}`);
    };

    const elementTarget: NativeCuaElementTarget = {
      app: 'Native Test',
      elementIndex: 1,
      targetIdentity: { kind: 'app-window' },
    };
    const pointTarget: NativeCuaPointTarget = {
      app: 'Native Test',
      x: 10,
      y: 20,
      targetIdentity: { kind: 'app-window' },
    };
    const windowTarget: NativeCuaAppWindowTarget = {
      app: 'Native Test',
      targetIdentity: { kind: 'app-window' },
    };

    try {
      await automation.clickNativeCuaElement(elementTarget);
      await automation.clickNativeCuaPoint(pointTarget);
      await automation.setNativeCuaElementValue(elementTarget, 'value');
      await automation.typeNativeCuaElementText(elementTarget, 'text');
      await automation.typeNativeCuaAppWindowText(windowTarget, 'text');
      await automation.selectNativeCuaElementOption(elementTarget, 'option');
      await automation.scrollNativeCuaElement(elementTarget, 'down', 1);
      await automation.scrollNativeCuaAppWindow(windowTarget, 'down', 1);
      await automation.pressNativeCuaKey(windowTarget, 'enter');
    } finally {
      automation.waitWithEmergencyStop = originalWaitWithEmergencyStop;
    }

    // The driver verifies its own actions (read-backs / evidence polls), so
    // the automation layer must not add fixed settle delays on top.
    expect(calls).toEqual([
      'click',
      'click-point',
      'set-value',
      'type-text',
      'type-window-text',
      'select-option',
      'scroll',
      'scroll-window',
      'press-key',
    ]);
  });
});
