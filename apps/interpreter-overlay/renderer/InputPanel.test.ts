import { describe, expect, test } from 'bun:test';
import { __test__ } from './InputPanel';
import type { OverlayContextItem, OverlayRegionContextItem } from '../shared/ipc';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../shared/target-identity';

function activeAppContextItem(): OverlayRegionContextItem {
  const bounds = { x: 10, y: 20, width: 800, height: 600 };
  const targetIdentity = buildOverlayTargetIdentity({
    kind: 'active-app',
    bounds,
    display: {
      id: '1',
      boundsDIP: { x: 0, y: 0, width: 1200, height: 800 },
      scaleFactor: 2,
    },
    appName: 'Chromium',
    generation: 1,
    now: 1000,
  });
  return {
    id: 'active-app-target',
    kind: 'region',
    role: 'target',
    label: 'Active app: Chromium',
    bounds,
    displayId: '1',
    scopeKind: 'active-app',
    previewText: null,
    previewImageDataUrl: null,
    targetWindowSessionKey: null,
    targetIdentity,
    snapshot: buildCurrentSelectionContext({ targetIdentity }),
    appIconDataUrl: 'data:image/png;base64,AAAA',
    appIconLabel: 'Chromium',
  };
}

describe('InputPanel text scale hysteresis', () => {
  test('does not bounce from medium back to large immediately after shrinking', () => {
    const { nextTextScale } = __test__;

    const mediumScale = nextTextScale('large', 113, true);
    expect(mediumScale).toBe('medium');
    expect(nextTextScale(mediumScale, 95, true)).toBe('medium');
    expect(nextTextScale(mediumScale, 71, true)).toBe('medium');
    expect(nextTextScale(mediumScale, 71, false)).toBe('large');
  });

  test('does not bounce from compact back to medium immediately after shrinking', () => {
    const { nextTextScale } = __test__;

    const compactScale = nextTextScale('medium', 145, true);
    expect(compactScale).toBe('compact');
    expect(nextTextScale(compactScale, 120, true)).toBe('compact');
    expect(nextTextScale(compactScale, 103, true)).toBe('compact');
    expect(nextTextScale(compactScale, 103, false)).toBe('large');
  });
});

describe('InputPanel file context', () => {
  test('keeps text file drops as metadata instead of eager prompt text', async () => {
    const { fileToOverlayContextItem } = __test__;
    const file = new File(['vendor: North Coast Office Supply'], 'request.txt', {
      type: 'text/plain',
    });
    Object.defineProperty(file, 'path', {
      value: '/tmp/request.txt',
    });
    const item = await fileToOverlayContextItem(file);

    expect(item).toMatchObject({
      kind: 'file',
      role: 'reference',
      name: 'request.txt',
      sizeBytes: file.size,
      filePath: '/tmp/request.txt',
      sourceKind: 'dropped-file',
      sourceLabel: 'Dropped file',
    });
    expect(item && item.kind === 'file' ? item.mimeType : undefined).toStartWith('text/plain');
    expect(item && 'extractedText' in item).toBe(false);
    expect(item && item.kind === 'file' ? item.dataUrl : undefined).toBeUndefined();
  });

  test('accepts Word and Excel drops as queryable file metadata', async () => {
    const { fileToOverlayContextItem } = __test__;
    const wordFile = new File(['not real docx bytes'], 'referral-packet.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    Object.defineProperty(wordFile, 'path', {
      value: '/tmp/referral-packet.docx',
    });
    const spreadsheetFile = new File(['not real xlsx bytes'], 'line-items.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    Object.defineProperty(spreadsheetFile, 'path', {
      value: '/tmp/line-items.xlsx',
    });

    const wordItem = await fileToOverlayContextItem(wordFile);
    const spreadsheetItem = await fileToOverlayContextItem(spreadsheetFile);

    expect(wordItem).toMatchObject({
      kind: 'file',
      role: 'reference',
      name: 'referral-packet.docx',
      filePath: '/tmp/referral-packet.docx',
      sourceKind: 'dropped-file',
    });
    expect(spreadsheetItem).toMatchObject({
      kind: 'file',
      role: 'reference',
      name: 'line-items.xlsx',
      filePath: '/tmp/line-items.xlsx',
      sourceKind: 'dropped-file',
    });
    expect(wordItem && wordItem.kind === 'file' ? wordItem.dataUrl : undefined).toBeUndefined();
    expect(spreadsheetItem && spreadsheetItem.kind === 'file' ? spreadsheetItem.dataUrl : undefined).toBeUndefined();
  });
});

