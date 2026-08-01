import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { BrowserControlStatus } from '../../shared/types/browserControl';
import { getBrowserSplitOfferTarget } from './browserSplitOffer';

function status(activeSessions: number, controlSource?: 'user' | 'agent-created' | 'auto-created'): BrowserControlStatus {
  return {
    relay: {
      phase: 'ready',
      version: null,
      runtimeDir: null,
      relayLogPath: null,
      relayCdpLogPath: null,
      ownsRelayProcess: true,
      lastError: null,
      reachable: true,
      endpoint: 'http://127.0.0.1:19988',
    },
    connectedBrowsers: activeSessions > 0 ? 1 : 0,
    activeSessions,
    profiles: [],
    connections: activeSessions > 0
      ? [{
          extensionId: 'extension-1',
          stableKey: 'stable-1',
          profileId: 'stable-1',
          browserName: 'Chrome',
          version: '1.0.0',
          activeSessions,
          targets: [{
            tabRef: 'stable-1:target-1',
            targetId: 'target-1',
            type: 'page',
            title: 'Browser page',
            url: 'https://example.com',
            controlSource,
          }],
          browserWindows: [],
          focusedWindowId: null,
          activeTabRef: null,
          focusedWindow: null,
          activeTab: null,
        }]
      : [],
  };
}

describe('getBrowserSplitOfferTarget', () => {
  test('does not offer on initial status hydration', () => {
    assert.equal(getBrowserSplitOfferTarget(null, status(1, 'user')), null);
  });

  test('offers when a user-controlled target moves active sessions from zero to one', () => {
    assert.deepEqual(getBrowserSplitOfferTarget(0, status(1, 'user')), {
      extensionId: 'extension-1',
      targetId: 'target-1',
      title: 'Browser page',
      url: 'https://example.com',
      browserName: 'Chrome',
    });
  });

  test('does not offer for agent-created tabs', () => {
    assert.equal(getBrowserSplitOfferTarget(0, status(1, 'agent-created')), null);
  });

  test('does not offer for auto-created tabs', () => {
    assert.equal(getBrowserSplitOfferTarget(0, status(1, 'auto-created')), null);
  });

  test('does not offer when active sessions were already present', () => {
    assert.equal(getBrowserSplitOfferTarget(1, status(2, 'user')), null);
  });

  test('does not offer when active sessions jump past the first controlled tab', () => {
    assert.equal(getBrowserSplitOfferTarget(0, status(2, 'user')), null);
  });

  test('does not offer when there are still no active sessions', () => {
    assert.equal(getBrowserSplitOfferTarget(0, status(0)), null);
  });
});
