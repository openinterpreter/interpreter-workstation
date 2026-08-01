import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { RunEngine } from './run-engine';
import type { Action, DisplayInfo } from '../../shared/types';
import type { NativeCuaAppWindowTarget, NativeCuaElementTarget, NativeCuaPointTarget } from '../../shared/ports';

const display: DisplayInfo = {
  id: 'display-1',
  scaleFactor: 2,
  boundsDIP: { x: 0, y: 0, width: 1000, height: 800 },
};

const nativeCua: NativeCuaElementTarget = {
  app: 'Notes',
  elementIndex: 7,
  targetIdentity: {
    kind: 'app-window',
    platform: 'darwin',
    app: { name: 'Notes', pid: 123 },
    window: { native_window_id: 456, title: 'Draft' },
  },
};

function activeAppTargetIdentity(id: string) {
  return {
    id,
    kind: 'active-app',
    displayId: display.id,
    coordinateSpace: 'screen-dip',
    scaleFactor: display.scaleFactor,
    bounds: { x: 50, y: 60, width: 400, height: 300 },
    capturedAt: Date.now(),
    generation: 1,
    app: { name: 'Notes', pid: 123, bundlePath: null },
    window: { nativeWindowId: 456, sessionKey: 'window-session-1' },
    browser: null,
    document: null,
    refInvalidation: { staleAfterMs: null, rules: [] },
    permissionScope: { targetWindowSessionKey: 'window-session-1' },
  };
}

function activeAppTargetWithoutNativeWindowId(id: string) {
  const targetIdentity = activeAppTargetIdentity(id);
  targetIdentity.window.nativeWindowId = null;
  return targetIdentity;
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, 'platform', descriptor);
    }
  }
}

function fakeEngineBase(calls: string[]) {
  const element = {
    id: 'element_index:7',
    role: 'AXTextField',
    label: 'Name',
    value: '',
    bbox: { x: 100, y: 120, width: 200, height: 30 },
    nativeCua,
  };

  return {
    currentRun: { id: 'run-1' },
    activeDisplay: display,
    capture: {
      getActiveDisplay: () => display,
    },
    formFieldStore: new Map([[element.id, element]]),
    focusedMenuElementId: null as string | null,
    ui: {
      blur: () => {
        calls.push('blur');
      },
    },
    auto: {
      click: async () => {
        calls.push('coordinate-click');
      },
      typeAt: async () => {
        calls.push('coordinate-type');
      },
      typeElement: async () => {
        calls.push('uia-type');
      },
      scrollElement: async () => {
        calls.push('uia-scroll');
      },
      scroll: async () => {
        calls.push('coordinate-scroll');
      },
      clickNativeCuaElement: async (target: NativeCuaElementTarget) => {
        calls.push(`native-click:${target.elementIndex}`);
      },
      clickNativeCuaPoint: async (target: NativeCuaPointTarget) => {
        calls.push(`native-point-click:${target.app}:${target.x}:${target.y}`);
      },
      clickElement: async () => {
        calls.push('uia-click');
      },
      setNativeCuaElementValue: async (target: NativeCuaElementTarget, value: string) => {
        calls.push(`native-set:${target.elementIndex}:${value}`);
      },
      typeNativeCuaElementText: async (target: NativeCuaElementTarget, text: string) => {
        calls.push(`native-type:${target.elementIndex}:${text}`);
      },
      typeNativeCuaAppWindowText: async (target: NativeCuaAppWindowTarget, text: string) => {
        calls.push(`native-window-type:${target.app}:${text}`);
      },
      selectNativeCuaElementOption: async (target: NativeCuaElementTarget, option: string) => {
        calls.push(`native-select:${target.elementIndex}:${option}`);
      },
      scrollNativeCuaElement: async (target: NativeCuaElementTarget, direction: string, pages: number) => {
        calls.push(`native-scroll:${target.elementIndex}:${direction}:${pages}`);
      },
      scrollNativeCuaAppWindow: async (target: NativeCuaAppWindowTarget, direction: string, pages: number) => {
        calls.push(`native-window-scroll:${target.app}:${direction}:${pages}`);
      },
      pressNativeCuaKey: async (target: NativeCuaAppWindowTarget, key: string) => {
        calls.push(`native-key:${target.app}:${key}`);
      },
      pressHotkey: async (key: string) => {
        calls.push(`local-key:${key}`);
      },
    },
    resolveFreshExecutionTarget: (RunEngine.prototype as any).resolveFreshExecutionTarget,
    getActionElementTarget: (RunEngine.prototype as any).getActionElementTarget,
    buildNativeCuaAppWindowTarget: (RunEngine.prototype as any).buildNativeCuaAppWindowTarget,
    buildNativeCuaElementTargetFromWindowsUiaId: (RunEngine.prototype as any).buildNativeCuaElementTargetFromWindowsUiaId,
    buildNativeCuaPointTarget: (RunEngine.prototype as any).buildNativeCuaPointTarget,
    nativeCuaSelectOptionOwnsVerification: (RunEngine.prototype as any).nativeCuaSelectOptionOwnsVerification,
    assertWindowsUiaElementHasNoAttachedNativeCuaTarget: (RunEngine.prototype as any).assertWindowsUiaElementHasNoAttachedNativeCuaTarget,
    focusAndTypeIntoVerifiedTarget: (RunEngine.prototype as any).focusAndTypeIntoVerifiedTarget,
    resolveTypingTarget: () => element,
    syncActionBBoxWithTarget: () => {},
    shouldClearTextBeforeTyping: (_target: unknown, _text: string, explicitClearFirst: boolean) => explicitClearFirst,
    getExpectedTypingTargetBBox: (_action: unknown, _display: unknown, target: { bbox: unknown }) => target.bbox,
    getTypingFocusCandidatePoints: () => [{ x: 200, y: 135 }],
    getPrimaryTargetProbePoint: () => ({ x: 200, y: 135 }),
    getVisionCoordinatePoint: () => null,
    resolveInteractionPoint: () => ({ x: 200, y: 135 }),
    getActiveViewportOrThrow: () => display.boundsDIP,
    getMenuItemTypeaheadText: (label: string) => label,
    getDropdownOptionTypeaheadText: (_fieldLabel: string, optionText: string) => optionText,
    isDropdownControlRole: () => false,
    isDropdownOptionElement: () => false,
    toAutomationPoint: (point: { x: number; y: number }) => point,
    lastVisionInteractionPoint: null,
  };
}

