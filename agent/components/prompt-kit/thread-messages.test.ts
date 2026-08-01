import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { serializeSkillMentionToken } from '../../../shared/utils/skillMentions';

import {
  collectDetachedToolCalls,
  collectToolCallIds,
  getStreamingTailKind,
  MessageBubble,
  shouldShowTrailingRunningIndicator,
  UserMessageBubble,
  getOrphanApprovalAnchor,
  groupMessageParts,
  isSelectedTtsModelInstalled,
  settleInactiveReasoningParts,
  shouldShowIdleStreamingActivity,
} from './thread-messages';
import { ToolCallGroup } from './tool-fallback';

const FILE_MENTION_MARKDOWN = 'See [AGENTS.md](</Users/example/Documents/My Workspace/AGENTS.md>) now';
const FILE_MENTION_PATH = '/Users/example/Documents/My Workspace/AGENTS.md';
const SKILL_MENTION_MARKDOWN = serializeSkillMentionToken({
  id: 'project:skill-creator:/Users/example/Documents/project/skills/skill-creator/SKILL.md',
  label: 'Skill Creator',
  name: 'skill-creator',
  path: '/Users/example/Documents/project/skills/skill-creator/SKILL.md',
});
const SKILL_MENTION_DIR = path.dirname('/Users/example/Documents/project/skills/skill-creator/SKILL.md');
const CODE_BLOCK_MARKDOWN = '```ts\nconst a = 1;\nconst b = 2;\n```';
const RTL_TEXT = '\u05d4\u05d9\u05d9 \u05de\u05d4 \u05e9\u05dc\u05d5\u05de\u05da';
const MIXED_DIRECTION_LIST_MARKDOWN = `- ${RTL_TEXT}\n- hello world`;
const RTL_WITH_INLINE_CODE_MARKDOWN = `${RTL_TEXT}\n\n\`const value = 1\``;

