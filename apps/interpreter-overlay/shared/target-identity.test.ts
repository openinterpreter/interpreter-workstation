import { describe, expect, test } from 'bun:test';

import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from './target-identity';

describe('overlay target identity', () => {
  test('normalizes browser, document, ref invalidation, and selectable ref metadata', () => {
    const targetIdentity = buildOverlayTargetIdentity({
      kind: 'active-app',
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
      appBundlePath: '/Applications/Google Chrome.app',
      browser: {
        profileId: 'profile-1',
        windowId: 7,
        tabId: 8,
        frameId: 'main',
        url: 'https://example.test/form',
        title: 'Example form',
        documentRevision: 'rev-1',
      },
      document: {
        id: 'doc-1',
        title: 'Example form',
        url: 'https://example.test/form',
        filePath: null,
        appSpecificId: 'tab-8',
      },
      refInvalidation: {
        staleAfterMs: 30_000,
        rules: ['custom_rule'],
      },
      generation: 5,
      now: 1234,
    });

    const snapshot = buildCurrentSelectionContext({
      targetIdentity,
      selectableRefs: [{
        id: 'element-1',
        role: 'button',
        label: 'Submit',
        bounds: { x: 20, y: 40, width: 100, height: 32 },
        browser: {
          tabRef: 'install:profile-1:chrome-tab:8',
          chromeTabId: 8,
          frameId: 0,
          refId: 'browser-element:rev-1:0',
          browserProfilePolicyId: 'install:profile-1',
          documentRevision: 'rev-1',
          origin: 'https://example.test',
          url: 'https://example.test/form',
        },
      }],
    });

    expect(targetIdentity.browser?.tabId).toBe(8);
    expect(targetIdentity.document?.appSpecificId).toBe('tab-8');
    expect(targetIdentity.refInvalidation).toEqual({
      staleAfterMs: 30_000,
      rules: ['custom_rule'],
    });
    expect(snapshot.selectableRefs[0]).toMatchObject({
      id: 'element-1',
      observedAt: 1234,
      coordinateSpace: 'screen-dip',
      displayId: 'display-1',
      scaleFactor: 2,
      browser: {
        tabRef: 'install:profile-1:chrome-tab:8',
        chromeTabId: 8,
        frameId: 0,
        refId: 'browser-element:rev-1:0',
        browserProfilePolicyId: 'install:profile-1',
        documentRevision: 'rev-1',
        origin: 'https://example.test',
        url: 'https://example.test/form',
      },
    });

    targetIdentity.refInvalidation.rules.push('mutated_after_snapshot');
    expect(snapshot.targetIdentity.refInvalidation.rules).toEqual(['custom_rule']);
  });
});