describe('InputPanel active-app context chip', () => {
  test('uses icon-only rendering only for active-app region targets', () => {
    const { shouldRenderContextChipIconOnly } = __test__;
    const activeAppItem: OverlayContextItem = activeAppContextItem();
    const activeAppItemWithoutIcon: OverlayContextItem = {
      ...activeAppItem,
      appIconDataUrl: null,
    };
    const draggedRegionItem: OverlayContextItem = {
      ...activeAppItem,
      id: 'dragged-target',
      label: 'Selected region',
      scopeKind: 'screen-region',
    };

    expect(shouldRenderContextChipIconOnly(activeAppItem)).toBe(true);
    expect(shouldRenderContextChipIconOnly(activeAppItemWithoutIcon)).toBe(false);
    expect(shouldRenderContextChipIconOnly(draggedRegionItem)).toBe(false);
    expect(shouldRenderContextChipIconOnly(undefined)).toBe(false);
  });

  test('suppresses the generic attachment icon for active-app chips until the real app icon hydrates', () => {
    const { shouldSuppressContextChipDefaultIcon } = __test__;
    const activeAppItem: OverlayContextItem = {
      ...activeAppContextItem(),
      appIconDataUrl: null,
    };
    const hydratedActiveAppItem: OverlayContextItem = {
      ...activeAppItem,
      appIconDataUrl: 'data:image/png;base64,AAAA',
    };
    const draggedRegionItem: OverlayContextItem = {
      ...activeAppItem,
      id: 'dragged-target',
      label: 'Selected region',
      scopeKind: 'screen-region',
    };

    expect(shouldSuppressContextChipDefaultIcon(activeAppItem)).toBe(true);
    expect(shouldSuppressContextChipDefaultIcon(hydratedActiveAppItem)).toBe(false);
    expect(shouldSuppressContextChipDefaultIcon(draggedRegionItem)).toBe(false);
    expect(shouldSuppressContextChipDefaultIcon(undefined)).toBe(false);
  });

  test('does not highlight the active-app computer context chip', () => {
    const { shouldHighlightContextChip } = __test__;
    const activeAppItem: OverlayContextItem = activeAppContextItem();
    const draggedRegionItem: OverlayContextItem = {
      ...activeAppItem,
      id: 'dragged-target',
      label: 'Selected region',
      scopeKind: 'screen-region',
    };
    const highlightedIds = new Set([activeAppItem.id, draggedRegionItem.id]);

    expect(shouldHighlightContextChip(activeAppItem, highlightedIds)).toBe(false);
    expect(shouldHighlightContextChip(draggedRegionItem, highlightedIds)).toBe(true);
    expect(shouldHighlightContextChip(draggedRegionItem, new Set())).toBe(false);
  });
});