describe('thread message mention rendering', () => {
  test('renders mentions in normal user messages', () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        msg: {
          id: 'user-1',
          role: 'user',
          parts: [{ kind: 'text', content: FILE_MENTION_MARKDOWN }],
        },
      }),
    );

    assert.match(html, /mention-node-view/);
    assert.match(html, new RegExp(`data-path=\"${FILE_MENTION_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\"`));
    assert.doesNotMatch(html, /\[AGENTS\.md\]\(&lt;\/Users\/example\/Documents\/My Workspace\/AGENTS\.md&gt;\)/);
  });

  test('renders mentions in assistant messages', () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        msg: {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ kind: 'text', content: FILE_MENTION_MARKDOWN }],
        },
        isLast: false,
      }),
    );

    assert.match(html, /mention-node-view/);
    assert.match(html, new RegExp(`data-path=\"${FILE_MENTION_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\"`));
    assert.doesNotMatch(html, /\[AGENTS\.md\]\(&lt;\/Users\/example\/Documents\/My Workspace\/AGENTS\.md&gt;\)/);
    assert.match(html, /hover:opacity-80/);
  });

  test('renders compact plain text in pinned user message headers', () => {
    const html = renderToStaticMarkup(
      React.createElement(UserMessageBubble, {
        content: FILE_MENTION_MARKDOWN,
        isPinned: true,
      }),
    );

    assert.doesNotMatch(html, /mention-node-view/);
    assert.match(html, /See AGENTS\.md now/);
    assert.doesNotMatch(html, /\[AGENTS\.md\]\(&lt;\/Users\/example\/Documents\/My Workspace\/AGENTS\.md&gt;\)/);
  });

  test('does not render code blocks in pinned user message headers', () => {
    const html = renderToStaticMarkup(
      React.createElement(UserMessageBubble, {
        content: CODE_BLOCK_MARKDOWN,
        isPinned: true,
      }),
    );

    assert.doesNotMatch(html, /<pre/);
    assert.match(html, /const a = 1; const b = 2;/);
  });

  test('renders auto direction on assistant message markdown paragraphs', () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        msg: {
          id: 'assistant-rtl',
          role: 'assistant',
          parts: [{ kind: 'text', content: RTL_TEXT }],
        },
        isLast: false,
      }),
    );

    assert.match(html, /<div dir="auto" class="oa-thread-markdown-paragraph[^"]*"/);
  });

  test('renders auto direction on each markdown list item', () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        msg: {
          id: 'assistant-mixed-list',
          role: 'assistant',
          parts: [{ kind: 'text', content: MIXED_DIRECTION_LIST_MARKDOWN }],
        },
        isLast: false,
      }),
    );

    assert.match(html, /<li dir="auto"[^>]*>/);
    assert.equal((html.match(/<li dir="auto"[^>]*>/g) || []).length, 2);
  });

  test('forces ltr direction for inline code inside rtl messages', () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        msg: {
          id: 'assistant-rtl-code',
          role: 'assistant',
          parts: [{ kind: 'text', content: RTL_WITH_INLINE_CODE_MARKDOWN }],
        },
        isLast: false,
      }),
    );

    assert.match(html, /<code dir="ltr" class="[^"]*"[^>]*>const value = 1<\/code>/);
  });

  test('renders auto direction in pinned user message previews', () => {
    const html = renderToStaticMarkup(
      React.createElement(UserMessageBubble, {
        content: RTL_TEXT,
        isPinned: true,
      }),
    );

    assert.match(html, /oa-user-message-markdown--pinned[^"]*" dir="auto"/);
  });

  test('detects whether the selected TTS model is installed', () => {
    const models = [
      { id: 'kokoro-82m' as const, installed: false },
      { id: 'kokoro-1b' as const, installed: true },
    ];

    assert.equal(isSelectedTtsModelInstalled('kokoro-82m', models), false);
    assert.equal(isSelectedTtsModelInstalled('kokoro-1b', models), true);
  });

  test('renders skill mentions in user messages', () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        msg: {
          id: 'user-skill-1',
          role: 'user',
          parts: [{ kind: 'text', content: SKILL_MENTION_MARKDOWN }],
        },
      }),
    );

    assert.match(html, /Skill Creator/);
    assert.match(html, /mention-node-view/);
    assert.match(html, new RegExp(`data-path=\"${SKILL_MENTION_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\"`));
    assert.match(html, /data-type="directory"/);
    assert.doesNotMatch(html, />skill:</);
    assert.doesNotMatch(html, /skill:\[/);
  });

  test('anchors orphan approvals to the latest running tool group even when a newer draft exists', () => {
    const anchor = getOrphanApprovalAnchor(
      [
        {
          id: 'assistant-with-shell',
          role: 'assistant',
          parts: [
            { kind: 'text', content: 'I found the local Ask User tool. I’m using it directly now.' },
            {
              kind: 'tool-call',
              toolCall: {
                id: 'shell-1',
                type: 'commandExecution',
                label: 'bash -lc "... ask_user_question ..."',
                state: 'loading',
              },
            },
          ],
        },
      ],
      {
        id: 'streaming-followup',
        role: 'assistant',
        parts: [],
      },
    );

    assert.deepEqual(anchor, {
      kind: 'activity-group',
      messageId: 'assistant-with-shell',
      groupIndex: 1,
    });
  });

  test('collects tool call ids across all tool groups in a message', () => {
    const groups = groupMessageParts([
      { kind: 'tool-call', toolCall: { id: 'shell-1', type: 'commandExecution', label: 'shell', state: 'complete' } },
      { kind: 'text', content: 'Done.' },
      { kind: 'tool-call', toolCall: { id: 'patch-1', type: 'commandExecution', label: 'apply_patch', state: 'loading' } },
    ]);

    assert.deepEqual(
      Array.from(collectToolCallIds(groups)),
      ['shell-1', 'patch-1'],
    );
  });

  test('groups reasoning and tools into one chronological activity group', () => {
    const groups = groupMessageParts([
      { kind: 'tool-call', toolCall: { id: 'reason-1', type: 'reasoning', label: 'reasoning', state: 'loading' } },
      { kind: 'tool-call', toolCall: { id: 'shell-1', type: 'commandExecution', label: 'pwd', state: 'complete' } },
      { kind: 'text', content: 'Done.' },
    ]);

    assert.deepEqual(groups, [
      {
        type: 'activity-group',
        toolCalls: [
          { id: 'reason-1', type: 'reasoning', label: 'reasoning', state: 'loading' },
          { id: 'shell-1', type: 'commandExecution', label: 'pwd', state: 'complete' },
        ],
      },
      { type: 'text', content: 'Done.' },
    ]);
  });

  test('settles loading reasoning when the assistant turn is no longer streaming', () => {
    const parts = settleInactiveReasoningParts([
      { kind: 'tool-call', toolCall: { id: 'reason-1', type: 'reasoning', label: 'reasoning', state: 'loading' } },
      { kind: 'tool-call', toolCall: { id: 'cmd-1', type: 'commandExecution', label: 'pwd', state: 'loading' } },
    ], false);

    assert.deepEqual(parts, [
      { kind: 'tool-call', toolCall: { id: 'reason-1', type: 'reasoning', label: 'reasoning', state: 'complete' } },
      { kind: 'tool-call', toolCall: { id: 'cmd-1', type: 'commandExecution', label: 'pwd', state: 'loading' } },
    ]);
  });

  test('collects detached live tool calls once later content appears', () => {
    const toolCalls = collectDetachedToolCalls(
      [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              kind: 'tool-call',
              toolCall: {
                id: 'cmd-1',
                type: 'commandExecution',
                label: 'sleep 30',
                state: 'loading',
              },
            },
            { kind: 'text', content: 'Still working on the rest.' },
          ],
        },
      ],
      {
        id: 'assistant-2',
        role: 'assistant',
        parts: [
          {
            kind: 'tool-call',
            toolCall: {
              id: 'search-1',
              type: 'webSearch',
              label: 'search',
              state: 'loading',
            },
          },
          { kind: 'text', content: 'Streaming follow-up' },
        ],
      },
    );

    assert.deepEqual(
      toolCalls.map((entry) => [entry.toolCallId, entry.toolCall.id]),
      [
        ['cmd-1', 'cmd-1'],
        ['search-1', 'search-1'],
      ],
    );
  });

  test('does not detach the trailing active tool call when nothing follows it', () => {
    const toolCalls = collectDetachedToolCalls(
      [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              kind: 'tool-call',
              toolCall: {
                id: 'cmd-1',
                type: 'commandExecution',
                label: 'sleep 30',
                state: 'loading',
              },
            },
          ],
        },
      ],
      null,
    );

    assert.equal(toolCalls.length, 0);
  });

  test('detaches an explicit background wait even before later text arrives', () => {
    const toolCalls = collectDetachedToolCalls(
      [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              kind: 'tool-call',
              toolCall: {
                id: 'cmd-1',
                type: 'commandExecution',
                label: 'sleep 30',
                state: 'loading',
                backgroundState: 'waiting',
              },
            },
          ],
        },
      ],
      null,
    );

    assert.deepEqual(
      toolCalls.map((entry) => entry.toolCallId),
      ['cmd-1'],
    );
  });

  test('detaches earlier loading tool calls inside the same chronological burst', () => {
    const toolCalls = collectDetachedToolCalls(
      [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              kind: 'tool-call',
              toolCall: {
                id: 'cmd-1',
                type: 'commandExecution',
                label: 'sleep 30',
                state: 'loading',
              },
            },
            {
              kind: 'tool-call',
              toolCall: {
                id: 'reason-1',
                type: 'reasoning',
                label: 'reasoning',
                state: 'loading',
              },
            },
          ],
        },
      ],
      null,
    );

    assert.deepEqual(
      toolCalls.map((entry) => entry.toolCallId),
      ['cmd-1'],
    );
  });

  test('never detaches reasoning as background activity', () => {
    const toolCalls = collectDetachedToolCalls(
      [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              kind: 'tool-call',
              toolCall: {
                id: 'reason-1',
                type: 'reasoning',
                label: 'reasoning',
                state: 'loading',
              },
            },
            { kind: 'text', content: 'Follow-up text exists.' },
          ],
        },
      ],
      null,
    );

    assert.equal(toolCalls.length, 0);
  });

  test('hides empty completed reasoning rows from expanded tool groups', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'reason-empty',
            type: 'reasoning',
            label: 'reasoning',
            state: 'complete',
            item: {
              type: 'reasoning',
              id: 'reason-empty',
              summary: [],
              content: [],
              status: 'completed',
            },
          },
          {
            id: 'cmd-1',
            type: 'commandExecution',
            label: 'pwd',
            state: 'complete',
          },
        ],
      }),
    );

    assert.doesNotMatch(html, /reason-empty/);
    assert.match(html, /pwd/);
  });

  test('renders subagent items as normal tool calls without an extra subagent frame label', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'collab-1',
            type: 'collabAgentToolCall',
            label: 'spawnAgent',
            state: 'loading',
            output: 'child-1: running',
            item: {
              type: 'collabAgentToolCall',
              id: 'collab-1',
              tool: 'spawnAgent',
              status: 'inProgress',
              senderThreadId: 'parent',
              receiverThreadIds: ['child-1'],
              prompt: 'Inspect the repo',
              agentsStates: {
                'child-1': { status: 'running', message: 'Inspecting files' },
              },
            },
          },
        ],
      }),
    );

    assert.match(html, /Delegating task/);
    assert.match(html, /tool-call-collabAgentToolCall/);
    assert.doesNotMatch(html, />Subagent</);
  });

  test('falls back to the latest assistant bubble when no tool group exists yet', () => {
    const anchor = getOrphanApprovalAnchor(
      [],
      {
        id: 'streaming-followup',
        role: 'assistant',
        parts: [{ kind: 'text', content: 'Waiting for approval...' }],
      },
    );

    assert.deepEqual(anchor, {
      kind: 'empty',
      messageId: 'streaming-followup',
    });
  });

  test('skips hidden system notifications when anchoring orphan approvals', () => {
    const anchor = getOrphanApprovalAnchor(
      [
        {
          id: 'assistant-visible',
          role: 'assistant',
          parts: [{ kind: 'text', content: 'Visible assistant bubble' }],
        },
        {
          id: 'assistant-hidden',
          role: 'assistant',
          parts: [{ kind: 'text', content: '<system-notification source="codex">hidden</system-notification>' }],
        },
      ],
      null,
    );

    assert.deepEqual(anchor, {
      kind: 'empty',
      messageId: 'assistant-visible',
    });
  });

  test('skips hidden assistant messages when finding the latest running tool group', () => {
    const anchor = getOrphanApprovalAnchor(
      [
        {
          id: 'assistant-with-shell',
          role: 'assistant',
          parts: [
            { kind: 'text', content: 'Running shell command' },
            {
              kind: 'tool-call',
              toolCall: {
                id: 'shell-1',
                type: 'commandExecution',
                label: 'bash -lc "ls"',
                state: 'loading',
              },
            },
          ],
        },
        {
          id: 'assistant-hidden',
          role: 'assistant',
          parts: [{ kind: 'text', content: '<system-notification source="codex">hidden</system-notification>' }],
        },
      ],
      null,
    );

    assert.deepEqual(anchor, {
      kind: 'activity-group',
      messageId: 'assistant-with-shell',
      groupIndex: 1,
    });
  });
});

