import { describe, expect, test } from 'bun:test';

import type { WorkspaceFilesChangedEvent } from '../../electron/ipc/registry';
import { shouldRefreshUnlinkedMentionCandidatesFromWorkspaceEvent } from './unlinkedMentionRefresh';

const CURRENT_FILE_PATH = '/workspace/Current.md';

function createEvent(overrides: Partial<WorkspaceFilesChangedEvent>): WorkspaceFilesChangedEvent {
  return {
    eventType: 'change',
    ...overrides,
  };
}

describe('unlinkedMentionRefresh', () => {
  test('ignores routine markdown change events to avoid full-vault refreshes on save', () => {
    expect(shouldRefreshUnlinkedMentionCandidatesFromWorkspaceEvent(
      createEvent({ eventType: 'change', path: 'notes/Other.md' }),
      CURRENT_FILE_PATH,
    )).toBe(false);
  });

  test('refreshes when another markdown note is added or removed', () => {
    expect(shouldRefreshUnlinkedMentionCandidatesFromWorkspaceEvent(
      createEvent({ eventType: 'add', path: 'notes/Other.md' }),
      CURRENT_FILE_PATH,
    )).toBe(true);

    expect(shouldRefreshUnlinkedMentionCandidatesFromWorkspaceEvent(
      createEvent({ eventType: 'unlink', path: 'notes/Other.markdown' }),
      CURRENT_FILE_PATH,
    )).toBe(true);
  });

  test('ignores non-markdown and current-note events', () => {
    expect(shouldRefreshUnlinkedMentionCandidatesFromWorkspaceEvent(
      createEvent({ eventType: 'add', path: 'notes/Other.txt' }),
      CURRENT_FILE_PATH,
    )).toBe(false);

    expect(shouldRefreshUnlinkedMentionCandidatesFromWorkspaceEvent(
      createEvent({ eventType: 'unlink', path: 'Current.md' }),
      CURRENT_FILE_PATH,
    )).toBe(false);
  });
});
