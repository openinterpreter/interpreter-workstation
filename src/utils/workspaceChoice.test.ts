import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  DETECTED_WORKSPACE_SCROLL_THRESHOLD,
  buildDetectedWorkspaceSections,
  shouldConstrainDetectedWorkspaceList,
} from './workspaceChoice';

describe('buildDetectedWorkspaceSections', () => {
  test('keeps detected workspaces grouped in source order without slicing the list', () => {
    const sections = buildDetectedWorkspaceSections([
      { source: 'foam', name: 'Foam Notes', path: '/tmp/foam' },
      { source: 'obsidian', name: 'Vault A', path: '/tmp/obsidian-a' },
      { source: 'logseq', name: 'Graph', path: '/tmp/logseq' },
      { source: 'obsidian', name: 'Vault B', path: '/tmp/obsidian-b' },
      { source: 'foam', name: 'Foam Archive', path: '/tmp/foam-archive' },
    ]);

    assert.deepEqual(
      sections.map((section) => ({
        source: section.source,
        names: section.workspaces.map((workspace) => workspace.name),
      })),
      [
        { source: 'obsidian', names: ['Vault A', 'Vault B'] },
        { source: 'logseq', names: ['Graph'] },
        { source: 'foam', names: ['Foam Notes', 'Foam Archive'] },
      ],
    );
  });
});

describe('shouldConstrainDetectedWorkspaceList', () => {
  test('switches to a scrollable detected-workspace list after the threshold', () => {
    assert.equal(
      shouldConstrainDetectedWorkspaceList(DETECTED_WORKSPACE_SCROLL_THRESHOLD),
      false,
    );
    assert.equal(
      shouldConstrainDetectedWorkspaceList(DETECTED_WORKSPACE_SCROLL_THRESHOLD + 1),
      true,
    );
  });
});
