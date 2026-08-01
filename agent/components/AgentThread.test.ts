// ---------------------------------------------------------------------------
// Tests for the initial-message send guard in AgentThread.
//
// Bug being prevented:
//   When the Electron app is closed and reopened, agent tabs that had already
//   sent their initial message would re-send it. The root cause is a race
//   between layout persistence and async history loading:
//
//   1. createAgentTab() stores initialMessage + requestId on the Tab object.
//      See: src/utils/layoutHelpers.ts:121-137
//
//   2. saveLayoutState() serializes the full LayoutState (including those
//      fields) to localStorage. They are never cleared after the message
//      is sent.
//      See: src/utils/layoutPersistence.ts:16-24
//
//   3. On restart, loadLayoutState() restores tab.initialMessage and
//      tab.requestId from localStorage.
//      See: src/utils/layoutPersistence.ts:27-43
//
//   4. AgentThreadWithRuntime mounts with a fresh useRef(false) for
//      hasSentInitialRef. useChat initializes messages as [].
//      See: src/hooks/use-chat.ts:141
//
//   5. For tabs with a codexThreadId, useChat fetches history async
//      (src/hooks/use-chat.ts:159-217). But the initialMessage useEffect
//      fires synchronously on the first render when messages.length === 0,
//      BEFORE the fetch resolves.
//
//   Fix: the guard must also check historyLoaded (returned by useChat)
//   before allowing the send. historyLoaded is true immediately for new
//   tabs (no codexThreadId) and flips to true after fetch for restored tabs.
//
//   The misleading comment at src/components/layout/PersistentLayer.tsx:110-112
//   claimed that "hasSubmittedRef + thread.messages.length check" were
//   sufficient to prevent re-firing on restart. They were not.
// ---------------------------------------------------------------------------

import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  buildConversationRestartPrompt,
  getRecoveredStaleThreadIdForToast,
  getAgentThreadRuntimeKey,
  hasLockedAfterNextToolPendingInput,
  moveUnlockedAfterNextToolInputsToEndOfTurn,
  shouldConsumeProgrammaticStartup,
  shouldSendInitialMessage,
} from "./AgentThread";
import type { ChatMessage } from "../../src/hooks/use-chat";
import type { AgentPendingInput } from "../../src/stores/agentPendingInputStore";

type SendGuardParams = Parameters<typeof shouldSendInitialMessage>[0];

// NOTE(victor): BASE represents a brand-new agent tab on first mount --
// all conditions satisfied, historyLoaded true (no codexThreadId to fetch).
const BASE: SendGuardParams = {
  initialMessage: "Hello, help me with this",
  requestId: "req-abc123",
  hasSentInitial: false,
  messagesLength: 0,
  isStreaming: false,
  historyLoaded: true,
};

function params(overrides: Partial<SendGuardParams> = {}): SendGuardParams {
  return { ...BASE, ...overrides };
}

function makePendingInput(overrides: Partial<AgentPendingInput> = {}): AgentPendingInput {
  return {
    id: 'pending-1',
    agentId: 'agent-1',
    draftText: 'draft',
    previewText: 'preview',
    messageText: 'message',
    afterNextToolState: null,
    submittedText: null,
    workspacePath: null,
    contextSnapshot: null,
    stage: 'endOfTurn',
    createdAt: 1,
    ...overrides,
  };
}

