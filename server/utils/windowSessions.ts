import { AsyncLocalStorage } from 'node:async_hooks';

export interface WindowSessionRecord {
  sessionKey: string;
  windowId: number;
  workspacePath: string | null;
  createdAt: number;
}

const sessionsByKey = new Map<string, WindowSessionRecord>();
const sessionKeyByWindowId = new Map<number, string>();
const windowSessionStorage = new AsyncLocalStorage<{ sessionKey: string | null }>();

export function registerWindowSession(input: {
  sessionKey: string;
  windowId: number;
  workspacePath: string | null;
}): WindowSessionRecord {
  const existingSessionKey = sessionKeyByWindowId.get(input.windowId);
  if (existingSessionKey && existingSessionKey !== input.sessionKey) {
    sessionsByKey.delete(existingSessionKey);
  }

  const nextRecord: WindowSessionRecord = {
    sessionKey: input.sessionKey,
    windowId: input.windowId,
    workspacePath: input.workspacePath,
    createdAt: Date.now(),
  };

  sessionKeyByWindowId.set(input.windowId, input.sessionKey);
  sessionsByKey.set(input.sessionKey, nextRecord);
  return nextRecord;
}

export function unregisterWindowSession(windowId: number): WindowSessionRecord | null {
  const sessionKey = sessionKeyByWindowId.get(windowId);
  if (!sessionKey) {
    return null;
  }

  sessionKeyByWindowId.delete(windowId);
  const existingRecord = sessionsByKey.get(sessionKey) ?? null;
  sessionsByKey.delete(sessionKey);
  return existingRecord;
}

export function updateWindowSessionWorkspace(
  sessionKey: string,
  workspacePath: string | null,
): WindowSessionRecord | null {
  const existingRecord = sessionsByKey.get(sessionKey);
  if (!existingRecord) {
    return null;
  }

  const nextRecord: WindowSessionRecord = {
    ...existingRecord,
    workspacePath,
  };
  sessionsByKey.set(sessionKey, nextRecord);
  return nextRecord;
}

export function assignWorkspaceToSessionsWithoutOverride(
  workspacePath: string | null,
): WindowSessionRecord[] {
  if (workspacePath === null) {
    return [];
  }

  const updatedRecords: WindowSessionRecord[] = [];
  for (const record of listWindowSessions()) {
    if (record.workspacePath !== null) {
      continue;
    }
    const updatedRecord = updateWindowSessionWorkspace(record.sessionKey, workspacePath);
    if (updatedRecord) {
      updatedRecords.push(updatedRecord);
    }
  }
  return updatedRecords;
}

export function getWindowSessionByKey(sessionKey: string | null | undefined): WindowSessionRecord | null {
  if (!sessionKey) {
    return null;
  }
  return sessionsByKey.get(sessionKey) ?? null;
}

export function getWindowSessionByWindowId(windowId: number | null | undefined): WindowSessionRecord | null {
  if (!windowId) {
    return null;
  }

  const sessionKey = sessionKeyByWindowId.get(windowId);
  if (!sessionKey) {
    return null;
  }

  return getWindowSessionByKey(sessionKey);
}

export function getWindowSessionKeyForWindowId(windowId: number | null | undefined): string | null {
  if (!windowId) {
    return null;
  }
  return sessionKeyByWindowId.get(windowId) ?? null;
}

export function getWindowSessionWorkspace(input: {
  sessionKey?: string | null;
  windowId?: number | null;
}): string | null {
  if (input.sessionKey) {
    return getWindowSessionByKey(input.sessionKey)?.workspacePath ?? null;
  }

  if (input.windowId) {
    return getWindowSessionByWindowId(input.windowId)?.workspacePath ?? null;
  }

  return null;
}

export function resolveSessionWorkspaceOverride(
  sessionKey: string | null | undefined,
): string | null | undefined {
  if (!sessionKey) {
    return undefined;
  }

  return getWindowSessionByKey(sessionKey)?.workspacePath ?? null;
}

export function listWindowSessions(): WindowSessionRecord[] {
  return Array.from(sessionsByKey.values()).sort((left, right) => left.createdAt - right.createdAt);
}

export function getWindowSessionKeysForWorkspace(workspacePath: string | null): string[] {
  return listWindowSessions()
    .filter((record) => record.workspacePath === workspacePath)
    .map((record) => record.sessionKey);
}

export function getWindowIdsForWorkspace(workspacePath: string | null): number[] {
  return listWindowSessions()
    .filter((record) => record.workspacePath === workspacePath)
    .map((record) => record.windowId);
}

export function getCurrentWindowSessionKey(): string | null {
  return windowSessionStorage.getStore()?.sessionKey ?? null;
}

export function enterWindowSessionOverride(sessionKey: string | null): void {
  windowSessionStorage.enterWith({ sessionKey });
}

export async function runWithWindowSessionOverride<T>(
  sessionKey: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return await windowSessionStorage.run({ sessionKey }, fn);
}