describe('RunEngine native CUA execution', () => {
  test('does not bypass native CUA app-window targets in vision-mode coordinate clicks or scrolls', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'run-engine.ts'), 'utf8');
    expect(source).toContain("const nativeCuaPointClickEligible = (!OVERLAY_VISION_MODE || this.activeTargetIdentity?.kind === 'active-app')");
    expect(source).toContain('const nativeCuaTarget = this.buildNativeCuaAppWindowTarget();');
    expect(source).not.toContain('const nativeCuaTarget = !OVERLAY_VISION_MODE\n          ? this.buildNativeCuaAppWindowTarget()\n          : null;');
  });

  test('routes scoped vision scroll hotkeys through native CUA when attached to an active app', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'run-engine.ts'), 'utf8');
    const scopedScrollStart = source.indexOf('const scopedScroll = OVERLAY_VISION_MODE ? getScopedScrollForHotkey(hotkey) : null;');
    const focusedControlStart = source.indexOf('if (isScopedFocusedControlHotkeyAllowed(hotkey))', scopedScrollStart);
    expect(scopedScrollStart).toBeGreaterThanOrEqual(0);
    expect(focusedControlStart).toBeGreaterThan(scopedScrollStart);

    const scopedScrollBlock = source.slice(scopedScrollStart, focusedControlStart);
    expect(scopedScrollBlock).toContain('const nativeCuaTarget = this.buildNativeCuaAppWindowTarget();');
    expect(scopedScrollBlock).toContain('await this.auto.scrollNativeCuaAppWindow(nativeCuaTarget, scopedScroll.direction, scopedScroll.amount);');
    expect(scopedScrollBlock).toContain("throw new Error('Active app scroll requires a native CUA target identity.');");
    expect(scopedScrollBlock).toContain('await this.auto.scroll(this.toAutomationPoint(center, display), scopedScroll.direction, scopedScroll.amount);');
    expect(scopedScrollBlock.indexOf('scrollNativeCuaAppWindow')).toBeLessThan(scopedScrollBlock.indexOf('await this.auto.scroll(this.toAutomationPoint(center, display), scopedScroll.direction, scopedScroll.amount);'));
  });

  test('routes vision focused typing through native CUA when attached to an active app', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'run-engine.ts'), 'utf8');
    const visionTypeStart = source.indexOf('} else if (OVERLAY_VISION_MODE) {');
    const noBboxStart = source.indexOf('} else if (!action.bbox) {', visionTypeStart);
    expect(visionTypeStart).toBeGreaterThanOrEqual(0);
    expect(noBboxStart).toBeGreaterThan(visionTypeStart);

    const visionTypeBlock = source.slice(visionTypeStart, noBboxStart);
    expect(visionTypeBlock).toContain('const nativeCuaTarget = this.buildNativeCuaAppWindowTarget();');
    expect(visionTypeBlock).toContain("throw new Error('Native CUA focused replacement typing requires an explicit element target.');");
    expect(visionTypeBlock).toContain("throw new Error('Native CUA app-window text execution is unavailable.');");
    expect(visionTypeBlock).toContain('await this.auto.typeNativeCuaAppWindowText(nativeCuaTarget, text);');
    expect(visionTypeBlock).toContain("throw new Error('Active app typing requires a native CUA target identity.');");
    expect(visionTypeBlock).toContain('await this.auto.typeFocused(text, clearFirst, this.toAutomationPointOrNull(anchorPoint, display), null);');
    expect(visionTypeBlock.indexOf('typeNativeCuaAppWindowText')).toBeLessThan(visionTypeBlock.indexOf('await this.auto.typeFocused(text, clearFirst, this.toAutomationPointOrNull(anchorPoint, display), null);'));
  });

  test('rejects observed typing and dropdown targets without unified refs before raw focused-control execution', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'run-engine.ts'), 'utf8');
    const dropdownGuard = "if (targetElement) {\n            throw new Error(`Overlay dropdown target ${targetElement.id} requires a native CUA or browser ref.`);\n          }";
    const typingGuard = "if (!(process.platform === 'win32' && isWindowsUiaElementId(targetElement.id))) {\n              throw new Error(`Overlay typing target ${targetElement.id} requires a native CUA or browser ref.`);\n            }";

    const dropdownGuardIndex = source.indexOf(dropdownGuard);
    expect(dropdownGuardIndex).toBeGreaterThanOrEqual(0);
    expect(source).not.toContain('const selectedObservedOption = await this.trySelectObservedDropdownOption(targetElement, text);');
    expect(source).not.toContain('this.getDropdownOptionTypeaheadText(targetElement?.label');

    const typingGuardIndex = source.indexOf(typingGuard);
    const localVerifiedTypeIndex = source.indexOf('await this.focusAndTypeIntoVerifiedTarget(action, targetElement, text, clearFirst);');
    expect(typingGuardIndex).toBeGreaterThanOrEqual(0);
    expect(localVerifiedTypeIndex).toBeGreaterThan(typingGuardIndex);
  });

  test('rejects observed scrolls without unified refs before raw coordinate execution', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'run-engine.ts'), 'utf8');
    const observedScrollGuard = "else if (targetElement) {\n          throw new Error(`Overlay scroll target ${targetElement.id} requires a native CUA or browser ref.`);\n        }";
    const guardIndex = source.indexOf(observedScrollGuard);
    const rawScrollIndex = source.indexOf('await this.auto.scroll(this.toAutomationPoint(center, display), params.direction, amount);');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(rawScrollIndex).toBeGreaterThan(guardIndex);
  });

  test('rejects observed clicks without unified refs before raw coordinate execution', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'run-engine.ts'), 'utf8');
    const observedClickGuard = "if (targetElement) {\n          throw new Error(`Overlay click target ${targetElement.id} requires a native CUA or browser ref.`);\n        }";
    const guardIndex = source.indexOf(observedClickGuard);
    const rawClickIndex = source.indexOf('await this.auto.click(this.toAutomationPoint(center, display), interactionKind, interactionText, null);');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(rawClickIndex).toBeGreaterThan(guardIndex);
  });

  test('keeps raw coordinate click only for unscoped targetless primitives', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      activeTargetIdentity: null,
      resolveFreshExecutionTarget: () => ({ elementId: undefined, targetElement: null }),
    };
    const action: Action = {
      id: 'targetless-click',
      seq: 0,
      tool: 'click',
      params: {},
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(calls).toEqual(['blur', 'coordinate-click']);
  });

  test('executes reviewed plain app-window clicks through native CUA point clicks', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: undefined, targetElement: null }),
      activeTargetIdentity: {
        id: 'overlay-target-1',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notes', pid: 123, bundlePath: null },
        window: { nativeWindowId: 456, sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
    };
    const action: Action = {
      id: 'action-0',
      seq: 0,
      tool: 'click',
      params: {},
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(calls).toEqual(['blur', 'native-point-click:Notes:200:135']);
  });

  test('executes reviewed plain app-window radio clicks through native CUA point clicks', async () => {
    const calls: string[] = [];
    const radioElement = {
      id: 'radio-1',
      role: 'AXRadioButton',
      label: 'Standard',
      value: '',
      bbox: { x: 160, y: 120, width: 80, height: 24 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: radioElement.id, targetElement: radioElement }),
      formFieldStore: new Map([[radioElement.id, radioElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-radio',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notes', pid: 123, bundlePath: null },
        window: { nativeWindowId: 456, sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
    };
    const action: Action = {
      id: 'action-radio',
      seq: 10,
      tool: 'click',
      params: { element_id: radioElement.id },
      bbox: { x_min: 0.16, y_min: 0.15, x_max: 0.24, y_max: 0.18 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(calls).toEqual(['blur', 'native-point-click:Notes:200:135']);
  });

  test('executes reviewed plain app-window checkbox clicks through native CUA point clicks', async () => {
    const calls: string[] = [];
    const checkboxElement = {
      id: 'checkbox-1',
      role: 'AXCheckBox',
      label: 'Newsletter',
      value: '',
      bbox: { x: 160, y: 120, width: 80, height: 24 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: checkboxElement.id, targetElement: checkboxElement }),
      formFieldStore: new Map([[checkboxElement.id, checkboxElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-checkbox',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notes', pid: 123, bundlePath: null },
        window: { nativeWindowId: 456, sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
    };
    const action: Action = {
      id: 'action-checkbox',
      seq: 11,
      tool: 'click',
      params: { element_id: checkboxElement.id },
      bbox: { x_min: 0.16, y_min: 0.15, x_max: 0.24, y_max: 0.18 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(calls).toEqual(['blur', 'native-point-click:Notes:200:135']);
  });

  test('executes reviewed app-window menuitem clicks through native CUA point clicks', async () => {
    const calls: string[] = [];
    const menuItem = {
      id: 'menu-item-1',
      role: 'AXMenuItem',
      label: 'Save',
      value: '',
      bbox: { x: 160, y: 120, width: 80, height: 24 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: menuItem.id, targetElement: menuItem }),
      formFieldStore: new Map([[menuItem.id, menuItem]]),
      activeTargetIdentity: activeAppTargetIdentity('overlay-target-menuitem'),
    };
    const action: Action = {
      id: 'action-menuitem',
      seq: 12,
      tool: 'click',
      params: { element_id: menuItem.id },
      bbox: { x_min: 0.16, y_min: 0.15, x_max: 0.24, y_max: 0.18 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(calls).toEqual(['blur', 'native-point-click:Notes:200:135']);
  });

  test('executes reviewed app-window dropdown-option clicks through native CUA point clicks', async () => {
    const calls: string[] = [];
    const dropdown = {
      id: 'dropdown-1',
      role: 'AXPopUpButton',
      label: 'Priority',
      value: '',
      bbox: { x: 140, y: 100, width: 120, height: 28 },
    };
    const option = {
      id: 'menu-item-high',
      role: 'AXMenuItem',
      label: 'High',
      value: '',
      bbox: { x: 160, y: 120, width: 80, height: 24 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      focusedMenuElementId: dropdown.id,
      resolveFreshExecutionTarget: () => ({ elementId: option.id, targetElement: option }),
      formFieldStore: new Map([
        [dropdown.id, dropdown],
        [option.id, option],
      ]),
      isDropdownControlRole: (role: string) => role === 'AXPopUpButton',
      activeTargetIdentity: activeAppTargetIdentity('overlay-target-dropdown-option'),
    };
    const action: Action = {
      id: 'action-dropdown-option',
      seq: 13,
      tool: 'click',
      params: { element_id: option.id },
      bbox: { x_min: 0.16, y_min: 0.15, x_max: 0.24, y_max: 0.18 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(calls).toEqual(['blur', 'native-point-click:Notes:200:135']);
  });

  test('does not fall back to local coordinates when eligible native CUA point click is unavailable', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: undefined, targetElement: null }),
      activeTargetIdentity: {
        id: 'overlay-target-2',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notes', pid: 123, bundlePath: null },
        window: { nativeWindowId: 456, sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
      auto: {
        ...fakeEngineBase(calls).auto,
        clickNativeCuaPoint: undefined,
      },
    };
    const action: Action = {
      id: 'action-0b',
      seq: 0,
      tool: 'click',
      params: {},
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Native CUA point-click execution is unavailable.');
    expect(calls).toEqual(['blur']);
  });

  test('does not use coordinate click when active app target lacks native CUA identity', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: undefined, targetElement: null }),
      activeTargetIdentity: activeAppTargetWithoutNativeWindowId('overlay-target-missing-window-id'),
    };
    const action: Action = {
      id: 'action-missing-native-cua-click',
      seq: 14,
      tool: 'click',
      params: {},
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Active app click requires a native CUA target identity.');
    expect(calls).toEqual(['blur']);
  });

  test('does not use coordinate click for observed targets without unified refs', async () => {
    const calls: string[] = [];
    const plainButton = {
      id: 'ax-button-plain',
      role: 'AXButton',
      label: 'Submit',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: plainButton.id, targetElement: plainButton }),
      formFieldStore: new Map([[plainButton.id, plainButton]]),
      activeTargetIdentity: null,
    };
    const action: Action = {
      id: 'action-click-plain-target-without-ref',
      seq: 19,
      tool: 'click',
      params: { element_id: plainButton.id },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Overlay click target ax-button-plain requires a native CUA or browser ref.');
    expect(calls).toEqual(['blur']);
  });

  test('does not use local hotkey when active app target lacks native CUA identity', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      activeTargetIdentity: activeAppTargetWithoutNativeWindowId('overlay-target-hotkey-missing-window-id'),
      hasScopedViewport: () => false,
      getHotkeyActivationPoint: () => null,
      toAutomationPointOrNull: () => null,
    };
    const action: Action = {
      id: 'action-hotkey-missing-native-target',
      seq: 15,
      tool: 'hotkey',
      params: { hotkey: 'cmd+a' },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Active app hotkey requires a native CUA target identity.');
    expect(calls).toEqual(['blur']);
  });

  test('executes reviewed app-window hotkeys through native CUA press_key', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      activeTargetIdentity: {
        id: 'overlay-target-hotkey',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notes', pid: 123, bundlePath: null },
        window: { nativeWindowId: 456, sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
      hasScopedViewport: () => false,
      getHotkeyActivationPoint: () => null,
      toAutomationPointOrNull: () => null,
    };
    const action: Action = {
      id: 'action-hotkey',
      seq: 12,
      tool: 'hotkey',
      params: { hotkey: 'cmd+a' },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(calls).toEqual(['blur', 'native-key:Notes:cmd+a']);
  });

  test('does not fall back to local hotkeys when eligible native CUA key execution is unavailable', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      activeTargetIdentity: {
        id: 'overlay-target-hotkey-missing',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notes', pid: 123, bundlePath: null },
        window: { nativeWindowId: 456, sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
      hasScopedViewport: () => false,
      getHotkeyActivationPoint: () => null,
      toAutomationPointOrNull: () => null,
      auto: {
        ...fakeEngineBase(calls).auto,
        pressNativeCuaKey: undefined,
      },
    };
    const action: Action = {
      id: 'action-hotkey-missing',
      seq: 13,
      tool: 'hotkey',
      params: { hotkey: 'enter' },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Native CUA key execution is unavailable.');
    expect(calls).toEqual(['blur']);
  });

  test('executes reviewed focused app-window typing through native CUA type_text', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: undefined, targetElement: null }),
      activeTargetIdentity: {
        id: 'overlay-target-focused-type',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notes', pid: 123, bundlePath: null },
        window: { nativeWindowId: 456, sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
    };
    const action: Action = {
      id: 'action-focused-type',
      seq: 14,
      tool: 'type',
      params: { text: 'hello' },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(calls).toEqual(['blur', 'native-window-type:Notes:hello']);
  });

  test('does not fall back to local focused typing when eligible native CUA app-window typing is unavailable', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: undefined, targetElement: null }),
      activeTargetIdentity: {
        id: 'overlay-target-focused-type-missing',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notes', pid: 123, bundlePath: null },
        window: { nativeWindowId: 456, sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
      auto: {
        ...fakeEngineBase(calls).auto,
        typeNativeCuaAppWindowText: undefined,
      },
    };
    const action: Action = {
      id: 'action-focused-type-missing',
      seq: 15,
      tool: 'type',
      params: { text: 'hello' },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Native CUA app-window text execution is unavailable.');
    expect(calls).toEqual(['blur']);
  });

  test('does not use local focused typing when active app target lacks native CUA identity', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: undefined, targetElement: null }),
      activeTargetIdentity: activeAppTargetWithoutNativeWindowId('overlay-target-focused-type-missing-window-id'),
    };
    const action: Action = {
      id: 'action-focused-type-missing-native-target',
      seq: 19,
      tool: 'type',
      params: { text: 'hello' },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Active app typing requires a native CUA target identity.');
    expect(calls).toEqual(['blur']);
  });

  test('does not use coordinate typing when active app target lacks native CUA identity', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: undefined, targetElement: null }),
      activeTargetIdentity: activeAppTargetWithoutNativeWindowId('overlay-target-coordinate-type-missing-window-id'),
    };
    const action: Action = {
      id: 'action-coordinate-type-missing-native-target',
      seq: 20,
      tool: 'type',
      params: { text: 'hello' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Active app typing requires a native CUA target identity.');
    expect(calls).toEqual(['blur']);
  });

  test('executes reviewed app-window scrolls through native CUA scroll', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: undefined, targetElement: null }),
      activeTargetIdentity: {
        id: 'overlay-target-window-scroll',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notes', pid: 123, bundlePath: null },
        window: { nativeWindowId: 456, sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
    };
    const action: Action = {
      id: 'action-window-scroll',
      seq: 16,
      tool: 'scroll',
      params: { direction: 'down', amount: 2 },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(calls).toEqual(['blur', 'native-window-scroll:Notes:down:2']);
  });

  test('does not fall back to local scroll when eligible native CUA app-window scroll is unavailable', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: undefined, targetElement: null }),
      activeTargetIdentity: {
        id: 'overlay-target-window-scroll-missing',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notes', pid: 123, bundlePath: null },
        window: { nativeWindowId: 456, sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
      auto: {
        ...fakeEngineBase(calls).auto,
        scrollNativeCuaAppWindow: undefined,
      },
    };
    const action: Action = {
      id: 'action-window-scroll-missing',
      seq: 17,
      tool: 'scroll',
      params: { direction: 'down', amount: 2 },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Native CUA app-window scroll execution is unavailable.');
    expect(calls).toEqual(['blur']);
  });

  test('does not use local scroll when active app target lacks native CUA identity', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: undefined, targetElement: null }),
      activeTargetIdentity: activeAppTargetWithoutNativeWindowId('overlay-target-scroll-missing-window-id'),
    };
    const action: Action = {
      id: 'action-scroll-missing-native-target',
      seq: 18,
      tool: 'scroll',
      params: { direction: 'down', amount: 2 },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Active app scroll requires a native CUA target identity.');
    expect(calls).toEqual(['blur']);
  });

  test('does not use coordinate scroll for observed targets without unified refs', async () => {
    const calls: string[] = [];
    const plainScrollArea = {
      id: 'ax-scroll-plain',
      role: 'AXScrollArea',
      label: 'Results',
      value: '',
      bbox: { x: 100, y: 120, width: 300, height: 200 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: plainScrollArea.id, targetElement: plainScrollArea }),
      formFieldStore: new Map([[plainScrollArea.id, plainScrollArea]]),
      activeTargetIdentity: null,
    };
    const action: Action = {
      id: 'action-scroll-plain-target-without-ref',
      seq: 20,
      tool: 'scroll',
      params: { direction: 'down', amount: 2, element_id: plainScrollArea.id },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Overlay scroll target ax-scroll-plain requires a native CUA or browser ref.');
    expect(calls).toEqual(['blur']);
  });

  test('executes reviewed clicks through native CUA target refs', async () => {
    const calls: string[] = [];
    const action: Action = {
      id: 'action-1',
      seq: 1,
      tool: 'click',
      params: { element_id: 'element_index:7' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngineBase(calls), action);

    expect(calls).toEqual(['blur', 'native-click:7']);
  });

  test('executes reviewed Windows UIA element clicks through native CUA refs when target identity matches', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXButton',
      label: 'Submit',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-windows-uia',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notepad', pid: 4321, bundlePath: null },
        window: { nativeWindowId: 'hwnd-1', sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
    };
    const action: Action = {
      id: 'action-windows-uia-click',
      seq: 14,
      tool: 'click',
      params: { element_id: windowsElement.id },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);
    });

    expect(calls).toEqual(['blur', 'native-click:7']);
  });

  test('does not fall back to direct Windows UIA click when matching native CUA click is unavailable', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXButton',
      label: 'Submit',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-windows-uia-missing',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notepad', pid: 4321, bundlePath: null },
        window: { nativeWindowId: 'hwnd-1', sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
      auto: {
        ...fakeEngineBase(calls).auto,
        clickNativeCuaElement: undefined,
      },
    };
    const action: Action = {
      id: 'action-windows-uia-click-missing',
      seq: 15,
      tool: 'click',
      params: { element_id: windowsElement.id },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('Native CUA click execution is unavailable.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('rejects Windows UIA click refs that do not match the attached CUA target identity', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:other-hwnd:7',
      role: 'AXButton',
      label: 'Submit',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-windows-uia-mismatch',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notepad', pid: 4321, bundlePath: null },
        window: { nativeWindowId: 'hwnd-1', sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
    };
    const action: Action = {
      id: 'action-windows-uia-click-mismatch',
      seq: 16,
      tool: 'click',
      params: { element_id: windowsElement.id },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('Windows UIA element winuia:other-hwnd:7 does not match the attached native CUA target identity.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('does not use legacy Windows UIA click without an attached native CUA target identity', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXButton',
      label: 'Submit',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: null,
    };
    const action: Action = {
      id: 'action-windows-uia-click-no-target',
      seq: 16,
      tool: 'click',
      params: { element_id: windowsElement.id },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('Windows UIA element winuia:hwnd-1:7 requires an attached native CUA target identity.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('executes reviewed Windows UIA replacement typing through native CUA set_value', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXTextField',
      label: 'Name',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-windows-uia-type-set',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notepad', pid: 4321, bundlePath: null },
        window: { nativeWindowId: 'hwnd-1', sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
    };
    const action: Action = {
      id: 'action-windows-uia-type-set',
      seq: 16,
      tool: 'type',
      params: { element_id: windowsElement.id, text: 'Ada', clear_first: true },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);
    });

    expect(calls).toEqual(['blur', 'native-set:7:Ada']);
  });

  test('executes reviewed Windows UIA append typing through native CUA type_text', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXTextField',
      label: 'Name',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-windows-uia-type-text',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notepad', pid: 4321, bundlePath: null },
        window: { nativeWindowId: 'hwnd-1', sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
    };
    const action: Action = {
      id: 'action-windows-uia-type-text',
      seq: 17,
      tool: 'type',
      params: { element_id: windowsElement.id, text: ' Ada' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);
    });

    expect(calls).toEqual(['blur', 'native-type:7: Ada']);
  });

  test('does not fall back to direct Windows UIA typing when matching native CUA typing is unavailable', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXTextField',
      label: 'Name',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-windows-uia-type-missing',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notepad', pid: 4321, bundlePath: null },
        window: { nativeWindowId: 'hwnd-1', sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
      auto: {
        ...fakeEngineBase(calls).auto,
        typeNativeCuaElementText: undefined,
      },
    };
    const action: Action = {
      id: 'action-windows-uia-type-missing',
      seq: 18,
      tool: 'type',
      params: { element_id: windowsElement.id, text: ' Ada' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('Native CUA text execution is unavailable.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('rejects Windows UIA typing refs that do not match the attached CUA target identity', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:other-hwnd:7',
      role: 'AXTextField',
      label: 'Name',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-windows-uia-type-mismatch',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notepad', pid: 4321, bundlePath: null },
        window: { nativeWindowId: 'hwnd-1', sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
    };
    const action: Action = {
      id: 'action-windows-uia-type-mismatch',
      seq: 20,
      tool: 'type',
      params: { element_id: windowsElement.id, text: 'Ada' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('Windows UIA element winuia:other-hwnd:7 does not match the attached native CUA target identity.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('does not use legacy Windows UIA typing without an attached native CUA target identity', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXTextField',
      label: 'Name',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: null,
    };
    const action: Action = {
      id: 'action-windows-uia-type-no-target',
      seq: 20,
      tool: 'type',
      params: { element_id: windowsElement.id, text: 'Ada' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('Windows UIA element winuia:hwnd-1:7 requires an attached native CUA target identity.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('does not use local macOS AX typing when an attached app-window target lacks a native CUA ref', async () => {
    const calls: string[] = [];
    const macElement = {
      id: 'ax-field-1',
      role: 'AXTextField',
      label: 'Name',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: macElement.id, targetElement: macElement }),
      formFieldStore: new Map([[macElement.id, macElement]]),
      activeTargetIdentity: activeAppTargetIdentity('overlay-target-mac-ax-type'),
    };
    const action: Action = {
      id: 'action-mac-ax-type',
      seq: 21,
      tool: 'type',
      params: { element_id: macElement.id, text: 'Ada' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('darwin', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('macOS AX typing target ax-field-1 requires a native CUA selected ref.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('does not use local AX typing without a native CUA or browser ref', async () => {
    const calls: string[] = [];
    const element = {
      id: 'ax-field-plain',
      role: 'AXTextField',
      label: 'Name',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: element.id, targetElement: element }),
      formFieldStore: new Map([[element.id, element]]),
      activeTargetIdentity: null,
    };
    const action: Action = {
      id: 'action-plain-ax-type',
      seq: 22,
      tool: 'type',
      params: { element_id: element.id, text: 'Ada' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Overlay typing target ax-field-plain requires a native CUA or browser ref.');
    expect(calls).toEqual(['blur']);
  });

  test('does not use local macOS AX dropdown typing when an attached app-window target lacks a native CUA ref', async () => {
    const calls: string[] = [];
    const macElement = {
      id: 'ax-dropdown-1',
      role: 'AXPopUpButton',
      label: 'Priority',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: macElement.id, targetElement: macElement }),
      formFieldStore: new Map([[macElement.id, macElement]]),
      activeTargetIdentity: activeAppTargetIdentity('overlay-target-mac-ax-dropdown'),
      isDropdownControlRole: (role: string) => role === 'AXPopUpButton',
    };
    const action: Action = {
      id: 'action-mac-ax-dropdown',
      seq: 22,
      tool: 'type',
      params: { element_id: macElement.id, text: 'High' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('darwin', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('macOS AX dropdown target ax-dropdown-1 requires a native CUA selected ref.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('executes reviewed Windows UIA dropdown typing through native CUA select_option', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXPopUpButton',
      label: 'Department',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-windows-uia-dropdown',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notepad', pid: 4321, bundlePath: null },
        window: { nativeWindowId: 'hwnd-1', sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
      isDropdownControlRole: (role: string) => role === 'AXPopUpButton',
      assertDropdownTypeApplied: async (_elementId: string | undefined, _targetElement: unknown, text: string) => {
        calls.push(`verify-dropdown:${text}`);
      },
    };
    const action: Action = {
      id: 'action-windows-uia-dropdown',
      seq: 19,
      tool: 'type',
      params: { element_id: windowsElement.id, text: 'Revenue Operations' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);
    });

    expect(calls).toEqual([
      'blur',
      'native-select:7:Revenue Operations',
      'verify-dropdown:Revenue Operations',
    ]);
  });

  test('does not fall back to direct Windows UIA dropdown typing when matching native CUA dropdown execution is unavailable', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXPopUpButton',
      label: 'Department',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-windows-uia-dropdown-missing',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notepad', pid: 4321, bundlePath: null },
        window: { nativeWindowId: 'hwnd-1', sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
      isDropdownControlRole: (role: string) => role === 'AXPopUpButton',
      auto: {
        ...fakeEngineBase(calls).auto,
        selectNativeCuaElementOption: undefined,
      },
    };
    const action: Action = {
      id: 'action-windows-uia-dropdown-missing',
      seq: 20,
      tool: 'type',
      params: { element_id: windowsElement.id, text: 'Revenue Operations' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('Native CUA dropdown execution is unavailable.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('does not use legacy Windows UIA dropdown typing without an attached native CUA target identity', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXPopUpButton',
      label: 'Department',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: null,
      isDropdownControlRole: (role: string) => role === 'AXPopUpButton',
    };
    const action: Action = {
      id: 'action-windows-uia-dropdown-no-target',
      seq: 20,
      tool: 'type',
      params: { element_id: windowsElement.id, text: 'Revenue Operations' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('Windows UIA dropdown winuia:hwnd-1:7 requires an attached native CUA target identity.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('executes reviewed Windows UIA scrolls through native CUA refs when target identity matches', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXScrollArea',
      label: 'Messages',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 120 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-windows-uia-scroll',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notepad', pid: 4321, bundlePath: null },
        window: { nativeWindowId: 'hwnd-1', sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
    };
    const action: Action = {
      id: 'action-windows-uia-scroll',
      seq: 21,
      tool: 'scroll',
      params: { element_id: windowsElement.id, direction: 'down', amount: 2 },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);
    });

    expect(calls).toEqual(['blur', 'native-scroll:7:down:2']);
  });

  test('does not fall back to direct Windows UIA scroll when matching native CUA scroll is unavailable', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXScrollArea',
      label: 'Messages',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 120 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: {
        id: 'overlay-target-windows-uia-scroll-missing',
        kind: 'active-app',
        displayId: display.id,
        coordinateSpace: 'screen-dip',
        scaleFactor: display.scaleFactor,
        bounds: { x: 50, y: 60, width: 400, height: 300 },
        capturedAt: Date.now(),
        generation: 1,
        app: { name: 'Notepad', pid: 4321, bundlePath: null },
        window: { nativeWindowId: 'hwnd-1', sessionKey: 'window-session-1' },
        browser: null,
        document: null,
        refInvalidation: { staleAfterMs: null, rules: [] },
        permissionScope: { targetWindowSessionKey: 'window-session-1' },
      },
      auto: {
        ...fakeEngineBase(calls).auto,
        scrollNativeCuaElement: undefined,
      },
    };
    const action: Action = {
      id: 'action-windows-uia-scroll-missing',
      seq: 22,
      tool: 'scroll',
      params: { element_id: windowsElement.id, direction: 'down', amount: 2 },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('Native CUA scroll execution is unavailable.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('does not use legacy Windows UIA scroll without an attached native CUA target identity', async () => {
    const calls: string[] = [];
    const windowsElement = {
      id: 'winuia:hwnd-1:7',
      role: 'AXScrollArea',
      label: 'Messages',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 120 },
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      resolveFreshExecutionTarget: () => ({ elementId: windowsElement.id, targetElement: windowsElement }),
      formFieldStore: new Map([[windowsElement.id, windowsElement]]),
      activeTargetIdentity: null,
    };
    const action: Action = {
      id: 'action-windows-uia-scroll-no-target',
      seq: 23,
      tool: 'scroll',
      params: { element_id: windowsElement.id, direction: 'down', amount: 2 },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await withPlatform('win32', async () => {
      await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
        .rejects.toThrow('Windows UIA element winuia:hwnd-1:7 requires an attached native CUA target identity.');
    });
    expect(calls).toEqual(['blur']);
  });

  test('honors explicit clear-first for native CUA refs even when current value is absent', async () => {
    const targetElement = {
      id: 'element_index:7',
      role: 'AXTextField',
      label: '- [7] AXTextField (Name) bounds={x=100, y=120, width=200, height=30, coordinate_space=screen_points}',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
      nativeCua,
    };

    await withPlatform('darwin', async () => {
      expect((RunEngine.prototype as any).shouldClearTextBeforeTyping.call(
        Object.create(RunEngine.prototype),
        targetElement,
        'Ada',
        true,
      )).toBe(true);
    });
  });

  test('executes reviewed clear-first typing through native CUA set_value', async () => {
    const calls: string[] = [];
    const action: Action = {
      id: 'action-2',
      seq: 2,
      tool: 'type',
      params: {
        element_id: 'element_index:7',
        text: 'Ada',
        clear_first: true,
      },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngineBase(calls), action);

    expect(calls).toEqual(['blur', 'native-set:7:Ada']);
  });

  test('executes reviewed non-clear-first typing through native CUA type_text', async () => {
    const calls: string[] = [];
    const action: Action = {
      id: 'action-3',
      seq: 3,
      tool: 'type',
      params: {
        element_id: 'element_index:7',
        text: ' Ada',
      },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngineBase(calls), action);

    expect(calls).toEqual(['blur', 'native-type:7: Ada']);
  });

  test('executes reviewed dropdown typing through native CUA select_option', async () => {
    const calls: string[] = [];
    const dropdownElement = {
      id: 'element_index:7',
      role: 'AXPopUpButton',
      label: 'Department',
      value: '',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
      nativeCua,
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      formFieldStore: new Map([[dropdownElement.id, dropdownElement]]),
      resolveTypingTarget: () => dropdownElement,
      isDropdownControlRole: (role: string) => role === 'AXPopUpButton',
      assertDropdownTypeApplied: async (_elementId: string | undefined, _targetElement: unknown, text: string) => {
        calls.push(`verify-dropdown:${text}`);
      },
    };
    const action: Action = {
      id: 'action-4',
      seq: 4,
      tool: 'type',
      params: {
        element_id: 'element_index:7',
        text: 'Revenue Operations',
      },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(calls).toEqual([
      'blur',
      'native-select:7:Revenue Operations',
    ]);
  });

  test('executes reviewed scrolls through native CUA target refs', async () => {
    const calls: string[] = [];
    const action: Action = {
      id: 'action-5',
      seq: 5,
      tool: 'scroll',
      params: {
        element_id: 'element_index:7',
        direction: 'down',
        amount: 2,
      },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngineBase(calls), action);

    expect(calls).toEqual(['blur', 'native-scroll:7:down:2']);
  });
});