describe("shouldSendInitialMessage", () => {
  // -------------------------------------------------------------------
  // Happy path: brand-new tab, first mount, no history to load
  // -------------------------------------------------------------------

  test("should_send_when_all_conditions_met_on_fresh_tab", () => {
    assert.equal(shouldSendInitialMessage(params()), true);
  });

  // -------------------------------------------------------------------
  // Guards: missing required fields
  // These are set by createAgentTab() (src/utils/layoutHelpers.ts:131-132)
  // and must both be present for the send to proceed.
  // -------------------------------------------------------------------

  test("should_not_send_when_initialMessage_is_undefined", () => {
    assert.equal(
      shouldSendInitialMessage(params({ initialMessage: undefined })),
      false,
    );
  });

  test("should_not_send_when_initialMessage_is_empty_string", () => {
    assert.equal(
      shouldSendInitialMessage(params({ initialMessage: "" })),
      false,
    );
  });

  test("should_not_send_when_requestId_is_undefined", () => {
    assert.equal(
      shouldSendInitialMessage(params({ requestId: undefined })),
      false,
    );
  });

  test("should_not_send_when_requestId_is_empty_string", () => {
    assert.equal(
      shouldSendInitialMessage(params({ requestId: "" })),
      false,
    );
  });

  // -------------------------------------------------------------------
  // Guard: hasSentInitial (maps to hasSentInitialRef in AgentThread)
  // This ref prevents double-sends within a single component lifecycle
  // but resets to false on remount (e.g. app restart).
  // -------------------------------------------------------------------

  test("should_not_send_when_already_sent", () => {
    assert.equal(
      shouldSendInitialMessage(params({ hasSentInitial: true })),
      false,
    );
  });

  // -------------------------------------------------------------------
  // Guard: messages already present
  // If useChat has messages (from history or prior turns), skip.
  // -------------------------------------------------------------------

  test("should_not_send_when_messages_already_exist", () => {
    assert.equal(
      shouldSendInitialMessage(params({ messagesLength: 3 })),
      false,
    );
  });

  // -------------------------------------------------------------------
  // Guard: currently streaming
  // -------------------------------------------------------------------

  test("should_not_send_when_streaming", () => {
    assert.equal(
      shouldSendInitialMessage(params({ isStreaming: true })),
      false,
    );
  });

  // -------------------------------------------------------------------
  // REGRESSION: app restart re-send
  //
  // Reproduces the exact state on restart:
  //   - initialMessage + requestId: persisted in localStorage
  //     (src/utils/layoutPersistence.ts:16-24)
  //   - hasSentInitial: false (fresh React ref after remount)
  //   - messagesLength: 0 (useChat starts with [], src/hooks/use-chat.ts:141)
  //   - isStreaming: false
  //   - historyLoaded: false (async fetch in progress, src/hooks/use-chat.ts:172)
  //
  // Without the historyLoaded guard, all other conditions pass and
  // sendMessage fires a duplicate.
  // -------------------------------------------------------------------

  test("should_not_send_when_history_has_not_loaded_yet", () => {
    assert.equal(
      shouldSendInitialMessage(params({ historyLoaded: false })),
      false,
      "Must wait for history to load before deciding to send -- " +
        "otherwise app restart re-fires the initial message",
    );
  });

  test("should_not_send_when_history_loading_even_with_all_other_conditions_met", () => {
    assert.equal(
      shouldSendInitialMessage(
        params({
          historyLoaded: false,
          messagesLength: 0,
          hasSentInitial: false,
          isStreaming: false,
        }),
      ),
      false,
      "Simulates exact restart state: persisted initialMessage, fresh ref, " +
        "empty messages (history not yet fetched), not streaming",
    );
  });
});

describe("shouldConsumeProgrammaticStartup", () => {
  test("consumes a backend-owned startup once history is ready", () => {
    assert.equal(
      shouldConsumeProgrammaticStartup({
        startupId: "startup-123",
        hasConsumedStartup: false,
        messagesLength: 0,
        isStreaming: false,
        historyLoaded: true,
      }),
      true,
    );
  });

  test("does not consume before history finishes loading", () => {
    assert.equal(
      shouldConsumeProgrammaticStartup({
        startupId: "startup-123",
        hasConsumedStartup: false,
        messagesLength: 0,
        isStreaming: false,
        historyLoaded: false,
      }),
      false,
    );
  });

  test("does not consume twice", () => {
    assert.equal(
      shouldConsumeProgrammaticStartup({
        startupId: "startup-123",
        hasConsumedStartup: true,
        messagesLength: 0,
        isStreaming: false,
        historyLoaded: true,
      }),
      false,
    );
  });

  test("still consumes when reopening an existing thread with loaded history", () => {
    assert.equal(
      shouldConsumeProgrammaticStartup({
        startupId: "startup-123",
        hasConsumedStartup: false,
        messagesLength: 4,
        isStreaming: false,
        historyLoaded: true,
      }),
      true,
    );
  });
});

