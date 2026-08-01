import { describe, expect, test } from 'bun:test';
import {
  loadCuaRegionSelectionElements,
  parseCuaUiElementsResponseForTest,
  type OverlayCuaRegionCallTool,
} from './cua-region-selection';

const sampleResponse = [
  'CUA UI elements (coordinate_space=screen_points)',
  'Target: app="Notes" pid=123 window_id=456',
  '<ui_elements>',
  'ref=element_index:7 element_index=7 role=AXTextField bounds={x=130, y=240, width=180, height=30, coordinate_space=screen_points} raw="- [7] AXTextField bounds={x=130, y=240, width=180, height=30, coordinate_space=screen_points}"',
  'ref=element_index:8 element_index=8 role=AXButton bounds={x=900, y=900, width=100, height=30, coordinate_space=screen_points} raw="- [8] AXButton bounds={x=900, y=900, width=100, height=30, coordinate_space=screen_points}"',
  '</ui_elements>',
].join('\n');

describe('CUA region selection', () => {
  test('parses explicit get_ui_elements refs without inferring labels', () => {
    expect(parseCuaUiElementsResponseForTest(sampleResponse)).toEqual([
      {
        elementIndex: 7,
        role: 'AXTextField',
        bounds: { x: 130, y: 240, width: 180, height: 30 },
        label: '- [7] AXTextField bounds={x=130, y=240, width=180, height=30, coordinate_space=screen_points}',
      },
      {
        elementIndex: 8,
        role: 'AXButton',
        bounds: { x: 900, y: 900, width: 100, height: 30 },
        label: '- [8] AXButton bounds={x=900, y=900, width=100, height=30, coordinate_space=screen_points}',
      },
    ]);
  });

  test('calls CUA get_ui_elements and converts screen bounds to display-local overlay refs', async () => {
    const calls: Parameters<OverlayCuaRegionCallTool>[] = [];
    const callTool: OverlayCuaRegionCallTool = async (...args) => {
      calls.push(args);
      return {
        content: [{ type: 'text', text: sampleResponse }],
      };
    };

    await expect(loadCuaRegionSelectionElements({
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: null,
      appName: 'Notes',
      targetIdentity: {
        kind: 'app-window',
        app: { name: 'Notes', pid: 123 },
        window: { native_window_id: 456, title: 'Draft' },
      },
      regionBounds: { x: 120, y: 230, width: 300, height: 200 },
      display: {
        id: 'display-1',
        scaleFactor: 2,
        boundsDIP: { x: 100, y: 200, width: 500, height: 400 },
      },
      callTool,
    })).resolves.toEqual([
      {
        id: 'element_index:7',
        role: 'AXTextField',
        label: '- [7] AXTextField bounds={x=130, y=240, width=180, height=30, coordinate_space=screen_points}',
        bounds: { x: 30, y: 40, width: 180, height: 30 },
        nativeCua: {
          app: 'Notes',
          elementIndex: 7,
          targetIdentity: {
            kind: 'app-window',
            app: { name: 'Notes', pid: 123 },
            window: { native_window_id: 456, title: 'Draft' },
          },
        },
      },
    ]);

    expect(calls).toEqual([
      [
        'builtin-cua-driver',
        'get_ui_elements',
        {
          app: 'Notes',
          x: 120,
          y: 230,
          width: 300,
          height: 200,
          target_identity: {
            kind: 'app-window',
            app: { name: 'Notes', pid: 123 },
            window: { native_window_id: 456, title: 'Draft' },
          },
        },
        undefined,
        {
          callerTabId: 'overlay-agent-1',
          workspace: '/workspace',
        },
        { includeHiddenBuiltins: true },
      ],
    ]);
  });

  test('fails loudly when the CUA ref block format changes', () => {
    expect(() => parseCuaUiElementsResponseForTest('Target: app="Notes"')).toThrow(
      'CUA get_ui_elements output missing <ui_elements> block.',
    );
  });
});
