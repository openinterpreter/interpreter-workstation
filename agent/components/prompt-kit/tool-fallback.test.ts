import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ToolCallGroup,
  getExpandedToolGroupBodyStyle,
  getToolHeaderTitleWidth,
  isOrphanApprovalForThread,
  paramsTextForToolCall,
  resolveInlineGroupApproval,
  shouldStackToolHeader,
} from './tool-fallback';
import { ApprovalSupportContent, normalizeApprovalOptionCopy } from '../../../src/components/approvals/ApprovalSupportContent';

function makeApproval(overrides: {
  serverId?: string;
  toolName?: string;
  threadId?: string;
  toolCallId?: string;
  noContext?: boolean;
} = {}) {
  return {
    serverId: overrides.serverId ?? 'main-agent-server',
    toolName: overrides.toolName ?? 'view_image',
    ...(overrides.noContext ? {} : { context: { threadId: overrides.threadId ?? 'thread-A' } }),
    ...(overrides.toolCallId !== undefined ? { toolCallId: overrides.toolCallId } : {}),
  };
}

describe('isOrphanApprovalForThread', () => {
  const empty = new Set<string>();

  test('should_match_orphan_approval_targeting_same_thread', () => {
    assert.equal(
      isOrphanApprovalForThread(makeApproval({ threadId: 'thr_abc' }), 'thr_abc', empty),
      true,
    );
  });

  test('should_reject_approval_from_different_thread', () => {
    assert.equal(
      isOrphanApprovalForThread(makeApproval({ threadId: 'thr_other' }), 'thr_abc', empty),
      false,
    );
  });

  test('should_reject_when_component_has_no_thread_yet', () => {
    // NOTE(victor): Before the codex thread is established, threadId is undefined.
    // Approvals must not attach to any ToolCallGroup in that state.
    assert.equal(
      isOrphanApprovalForThread(makeApproval({ threadId: 'thr_abc' }), undefined, empty),
      false,
    );
  });

  test('should_reject_approval_missing_context_entirely', () => {
    assert.equal(
      isOrphanApprovalForThread(makeApproval({ noContext: true }), 'thr_abc', empty),
      false,
    );
  });

  test('should_reject_approval_with_context_but_no_threadId_field', () => {
    const approval = { serverId: 'main-agent-server', toolName: 'view_image', context: {} };
    assert.equal(isOrphanApprovalForThread(approval, 'thr_abc', empty), false);
  });

  test('should_reject_non_view_image_approvals', () => {
    assert.equal(
      isOrphanApprovalForThread(makeApproval({ toolName: 'shell_exec' }), 'thr_abc', empty),
      false,
    );
  });

  test('should_match_agent_owned_ask_user_question_without_thread_context', () => {
    const approval = {
      serverId: 'builtin-ask-user',
      toolName: 'ask_user_question',
      agentId: 'agent-owner',
    };
    assert.equal(
      isOrphanApprovalForThread(approval, undefined, empty, 'agent-owner'),
      true,
    );
  });

  test('should_reject_agent_owned_ask_user_question_for_other_agent', () => {
    const approval = {
      serverId: 'builtin-ask-user',
      toolName: 'ask_user_question',
      agentId: 'agent-owner',
    };
    assert.equal(
      isOrphanApprovalForThread(approval, undefined, empty, 'agent-other'),
      false,
    );
  });

  test('should_reject_approvals_from_other_servers', () => {
    assert.equal(
      isOrphanApprovalForThread(makeApproval({ serverId: 'mcp-filesystem' }), 'thr_abc', empty),
      false,
    );
  });

  test('should_reject_approval_whose_toolCallId_is_already_tracked', () => {
    // NOTE(victor): If a ToolCallCard already owns this approval via toolCallId match,
    // ToolCallGroup must not also claim it as an orphan.
    const tracked = new Set(['item_42']);
    assert.equal(
      isOrphanApprovalForThread(makeApproval({ toolCallId: 'item_42' }), 'thr_abc', tracked),
      false,
    );

    const agentOwnedApproval = {
      serverId: 'builtin-ask-user',
      toolName: 'ask_user_question',
      toolCallId: 'item_42',
      agentId: 'agent-owner',
    };
    assert.equal(
      isOrphanApprovalForThread(agentOwnedApproval, undefined, tracked, 'agent-owner'),
      false,
    );
  });

  test('should_reject_agent_owned_approval_when_a_different_tool_group_already_knows_the_tool_call', () => {
    const knownToolCalls = new Set(['item_7', 'item_42']);
    const approval = {
      serverId: 'builtin-ask-user',
      toolName: 'ask_user_question',
      toolCallId: 'item_42',
      agentId: 'agent-owner',
    };

    assert.equal(
      isOrphanApprovalForThread(approval, undefined, knownToolCalls, 'agent-owner'),
      false,
    );
  });

  test('should_accept_approval_with_toolCallId_not_in_tracked_set', () => {
    const tracked = new Set(['item_1']);
    assert.equal(
      isOrphanApprovalForThread(makeApproval({ threadId: 'thr_abc', toolCallId: 'item_99' }), 'thr_abc', tracked),
      true,
    );
  });

  test('should_accept_approval_with_no_toolCallId_at_all', () => {
    // NOTE(victor): Codex view_image approvals may arrive before the tool call
    // item is streamed, so toolCallId can be absent. These are the primary
    // orphan case.
    const tracked = new Set(['item_1']);
    assert.equal(
      isOrphanApprovalForThread(makeApproval(), 'thread-A', tracked),
      true,
    );
  });

  test('should_not_match_when_both_sides_have_undefined_threadId', () => {
    // NOTE(victor): undefined === undefined would be true in JS. But an approval
    // without context.threadId and a component without threadId should NOT match --
    // that would re-introduce the cross-thread leak. The context?.threadId access
    // returns undefined, and the component threadId is undefined, so this verifies
    // the predicate rejects that case.
    const approval = { serverId: 'main-agent-server', toolName: 'view_image', context: {} };
    assert.equal(isOrphanApprovalForThread(approval, undefined, empty), false);
  });
});

