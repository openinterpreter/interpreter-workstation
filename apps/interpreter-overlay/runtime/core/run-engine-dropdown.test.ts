import { describe, expect, it } from 'bun:test';
import { RunEngine } from './run-engine.js';
import type { Action, DisplayInfo } from '../../shared/types.js';

describe('RunEngine dropdown typing', () => {
  it('rejects AX dropdown typing without a native CUA or browser ref', async () => {
    const display: DisplayInfo = {
      id: 'display-1',
      scaleFactor: 2,
      boundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
    };
    const action: Action = {
      id: 'action-1',
      seq: 1,
      tool: 'type',
      params: {
        element_id: 'language',
        text: 'English',
      },
      bbox: {
        x_min: 0.1,
        y_min: 0.2,
        x_max: 0.2,
        y_max: 0.25,
      },
    };
    const callOrder: string[] = [];
    const clickCalls: Array<{ center: { x: number; y: number } }> = [];
    const typeCalls: Array<{ text: string; clearFirst: boolean; center: { x: number; y: number } | null | undefined }> = [];
    const hotkeyCalls: Array<{ hotkey: string; center: { x: number; y: number } | null | undefined }> = [];
    const selectCalls: Array<{ elementId: string; optionText: string; center: { x: number; y: number } | null | undefined }> = [];

    const dropdownElement = {
      id: 'language',
      role: 'AXPopUpButton',
      label: 'Preferred Language dropdown',
      value: '',
      bbox: { x: 120, y: 180, width: 240, height: 32 },
    };
    const fakeEngine = {
      currentRun: { id: 'run-1' },
      activeDisplay: null,
      capture: {
        getActiveDisplay: () => display,
      },
      formFieldStore: new Map([
        ['language', dropdownElement],
        ['opt-1', {
          id: 'opt-1',
          role: 'AXButton',
          label: 'Preferred Language: English',
          value: '',
          bbox: { x: 120, y: 220, width: 240, height: 24 },
        }],
        ['opt-2', {
          id: 'opt-2',
          role: 'AXButton',
          label: 'Preferred Language: Spanish',
          value: '',
          bbox: { x: 120, y: 248, width: 240, height: 24 },
        }],
      ]),
      focusedMenuElementId: null as string | null,
      ui: {
        blur: () => {
          callOrder.push('blur');
        },
      },
      auto: {
        click: async (center: { x: number; y: number }) => {
          callOrder.push('click');
          clickCalls.push({ center });
        },
        typeFocused: async (
          text: string,
          clearFirst?: boolean,
          center?: { x: number; y: number } | null,
        ) => {
          callOrder.push('typeFocused');
          typeCalls.push({ text, clearFirst: Boolean(clearFirst), center });
        },
        pressHotkey: async (hotkey: string, center?: { x: number; y: number } | null) => {
          callOrder.push('pressHotkey');
          hotkeyCalls.push({ hotkey, center });
        },
        selectOptionElement: async (
          elementId: string,
          optionText: string,
          center?: { x: number; y: number } | null,
        ) => {
          callOrder.push('selectOptionElement');
          selectCalls.push({ elementId, optionText, center });
        },
      },
      resolveFreshExecutionTarget: (RunEngine.prototype as any).resolveFreshExecutionTarget,
      getActionElementTarget: (RunEngine.prototype as any).getActionElementTarget,
      buildNativeCuaAppWindowTarget: () => null,
      buildNativeCuaPointTarget: () => null,
      resolveTypingTarget: (element: typeof dropdownElement) => element,
      syncActionBBoxWithTarget: () => {},
      toAutomationPoint: (point: { x: number; y: number }) => point,
      shouldClearTextBeforeTyping: () => false,
      getVisionCoordinatePoint: () => null,
      resolveInteractionPoint: () => ({ x: 240, y: 196 }),
      getActiveViewportOrThrow: () => display.boundsDIP,
      isDropdownControlRole: (RunEngine.prototype as any).isDropdownControlRole,
      getDropdownOptionTypeaheadText: (RunEngine.prototype as any).getDropdownOptionTypeaheadText,
      trySelectObservedDropdownOption: async () => false,
      dropdownSnapshotShowsExpected: (RunEngine.prototype as any).dropdownSnapshotShowsExpected,
      structuredDropdownTextShowsExpected: (RunEngine.prototype as any).structuredDropdownTextShowsExpected,
      parseDropdownOptionLabel: (RunEngine.prototype as any).parseDropdownOptionLabel,
      isDropdownOptionElement: (RunEngine.prototype as any).isDropdownOptionElement,
      normalizeDropdownFieldLabel: (RunEngine.prototype as any).normalizeDropdownFieldLabel,
      normalizeElementLabel: (RunEngine.prototype as any).normalizeElementLabel,
      normalizeTypedTextValue: (RunEngine.prototype as any).normalizeTypedTextValue,
      assertDropdownTypeApplied: async () => {},
      captureStructuredRefreshSnapshot: async () => ({
        formattedText: '<window><dropdown name="Preferred Language dropdown">English</dropdown></window>',
        elements: [{ ...dropdownElement, value: 'English' }],
        focusedMenuElementId: null,
      }),
      lastVisionInteractionPoint: null,
    };

    await expect((RunEngine.prototype as any).executeAction.call(fakeEngine, action))
      .rejects.toThrow('Overlay dropdown target language requires a native CUA or browser ref.');

    expect(callOrder).toEqual(['blur']);
    expect(selectCalls).toEqual([]);
    expect(clickCalls).toEqual([]);
    expect(typeCalls).toEqual([]);
    expect(hotkeyCalls).toEqual([]);
    expect(fakeEngine.focusedMenuElementId).toBeNull();
  });

  it('does not request window reactivation for hotkeys while a dropdown menu is open', () => {
    const fakeEngine = {
      focusedMenuElementId: 'department' as string | null,
      formFieldStore: new Map([
        ['department', {
          id: 'department',
          role: 'AXPopUpButton',
          label: 'Department dropdown',
          value: '',
          bbox: { x: 120, y: 180, width: 240, height: 32 },
        }],
      ]),
      getFocusedInteractiveElement: () => null,
      getScopedElementBBox: () => null,
      absoluteBBoxCenter: (bbox: { x: number; y: number; width: number; height: number }) => ({
        x: bbox.x + bbox.width / 2,
        y: bbox.y + bbox.height / 2,
      }),
    };

    const activationPoint = (RunEngine.prototype as any).getHotkeyActivationPoint.call(fakeEngine);

    expect(activationPoint).toBeNull();
  });

  it('derives a unique dropdown typeahead prefix from visible menu items', () => {
    const fakeEngine = {
      formFieldStore: new Map([
        ['department', {
          id: 'department',
          role: 'AXPopUpButton',
          label: 'Department dropdown',
          value: '',
          bbox: { x: 120, y: 180, width: 240, height: 32 },
        }],
        ['menu-1', {
          id: 'menu-1',
          role: 'AXMenuItem',
          label: 'Customer Success',
          value: 'Customer Success',
          bbox: { x: 120, y: 220, width: 240, height: 24 },
        }],
        ['menu-2', {
          id: 'menu-2',
          role: 'AXMenuItem',
          label: 'Finance',
          value: 'Finance',
          bbox: { x: 120, y: 248, width: 240, height: 24 },
        }],
        ['menu-3', {
          id: 'menu-3',
          role: 'AXMenuItem',
          label: 'People Operations',
          value: 'People Operations',
          bbox: { x: 120, y: 276, width: 240, height: 24 },
        }],
        ['menu-4', {
          id: 'menu-4',
          role: 'AXMenuItem',
          label: 'Revenue Operations',
          value: 'Revenue Operations',
          bbox: { x: 120, y: 304, width: 240, height: 24 },
        }],
      ]),
      focusedMenuElementId: 'department' as string | null,
      isDropdownOptionElement: (RunEngine.prototype as any).isDropdownOptionElement,
      parseDropdownOptionLabel: (RunEngine.prototype as any).parseDropdownOptionLabel,
      isDropdownControlRole: (RunEngine.prototype as any).isDropdownControlRole,
      normalizeDropdownFieldLabel: (RunEngine.prototype as any).normalizeDropdownFieldLabel,
      normalizeElementLabel: (RunEngine.prototype as any).normalizeElementLabel,
    };

    const typeahead = (RunEngine.prototype as any).getDropdownOptionTypeaheadText.call(
      fakeEngine,
      'Department dropdown',
      'Revenue Operations',
    );

    expect(typeahead).toBe('r');
  });

  it('routes menuitems under the currently open dropdown through native CUA point clicks', async () => {
    const display: DisplayInfo = {
      id: 'display-1',
      scaleFactor: 2,
      boundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
    };
    const action: Action = {
      id: 'action-2',
      seq: 2,
      tool: 'click',
      params: {
        element_id: 'department-option',
      },
      bbox: {
        x_min: 0.2,
        y_min: 0.3,
        x_max: 0.25,
        y_max: 0.34,
      },
    };
    const clickCalls: string[] = [];

    const fakeEngine = {
      currentRun: { id: 'run-1' },
      activeDisplay: null,
      capture: {
        getActiveDisplay: () => display,
      },
      formFieldStore: new Map([
        ['department', {
          id: 'department',
          role: 'AXPopUpButton',
          label: 'Department dropdown',
          value: '',
          bbox: { x: 120, y: 180, width: 240, height: 32 },
        }],
        ['department-option', {
          id: 'department-option',
          role: 'AXMenuItem',
          label: 'Revenue Operations',
          value: 'Revenue Operations',
          bbox: { x: 120, y: 220, width: 240, height: 24 },
        }],
      ]),
      focusedMenuElementId: 'department' as string | null,
      activeTargetIdentity: {
        id: 'overlay-target-dropdown',
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
      ui: {
        blur: () => {},
      },
      auto: {
        clickNativeCuaPoint: async (target: { app: string; x: number; y: number }) => {
          clickCalls.push(`native-point-click:${target.app}:${target.x}:${target.y}`);
        },
      },
      resolveFreshExecutionTarget: (RunEngine.prototype as any).resolveFreshExecutionTarget,
      getActionElementTarget: (RunEngine.prototype as any).getActionElementTarget,
      buildNativeCuaAppWindowTarget: (RunEngine.prototype as any).buildNativeCuaAppWindowTarget,
      buildNativeCuaPointTarget: (RunEngine.prototype as any).buildNativeCuaPointTarget,
      syncActionBBoxWithTarget: () => {},
      toAutomationPoint: (point: { x: number; y: number }) => point,
      getVisionCoordinatePoint: () => null,
      resolveInteractionPoint: () => ({ x: 240, y: 232 }),
      getActiveViewportOrThrow: () => display.boundsDIP,
      isDropdownControlRole: (RunEngine.prototype as any).isDropdownControlRole,
      getDropdownOptionTypeaheadText: (RunEngine.prototype as any).getDropdownOptionTypeaheadText,
      getMenuItemTypeaheadText: (RunEngine.prototype as any).getMenuItemTypeaheadText,
      isDropdownOptionElement: (RunEngine.prototype as any).isDropdownOptionElement,
      parseDropdownOptionLabel: (RunEngine.prototype as any).parseDropdownOptionLabel,
      normalizeDropdownFieldLabel: (RunEngine.prototype as any).normalizeDropdownFieldLabel,
      normalizeElementLabel: (RunEngine.prototype as any).normalizeElementLabel,
      lastVisionInteractionPoint: null,
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(clickCalls).toEqual(['native-point-click:Notes:240:232']);
    expect(fakeEngine.focusedMenuElementId).toBeNull();
  });

  it('selects an observed AX dropdown option through native CUA point click', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });

    try {
      const display: DisplayInfo = {
        id: 'display-1',
        scaleFactor: 2,
        boundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
      };
      const targetElement = {
        id: 'department',
        role: 'AXPopUpButton',
        label: 'Department dropdown',
        value: '',
        bbox: { x: 120, y: 180, width: 240, height: 32 },
      };
      const clickCalls: string[] = [];
      const fakeEngine = {
        formFieldStore: new Map([
          ['department', targetElement],
          ['department-option', {
            id: 'department-option',
            role: 'AXMenuItem',
            label: 'Revenue Operations',
            value: 'Revenue Operations',
            bbox: { x: 120, y: 220, width: 240, height: 24 },
          }],
        ]),
        activeTargetIdentity: {
          id: 'overlay-target-observed-dropdown-option',
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
          clickNativeCuaPoint: async (target: { app: string; x: number; y: number }) => {
            clickCalls.push(`native-point-click:${target.app}:${target.x}:${target.y}`);
          },
        },
        captureStructuredRefreshSnapshot: async () => ({}),
        buildNativeCuaAppWindowTarget: (RunEngine.prototype as any).buildNativeCuaAppWindowTarget,
        buildNativeCuaPointTarget: (RunEngine.prototype as any).buildNativeCuaPointTarget,
        normalizeMenuTypeahead: (RunEngine.prototype as any).normalizeMenuTypeahead,
        parseDropdownOptionLabel: (RunEngine.prototype as any).parseDropdownOptionLabel,
        getScopedElementBBox: (element: { bbox?: unknown }) => element.bbox,
        absoluteBBoxCenter: (bbox: { x: number; y: number; width: number; height: number }) => ({
          x: bbox.x + bbox.width / 2,
          y: bbox.y + bbox.height / 2,
        }),
        toAutomationPoint: (point: { x: number; y: number }) => point,
      };

      const selected = await (RunEngine.prototype as any).trySelectObservedDropdownOption.call(
        fakeEngine,
        targetElement,
        'Revenue Operations',
      );

      expect(selected).toBe(true);
      expect(clickCalls).toEqual(['native-point-click:Notes:240:232']);
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
  });

  it('trusts a refreshed dropdown id match before a nearby geometry match', async () => {
    const targetElement = {
      id: 'department',
      role: 'AXPopUpButton',
      label: '* Department',
      value: 'Select department',
      bbox: { x: 120, y: 180, width: 240, height: 32 },
    };
    const fakeEngine = {
      isDropdownControlRole: (RunEngine.prototype as any).isDropdownControlRole,
      normalizeTypedTextValue: (RunEngine.prototype as any).normalizeTypedTextValue,
      normalizeElementLabel: (RunEngine.prototype as any).normalizeElementLabel,
      dropdownSnapshotShowsExpected: (RunEngine.prototype as any).dropdownSnapshotShowsExpected,
      structuredDropdownTextShowsExpected: (RunEngine.prototype as any).structuredDropdownTextShowsExpected,
      normalizeDropdownComparableText: (RunEngine.prototype as any).normalizeDropdownComparableText,
      captureStructuredRefreshSnapshot: async () => ({
        formattedText: '<window><dropdown id="department" name="* Department">Operations</dropdown></window>',
        elements: [
          {
            id: 'nearby',
            role: 'AXPopUpButton',
            label: '* Cost Center',
            value: 'Select cost center',
            bbox: { x: 122, y: 182, width: 240, height: 32 },
          },
          {
            ...targetElement,
            value: 'Operations',
            bbox: { x: 900, y: 330, width: 313, height: 32 },
          },
        ],
      }),
    };

    const snapshot = await fakeEngine.captureStructuredRefreshSnapshot();
    expect(
      (RunEngine.prototype as any).dropdownSnapshotShowsExpected.call(
        fakeEngine,
        snapshot,
        'department',
        targetElement,
        'Operations',
      ),
    ).toBe(true);
  });

  it('accepts a dropdown value from exact structured text when element value is empty', async () => {
    const targetElement = {
      id: 'department',
      role: 'AXPopUpButton',
      label: '* Department',
      value: 'Select department',
      bbox: { x: 120, y: 180, width: 240, height: 32 },
    };
    const fakeEngine = {
      isDropdownControlRole: (RunEngine.prototype as any).isDropdownControlRole,
      normalizeTypedTextValue: (RunEngine.prototype as any).normalizeTypedTextValue,
      normalizeElementLabel: (RunEngine.prototype as any).normalizeElementLabel,
      normalizeDropdownComparableText: (RunEngine.prototype as any).normalizeDropdownComparableText,
      dropdownSnapshotShowsExpected: (RunEngine.prototype as any).dropdownSnapshotShowsExpected,
      structuredDropdownTextShowsExpected: (RunEngine.prototype as any).structuredDropdownTextShowsExpected,
      captureStructuredRefreshSnapshotWithTimeout: (RunEngine.prototype as any).captureStructuredRefreshSnapshotWithTimeout,
      captureStructuredRefreshSnapshot: async () => ({
        formattedText: '<window>\n  <dropdown id="department" name="* Department" focused>Operations</dropdown>\n</window>',
        elements: [
          {
            ...targetElement,
            value: '',
          },
        ],
      }),
    };

    await expect(
      (RunEngine.prototype as any).assertDropdownTypeApplied.call(
        fakeEngine,
        'department',
        targetElement,
        'Operations',
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts normalized dash variants when verifying dropdown values', async () => {
    const targetElement = {
      id: 'place-of-service',
      role: 'AXPopUpButton',
      label: '* Place of Service',
      value: 'Select',
      bbox: { x: 120, y: 180, width: 260, height: 32 },
    };
    const fakeEngine = {
      isDropdownControlRole: (RunEngine.prototype as any).isDropdownControlRole,
      normalizeTypedTextValue: (RunEngine.prototype as any).normalizeTypedTextValue,
      normalizeElementLabel: (RunEngine.prototype as any).normalizeElementLabel,
      normalizeDropdownComparableText: (RunEngine.prototype as any).normalizeDropdownComparableText,
      dropdownSnapshotShowsExpected: (RunEngine.prototype as any).dropdownSnapshotShowsExpected,
      structuredDropdownTextShowsExpected: (RunEngine.prototype as any).structuredDropdownTextShowsExpected,
      captureStructuredRefreshSnapshotWithTimeout: (RunEngine.prototype as any).captureStructuredRefreshSnapshotWithTimeout,
      captureStructuredRefreshSnapshot: async () => ({
        formattedText: '<window>\n  <dropdown id="place-of-service" name="* Place of Service" focused>22 - Outpatient Hospital</dropdown>\n</window>',
        elements: [
          {
            ...targetElement,
            value: '22 - Outpatient Hospital',
          },
        ],
      }),
    };

    await expect(
      (RunEngine.prototype as any).assertDropdownTypeApplied.call(
        fakeEngine,
        'place-of-service',
        targetElement,
        '22 – Outpatient Hospital',
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts compound dropdown values that only differ by whitespace', async () => {
    const targetElement = {
      id: 'line-of-business',
      role: 'AXPopUpButton',
      label: 'Line of Business',
      value: 'Select',
      bbox: { x: 120, y: 180, width: 260, height: 32 },
    };
    const fakeEngine = {
      isDropdownControlRole: (RunEngine.prototype as any).isDropdownControlRole,
      normalizeTypedTextValue: (RunEngine.prototype as any).normalizeTypedTextValue,
      normalizeElementLabel: (RunEngine.prototype as any).normalizeElementLabel,
      normalizeDropdownComparableText: (RunEngine.prototype as any).normalizeDropdownComparableText,
      dropdownSnapshotShowsExpected: (RunEngine.prototype as any).dropdownSnapshotShowsExpected,
      structuredDropdownTextShowsExpected: (RunEngine.prototype as any).structuredDropdownTextShowsExpected,
      captureStructuredRefreshSnapshotWithTimeout: (RunEngine.prototype as any).captureStructuredRefreshSnapshotWithTimeout,
      captureStructuredRefreshSnapshot: async () => ({
        formattedText: '<window>\n  <dropdown id="line-of-business" name="Line of Business">Business owners policy</dropdown>\n</window>',
        elements: [
          {
            ...targetElement,
            value: 'Business owners policy',
          },
        ],
      }),
    };

    await expect(
      (RunEngine.prototype as any).assertDropdownTypeApplied.call(
        fakeEngine,
        'line-of-business',
        targetElement,
        'Businessowners Policy',
      ),
    ).resolves.toBeUndefined();
  });

  it('bounds hung dropdown verification refreshes', async () => {
    const targetElement = {
      id: 'gl-account',
      role: 'AXPopUpButton',
      label: 'GL Account',
      value: 'Select GL account',
      bbox: { x: 120, y: 180, width: 260, height: 32 },
    };
    const startedAt = Date.now();
    const fakeEngine = {
      isDropdownControlRole: (RunEngine.prototype as any).isDropdownControlRole,
      normalizeTypedTextValue: (RunEngine.prototype as any).normalizeTypedTextValue,
      normalizeElementLabel: (RunEngine.prototype as any).normalizeElementLabel,
      normalizeDropdownComparableText: (RunEngine.prototype as any).normalizeDropdownComparableText,
      dropdownSnapshotShowsExpected: (RunEngine.prototype as any).dropdownSnapshotShowsExpected,
      structuredDropdownTextShowsExpected: (RunEngine.prototype as any).structuredDropdownTextShowsExpected,
      captureStructuredRefreshSnapshotWithTimeout: (RunEngine.prototype as any).captureStructuredRefreshSnapshotWithTimeout,
      captureStructuredRefreshSnapshot: async () => new Promise(() => {}),
    };

    await expect(
      (RunEngine.prototype as any).assertDropdownTypeApplied.call(
        fakeEngine,
        'gl-account',
        targetElement,
        '6820 Office Supplies',
      ),
    ).rejects.toThrow('Dropdown "GL Account" could not be verified after selecting "6820 Office Supplies". Structured refresh error: Structured refresh timed out');
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});
