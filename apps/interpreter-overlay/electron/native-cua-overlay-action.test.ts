import { describe, expect, test } from 'bun:test';

import type { OverlaySessionRecord } from '../../../server/overlaySessionManager';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../shared/target-identity';
import {
  buildNativeCuaAppWindowScrollToolCallForTarget,
  buildNativeCuaAppWindowTypeTextToolCallForTarget,
  buildNativeCuaOverlayClickToolCall,
  buildNativeCuaOverlayScrollToolCall,
  buildNativeCuaOverlayTypeToolCall,
  buildNativeCuaPointClickToolCallForTarget,
  buildNativeCuaPressKeyToolCallForTarget,
  buildNativeCuaScrollToolCallForTarget,
  buildNativeCuaSelectOptionToolCallForTarget,
} from './native-cua-overlay-action';

function sessionWithNativeCuaRef(): OverlaySessionRecord {
  const targetIdentity = buildOverlayTargetIdentity({
    kind: 'screen-region',
    bounds: { x: 10, y: 20, width: 300, height: 200 },
    display: {
      id: 'display-1',
      boundsDIP: { x: 0, y: 0, width: 1000, height: 800 },
      scaleFactor: 2,
    },
    generation: 1,
    now: 1000,
  });
  const latestContext = {
    agentMode: 'ax' as const,
    formattedText: '',
    elementCount: 1,
    elements: [],
    targetIdentity,
    currentSelectionContext: buildCurrentSelectionContext({
      targetIdentity,
      selectableRefs: [{
        id: 'element_index:7',
        role: 'AXTextField',
        label: 'Name',
        bounds: { x: 20, y: 30, width: 120, height: 24 },
        nativeCua: {
          app: 'Notes',
          elementIndex: 7,
          targetIdentity: {
            kind: 'app-window',
            app: { name: 'Notes', pid: 123 },
            window: { native_window_id: 456, title: 'Draft' },
          },
        },
      }, {
        id: 'element_index:9',
        role: 'AXPopUpButton',
        label: 'Department',
        bounds: { x: 20, y: 70, width: 140, height: 24 },
        nativeCua: {
          app: 'Notes',
          elementIndex: 9,
          targetIdentity: {
            kind: 'app-window',
            app: { name: 'Notes', pid: 123 },
            window: { native_window_id: 456, title: 'Draft' },
          },
        },
      }, {
        id: 'plain-ax-ref',
        role: 'AXButton',
        label: 'Save',
        bounds: { x: 40, y: 80, width: 80, height: 30 },
      }],
    }),
  };

  return {
    id: 'overlay-session-1',
    agentId: 'overlay-agent-1',
    callerToken: 'caller-token',
    workspacePath: '/workspace',
    windowSessionKey: 'window-session-1',
    displayId: 'display-1',
    scopeBoundsDIP: { x: 10, y: 20, width: 300, height: 200 },
    createdAt: 1000,
    updatedAt: 1000,
    status: 'active',
    initialContext: latestContext,
    latestContext,
  };
}

