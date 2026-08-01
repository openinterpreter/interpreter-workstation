import { describe, expect, test } from 'bun:test';

import type { WorkspaceFilesChangedEvent } from '../../electron/ipc/registry';
import { shouldRefreshNoteContextFromWorkspaceEvent } from './noteContextRefresh';

const CURRENT_FILE_PATH = '/workspace/Current.md';

function createEvent(overrides: Partial<WorkspaceFilesChangedEvent>): WorkspaceFilesChangedEvent {
  return {
    eventType: 'change',
    ...overrides,
  };
}

describe('noteContextRefresh', () => {
  test('refreshes when the current note changes', () => {
    expect(shouldRefreshNoteContextFromWorkspaceEvent(
      createEvent({ eventType: 'change', path: 'Current.md' }),
      CURRENT_FILE_PATH,
    )).toBe(true);
  });

  test('ignores unrelated markdown change events to avoid full-vault rebuilds during editing', () => {
    expect(shouldRefreshNoteContextFromWorkspaceEvent(
      createEvent({ eventType: 'change', path: 'notes/Other.md' }),
      CURRENT_FILE_PATH,
    )).toBe(false);
  });

  test('refreshes when another markdown note is added or removed', () => {
    expect(shouldRefreshNoteContextFromWorkspaceEvent(
      createEvent({ eventType: 'add', path: 'notes/Other.md' }),
      CURRENT_FILE_PATH,
    )).toBe(true);

    expect(shouldRefreshNoteContextFromWorkspaceEvent(
      createEvent({ eventType: 'unlink', path: 'notes/Other.markdown' }),
      CURRENT_FILE_PATH,
    )).toBe(true);
  });

  test('ignores non-markdown events', () => {
    expect(shouldRefreshNoteContextFromWorkspaceEvent(
      createEvent({ eventType: 'change', path: 'assets/logo.png' }),
      CURRENT_FILE_PATH,
    )).toBe(false);
  });
});
