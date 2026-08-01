import { describe, expect, test } from 'bun:test';

import type { OverlaySessionRecord } from '../../../server/overlaySessionManager';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../shared/target-identity';
import type { BrowserPageElementTarget } from '../shared/ports';
import {
  buildBrowserPageClickToolCallForTarget,
  buildBrowserPageOverlayClickToolCall,
  buildBrowserPageOverlayScrollToolCall,
  buildBrowserPageSelectToolCallForTarget,
  buildBrowserPageScrollToolCallForTarget,
  buildBrowserPageTypeToolCallForTarget,
} from './browser-page-overlay-action';

const target: BrowserPageElementTarget = {
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

function sessionWithBrowserRef(): OverlaySessionRecord {
  const overlayTargetIdentity = buildOverlayTargetIdentity({
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
    targetIdentity: overlayTargetIdentity,
    currentSelectionContext: buildCurrentSelectionContext({
      targetIdentity: overlayTargetIdentity,
      selectableRefs: [{
        id: target.refId,
        role: 'button',
        label: 'Submit',
        bounds: { x: 20, y: 30, width: 120, height: 24 },
        browser: {
          tabRef: 'install:profile-1:chrome-tab:12',
          chromeTabId: 12,
          browserWindowId: 7,
          frameId: 0,
          chromeDocumentId: 'doc-1',
          refId: target.refId,
          browserProfilePolicyId: 'install:profile-1',
          documentRevision: 'rev-1',
          origin: 'https://example.test',
          url: 'https://example.test/form',
          targetIdentity: target.targetIdentity,
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

describe('browser page overlay action mapping', () => {
  test('maps browser selected click refs to browser page tool calls', () => {
    expect(buildBrowserPageClickToolCallForTarget(target)).toEqual({
      serverId: 'builtin-interpreter',
      toolName: 'interpreter_browser_page_click',
      args: {
        target_identity: target.targetIdentity,
        ref_id: 'browser-element:rev-1:0',
      },
    });
  });

  test('maps browser selected typing refs to browser page tool calls', () => {
    expect(buildBrowserPageTypeToolCallForTarget(target, 'Ada')).toEqual({
      serverId: 'builtin-interpreter',
      toolName: 'interpreter_browser_page_type',
      args: {
        target_identity: target.targetIdentity,
        ref_id: 'browser-element:rev-1:0',
        text: 'Ada',
      },
    });
  });

  test('maps browser selected select refs to browser page tool calls', () => {
    expect(buildBrowserPageSelectToolCallForTarget(target, 'support')).toEqual({
      serverId: 'builtin-interpreter',
      toolName: 'interpreter_browser_page_select',
      args: {
        target_identity: target.targetIdentity,
        ref_id: 'browser-element:rev-1:0',
        value: 'support',
      },
    });
  });

  test('maps browser selected scroll refs to browser page tool calls', () => {
    expect(buildBrowserPageScrollToolCallForTarget(target, 'down', 3)).toEqual({
      serverId: 'builtin-interpreter',
      toolName: 'interpreter_browser_page_scroll',
      args: {
        target_identity: target.targetIdentity,
        ref_id: 'browser-element:rev-1:0',
        delta_x: 0,
        delta_y: 360,
      },
    });
  });

  test('maps selected browser click refs from overlay sessions to browser page tool calls', () => {
    expect(buildBrowserPageOverlayClickToolCall(sessionWithBrowserRef(), {
      element_id: target.refId,
    })).toEqual({
      serverId: 'builtin-interpreter',
      toolName: 'interpreter_browser_page_click',
      args: {
        target_identity: target.targetIdentity,
        ref_id: target.refId,
      },
    });
  });

  test('maps selected browser scroll refs from overlay sessions to browser page tool calls', () => {
    expect(buildBrowserPageOverlayScrollToolCall(sessionWithBrowserRef(), {
      element_id: target.refId,
      direction: 'up',
      amount: 2,
    })).toEqual({
      serverId: 'builtin-interpreter',
      toolName: 'interpreter_browser_page_scroll',
      args: {
        target_identity: target.targetIdentity,
        ref_id: target.refId,
        delta_x: 0,
        delta_y: -240,
      },
    });
  });

  test('does not map plain AX refs to browser page tool calls', () => {
    const session = sessionWithBrowserRef();
    expect(buildBrowserPageOverlayClickToolCall(session, {
      element_id: 'plain-ax-ref',
    })).toBeNull();
    expect(buildBrowserPageOverlayScrollToolCall(session, {
      element_id: 'plain-ax-ref',
      direction: 'down',
    })).toBeNull();
  });
});
