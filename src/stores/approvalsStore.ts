import { approvals as approvalsIpc } from '@/ipc';
import type { ApprovalGetResponse, ApprovalListChangedEvent } from '../../electron/ipc/registry';
import type { QuestionRequest } from '../../shared/types/approval';

// NOTE(approval-flow): Renderer approval surfaces are views over the server-owned
// `ApprovalManager` queue. This store performs the initial `get` and then tracks
// `approvals:list-changed`; resolution still goes back through IPC/HTTP to
// `approvalManager.respond()`.

type Listener = () => void;
type ApprovalsClient = Pick<typeof approvalsIpc, 'get' | 'onListChanged'>;

let approvals: QuestionRequest[] = [];
let listeners = new Set<Listener>();
let ipcUnsubscribe: (() => void) | null = null;
let inflightRefresh: Promise<void> | null = null;
let approvalsClient: ApprovalsClient = approvalsIpc;

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setApprovals(nextApprovals: QuestionRequest[]): void {
  approvals = nextApprovals;
  emitChange();
}

function ensureIpcSubscription(): void {
  if (ipcUnsubscribe) {
    return;
  }

  ipcUnsubscribe = approvalsClient.onListChanged((event: ApprovalListChangedEvent) => {
    setApprovals(event.approvals);
  });
}

function maybeDisposeIpcSubscription(): void {
  if (listeners.size > 0 || !ipcUnsubscribe) {
    return;
  }

  ipcUnsubscribe();
  ipcUnsubscribe = null;
}

export function getApprovalsSnapshot(): QuestionRequest[] {
  return approvals;
}

export function subscribeApprovals(listener: Listener): () => void {
  listeners.add(listener);
  ensureIpcSubscription();
  listener();

  return () => {
    listeners.delete(listener);
    maybeDisposeIpcSubscription();
  };
}

export async function refreshApprovals(): Promise<void> {
  if (inflightRefresh) {
    return inflightRefresh;
  }

  const request = approvalsClient.get({})
    .then((response: ApprovalGetResponse) => {
      setApprovals(response.approvals);
    })
    .finally(() => {
      inflightRefresh = null;
    });

  inflightRefresh = request;
  return request;
}

export function setApprovalsStoreClientForTests(client: ApprovalsClient | null): void {
  approvalsClient = client ?? approvalsIpc;
}

export function resetApprovalsStoreForTests(): void {
  ipcUnsubscribe?.();
  ipcUnsubscribe = null;
  inflightRefresh = null;
  approvals = [];
  listeners = new Set<Listener>();
  approvalsClient = approvalsIpc;
}
