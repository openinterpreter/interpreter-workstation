import { beforeEach, describe, expect, mock, test } from 'bun:test';

const approvalChannelListeners = new Set<(event: { approvals: any[] }) => void>();

const getMock = mock(() => Promise.resolve({ approvals: [] }));
const onListChangedMock = mock((callback: (event: { approvals: any[] }) => void) => {
  approvalChannelListeners.add(callback);
  return () => {
    approvalChannelListeners.delete(callback);
  };
});

const approvalsStore = await import('./approvalsStore');

function makeApproval(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    toolName: 'view_image',
    serverId: 'main-agent-server',
    questions: [],
    timestamp: 1,
    ...overrides,
  };
}

describe('approvalsStore', () => {
  beforeEach(() => {
    approvalsStore.resetApprovalsStoreForTests();
    approvalsStore.setApprovalsStoreClientForTests({
      get: getMock as any,
      onListChanged: onListChangedMock as any,
    });
    approvalChannelListeners.clear();
    getMock.mockClear();
    onListChangedMock.mockClear();
  });

  test('shares one IPC approval listener across multiple subscribers', async () => {
    const unsubscribeOne = approvalsStore.subscribeApprovals(() => {});
    const unsubscribeTwo = approvalsStore.subscribeApprovals(() => {});

    expect(onListChangedMock).toHaveBeenCalledTimes(1);
    expect(approvalChannelListeners.size).toBe(1);

    unsubscribeOne();
    expect(approvalChannelListeners.size).toBe(1);

    unsubscribeTwo();
    expect(approvalChannelListeners.size).toBe(0);
  });

  test('updates the shared snapshot from approval list change events', () => {
    approvalsStore.subscribeApprovals(() => {});

    const listener = approvalChannelListeners.values().next().value;
    listener({ approvals: [makeApproval('approval-1')] });

    expect(approvalsStore.getApprovalsSnapshot()).toEqual([makeApproval('approval-1')]);
  });

  test('replaces revised permission cards from list change events', () => {
    approvalsStore.subscribeApprovals(() => {});

    const listener = approvalChannelListeners.values().next().value;
    listener({
      approvals: [
        makeApproval('approval-presidents-4', {
          replacementKey: 'presidents-preview',
          context: {
            message: 'Show me the last 4 presidents.',
            permissionCard: {
              version: 1,
              blocks: [
                { type: 'text', text: 'Showing 4 president cards.' },
              ],
            },
          },
        }),
      ],
    });
    listener({
      approvals: [
        makeApproval('approval-presidents-5', {
          replacementKey: 'presidents-preview',
          context: {
            message: 'Show me the last 5 presidents.',
            permissionCard: {
              version: 1,
              blocks: [
                { type: 'text', text: 'Showing 5 president cards.' },
              ],
            },
          },
        }),
      ],
    });

    expect(approvalsStore.getApprovalsSnapshot()).toEqual([
      makeApproval('approval-presidents-5', {
        replacementKey: 'presidents-preview',
        context: {
          message: 'Show me the last 5 presidents.',
          permissionCard: {
            version: 1,
            blocks: [
              { type: 'text', text: 'Showing 5 president cards.' },
            ],
          },
        },
      }),
    ]);
    expect(JSON.stringify(approvalsStore.getApprovalsSnapshot())).not.toContain('last 4 presidents');
  });

  test('replays the current snapshot immediately to new subscribers', () => {
    approvalsStore.subscribeApprovals(() => {});

    const listener = approvalChannelListeners.values().next().value;
    listener({ approvals: [makeApproval('approval-1')] });

    const syncListener = mock(() => {});
    approvalsStore.subscribeApprovals(syncListener);

    expect(syncListener).toHaveBeenCalledTimes(1);
    expect(approvalsStore.getApprovalsSnapshot()).toEqual([makeApproval('approval-1')]);
  });

  test('deduplicates concurrent approval refreshes', async () => {
    getMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      return { approvals: [makeApproval('approval-2')] };
    });

    await Promise.all([
      approvalsStore.refreshApprovals(),
      approvalsStore.refreshApprovals(),
    ]);

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(approvalsStore.getApprovalsSnapshot()).toEqual([makeApproval('approval-2')]);
  });
});
