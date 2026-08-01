import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ConversationTitleContent,
  archiveConversationWithConfirmedClose,
  deleteAllConversationsWithConfirmedClose,
  deleteConversationWithConfirmedClose,
  getDeleteAllConversationScope,
  removePendingConversationKey,
  renameConversationWithConfirmedSave,
  unarchiveConversationWithConfirmedRefresh,
  type ConversationPreview,
} from './ConversationHistoryPanel';

describe('ConversationTitleContent', () => {
  test('renders local markdown links in history titles as mention chips', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConversationTitleContent, {
        title: '[AGENTS.md](</Users/example/Documents/My Workspace/AGENTS.md>) what is this',
        fallbackTitle: 'Untitled',
        searchTerms: [],
      }),
    );

    assert.match(html, /mention-node-view/);
    assert.match(html, /data-path=\"\/Users\/example\/Documents\/My Workspace\/AGENTS\.md\"/);
    assert.match(html, /data-type=\"file\"/);
    assert.match(html, /what is this/);
    assert.doesNotMatch(html, /\[AGENTS\.md\]\(&lt;\/Users\/example\/Documents\/My Workspace\/AGENTS\.md&gt;\)/);
  });

  test('normalizes markdown note labels in history mention chips', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConversationTitleContent, {
        title: '[README.md](</tmp/README.md>) status',
        fallbackTitle: 'Untitled',
        searchTerms: [],
      }),
    );

    assert.match(html, /data-path=\"\/tmp\/README\.md\"/);
    assert.match(html, />README<\/span>/);
    assert.doesNotMatch(html, />README\.md<\/span>/);
  });

  test('renders non-local markdown links as plain label text', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConversationTitleContent, {
        title: 'read [docs](https://example.com/docs) next',
        fallbackTitle: 'Untitled',
        searchTerms: [],
      }),
    );

    assert.equal(html, 'read docs next');
    assert.doesNotMatch(html, /\[docs\]\(https:\/\/example\.com\/docs\)/);
    assert.doesNotMatch(html, /mention-node-view/);
  });
});

describe('conversation deletion sequencing', () => {
  function preview(overrides: Partial<ConversationPreview>): ConversationPreview {
    return {
      conversationId: overrides.conversationId ?? 'conversation-1',
      threadId: overrides.threadId ?? 'thread-1',
      agentId: overrides.agentId ?? 'agent-1',
      profileId: '',
      workspacePath: '',
      title: '',
      lastMessagePreview: '',
      messageCount: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      source: overrides.source ?? 'history',
      isArchived: overrides.isArchived ?? false,
      isOpen: overrides.isOpen ?? false,
      isSelected: false,
      ...overrides,
    };
  }

  test('does not close a live tab when thread deletion fails', async () => {
    const closeTabCalls: string[] = [];
    const deleteThreadCalls: string[] = [];

    await assert.rejects(
      deleteConversationWithConfirmedClose(
        {
          threadId: 'thread-1',
          isOpen: true,
          agentId: 'agent-1',
        },
        {
          deleteThread: async (threadId) => {
            deleteThreadCalls.push(threadId);
            return { success: false, error: 'trash failed' };
          },
          closeTab: (agentId) => {
            closeTabCalls.push(agentId);
          },
        },
      ),
      /trash failed/,
    );

    assert.deepEqual(deleteThreadCalls, ['thread-1']);
    assert.deepEqual(closeTabCalls, []);
  });

  test('closes live tabs only after delete-all succeeds', async () => {
    const closeTabCalls: string[] = [];
    let deleteAllCalls = 0;

    await assert.rejects(
      deleteAllConversationsWithConfirmedClose(
        [
          { isOpen: true, agentId: 'agent-1' },
          { isOpen: true, agentId: 'agent-2' },
        ],
        {
          deleteAll: async () => {
            deleteAllCalls += 1;
            return { success: false, error: 'trash all failed' };
          },
          closeTab: (agentId) => {
            closeTabCalls.push(agentId);
          },
        },
      ),
      /trash all failed/,
    );

    assert.equal(deleteAllCalls, 1);
    assert.deepEqual(closeTabCalls, []);
  });

  test('delete-all scope includes active recent tabs when invoked from archived history', () => {
    const scopedConversations = getDeleteAllConversationScope(
      true,
      [
        preview({
          conversationId: 'thread-archived',
          threadId: 'thread-archived',
          agentId: 'agent-thread-archived',
          isArchived: true,
        }),
      ],
      [
        preview({
          conversationId: 'thread-active',
          threadId: 'thread-active',
          agentId: 'agent-active',
          source: 'active',
          isOpen: true,
        }),
      ],
    );

    assert.deepEqual(scopedConversations.map((conversation) => conversation.agentId), [
      'agent-thread-archived',
      'agent-active',
    ]);
  });
});