describe('shouldShowIdleStreamingActivity', () => {
  test('shows idle indicator while assistant is streaming and no tool is active', () => {
    assert.equal(
      shouldShowIdleStreamingActivity({
        isUser: false,
        isStreaming: true,
        showTextActivity: false,
        hasRunningToolCall: false,
      }),
      true,
    );
  });

  test('hides idle indicator while a tool call is still running', () => {
    assert.equal(
      shouldShowIdleStreamingActivity({
        isUser: false,
        isStreaming: true,
        showTextActivity: false,
        hasRunningToolCall: true,
      }),
      false,
    );
  });

  test('hides idle indicator while text activity indicator is already visible', () => {
    assert.equal(
      shouldShowIdleStreamingActivity({
        isUser: false,
        isStreaming: true,
        showTextActivity: true,
        hasRunningToolCall: false,
      }),
      false,
    );
  });
});

describe('shouldShowTrailingRunningIndicator', () => {
  test('shows a trailing indicator while streaming plain assistant text', () => {
    assert.equal(
      shouldShowTrailingRunningIndicator({
        isStreaming: true,
        showOptimisticThinking: false,
        visibleStreamingMessage: {
          id: 'assistant-text',
          role: 'assistant',
          parts: [{ kind: 'text', content: 'Still working on it' }],
        },
        detachedToolCalls: [],
      }),
      true,
    );
  });

  test('hides the trailing indicator when the streaming message already ends in a live tool call', () => {
    assert.equal(
      shouldShowTrailingRunningIndicator({
        isStreaming: true,
        showOptimisticThinking: false,
        visibleStreamingMessage: {
          id: 'assistant-tool',
          role: 'assistant',
          parts: [
            { kind: 'text', content: 'Checking that now' },
            {
              kind: 'tool-call',
              toolCall: {
                id: 'tool-1',
                type: 'commandExecution',
                label: 'ls',
                state: 'loading',
              },
            },
          ],
        },
        detachedToolCalls: [],
      }),
      false,
    );
  });

  test('hides the trailing indicator when a detached live tool rail is already visible', () => {
    assert.equal(
      shouldShowTrailingRunningIndicator({
        isStreaming: true,
        showOptimisticThinking: false,
        visibleStreamingMessage: {
          id: 'assistant-text',
          role: 'assistant',
          parts: [{ kind: 'text', content: 'Waiting for the background job' }],
        },
        detachedToolCalls: [
          {
            toolCallId: 'tool-1',
            toolCall: {
              id: 'tool-1',
              type: 'commandExecution',
              label: 'sleep 30',
              state: 'loading',
            },
          },
        ],
      }),
      false,
    );
  });

  test('hides the trailing indicator when the streaming bubble already shows idle activity', () => {
    assert.equal(
      shouldShowTrailingRunningIndicator({
        isStreaming: true,
        showOptimisticThinking: false,
        visibleStreamingMessage: {
          id: 'assistant-idle',
          role: 'assistant',
          parts: [
            {
              kind: 'tool-call',
              toolCall: {
                id: 'reason-1',
                type: 'reasoning',
                label: 'Reasoning',
                state: 'complete',
              },
            },
          ],
        },
        detachedToolCalls: [],
      }),
      false,
    );
  });

  test('shows the trailing indicator while streaming before any visible draft content arrives', () => {
    assert.equal(
      shouldShowTrailingRunningIndicator({
        isStreaming: true,
        showOptimisticThinking: false,
        visibleStreamingMessage: null,
        detachedToolCalls: [],
      }),
      true,
    );
  });

  test('hides the trailing indicator while the optimistic interpreting row is visible', () => {
    assert.equal(
      shouldShowTrailingRunningIndicator({
        isStreaming: true,
        showOptimisticThinking: true,
        visibleStreamingMessage: null,
        detachedToolCalls: [],
      }),
      false,
    );
  });
});

