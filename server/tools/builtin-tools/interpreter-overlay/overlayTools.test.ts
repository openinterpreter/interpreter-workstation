import { afterAll, describe, expect, mock, test } from 'bun:test';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../../../../apps/interpreter-overlay/shared/target-identity';

const targetIdentity = buildOverlayTargetIdentity({
  kind: 'screen-region',
  bounds: { x: 10, y: 20, width: 300, height: 200 },
  display: {
    id: 'display-1',
    boundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
    scaleFactor: 2,
  },
  targetWindowSessionKey: 'window-session-1',
  nativeWindowId: 42,
  appName: 'Chrome',
  appPid: 123,
  browser: {
    profileId: 'profile-1',
    windowId: 7,
    tabId: 8,
    frameId: 'main',
    url: 'https://example.test/form',
    title: 'Lead form',
    documentRevision: 'rev-1',
  },
  document: {
    id: 'doc-1',
    title: 'Lead form',
    url: 'https://example.test/form',
    filePath: null,
    appSpecificId: 'tab-8',
  },
  generation: 1,
  now: 1000,
});
const currentSelectionContext = buildCurrentSelectionContext({
  targetIdentity,
  selectableRefs: [{
    id: 'field-1',
    role: 'textbox',
    label: 'Full Name',
    bounds: { x: 20, y: 40, width: 120, height: 30 },
  }],
});

const readContextMock = mock(async () => ({
  agentMode: 'ax' as const,
  formattedText: '<window name="Lead form"><button>Save</button></window>',
  elementCount: 1,
  elements: [],
  screenshotBase64: 'unused-base64',
  screenshotPath: '/tmp/interpreter-overlay/overlay-scope-read.png',
  captureBoundsDIP: { x: 10, y: 20, width: 300, height: 200 },
  displayBoundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
  targetIdentity,
  currentSelectionContext,
}));

const screenshotMock = mock(async () => ({
  agentMode: 'vision' as const,
  formattedText: '',
  elementCount: 0,
  elements: [],
  screenshotBase64: 'unused-base64',
  screenshotPath: '/tmp/interpreter-overlay/overlay-scope-shot.png',
  captureBoundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
  displayBoundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
}));
const computerBatchMock = mock(async () => ({
  result: {
    kind: 'structured-screen' as const,
    snapshot: {
      formattedText: '<window name="Lead form"><button>Saved</button></window>',
      elements: [],
      focusedMenuElementId: null,
    },
    debug: {
      durationMs: 120,
      actionTimings: [
        { seq: 1, tool: 'type', durationMs: 40, status: 'completed' as const },
        { seq: 2, tool: 'type', durationMs: 80, status: 'completed' as const },
      ],
    },
  },
  touchedWindowDiff: {
    changed: true,
    windows: [{
      window: '<window name="Lead form">',
      status: 'changed' as const,
      removedLines: ['<button>Save</button>'],
      addedLines: ['<button>Saved</button>'],
    }],
  },
}));
const clickMock = mock(async () => {});
const showDrawingsMock = mock(async () => {});
const clearDrawingsMock = mock(async () => {});

const { overlaySessionManager } = await import('../../../overlaySessionManager');
const originalReadContext = overlaySessionManager.readContext;
const originalScreenshot = overlaySessionManager.screenshot;
const originalComputerBatch = overlaySessionManager.computerBatch;
const originalClick = overlaySessionManager.click;
const originalShowDrawings = overlaySessionManager.showDrawings;
const originalClearDrawings = overlaySessionManager.clearDrawings;

(overlaySessionManager as any).readContext = readContextMock;
(overlaySessionManager as any).screenshot = screenshotMock;
(overlaySessionManager as any).computerBatch = computerBatchMock;
(overlaySessionManager as any).click = clickMock;
(overlaySessionManager as any).showDrawings = showDrawingsMock;
(overlaySessionManager as any).clearDrawings = clearDrawingsMock;

const {
  overlayClickTool,
  overlayClearDrawingsTool,
  overlayComputerBatchTool,
  overlayReadContextTool,
  overlayScreenshotTool,
  overlayShowDrawingsTool,
} = await import('./overlayTools');

afterAll(() => {
  overlaySessionManager.readContext = originalReadContext;
  overlaySessionManager.screenshot = originalScreenshot;
  overlaySessionManager.computerBatch = originalComputerBatch;
  overlaySessionManager.click = originalClick;
  overlaySessionManager.showDrawings = originalShowDrawings;
  overlaySessionManager.clearDrawings = originalClearDrawings;
});