describe('InputPanel Enter submit keydown decision', () => {
  test('Enter submits, Shift+Enter and IME composition do not', () => {
    const { isComposerSubmitKeydown } = __test__;

    expect(isComposerSubmitKeydown({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
    expect(isComposerSubmitKeydown({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
    expect(isComposerSubmitKeydown({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(isComposerSubmitKeydown({ key: 'a', shiftKey: false, isComposing: false })).toBe(false);
  });
});

describe('InputPanel mounted Enter submit', () => {
  test('Enter triggers submit and Shift+Enter does not, including when the textarea lost focus', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
    });
    (dom.window as unknown as { overlay: unknown }).overlay = {
      onRequestInputFocus: () => () => {},
      setIgnoreMouse: () => {},
      send: () => {},
    };

    const globalKeys = [
      'window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement',
      'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'Event',
      'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
    ] as const;
    const g = globalThis as unknown as Record<string, unknown>;
    const savedGlobals = new Map<string, unknown>(globalKeys.map((key) => [key, g[key]]));
    g.window = dom.window;
    g.document = dom.window.document;
    g.navigator = dom.window.navigator;
    g.HTMLElement = dom.window.HTMLElement;
    g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
    g.Element = dom.window.Element;
    g.Node = dom.window.Node;
    g.KeyboardEvent = dom.window.KeyboardEvent;
    g.MouseEvent = dom.window.MouseEvent;
    g.Event = dom.window.Event;
    g.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number;
    g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout);
    g.IS_REACT_ACT_ENVIRONMENT = true;

    try {
      const React = await import('react');
      const { act } = React;
      const { createRoot } = await import('react-dom/client');
      const { InputPanel } = await import('./InputPanel');

      const submissions: Array<Record<string, unknown>> = [];
      const container = dom.window.document.getElementById('root')!;
      const root = createRoot(container);
      await act(async () => {
        root.render(React.createElement(InputPanel, {
          visible: true,
          shown: true,
          screenshot: null,
          transcript: '',
          isRecording: false,
          amplitude: 0,
          contextItems: [],
          selectionInteractionActive: false,
          onInputFocusChange: () => {},
          onDraftChange: () => {},
          onClearInputContext: () => {},
          onRemoveContextItem: () => {},
          onFilesDropped: () => {},
          onSubmit: (submission: Record<string, unknown>) => submissions.push(submission),
          onVoiceToggle: () => {},
          onDismiss: () => {},
        }));
      });

      const textarea = container.querySelector('textarea')!;
      expect(textarea).toBeTruthy();
      const setTextareaValue = async (value: string) => {
        await act(async () => {
          const valueSetter = Object.getOwnPropertyDescriptor(
            dom.window.HTMLTextAreaElement.prototype,
            'value',
          )!.set!;
          valueSetter.call(textarea, value);
          textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        });
      };
      const pressKey = async (target: EventTarget, init: KeyboardEventInit) => {
        await act(async () => {
          target.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            ...init,
          }));
        });
      };

      await setTextareaValue('first draft');

      // Shift+Enter inserts a newline: no submit.
      await pressKey(textarea, { key: 'Enter', shiftKey: true });
      expect(submissions).toEqual([]);

      // Enter on the focused textarea submits exactly once (the window
      // backstop must not double-submit).
      await pressKey(textarea, { key: 'Enter' });
      expect(submissions).toEqual([{ text: 'first draft', attachments: [] }]);

      // Enter must still submit when DOM focus drifted off the textarea
      // (e.g. to document.body after clicking a non-focusable overlay
      // surface) — this is the window-level backstop path.
      await setTextareaValue('second draft');
      await pressKey(dom.window.document.body, { key: 'Enter', shiftKey: true });
      expect(submissions).toHaveLength(1);
      await pressKey(dom.window.document.body, { key: 'Enter' });
      expect(submissions).toHaveLength(2);
      expect(submissions[1]).toEqual({ text: 'second draft', attachments: [] });

      await act(async () => {
        root.unmount();
      });
    } finally {
      for (const [key, value] of savedGlobals) {
        if (value === undefined) {
          delete g[key];
        } else {
          g[key] = value;
        }
      }
    }
  });
});

describe('InputPanel window Enter backstop target guard', () => {
  test('skips the composer textarea and interactive elements, submits from non-interactive targets', async () => {
    const { shouldWindowEnterBackstopSubmit } = __test__;
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body><button id="b"></button><span id="s"></span></body></html>');
    const g = globalThis as unknown as Record<string, unknown>;
    const savedHtmlElement = g.HTMLElement;
    g.HTMLElement = dom.window.HTMLElement;

    try {
      const editor = dom.window.document.createElement('textarea');

      expect(shouldWindowEnterBackstopSubmit(editor, editor)).toBe(false);
      expect(shouldWindowEnterBackstopSubmit(dom.window.document.getElementById('b'), editor)).toBe(false);
      expect(shouldWindowEnterBackstopSubmit(dom.window.document.getElementById('s'), editor)).toBe(true);
      expect(shouldWindowEnterBackstopSubmit(dom.window.document.body, editor)).toBe(true);
    } finally {
      if (savedHtmlElement === undefined) {
        delete g.HTMLElement;
      } else {
        g.HTMLElement = savedHtmlElement;
      }
    }
  });
});

describe('InputPanel focus retry scheduling', () => {
  test('deduplicates pending retry timers by delay', () => {
    const { scheduleUniqueFocusRetry } = __test__;
    const timers = new Map<number, number>();
    const scheduled: Array<{ id: number; delayMs: number; handler: () => void }> = [];
    let callbackCount = 0;
    const scheduler = (handler: () => void, delayMs: number) => {
      const id = scheduled.length + 1;
      scheduled.push({ id, delayMs, handler });
      return id;
    };

    scheduleUniqueFocusRetry(timers, 16, scheduler, () => {
      callbackCount += 1;
    });
    scheduleUniqueFocusRetry(timers, 16, scheduler, () => {
      callbackCount += 1;
    });
    scheduleUniqueFocusRetry(timers, 48, scheduler, () => {
      callbackCount += 1;
    });

    expect(scheduled.map((entry) => entry.delayMs)).toEqual([16, 48]);
    expect(timers).toEqual(new Map([
      [16, 1],
      [48, 2],
    ]));

    scheduled[0].handler();
    expect(callbackCount).toBe(1);
    expect(timers.has(16)).toBe(false);
    expect(timers.get(48)).toBe(2);
  });
});