describe('getStreamingTailKind', () => {
  test('prefers the optimistic loader before visible draft content arrives', () => {
    assert.equal(
      getStreamingTailKind({
        showOptimisticThinking: true,
        visibleStreamingMessage: null,
        reasoningHandoffActive: false,
      }),
      'optimistic',
    );
  });

  test('keeps showing the optimistic loader during reasoning handoff', () => {
    assert.equal(
      getStreamingTailKind({
        showOptimisticThinking: true,
        visibleStreamingMessage: {
          id: 'assistant-1',
          role: 'assistant',
          parts: [],
        },
        reasoningHandoffActive: true,
      }),
      'optimistic',
    );
  });

  test('shows the streaming message once optimistic state clears', () => {
    assert.equal(
      getStreamingTailKind({
        showOptimisticThinking: false,
        visibleStreamingMessage: {
          id: 'assistant-2',
          role: 'assistant',
          parts: [{ kind: 'text', content: 'Hello' }],
        },
        reasoningHandoffActive: false,
      }),
      'message',
    );
  });

  test('returns none when no streaming tail is currently visible', () => {
    assert.equal(
      getStreamingTailKind({
        showOptimisticThinking: false,
        visibleStreamingMessage: null,
        reasoningHandoffActive: false,
      }),
      'none',
    );
  });
});

