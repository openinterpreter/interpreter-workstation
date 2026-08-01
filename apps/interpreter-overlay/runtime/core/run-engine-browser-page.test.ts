import { describe, expect, test } from 'bun:test';

import { RunEngine } from './run-engine';
import type { Action, DisplayInfo } from '../../shared/types';
import type { BrowserPageElementTarget } from '../../shared/ports';

const display: DisplayInfo = {
  id: 'display-1',
  scaleFactor: 2,
  boundsDIP: { x: 0, y: 0, width: 1000, height: 800 },
};

const browserPage: BrowserPageElementTarget = {
  refId: 'browser-element:rev-1:0',
  targetIdentity: {
    kind: 'browser-page',
    browser_profile_policy_id: 'install:profile-1',
    tab_ref: 'install:profile-1:chrome-tab:12',
    chrome_tab_id: 12,
    browser_window_id: 7,
    frame_id: 0,
    chrome_document_id: 'doc-1',
    document_revision: 'rev-1',
    origin: 'https://example.test',
    url: 'https://example.test/form',
    coordinate_space: 'browser-viewport-css-px',
    ref_lifetime: 'current_document_revision',
    ref_invalidation_rules: ['browser_document_revision_mismatch'],
  },
};

function fakeEngineBase(calls: string[]) {
  const element = {
    id: 'browser-element:rev-1:0',
    role: 'button',
    label: 'Submit',
    bbox: { x: 100, y: 120, width: 200, height: 30 },
    browserPage,
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
      clickBrowserPageElement: async (target: BrowserPageElementTarget) => {
        calls.push(`browser-click:${target.refId}`);
      },
      typeBrowserPageElement: async (target: BrowserPageElementTarget, text: string) => {
        calls.push(`browser-type:${target.refId}:${text}`);
      },
      selectBrowserPageElementOption: async (target: BrowserPageElementTarget, value: string) => {
        calls.push(`browser-select:${target.refId}:${value}`);
      },
      scrollBrowserPageElement: async (target: BrowserPageElementTarget, direction: string, amount: number) => {
        calls.push(`browser-scroll:${target.refId}:${direction}:${amount}`);
      },
    },
    resolveFreshExecutionTarget: (RunEngine.prototype as any).resolveFreshExecutionTarget,
    getActionElementTarget: (RunEngine.prototype as any).getActionElementTarget,
    resolveTypingTarget: () => element,
    syncActionBBoxWithTarget: () => {},
    shouldClearTextBeforeTyping: (_target: unknown, _text: string, explicitClearFirst: boolean) => explicitClearFirst,
    getVisionCoordinatePoint: () => null,
    resolveInteractionPoint: () => ({ x: 200, y: 135 }),
    getActiveViewportOrThrow: () => display.boundsDIP,
    isDropdownControlRole: () => false,
    isDropdownOptionElement: () => false,
    toAutomationPoint: (point: { x: number; y: number }) => point,
    lastVisionInteractionPoint: null,
  };
}

describe('RunEngine browser page execution', () => {
  test('executes reviewed browser clicks through browser page refs', async () => {
    const calls: string[] = [];
    const action: Action = {
      id: 'action-1',
      seq: 1,
      tool: 'click',
      params: { element_id: 'browser-element:rev-1:0' },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngineBase(calls), action);

    expect(calls).toEqual(['blur', 'browser-click:browser-element:rev-1:0']);
  });

  test('executes reviewed browser typing through browser page refs', async () => {
    const calls: string[] = [];
    const action: Action = {
      id: 'action-2',
      seq: 2,
      tool: 'type',
      params: {
        element_id: 'browser-element:rev-1:0',
        text: 'Ada',
        clear_first: true,
      },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngineBase(calls), action);

    expect(calls).toEqual(['blur', 'browser-type:browser-element:rev-1:0:Ada']);
  });

  test('executes reviewed browser dropdown typing through browser page select refs', async () => {
    const calls: string[] = [];
    const selectElement = {
      id: 'browser-element:rev-1:0',
      role: 'combobox',
      label: 'Department',
      bbox: { x: 100, y: 120, width: 200, height: 30 },
      browserPage,
    };
    const fakeEngine = {
      ...fakeEngineBase(calls),
      formFieldStore: new Map([[selectElement.id, selectElement]]),
      resolveTypingTarget: () => selectElement,
      isDropdownControlRole: (role: string) => role === 'combobox',
    };
    const action: Action = {
      id: 'action-3',
      seq: 3,
      tool: 'type',
      params: {
        element_id: 'browser-element:rev-1:0',
        text: 'support',
      },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngine, action);

    expect(calls).toEqual(['blur', 'browser-select:browser-element:rev-1:0:support']);
  });

  test('executes reviewed browser scrolls through browser page refs', async () => {
    const calls: string[] = [];
    const action: Action = {
      id: 'action-4',
      seq: 4,
      tool: 'scroll',
      params: {
        element_id: 'browser-element:rev-1:0',
        direction: 'down',
        amount: 4,
      },
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.3, y_max: 0.2 },
    };

    await (RunEngine.prototype as any).executeAction.call(fakeEngineBase(calls), action);

    expect(calls).toEqual(['blur', 'browser-scroll:browser-element:rev-1:0:down:4']);
  });
});