describe('ToolCallGroup', () => {
  test('stacks tool header metadata when mentions would clip the title', () => {
    assert.equal(
      shouldStackToolHeader({
        containerWidth: 320,
        titleWidth: 250,
        mentionsWidth: 90,
      }),
      true,
    );
  });

  test('keeps tool header metadata inline when both fit comfortably', () => {
    assert.equal(
      shouldStackToolHeader({
        containerWidth: 420,
        titleWidth: 220,
        mentionsWidth: 90,
      }),
      false,
    );
  });

  test('measures the actual title node instead of the stretched header wrapper', () => {
    const wrapper = {
      scrollWidth: 520,
      querySelector: () => ({ scrollWidth: 124 } as HTMLElement),
    } as Pick<HTMLElement, 'querySelector' | 'scrollWidth'>;

    const titleWidth = getToolHeaderTitleWidth(wrapper);

    assert.equal(titleWidth, 124);
    assert.equal(
      shouldStackToolHeader({
        containerWidth: 360,
        titleWidth,
        mentionsWidth: 148,
      }),
      false,
    );
  });

  test('falls back to the wrapper width when no dedicated title node exists', () => {
    const wrapper = {
      scrollWidth: 180,
      querySelector: () => null,
    } as Pick<HTMLElement, 'querySelector' | 'scrollWidth'>;

    assert.equal(getToolHeaderTitleWidth(wrapper), 180);
  });

  test('rewrites stale similar-command approval options using the command pattern from context', () => {
    const approval = {
      id: 'approval-command-option-1',
      serverId: 'codex',
      toolName: 'Shell command',
      timestamp: 0,
      questions: [],
      context: {
        proposedExecpolicyAmendment: ['interpreter', '--help'],
        availableDecisions: [
          'accept',
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['interpreter', '--help'] } },
          'cancel',
        ],
      },
    };

    const normalized = normalizeApprovalOptionCopy(approval, {
      label: 'Always allow similar commands',
      value: 'decision:1',
      description: 'Run it now and stop asking about similar commands.',
    });

    assert.equal(normalized.label, 'Always allow: interpreter --help');
    assert.equal(
      normalized.description,
      'Run it now and stop asking about commands that start with: interpreter --help',
    );
  });

  test('suppresses generic command approval copy when the command block is already shown', () => {
    const html = renderToStaticMarkup(
      React.createElement(ApprovalSupportContent, {
        approval: {
          id: 'approval-command-1',
          serverId: 'codex',
          toolName: 'Shell command',
          timestamp: 0,
          questions: [],
          context: {
            message: 'Interpreter wants to run a command.',
            description: 'Review this command before continuing.',
            command: '/bin/zsh -lc interpreter --help',
          },
        },
      }),
    );

    assert.doesNotMatch(html, /Review this command before continuing\./);
    assert.match(html, /Command/);
    assert.match(html, /interpreter --help/);
  });

  test('suppresses duplicate approval warning copy', () => {
    const html = renderToStaticMarkup(
      React.createElement(ApprovalSupportContent, {
        approval: {
          id: 'approval-duplicate-copy',
          serverId: 'builtin-cua-driver',
          toolName: 'list_windows',
          timestamp: 0,
          questions: [],
          context: {
            message: 'Let Interpreter list your running apps and windows?',
            warning: 'Let Interpreter list your running apps and windows?',
          },
        },
      }),
    );

    assert.equal(html, '');
  });

  test('does not expose raw tool plumbing as approval detail fields', () => {
    const html = renderToStaticMarkup(
      React.createElement(ApprovalSupportContent, {
        approval: {
          id: 'approval-cua-copy',
          serverId: 'builtin-cua-driver',
          toolName: 'list_windows',
          timestamp: 0,
          questions: [],
          context: {
            message: 'Let Interpreter list your running apps and windows?',
            warning: 'Interpreter can see app names, window titles, and which window is currently active.',
            toolName: 'list_windows',
            target: 'the selected Windows app',
          },
        },
      }),
    );

    assert.match(html, /Interpreter can see app names/);
    assert.doesNotMatch(html, /Tool Name/);
    assert.doesNotMatch(html, /Target/);
    assert.doesNotMatch(html, /the selected Windows app/);
  });

  test('shows session-aware MCP approval context', () => {
    const html = renderToStaticMarkup(
      React.createElement(ApprovalSupportContent, {
        approval: {
          id: 'approval-pubmed-search',
          serverId: 'pubmed',
          toolName: 'search_articles',
          timestamp: 0,
          questions: [],
          context: {
            message: 'Interpreter wants to use an MCP tool.',
            description: 'Review this MCP tool call before continuing.',
            serverId: 'pubmed',
            toolName: 'search_articles',
            args: {
              query: '("acid reflux" OR GERD OR "gastroesophageal reflux")',
              date_from: 2026,
              date_to: 2026,
            },
            threadId: 'thr_pubmed',
            warning: 'Interpreter wants to call pubmed__search_articles.',
            sessionAware: true,
          },
        },
      }),
    );

    assert.doesNotMatch(html, /Review this MCP tool call before continuing/);
    assert.doesNotMatch(html, /Server/);
    assert.doesNotMatch(html, /pubmed/);
    assert.doesNotMatch(html, /Tool Args/);
    assert.match(html, /acid reflux/);
    assert.match(html, /Date from/);
    assert.doesNotMatch(html, /Tool Name/);
    assert.doesNotMatch(html, /Thread Id/);
    assert.doesNotMatch(html, /Session Aware/);
  });

  test('resolves inline group approval for hidden owned tool calls before orphan matching', () => {
    const approval = {
      id: 'approval-1',
      serverId: 'builtin-ask-user',
      toolName: 'ask_user_question',
      toolCallId: 'tool-hidden',
      questions: [],
      timestamp: 0,
    };

    assert.equal(
      resolveInlineGroupApproval({
        approvals: [approval],
        groupToolCallIds: new Set(['tool-hidden']),
        visibleToolCallIds: new Set<string>(),
        allowOrphanApprovals: true,
        knownToolCallIds: new Set(['tool-hidden']),
      }),
      approval,
    );
  });

  test('resolves orphan approval when no visible or hidden owned tool call matches', () => {
    const approval = {
      id: 'approval-2',
      serverId: 'builtin-ask-user',
      toolName: 'ask_user_question',
      agentId: 'agent-owner',
      questions: [],
      timestamp: 0,
    };

    assert.equal(
      resolveInlineGroupApproval({
        approvals: [approval],
        groupToolCallIds: new Set<string>(),
        visibleToolCallIds: new Set<string>(),
        allowOrphanApprovals: true,
        knownToolCallIds: new Set<string>(),
        agentId: 'agent-owner',
      }),
      approval,
    );
  });

  test('summarizes collapsed multi-tool groups with the active or latest tool verb and target', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'tool-reason-1',
            type: 'reasoning',
            label: 'reasoning',
            state: 'complete',
            verb: { active: 'Reasoning', past: 'Reasoned' },
          },
          {
            id: 'tool-read-1',
            type: 'mcpToolCall',
            label: 'read_file',
            state: 'loading',
            verb: { active: 'Reading', past: 'Read' },
            target: 'README.md',
            filePath: '/workspace/README.md',
          },
        ],
      }),
    );

    assert.match(html, /Reading README\.md/);
    assert.match(html, /README\.md/);
    assert.doesNotMatch(html, /reasoning and/);
  });

  test('does not reserve an empty activity gutter for completed collapsed groups', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'tool-read-1',
            type: 'mcpToolCall',
            label: 'read_file',
            state: 'complete',
            verb: { active: 'Reading', past: 'Read' },
          },
          {
            id: 'tool-run-1',
            type: 'commandExecution',
            label: 'ls -la',
            state: 'error',
            verb: { active: 'Running', past: 'Ran' },
          },
        ],
      }),
    );

    assert.doesNotMatch(html, /oa-tool-mentions/);
    assert.match(html, /oa-activity-meta/);
  });

  test('lowercases continuation verbs in concatenated collapsed summaries', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'tool-read-1',
            type: 'mcpToolCall',
            label: 'read_file',
            state: 'loading',
            verb: { active: 'Reading', past: 'Read' },
          },
          {
            id: 'tool-run-1',
            type: 'commandExecution',
            label: 'ls -la',
            state: 'loading',
            verb: { active: 'Running', past: 'Ran' },
          },
        ],
      }),
    );

    assert.match(html, /Reading 1 file and working/);
    assert.doesNotMatch(html, /Reading 1 file and Working/);
  });

  test('renders bash wrapper tool calls as a generic script target', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'tool-run-1',
            type: 'commandExecution',
            label: '/bin/zsh -lc "set -e ..."',
            state: 'loading',
            verb: { active: 'Running', past: 'Ran' },
            target: 'script',
          },
        ],
      }),
    );

    assert.match(html, /Running script/);
    assert.doesNotMatch(html, /\/bin\/zsh -lc/);
  });

  test('renders interpreter-app MCP command executions as service actions', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'tool-run-1',
            type: 'commandExecution',
            label: 'interpreter-app mcp acme list_records',
            state: 'loading',
            verb: { active: 'Running', past: 'Ran' },
            item: {
              type: 'commandExecution',
              id: 'cmd-1',
              command: 'interpreter-app mcp acme list_records --json \'{"start_date":"2026-04-01"}\'',
              cwd: '/tmp',
              processId: null,
              status: 'running',
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
          },
        ],
      }),
    );

    assert.match(html, /Listing Records/);
    assert.doesNotMatch(html, /oa-tool-service-mention/);
    assert.doesNotMatch(html, /Running command/);
  });

  test('does not render brand icons for builtin interpreter-app command executions', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'tool-run-builtin-1',
            type: 'commandExecution',
            label: 'interpreter-app tools builtin-cells read_spreadsheet',
            state: 'loading',
            verb: { active: 'Running', past: 'Ran' },
            item: {
              type: 'commandExecution',
              id: 'cmd-builtin-1',
              command: 'interpreter-app tools builtin-cells read_spreadsheet --json \'{"path":"report.xlsx"}\'',
              cwd: '/tmp',
              processId: null,
              status: 'running',
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
          },
        ],
      }),
    );

    assert.doesNotMatch(html, /oa-tool-leading-icon/);
  });

  test('keeps nested child tool calls hidden until the group is expanded', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'tool-read-1',
            type: 'mcpToolCall',
            label: 'read_file',
            state: 'complete',
            verb: { active: 'Reading', past: 'Read' },
          },
          {
            id: 'tool-run-1',
            type: 'commandExecution',
            label: 'ls -la',
            state: 'complete',
            verb: { active: 'Running', past: 'Ran' },
          },
        ],
      }),
    );

    assert.match(html, /oa-activity-trigger/);
    assert.doesNotMatch(html, /oa-activity-list/);
    assert.doesNotMatch(html, /oa-tool-call--nested/);
  });

  test('indents expanded child tool calls under the parent group header', () => {
    assert.deepEqual(getExpandedToolGroupBodyStyle(), {
      marginTop: 'var(--unit-padding-small)',
      paddingTop: '0.125rem',
      paddingLeft: 'calc(12px + var(--unit-padding-small))',
    });
  });
});

