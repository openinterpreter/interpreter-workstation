import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { UnboundCliApprovals } from './UnboundCliApprovals';
import { resetApprovalsStoreForTests, setApprovalsStoreClientForTests } from '../stores/approvalsStore';

const windowKey = vi.hoisted(() => ({ value: 'owner-window' as string | null }));
vi.mock('../ipc', () => ({
  getWindowSessionKey: () => windowKey.value,
  approvals: { get: vi.fn(async () => ({ approvals: [] })), onListChanged: vi.fn(() => () => {}) },
}));
vi.mock('../hooks/useLayout', () => ({ useLayout: () => ({ state: { tabs: {} } }) }));
vi.mock('./Approvals', () => ({ Approvals: () => <div>Existing approval responder</div> }));

const approval = (id: string, ownerWindow: string | null) => ({
  id, toolName: 'test:action', serverId: 'test', questions: [], timestamp: 1,
  owner: { approvalOwnerKind: 'cli' as const, capturedAt: 1, displayName: 'CLI', color: '#000',
    identity: { agentId: null, windowSessionKey: ownerWindow, workspacePath: '/workspace' } },
});

afterEach(() => { resetApprovalsStoreForTests(); windowKey.value = 'owner-window'; });

describe('unbound CLI approval inbox', () => {
  test('shows only an approval captured by this window; does not render another window or unowned request', async () => {
    setApprovalsStoreClientForTests({
      get: vi.fn(async () => ({ approvals: [approval('other', 'other-window'), approval('missing', null), approval('owned', 'owner-window')] })),
      onListChanged: vi.fn(() => () => {}),
    } as any);
    render(<UnboundCliApprovals />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Interpreter CLI approvals' })).toBeTruthy());
    expect(screen.getByText('Existing approval responder')).toBeTruthy();
  });

  test('does not guess a window identity', async () => {
    windowKey.value = null;
    setApprovalsStoreClientForTests({ get: vi.fn(async () => ({ approvals: [approval('unbound', null)] })), onListChanged: vi.fn(() => () => {}) } as any);
    render(<UnboundCliApprovals />);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Interpreter CLI approvals' })).toBeNull());
  });
});