// ---------------------------------------------------------------------------
// Deterministic rendering order
// Ref: Vercel AI SDK uses structural toStrictEqual on message arrays to enforce
// ordering invariants (packages/react/src/use-chat.ui.test.tsx). We apply the
// same approach to groupMessageParts, which is the single deterministic mapping
// from a flat ChatMessage.parts[] to the rendered group structure.
// ---------------------------------------------------------------------------

describe('deterministic rendering order', () => {
  // Ref: Vercel AI SDK pattern -- assert exact structural equality on the
  // output of a pure transform given a fixed input. If the mapping ever
  // changes, these tests break immediately.

  test('interleaved text and tools produce strictly alternating groups', () => {
    const groups = groupMessageParts([
      { kind: 'text', content: 'Step 1' },
      { kind: 'tool-call', toolCall: { id: 'cmd-1', type: 'commandExecution', label: 'pwd', state: 'complete' } },
      { kind: 'text', content: 'Step 2' },
      { kind: 'tool-call', toolCall: { id: 'cmd-2', type: 'commandExecution', label: 'ls', state: 'complete' } },
      { kind: 'tool-call', toolCall: { id: 'cmd-3', type: 'commandExecution', label: 'cat', state: 'loading' } },
      { kind: 'text', content: 'Step 3' },
    ]);

    assert.equal(groups.length, 5);
    assert.equal(groups[0]!.type, 'text');
    assert.equal(groups[1]!.type, 'activity-group');
    assert.equal(groups[2]!.type, 'text');
    assert.equal(groups[3]!.type, 'activity-group');
    assert.equal(groups[4]!.type, 'text');
  });

  test('consecutive tool calls merge into one activity group regardless of type', () => {
    const groups = groupMessageParts([
      { kind: 'tool-call', toolCall: { id: 'reason-1', type: 'reasoning', label: 'reasoning', state: 'complete' } },
      { kind: 'tool-call', toolCall: { id: 'read-1', type: 'mcpToolCall', label: 'read_file', state: 'complete' } },
      { kind: 'tool-call', toolCall: { id: 'cmd-1', type: 'commandExecution', label: 'ls', state: 'loading' } },
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.type, 'activity-group');
    const toolCalls = (groups[0] as { type: 'activity-group'; toolCalls: unknown[] }).toolCalls;
    assert.equal(toolCalls.length, 3);
  });

  test('empty parts array produces empty groups', () => {
    assert.deepEqual(groupMessageParts([]), []);
  });

  test('single text part produces single text group', () => {
    const groups = groupMessageParts([{ kind: 'text', content: 'Hello' }]);
    assert.deepEqual(groups, [{ type: 'text', content: 'Hello' }]);
  });

  test('collectToolCallIds returns stable insertion-order set across groups', () => {
    // Ref: Vercel AI SDK mockId() pattern -- deterministic IDs make ordering
    // assertions reliable. We verify insertion order is preserved.
    const groups = groupMessageParts([
      { kind: 'tool-call', toolCall: { id: 'a', type: 'commandExecution', label: 'a', state: 'complete' } },
      { kind: 'text', content: 'break' },
      { kind: 'tool-call', toolCall: { id: 'b', type: 'commandExecution', label: 'b', state: 'complete' } },
      { kind: 'tool-call', toolCall: { id: 'c', type: 'mcpToolCall', label: 'c', state: 'loading' } },
    ]);

    const ids = Array.from(collectToolCallIds(groups));
    assert.deepEqual(ids, ['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// Single active indicator invariant
// Ref: Issue #678 -- "The blue circle should NOT appear more than once, EVER.
// It should only appear for the active tool, or at the bottom while no tool
// calls are happening." These tests enforce mutual exclusivity across every
// UI indicator signal: trailing dot, idle activity, optimistic loader, and
// detached rail. Only one can be active at any given state snapshot.
// ---------------------------------------------------------------------------

describe('single active indicator invariant', () => {
  // Ref: react-render-stream-testing-library pattern -- assert per-render
  // invariants on intermediate states. We emulate this by testing pure
  // functions over every meaningful state combination.

  test('trailing indicator and optimistic loader are mutually exclusive', () => {
    // When optimistic is showing, trailing must hide (and vice versa).
    const states = [
      { showOptimisticThinking: true, visibleStreamingMessage: null },
      { showOptimisticThinking: false, visibleStreamingMessage: null },
    ] as const;

    for (const s of states) {
      const tailKind = getStreamingTailKind({
        ...s,
        reasoningHandoffActive: false,
      });
      const trailing = shouldShowTrailingRunningIndicator({
        isStreaming: true,
        showOptimisticThinking: s.showOptimisticThinking,
        visibleStreamingMessage: s.visibleStreamingMessage,
        detachedToolCalls: [],
      });

      if (tailKind === 'optimistic') {
        assert.equal(trailing, false, 'trailing must hide when optimistic is active');
      }
    }
  });

  test('idle activity and trailing indicator are mutually exclusive given loading tool', () => {
    // Ref: Issue #678 -- when a tool is running, idle indicator hides. When
    // idle is showing (no running tool), the streaming message ends with
    // completed activity, so trailing also hides.
    const idle = shouldShowIdleStreamingActivity({
      isUser: false,
      isStreaming: true,
      showTextActivity: false,
      hasRunningToolCall: true,
    });
    assert.equal(idle, false);

    const trailing = shouldShowTrailingRunningIndicator({
      isStreaming: true,
      showOptimisticThinking: false,
      visibleStreamingMessage: {
        id: 'msg-1',
        role: 'assistant',
        parts: [{
          kind: 'tool-call',
          toolCall: { id: 'cmd-1', type: 'commandExecution', label: 'ls', state: 'loading' },
        }],
      },
      detachedToolCalls: [],
    });
    assert.equal(trailing, false);
  });

  test('detached rail suppresses trailing indicator', () => {
    const detachedToolCalls = [
      { toolCallId: 'cmd-1', toolCall: { id: 'cmd-1', type: 'commandExecution' as const, label: 'sleep', state: 'loading' as const } },
    ];
    const trailing = shouldShowTrailingRunningIndicator({
      isStreaming: true,
      showOptimisticThinking: false,
      visibleStreamingMessage: {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ kind: 'text', content: 'Working on it' }],
      },
      detachedToolCalls,
    });
    assert.equal(trailing, false);
  });

  test('idle activity hides when text is already streaming', () => {
    assert.equal(
      shouldShowIdleStreamingActivity({
        isUser: false,
        isStreaming: true,
        showTextActivity: true,
        hasRunningToolCall: false,
      }),
      false,
    );
  });

  test('no indicators fire when not streaming', () => {
    assert.equal(
      shouldShowTrailingRunningIndicator({
        isStreaming: false,
        showOptimisticThinking: false,
        visibleStreamingMessage: null,
        detachedToolCalls: [],
      }),
      false,
    );
    assert.equal(
      shouldShowIdleStreamingActivity({
        isUser: false,
        isStreaming: false,
        showTextActivity: false,
        hasRunningToolCall: false,
      }),
      false,
    );
    assert.equal(
      getStreamingTailKind({
        showOptimisticThinking: false,
        visibleStreamingMessage: null,
        reasoningHandoffActive: false,
      }),
      'none',
    );
  });
});

// ---------------------------------------------------------------------------
// Detached tool call uniqueness
// Ref: LobeChat E2E RFC-139 validates that UI lists have no duplicate keys.
// collectDetachedToolCalls must never return the same toolCallId twice, even
// with complex interleaved message+draft payloads.
// ---------------------------------------------------------------------------

describe('detached tool call uniqueness', () => {
  test('never produces duplicate toolCallIds across messages and draft', () => {
    const toolCalls = collectDetachedToolCalls(
      [
        {
          id: 'msg-1',
          role: 'assistant',
          parts: [
            { kind: 'tool-call', toolCall: { id: 'cmd-1', type: 'commandExecution', label: 'sleep 30', state: 'loading' } },
            { kind: 'text', content: 'Continuing...' },
            { kind: 'tool-call', toolCall: { id: 'cmd-2', type: 'commandExecution', label: 'sleep 60', state: 'loading' } },
          ],
        },
        {
          id: 'msg-2',
          role: 'assistant',
          parts: [
            { kind: 'tool-call', toolCall: { id: 'cmd-1', type: 'commandExecution', label: 'sleep 30', state: 'loading' } },
          ],
        },
      ],
      {
        id: 'draft',
        role: 'assistant',
        parts: [
          { kind: 'tool-call', toolCall: { id: 'cmd-3', type: 'commandExecution', label: 'ls', state: 'loading' } },
          { kind: 'text', content: 'Almost done' },
        ],
      },
    );

    const ids = toolCalls.map((tc) => tc.toolCallId);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, `duplicate toolCallIds found: ${JSON.stringify(ids)}`);
  });

  test('completed tool calls are never detached', () => {
    const toolCalls = collectDetachedToolCalls(
      [
        {
          id: 'msg-1',
          role: 'assistant',
          parts: [
            { kind: 'tool-call', toolCall: { id: 'cmd-1', type: 'commandExecution', label: 'ls', state: 'complete' } },
            { kind: 'text', content: 'Done.' },
          ],
        },
      ],
      {
        id: 'draft',
        role: 'assistant',
        parts: [
          { kind: 'tool-call', toolCall: { id: 'cmd-2', type: 'commandExecution', label: 'pwd', state: 'loading' } },
        ],
      },
    );

    assert.equal(toolCalls.length, 0);
  });
});