describe('conversation rename and archive sequencing', () => {
  test('renames saved threads and updates open tab labels after persistence succeeds', async () => {
    const renameCalls: Array<{ threadId: string; name: string }> = [];
    const labelUpdates: Array<{ agentId: string; label: string }> = [];

    const savedName = await renameConversationWithConfirmedSave(
      {
        threadId: 'thread-1',
        isOpen: true,
        agentId: 'agent-1',
      },
      '  Project Alpha  ',
      {
        renameThread: async (threadId, name) => {
          renameCalls.push({ threadId, name });
          return { success: true, name };
        },
        updateTabLabel: (agentId, label) => {
          labelUpdates.push({ agentId, label });
        },
      },
    );

    assert.equal(savedName, 'Project Alpha');
    assert.deepEqual(renameCalls, [{ threadId: 'thread-1', name: 'Project Alpha' }]);
    assert.deepEqual(labelUpdates, [{ agentId: 'agent-1', label: 'Project Alpha' }]);
  });

  test('does not update an open tab label when persisted rename fails', async () => {
    const labelUpdates: Array<{ agentId: string; label: string }> = [];

    await assert.rejects(
      renameConversationWithConfirmedSave(
        {
          threadId: 'thread-1',
          isOpen: true,
          agentId: 'agent-1',
        },
        'Project Alpha',
        {
          renameThread: async () => ({ success: false, error: 'rename failed' }),
          updateTabLabel: (agentId, label) => {
            labelUpdates.push({ agentId, label });
          },
        },
      ),
      /rename failed/,
    );

    assert.deepEqual(labelUpdates, []);
  });

  test('closes live tabs only after archive succeeds', async () => {
    const closeTabCalls: string[] = [];

    await assert.rejects(
      archiveConversationWithConfirmedClose(
        {
          threadId: 'thread-1',
          isOpen: true,
          agentId: 'agent-1',
        },
        {
          archiveThread: async () => ({ success: false, error: 'archive failed' }),
          closeTab: (agentId) => {
            closeTabCalls.push(agentId);
          },
        },
      ),
      /archive failed/,
    );

    assert.deepEqual(closeTabCalls, []);

    await archiveConversationWithConfirmedClose(
      {
        threadId: 'thread-1',
        isOpen: true,
        agentId: 'agent-1',
      },
      {
        archiveThread: async () => ({ success: true }),
        closeTab: (agentId) => {
          closeTabCalls.push(agentId);
        },
      },
    );

    assert.deepEqual(closeTabCalls, ['agent-1']);
  });

  test('unarchives saved threads through the thread service', async () => {
    const unarchiveCalls: string[] = [];

    await unarchiveConversationWithConfirmedRefresh(
      { threadId: 'thread-1' },
      {
        unarchiveThread: async (threadId) => {
          unarchiveCalls.push(threadId);
          return { success: true };
        },
      },
    );

    assert.deepEqual(unarchiveCalls, ['thread-1']);
  });

  test('clears pending removal by thread id after archive state changes settle', () => {
    const pendingKeys = new Set(['thread-1', 'thread-2']);

    const nextKeys = removePendingConversationKey(pendingKeys, {
      conversationId: 'history-thread-1',
      threadId: 'thread-1',
    });

    assert.deepEqual(Array.from(nextKeys), ['thread-2']);
    assert.deepEqual(Array.from(pendingKeys), ['thread-1', 'thread-2']);
  });
});
