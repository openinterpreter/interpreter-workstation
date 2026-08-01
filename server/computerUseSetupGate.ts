import { randomUUID } from 'node:crypto';

type ComputerUsePermissionStatus = {
  accessibilityGranted: boolean;
  screenRecordingGranted: boolean;
  screenRecordingStatus?: string;
};

const waiters = new Set<() => void>();
const statusWaiters = new Map<string, {
  resolve: (status: ComputerUsePermissionStatus) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

export function markComputerUseSetupReady(): void {
  for (const resolve of waiters) {
    resolve();
  }
  waiters.clear();
}

export async function waitForComputerUseSetupReady(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(resolveReady);
      reject(new Error('Timed out waiting for Computer Use Setup to finish.'));
    }, timeoutMs);

    function resolveReady() {
      clearTimeout(timeout);
      waiters.delete(resolveReady);
      resolve();
    }

    waiters.add(resolveReady);
  });
}

export function createComputerUsePermissionStatusRequest(timeoutMs: number): {
  requestId: string;
  promise: Promise<ComputerUsePermissionStatus>;
} {
  const requestId = randomUUID();
  const promise = new Promise<ComputerUsePermissionStatus>((resolve, reject) => {
    const timeout = setTimeout(() => {
      statusWaiters.delete(requestId);
      reject(new Error('Timed out waiting for Computer Use permission status.'));
    }, timeoutMs);
    statusWaiters.set(requestId, { resolve, reject, timeout });
  });
  return { requestId, promise };
}

export function resolveComputerUsePermissionStatusRequest(
  requestId: string,
  status: ComputerUsePermissionStatus,
): void {
  const waiter = statusWaiters.get(requestId);
  if (!waiter) return;
  clearTimeout(waiter.timeout);
  statusWaiters.delete(requestId);
  waiter.resolve(status);
}