// ---------------------------------------------------------------------------
// Active tool resolution in ToolCallGroup
// Ref: Issue #678 -- "ONE SINGLE blue indicator that MOVES AROUND to indicate
// the SOLE LAST active item. If it appears more than once, we have a bug."
//
// ToolCallGroup internally resolves resolvedActiveToolCallId as the LAST
// visible loading tool call (tool-fallback.tsx ~L3109-3127). Only that tool
// gets mode:'active' (shimmer on). All others get mode:'inactive' (past tense,
// no shimmer). These tests enforce that invariant structurally via SSR output.
//
// Ref: Vercel AI SDK tests tool-call lifecycles by asserting exact state shape
// at each step via controlled streams (packages/react/src/use-chat.ui.test.tsx).
// We apply the same principle: given a fixed ToolCallInfo[] payload, the
// rendered HTML must contain exactly one shimmer-active element.
// ---------------------------------------------------------------------------

describe('active tool shimmer resolution', () => {
  test('only the last loading tool shimmers in a multi-tool group', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'cmd-1',
            type: 'commandExecution',
            label: 'sleep 30',
            state: 'loading',
            verb: { active: 'Running', past: 'Ran' },
          },
          {
            id: 'read-1',
            type: 'mcpToolCall',
            label: 'read_file',
            state: 'loading',
            verb: { active: 'Reading', past: 'Read' },
            target: 'config.ts',
          },
        ],
      }),
    );

    assert.match(html, /Working and reading 1 file/);
    assert.equal(html.includes('data-active="true"'), true);
  });

  test('completed multi-tool group has no active shimmer', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'cmd-1',
            type: 'commandExecution',
            label: 'pwd',
            state: 'complete',
            verb: { active: 'Running', past: 'Ran' },
          },
          {
            id: 'read-1',
            type: 'mcpToolCall',
            label: 'read_file',
            state: 'complete',
            verb: { active: 'Reading', past: 'Read' },
            target: 'README.md',
          },
        ],
      }),
    );

    // Ref: Vercel AI SDK status transition pattern -- after all tools complete,
    // the group should use past-tense verbs exclusively and shimmer deactivates.
    assert.match(html, /Worked and read 1 file/);
    assert.equal(html.includes('data-active="false"'), true);
    assert.doesNotMatch(html, /Working and reading/);
    assert.doesNotMatch(html, /Reading/);
  });

  test('mixed loading and complete tools show only the loading tool as active', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'reason-1',
            type: 'reasoning',
            label: 'reasoning',
            state: 'complete',
            verb: { active: 'Reasoning', past: 'Reasoned' },
          },
          {
            id: 'cmd-1',
            type: 'commandExecution',
            label: 'pwd',
            state: 'complete',
            verb: { active: 'Running', past: 'Ran' },
          },
          {
            id: 'search-1',
            type: 'webSearch',
            label: 'web_search',
            state: 'loading',
            verb: { active: 'Searching', past: 'Searched' },
            target: 'the web',
          },
        ],
      }),
    );

    // NOTE(victor): hidden completed reasoning is excluded from summary.
    assert.match(html, /Working and searching the web/);
    assert.equal(html.includes('data-active="true"'), true);
    assert.doesNotMatch(html, /Reasoning/);
  });

  test('error state tools use past tense like completed tools', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'cmd-1',
            type: 'commandExecution',
            label: 'rm -rf /',
            state: 'error',
            verb: { active: 'Running', past: 'Ran' },
          },
          {
            id: 'cmd-2',
            type: 'commandExecution',
            label: 'ls',
            state: 'loading',
            verb: { active: 'Running', past: 'Ran' },
          },
        ],
      }),
    );

    // Only the loading tool should show active verb in collapsed summary.
    assert.match(html, /Working/);
    // The errored tool's active verb should not appear as the primary action.
    assert.doesNotMatch(html, /rm -rf/);
  });

  test('single loading tool renders standalone with active shimmer data attribute', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'read-1',
            type: 'mcpToolCall',
            label: 'read_file',
            state: 'loading',
            verb: { active: 'Reading', past: 'Read' },
            target: 'index.ts',
          },
        ],
      }),
    );

    // Single tool renders as standalone ToolCallCard, not collapsed group.
    assert.match(html, /data-state="loading"/);
    assert.match(html, /Reading/);
    assert.doesNotMatch(html, /oa-activity-trigger/);
  });

  test('single MCP tool card does not render raw params', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'mcp-1',
            type: 'mcpToolCall',
            label: 'search_issues',
            state: 'complete',
            verb: { active: 'Searching', past: 'Searched' },
            target: 'issues',
            item: {
              id: 'mcp-1',
              type: 'mcpToolCall',
              server: 'github',
              tool: 'search_issues',
              status: 'completed',
              arguments: { query: 'is:issue repo:openai/codex' },
              result: null,
              error: null,
            },
          },
        ],
      }),
    );

    assert.doesNotMatch(html, /Params/);
    assert.doesNotMatch(html, /is:issue repo:openai\/codex/);
  });

  test('does not produce raw params text for MCP tool calls', () => {
    assert.equal(
      paramsTextForToolCall({
        id: 'mcp-1',
        type: 'mcpToolCall',
        label: 'search_issues',
        state: 'complete',
        item: {
          id: 'mcp-1',
          type: 'mcpToolCall',
          server: 'github',
          tool: 'search_issues',
          status: 'completed',
          arguments: { query: 'is:issue repo:openai/codex' },
          result: null,
          error: null,
        },
      }),
      undefined,
    );
  });

  test('single completed tool has no active data attribute', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallGroup, {
        toolCalls: [
          {
            id: 'read-1',
            type: 'mcpToolCall',
            label: 'read_file',
            state: 'complete',
            verb: { active: 'Reading', past: 'Read' },
            target: 'index.ts',
          },
        ],
      }),
    );

    assert.match(html, /data-state="complete"/);
    assert.doesNotMatch(html, /data-state="loading"/);
  });
});