describe('overlayTools', () => {
  test('overlay_read_context returns AX text plus a saved screenshot file mention without inline images', async () => {
    const result = await overlayReadContextTool.handler({}, { agentId: 'agent-1' });

    expect(readContextMock).toHaveBeenCalledWith('agent-1');
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content?.[0]?.type).toBe('text');
    expect(result.content?.[0]?.text).toContain('Interpreter Overlay live context');
    expect(result.content?.[0]?.text).toContain('target_browser_tab_id: 8');
    expect(result.content?.[0]?.text).toContain('target_document_app_specific_id: tab-8');
    expect(result.content?.[0]?.text).toContain('<selected_context>');
    expect(result.content?.[0]?.text).toContain('valid_element_id_source: only ref id values in this selectable_refs block are valid current tool element_id handles; reread context after UI changes');
    expect(result.content?.[0]?.text).toContain('ref_coordinate_space: screen-dip');
    expect(result.content?.[0]?.text).toContain('ref_observed_at: 1000');
    expect(result.content?.[0]?.text).toContain('ref id="field-1" role="textbox" label="Full Name" bounds="x=20 y=40 width=120 height=30"');
    expect(result.content?.[0]?.text).not.toContain('selected_context_snapshot_id');
    expect(result.content?.[0]?.text).toContain('@[Screen region](</tmp/interpreter-overlay/overlay-scope-read.png>)');
    expect(result.content?.[0]?.text).toContain('<window name="Lead form"><button>Save</button></window>');
  });

  test('overlay_read_context returns screenshot-first guidance in vision mode', async () => {
    readContextMock.mockImplementationOnce(async () => ({
      agentMode: 'vision' as const,
      formattedText: '',
      elementCount: 0,
      elements: [],
      screenshotBase64: 'unused-base64',
      screenshotPath: '/tmp/interpreter-overlay/overlay-scope-vision.png',
      captureBoundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
      displayBoundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
    }));

    const result = await overlayReadContextTool.handler({}, { agentId: 'agent-vision' });

    expect(result.isError).toBeUndefined();
    expect(result.content?.[0]?.text).toContain('@[Screen contents](</tmp/interpreter-overlay/overlay-scope-vision.png>)');
    expect(result.content?.[0]?.text).toContain('Vision mode is active. Use the screenshot file reference for the latest screen state.');
  });

  test('overlay_screenshot returns a saved screenshot file mention without inline images', async () => {
    const result = await overlayScreenshotTool.handler({}, { agentId: 'agent-2' });

    expect(screenshotMock).toHaveBeenCalledWith('agent-2');
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content?.[0]?.type).toBe('text');
    expect(result.content?.[0]?.text).toContain('Captured a fresh screenshot of the granted square.');
    expect(result.content?.[0]?.text).toContain('@[Screen contents](</tmp/interpreter-overlay/overlay-scope-shot.png>)');
  });

  test('computer_batch delegates the action list and returns execution summary plus the touched-window diff', async () => {
    const result = await overlayComputerBatchTool.handler({
      actions: [
        {
          seq: 1,
          tool: {
            name: 'type',
            params: {
              element_id: 'field-1',
              element_description: 'Full Name',
              text: 'Jordan Lee',
            },
          },
        },
        {
          seq: 2,
          tool: {
            name: 'type',
            params: {
              element_id: 'field-2',
              element_description: 'Company',
              text: 'Northstar Analytics',
            },
          },
        },
      ],
    }, { agentId: 'agent-3' });

    expect(computerBatchMock).toHaveBeenCalledWith('agent-3', {
      actions: [
        {
          seq: 1,
          tool: {
            name: 'type',
            params: {
              element_id: 'field-1',
              element_description: 'Full Name',
              text: 'Jordan Lee',
            },
          },
        },
        {
          seq: 2,
          tool: {
            name: 'type',
            params: {
              element_id: 'field-2',
              element_description: 'Company',
              text: 'Northstar Analytics',
            },
          },
        },
      ],
    });
    // The batch result carries only per-action outcomes plus the touched-window
    // diff. Full state requires an explicit overlay_read_context call.
    expect(readContextMock.mock.calls.some(([agentId]) => agentId === 'agent-3')).toBe(false);
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content?.[0]?.type).toBe('text');
    const batchResult = JSON.parse(result.content?.[0]?.text ?? '{}');
    expect(batchResult).toMatchObject({
      status: 'completed',
      action_count: 2,
      results: [{
        seq: 1,
        tool: 'selected-target/batch[type,type]',
        action_seqs: [1, 2],
      }],
    });
    const selectedTargetResultText = batchResult.results[0].result.text as string;
    expect(selectedTargetResultText).toContain('computer_batch execution result');
    expect(selectedTargetResultText).toContain('requested_actions: 2');
    expect(selectedTargetResultText).toContain('completed_actions: 2');
    expect(selectedTargetResultText).toContain('All approved computer_batch actions completed without executor errors.');
    expect(selectedTargetResultText).toContain('call overlay_complete next instead of searching outside the granted square');
    expect(selectedTargetResultText).toContain('<touched_window_diff>');
    expect(selectedTargetResultText).toContain('<window_diff window="<window name=\\"Lead form\\">" status="changed">');
    expect(selectedTargetResultText).toContain('- <button>Save</button>');
    expect(selectedTargetResultText).toContain('+ <button>Saved</button>');
    expect(selectedTargetResultText).not.toContain('Interpreter Overlay live context');
  });

  test('computer_batch rejects flat action objects', async () => {
    const result = await overlayComputerBatchTool.handler({
      actions: [
        {
          seq: 1,
          type: 'type',
          element_id: 'field-1',
          text: 'Jordan Lee',
        },
      ],
    }, { agentId: 'agent-flat' });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('computer_batch actions[0] has unknown key "type".');
    expect(computerBatchMock.mock.calls.some(([agentId]) => agentId === 'agent-flat')).toBe(false);
  });

  test('computer_batch schema advertises hotkey params explicitly', () => {
    const actionItems = overlayComputerBatchTool.inputSchema.properties?.actions?.items as {
      oneOf?: Array<{ properties?: { tool?: { properties?: { name?: unknown; params?: { properties?: Record<string, unknown> } } } } }>;
    };
    const variants = actionItems.oneOf ?? [];
    const hotkeyVariant = variants.find((variant) => {
      const name = variant.properties?.tool?.properties?.name as { enum?: string[] } | undefined;
      return name?.enum?.includes('hotkey');
    });

    expect(hotkeyVariant?.properties?.tool?.properties?.params?.properties).toHaveProperty('hotkey');
    expect(hotkeyVariant?.properties?.tool?.properties?.params?.properties).not.toHaveProperty('key');
  });

  test('computer_batch schema advertises the unified normal Interpreter tool action', () => {
    const actionItems = overlayComputerBatchTool.inputSchema.properties?.actions?.items as {
      oneOf?: Array<{
        properties?: Record<string, unknown>;
        required?: string[];
      }>;
    };
    const normalToolVariant = (actionItems.oneOf ?? []).find((variant) => (
      variant.required?.includes('server_id')
      && variant.required.includes('tool_name')
      && variant.required.includes('arguments')
    ));

    expect(normalToolVariant?.required).toEqual([
      'seq',
      'server_id',
      'tool_name',
      'arguments',
    ]);
    expect(normalToolVariant?.properties).toHaveProperty('server_id');
    expect(normalToolVariant?.properties).toHaveProperty('tool_name');
    expect(normalToolVariant?.properties).toHaveProperty('arguments');
  });

  test('computer_batch schema describes clear_first as the text replacement primitive', () => {
    const actionItems = overlayComputerBatchTool.inputSchema.properties?.actions?.items as {
      oneOf?: Array<{ properties?: { tool?: { properties?: { name?: unknown; params?: { properties?: Record<string, { description?: string }> } } } } }>;
    };
    const typeVariant = (actionItems.oneOf ?? []).find((variant) => {
      const name = variant.properties?.tool?.properties?.name as { enum?: string[] } | undefined;
      return name?.enum?.includes('type');
    });

    const clearFirst = typeVariant?.properties?.tool?.properties?.params?.properties?.clear_first;
    expect(clearFirst?.description).toContain('replacing or setting the final value of a text field');
    expect(clearFirst?.description).toContain('Do not emulate replacement');
  });

  test('overlay_show_drawings parses screen-DIP annotations and does not refresh context', async () => {
    const result = await overlayShowDrawingsTool.handler({
      annotations: [{
        id: 'callout-1',
        label: 'Submit button',
        x: 520,
        y: 650,
        width: 92,
        height: 36,
      }],
    }, { agentId: 'agent-draw' });

    expect(showDrawingsMock).toHaveBeenCalledWith('agent-draw', {
      annotations: [{
        id: 'callout-1',
        label: 'Submit button',
        bounds: { x: 520, y: 650, width: 92, height: 36 },
      }],
    });
    expect(readContextMock.mock.calls.some(([agentId]) => agentId === 'agent-draw')).toBe(false);
    expect(result.isError).toBeUndefined();
    expect(result.content?.[0]?.text).toBe('Showing 1 overlay drawing.');
  });

  test('overlay_show_drawings rejects zero-size annotations', async () => {
    const result = await overlayShowDrawingsTool.handler({
      annotations: [{
        x: 10,
        y: 20,
        width: 0,
        height: 30,
      }],
    }, { agentId: 'agent-bad-draw' });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('width and overlay_show_drawings annotations[0].height must be greater than zero.');
    expect(showDrawingsMock.mock.calls.some(([agentId]) => agentId === 'agent-bad-draw')).toBe(false);
  });

  test('overlay_clear_drawings delegates without refreshing context', async () => {
    const result = await overlayClearDrawingsTool.handler({}, { agentId: 'agent-clear-draw' });

    expect(clearDrawingsMock).toHaveBeenCalledWith('agent-clear-draw');
    expect(readContextMock.mock.calls.some(([agentId]) => agentId === 'agent-clear-draw')).toBe(false);
    expect(result.isError).toBeUndefined();
    expect(result.content?.[0]?.text).toBe('Cleared overlay drawings.');
  });

  test('overlay_click forwards current element refs without snapshot metadata', async () => {
    const result = await overlayClickTool.handler({
      element_id: 'field-1',
      element_description: 'Full Name',
    }, { agentId: 'agent-click' });

    expect(clickMock).toHaveBeenCalledWith('agent-click', {
      element_id: 'field-1',
      element_description: 'Full Name',
      x: undefined,
      y: undefined,
    });
    expect(result.isError).toBeUndefined();
  });
});