describe("after-next-tool pending input helpers", () => {
  test("treats in-flight steers as blocking queued dispatch", () => {
    assert.equal(hasLockedAfterNextToolPendingInput([
      makePendingInput({
        stage: 'afterNextTool',
        afterNextToolState: 'submitting',
      }),
    ]), true);

    assert.equal(hasLockedAfterNextToolPendingInput([
      makePendingInput({
        stage: 'afterNextTool',
        afterNextToolState: 'local',
      }),
    ]), false);
  });

  test("requeues only local after-next-tool inputs when a turn ends", () => {
    const pendingInputs = moveUnlockedAfterNextToolInputsToEndOfTurn([
      makePendingInput({
        id: 'local-steer',
        stage: 'afterNextTool',
        afterNextToolState: 'local',
        submittedText: 'message',
      }),
      makePendingInput({
        id: 'submitted-steer',
        stage: 'afterNextTool',
        afterNextToolState: 'submitted',
        submittedText: 'message',
      }),
      makePendingInput({
        id: 'interrupting',
        stage: 'interrupting',
      }),
    ]);

    assert.deepEqual(pendingInputs, [
      makePendingInput({
        id: 'local-steer',
        stage: 'endOfTurn',
        afterNextToolState: null,
        submittedText: null,
      }),
      makePendingInput({
        id: 'submitted-steer',
        stage: 'afterNextTool',
        afterNextToolState: 'submitted',
        submittedText: 'message',
      }),
      makePendingInput({
        id: 'interrupting',
        stage: 'interrupting',
      }),
    ]);
  });
});

describe("getAgentThreadRuntimeKey", () => {
  test("uses the agent id before a conversation exists", () => {
    assert.equal(
      getAgentThreadRuntimeKey({ agentId: "agent-123" }),
      "agent-123",
    );
  });

  test("uses the existing conversation id when loading saved history", () => {
    assert.equal(
      getAgentThreadRuntimeKey({
        agentId: "agent-123",
        conversationId: "thread-456",
      }),
      "thread-456",
    );
  });
});

describe("getRecoveredStaleThreadIdForToast", () => {
  test("returns the initial thread id when history recovered to a fresh chat", () => {
    assert.equal(
      getRecoveredStaleThreadIdForToast({
        initialThreadId: "thread-stale",
        historyLoaded: true,
        threadId: null,
        messagesLength: 0,
        error: null,
      }),
      "thread-stale",
    );
  });

  test("returns null while history is still loading", () => {
    assert.equal(
      getRecoveredStaleThreadIdForToast({
        initialThreadId: "thread-stale",
        historyLoaded: false,
        threadId: null,
        messagesLength: 0,
        error: null,
      }),
      null,
    );
  });

  test("returns null for a normal restored thread", () => {
    assert.equal(
      getRecoveredStaleThreadIdForToast({
        initialThreadId: "thread-ok",
        historyLoaded: true,
        threadId: "thread-ok",
        messagesLength: 0,
        error: null,
      }),
      null,
    );
  });

  test("returns null once chat messages already exist", () => {
    assert.equal(
      getRecoveredStaleThreadIdForToast({
        initialThreadId: "thread-stale",
        historyLoaded: true,
        threadId: null,
        messagesLength: 1,
        error: null,
      }),
      null,
    );
  });
});

describe("buildConversationRestartPrompt", () => {
  test("formats visible user and assistant messages into a plain transcript", () => {
    const messages: ChatMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ kind: "text", content: "Need help with this repo." }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ kind: "text", content: "Sure. What broke?" }],
      },
    ];

    assert.equal(
      buildConversationRestartPrompt(messages),
      "Continue this conversation in a fresh chat. Here is the conversation so far:\n\nUser:\nNeed help with this repo.\n\nAssistant:\nSure. What broke?",
    );
  });

  test("strips workstation context and skips hidden system messages", () => {
    const messages: ChatMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{
          kind: "text",
          content: "<workstation-context>\nworkspace: /tmp/project\n</workstation-context>\nplease continue",
        }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ kind: "text", content: "<system-notification source=\"codex\">foo</system-notification>" }],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [{ kind: "text", content: "<compaction reason=\"context_limit\">hidden</compaction>" }],
      },
    ];

    assert.equal(
      buildConversationRestartPrompt(messages),
      "Continue this conversation in a fresh chat. Here is the conversation so far:\n\nUser:\nplease continue",
    );
  });
});
