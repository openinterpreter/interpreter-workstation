import { afterEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { agentTabManager } from '../agentTabManager';
import { getPendingRequests } from './agentTabs';

afterEach(() => {
  agentTabManager.clearAll();
});

describe('agentTabs handlers', () => {
  test('returns pending requests in the transport contract used by both Electron and browser mode', async () => {
    const created = agentTabManager.requestAgentTask({
      agentId: 'agent-pending-shape',
      callerToken: 'agtok_pending_shape',
      initialMessage: 'Open the agent tab',
      completionDisposition: 'keep_open',
    });

    const result = await getPendingRequests();

    assert.deepEqual(Object.keys(result), ['requests']);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0]?.requestId, created.requestId);
    assert.equal(result.requests[0]?.agentId, 'agent-pending-shape');
  });
});
