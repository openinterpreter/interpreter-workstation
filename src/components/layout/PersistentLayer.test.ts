import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  getEditorEmptyStateJustifyContent,
  shouldReplaceEditorAgentTabWithTerminalProfile,
  shouldShowCenteredAgentLogo,
  shouldShowEditorAgentEmptyState,
} from './editorAgentState';

describe('shouldShowEditorAgentEmptyState', () => {
  test('shows the empty state for a fresh editor agent tab', () => {
    assert.equal(
      shouldShowEditorAgentEmptyState({
        isSidebar: false,
        hasConversationThread: false,
        messageCount: 0,
        isStreaming: false,
      }),
      true,
    );
  });

  test('hides the empty state once a message exists', () => {
    assert.equal(
      shouldShowEditorAgentEmptyState({
        isSidebar: false,
        hasConversationThread: false,
        messageCount: 1,
        isStreaming: false,
      }),
      false,
    );
  });

  test('hides the empty state while loading an existing thread', () => {
    assert.equal(
      shouldShowEditorAgentEmptyState({
        isSidebar: false,
        hasConversationThread: true,
        messageCount: 0,
        isStreaming: false,
      }),
      false,
    );
  });
});

describe('shouldShowCenteredAgentLogo', () => {
  test('shows the centered logo for a fresh sidebar agent tab', () => {
    assert.equal(
      shouldShowCenteredAgentLogo({
        isSidebar: true,
        hasConversationThread: false,
        messageCount: 0,
        isStreaming: false,
      }),
      true,
    );
  });

  test('hides the centered logo once the sidebar agent has messages', () => {
    assert.equal(
      shouldShowCenteredAgentLogo({
        isSidebar: true,
        hasConversationThread: false,
        messageCount: 1,
        isStreaming: false,
      }),
      false,
    );
  });

  test('keeps the editor empty state as the only surface for a fresh editor tab', () => {
    assert.equal(
      shouldShowCenteredAgentLogo({
        isSidebar: false,
        hasConversationThread: false,
        messageCount: 0,
        isStreaming: false,
      }),
      false,
    );
  });
});

describe('shouldReplaceEditorAgentTabWithTerminalProfile', () => {
  test('reuses the current editor tab when it is still a fresh empty chat', () => {
    assert.equal(
      shouldReplaceEditorAgentTabWithTerminalProfile({
        isSidebar: false,
        hasConversationThread: false,
        messageCount: 0,
        isStreaming: false,
      }),
      true,
    );
  });

  test('opens a new terminal chat once the editor tab already has conversation state', () => {
    assert.equal(
      shouldReplaceEditorAgentTabWithTerminalProfile({
        isSidebar: false,
        hasConversationThread: true,
        messageCount: 0,
        isStreaming: false,
      }),
      false,
    );
    assert.equal(
      shouldReplaceEditorAgentTabWithTerminalProfile({
        isSidebar: false,
        hasConversationThread: false,
        messageCount: 1,
        isStreaming: false,
      }),
      false,
    );
  });

  test('never replaces a sidebar agent tab in place', () => {
    assert.equal(
      shouldReplaceEditorAgentTabWithTerminalProfile({
        isSidebar: true,
        hasConversationThread: false,
        messageCount: 0,
        isStreaming: false,
      }),
      false,
    );
  });
});

describe('getEditorEmptyStateJustifyContent', () => {
  test('uses safe centering for the editor empty state container', () => {
    assert.equal(getEditorEmptyStateJustifyContent(true), 'safe center');
  });

  test('returns no explicit alignment outside the empty state', () => {
    assert.equal(getEditorEmptyStateJustifyContent(false), undefined);
  });
});