describe('native CUA overlay action mapping', () => {
  test('maps native point clicks to CUA driver target-identity calls', () => {
    expect(buildNativeCuaPointClickToolCallForTarget({
      app: 'Notes',
      x: 200,
      y: 135,
      targetIdentity: {
        kind: 'app-window',
        app: { name: 'Notes', pid: 123 },
        window: { native_window_id: 456 },
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      },
    })).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'click',
      args: {
        app: 'Notes',
        x: 200,
        y: 135,
        target_identity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456 },
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        },
        skip_change_detection: true,
      },
    });
  });

  test('maps native app-window hotkeys to CUA driver press_key calls', () => {
    expect(buildNativeCuaPressKeyToolCallForTarget({
      app: 'Notes',
      targetIdentity: {
        kind: 'app-window',
        app: { name: 'Notes', pid: 123 },
        window: { native_window_id: 456 },
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      },
    }, 'cmd+a')).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'press_key',
      args: {
        app: 'Notes',
        key: 'cmd+a',
        target_identity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456 },
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        },
        skip_change_detection: true,
      },
    });
  });

  test('maps native app-window focused typing to CUA driver type_text calls', () => {
    expect(buildNativeCuaAppWindowTypeTextToolCallForTarget({
      app: 'Notes',
      targetIdentity: {
        kind: 'app-window',
        app: { name: 'Notes', pid: 123 },
        window: { native_window_id: 456 },
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      },
    }, 'hello')).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'type_text',
      args: {
        app: 'Notes',
        text: 'hello',
        target_identity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456 },
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        },
        skip_change_detection: true,
      },
    });
  });

  test('maps native app-window scrolls to CUA driver scroll calls', () => {
    expect(buildNativeCuaAppWindowScrollToolCallForTarget({
      app: 'Notes',
      targetIdentity: {
        kind: 'app-window',
        app: { name: 'Notes', pid: 123 },
        window: { native_window_id: 456 },
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      },
    }, 'down', 2)).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'scroll',
      args: {
        app: 'Notes',
        direction: 'down',
        pages: 2,
        target_identity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456 },
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        },
        skip_change_detection: true,
      },
    });
  });

  test('maps native selected click refs to CUA driver target-identity calls', () => {
    expect(buildNativeCuaOverlayClickToolCall(sessionWithNativeCuaRef(), {
      element_id: 'element_index:7',
    })).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'click',
      args: {
        app: 'Notes',
        element_index: '7',
        target_identity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456, title: 'Draft' },
        },
        skip_change_detection: true,
      },
    });
  });

  test('does not map plain AX refs', () => {
    const session = sessionWithNativeCuaRef();
    expect(buildNativeCuaOverlayClickToolCall(session, {
      element_id: 'plain-ax-ref',
    })).toBeNull();
    expect(buildNativeCuaOverlayTypeToolCall(session, {
      element_id: 'plain-ax-ref',
      text: 'Ada',
    })).toBeNull();
    expect(buildNativeCuaOverlayScrollToolCall(session, {
      element_id: 'plain-ax-ref',
      direction: 'down',
    })).toBeNull();
  });

  test('maps non-replacement typing to CUA type_text', () => {
    expect(buildNativeCuaOverlayTypeToolCall(sessionWithNativeCuaRef(), {
      element_id: 'element_index:7',
      text: 'Ada',
    })).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'type_text',
      args: {
        app: 'Notes',
        element_index: '7',
        target_identity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456, title: 'Draft' },
        },
        text: 'Ada',
        skip_change_detection: true,
      },
    });
  });

  test('maps clear-first typing to CUA set_value', () => {
    expect(buildNativeCuaOverlayTypeToolCall(sessionWithNativeCuaRef(), {
      element_id: 'element_index:7',
      text: 'Ada',
      clear_first: true,
    })).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'set_value',
      args: {
        app: 'Notes',
        element_index: '7',
        target_identity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456, title: 'Draft' },
        },
        value: 'Ada',
        skip_change_detection: true,
      },
    });
  });

  test('maps dropdown typing to CUA select_option', () => {
    expect(buildNativeCuaOverlayTypeToolCall(sessionWithNativeCuaRef(), {
      element_id: 'element_index:9',
      text: 'Revenue Operations',
      clear_first: true,
    })).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'select_option',
      args: {
        app: 'Notes',
        element_index: '9',
        target_identity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456, title: 'Draft' },
        },
        option: 'Revenue Operations',
        skip_change_detection: true,
      },
    });
  });

  test('builds native selected dropdown calls with CUA select_option', () => {
    expect(buildNativeCuaSelectOptionToolCallForTarget({
      app: 'Notes',
      elementIndex: 7,
      targetIdentity: {
        kind: 'app-window',
        app: { name: 'Notes', pid: 123 },
        window: { native_window_id: 456, title: 'Draft' },
      },
    }, 'Revenue Operations')).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'select_option',
      args: {
        app: 'Notes',
        element_index: '7',
        target_identity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456, title: 'Draft' },
        },
        option: 'Revenue Operations',
        skip_change_detection: true,
      },
    });
  });

  test('builds native selected scroll calls with CUA scroll', () => {
    expect(buildNativeCuaScrollToolCallForTarget({
      app: 'Notes',
      elementIndex: 7,
      targetIdentity: {
        kind: 'app-window',
        app: { name: 'Notes', pid: 123 },
        window: { native_window_id: 456, title: 'Draft' },
      },
    }, 'down', 2)).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'scroll',
      args: {
        app: 'Notes',
        element_index: '7',
        target_identity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456, title: 'Draft' },
        },
        direction: 'down',
        pages: 2,
        skip_change_detection: true,
      },
    });
  });

  test('maps native selected scroll refs to CUA driver target-identity calls', () => {
    expect(buildNativeCuaOverlayScrollToolCall(sessionWithNativeCuaRef(), {
      element_id: 'element_index:7',
      direction: 'down',
      amount: 2,
    })).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'scroll',
      args: {
        app: 'Notes',
        element_index: '7',
        target_identity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456, title: 'Draft' },
        },
        direction: 'down',
        pages: 2,
        skip_change_detection: true,
      },
    });
  });
});
