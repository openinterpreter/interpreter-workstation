import { describe, test, expect, beforeEach, mock } from 'bun:test';
import EventEmitter from 'node:events';

// NOTE(victor): connection mock replaces the Baileys WASocket singleton.
// Real connection.ts creates a socket via makeWASocket() from
// @whiskeysockets/baileys/lib/Socket/index.js which chains:
//   makeCommunitiesSocket -> makeChatsSocket -> makeSocket -> makeMessagesRecvSocket -> makeMessagesSocket
// The connectionEvents emitter is the bridge's only integration point --
// it fires 'message' with (CachedMessage, WAMessage?) on every messages.upsert.
// getSocket() returns the live WASocket; we stub it as truthy for forwardWhatsAppAssistantMessage.
// getPhoneNumber() returns sock.user.id split at '@' and ':', set on connection.update 'open'.
const fakeConnectionEvents = new EventEmitter();
let fakePhoneNumber = '+15551234567';

// NOTE(victor): normalize and extract are NOT mocked -- real implementations are used.
// The bridge calls jidToPhone() (normalize.ts) inside isSelfChat() to compare
// chatId digits against getPhoneNumber() digits. The real jidToPhone uses
// WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i to extract phone.
// The bridge calls extractDownloadableMedia() (extract.ts) only when a raw WAMessage
// is passed as the second arg to connectionEvents 'message'. Our test emits only
// CachedMessage (no rawMessage), so extract is never invoked in this test suite.

// NOTE(victor): outbound mock mirrors sendWhatsAppMessageWithRetry from outbound.ts.
// The real function parses markdown links for attachments, sends via sock.sendMessage(),
// and invokes options.onBeforeSend/onSent hooks per part (see outbound.ts lines 376-478).
// The bridge's forwardWhatsAppAssistantMessage relies on these hooks to register echo
// suppression via markOutboundEchoToIgnore (bridge lines 633-641).
// Our mock invokes the same hooks with a realistic OutboundSendPart shape so that
// echo suppression is exercised end-to-end.
const sendMessageMock = mock(async (params: any) => {
  const text = params.text?.trim() || '';
  const part = {
    kind: 'text' as const,
    textForEcho: text,
    messageId: `mock-msg-${Date.now()}-${Math.random()}`,
  };
  params.options?.onBeforeSend?.(part);
  params.options?.onSent?.(part);
  return { parts: [part] };
});
const broadcastSpy = mock(() => {});
const notifySpy = mock(() => {});

mock.module('./whatsappBridgeDependencies', () => ({
  connectionEvents: fakeConnectionEvents,
  getPhoneNumber: () => fakePhoneNumber,
  getSocket: () => ({}),
  sendWhatsAppMessageWithRetry: sendMessageMock,
  broadcastEvent: broadcastSpy,
  notifyAgent: notifySpy,
}));

const {
  initializeWhatsAppBridge,
  onWhatsAppBridgeTabCreated,
  bindWhatsAppBridgeConversation,
  forwardWhatsAppAssistantMessage,
  closeWhatsAppBridgeSession,
} = await import('./whatsappBridge');

const BATCH_FLUSH_MS = 1_500;
const SELF_JID = '15551234567@s.whatsapp.net';

function makeSelfChatMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    chatId: SELF_JID,
    from: 'You',
    fromId: SELF_JID,
    timestamp: Date.now(),
    body: 'Hello from self-chat',
    isOutgoing: true,
    isGroup: false,
    ...overrides,
  };
}

function waitForBatchFlush(): Promise<void> {
  return new Promise(r => setTimeout(r, BATCH_FLUSH_MS));
}

function resetBridgeSession(): void {
  fakeConnectionEvents.emit('logged_out');
}

function extractRequestId(): string {
  const call = broadcastSpy.mock.calls.find(
    (c: any[]) => c[0] === 'agent-tab:create-requested',
  );
  return call?.[1]?.requestId;
}

initializeWhatsAppBridge();

describe('whatsappBridge', () => {
  beforeEach(() => {
    broadcastSpy.mockClear();
    notifySpy.mockClear();
    sendMessageMock.mockClear();
    fakePhoneNumber = '+15551234567';
    resetBridgeSession();
  });

  // ===========================================================================
  // Self-chat detection
  // ===========================================================================
  describe('self-chat detection', () => {
    test('should accept self-chat message with isOutgoing=true', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ isOutgoing: true }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledWith(
        'agent-tab:create-requested',
        expect.objectContaining({ channel: 'whatsapp' }),
      );
    });

    test('should accept self-chat message with isOutgoing=false (other device)', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ isOutgoing: false }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledWith(
        'agent-tab:create-requested',
        expect.objectContaining({ channel: 'whatsapp' }),
      );
    });

    test('should reject message from a different user', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({
        chatId: '15559999999@s.whatsapp.net',
        fromId: '15559999999@s.whatsapp.net',
      }));
      await waitForBatchFlush();
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    test('should reject message from a group JID', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({
        chatId: '120363012345678901@g.us',
        isGroup: true,
      }));
      await waitForBatchFlush();
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    test('should reject when own phone number is unavailable', async () => {
      fakePhoneNumber = '';
      fakeConnectionEvents.emit('message', makeSelfChatMessage());
      await waitForBatchFlush();
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    test('should match phone number with + prefix against JID digits', async () => {
      fakePhoneNumber = '+15551234567';
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ chatId: '15551234567@s.whatsapp.net' }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
    });

    test('should match phone number without + prefix', async () => {
      fakePhoneNumber = '15551234567';
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ chatId: '15551234567@s.whatsapp.net' }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Message filtering
  // ===========================================================================
  describe('message filtering', () => {
    test('should reject empty body', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: '' }));
      await waitForBatchFlush();
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    test('should reject whitespace-only body', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: '   \n\t  ' }));
      await waitForBatchFlush();
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    test('should accept [media] placeholder body as fallback', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: '[media]' }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledWith(
        'agent-tab:create-requested',
        expect.objectContaining({ channel: 'whatsapp' }),
      );
    });

    test('should accept normal text body', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'Do my taxes' }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Broadcast payload shape
  // ===========================================================================
  describe('broadcast payload', () => {
    test('should contain all required fields in agent-tab:create-requested', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'payload test' }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledWith(
        'agent-tab:create-requested',
        expect.objectContaining({
          requestId: expect.any(String),
          initialMessage: 'payload test',
          timeout: 120000,
          activate: true,
          channel: 'whatsapp',
          channelLabel: 'WhatsApp',
          channelThreadId: SELF_JID,
        }),
      );
    });

    test('requestId should have whatsapp-bridge- prefix', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'prefix test' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      expect(requestId).toBeDefined();
      expect(requestId.startsWith('whatsapp-bridge-')).toBe(true);
    });
  });

  // ===========================================================================
  // Session lifecycle
  // ===========================================================================
  describe('session lifecycle', () => {
    test('should create a new session on first inbound message', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'first' }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
    });

    test('should not create duplicate session for second message', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'first msg' }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledTimes(1);

      broadcastSpy.mockClear();
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'second msg' }));
      await waitForBatchFlush();
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    test('should queue follow-up messages while session is pending', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'initial' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();

      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'follow-up' }));
      await waitForBatchFlush();

      onWhatsAppBridgeTabCreated(requestId, 'agent-queue-test');
      expect(notifySpy).toHaveBeenCalledWith('agent-queue-test', 'follow-up', 'whatsapp');
    });

    test('should flush all pending messages on promotion', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'init' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();

      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'queued-a' }));
      await waitForBatchFlush();
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'queued-b' }));
      await waitForBatchFlush();

      onWhatsAppBridgeTabCreated(requestId, 'agent-flush-test');
      expect(notifySpy).toHaveBeenCalledTimes(2);
      const notifiedTexts = notifySpy.mock.calls.map((c: any[]) => c[1]);
      expect(notifiedTexts).toContain('queued-a');
      expect(notifiedTexts).toContain('queued-b');
    });

    test('should immediately notify agent for messages after promotion', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'create' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-live');

      notifySpy.mockClear();
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'live msg' }));
      await waitForBatchFlush();
      expect(notifySpy).toHaveBeenCalledWith('agent-live', 'live msg', 'whatsapp');
    });

    test('should continue dispatching when self-chat JID includes device suffix', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'create-device-jid' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-device-jid');

      notifySpy.mockClear();
      fakeConnectionEvents.emit('message', makeSelfChatMessage({
        chatId: '15551234567:42@s.whatsapp.net',
        fromId: '15551234567:42@s.whatsapp.net',
        body: 'live msg device jid',
      }));
      await waitForBatchFlush();
      expect(notifySpy).toHaveBeenCalledWith('agent-device-jid', 'live msg device jid', 'whatsapp');
    });

    test('should silently drop messages from different chatId (single session MVP)', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'session owner' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-mvp');

      notifySpy.mockClear();
      broadcastSpy.mockClear();

      fakePhoneNumber = '+19998887777';
      fakeConnectionEvents.emit('message', makeSelfChatMessage({
        chatId: '19998887777@s.whatsapp.net',
        fromId: '19998887777@s.whatsapp.net',
        body: 'different user',
      }));
      await waitForBatchFlush();

      expect(notifySpy).not.toHaveBeenCalled();
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    test('should allow new session after logged_out', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'before logout' }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      broadcastSpy.mockClear();

      resetBridgeSession();

      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'after logout' }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledWith(
        'agent-tab:create-requested',
        expect.objectContaining({ initialMessage: 'after logout' }),
      );
    });

    test('onWhatsAppBridgeTabCreated should ignore mismatched requestId', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'mismatch' }));
      await waitForBatchFlush();

      onWhatsAppBridgeTabCreated('wrong-request-id', 'agent-wrong');

      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'follow-up-mismatch' }));
      await waitForBatchFlush();
      expect(notifySpy).not.toHaveBeenCalled();
    });

    test('onWhatsAppBridgeTabCreated should not double-promote', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'double' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();

      onWhatsAppBridgeTabCreated(requestId, 'agent-first');
      onWhatsAppBridgeTabCreated(requestId, 'agent-second');

      notifySpy.mockClear();
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'after double promote' }));
      await waitForBatchFlush();
      expect(notifySpy).toHaveBeenCalledWith('agent-first', 'after double promote', 'whatsapp');
    });
  });

  // ===========================================================================
  // closeWhatsAppBridgeSession
  // ===========================================================================
  describe('closeWhatsAppBridgeSession', () => {
    test('should close active session with matching agentId', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'close-test' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-close');

      const closed = closeWhatsAppBridgeSession({ agentId: 'agent-close' });
      expect(closed).toBe(true);

      broadcastSpy.mockClear();
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'after close' }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledWith(
        'agent-tab:create-requested',
        expect.objectContaining({ initialMessage: 'after close' }),
      );
    });

    test('should not close session with wrong agentId', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'wrong-close' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-real');

      const closed = closeWhatsAppBridgeSession({ agentId: 'agent-wrong' });
      expect(closed).toBe(false);
    });

    test('should return false when no session exists', () => {
      const closed = closeWhatsAppBridgeSession({ agentId: 'no-session' });
      expect(closed).toBe(false);
    });

    test('should close with matching conversationId', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'conv-close' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-conv');
      bindWhatsAppBridgeConversation('agent-conv', 'conv-123');

      const closed = closeWhatsAppBridgeSession({ conversationId: 'conv-123' });
      expect(closed).toBe(true);
    });

    test('should not close with wrong conversationId', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'conv-wrong' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-conv2');
      bindWhatsAppBridgeConversation('agent-conv2', 'conv-real');

      const closed = closeWhatsAppBridgeSession({ conversationId: 'conv-fake' });
      expect(closed).toBe(false);
    });
  });

  // ===========================================================================
  // bindWhatsAppBridgeConversation
  // ===========================================================================
  describe('bindWhatsAppBridgeConversation', () => {
    test('should bind conversationId to active session', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'bind-test' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-bind');

      bindWhatsAppBridgeConversation('agent-bind', 'conv-bind');

      const sent = await forwardWhatsAppAssistantMessage('conv-bind', 'reply');
      expect(sent).toBe(true);
    });

    test('should not bind when agentId does not match', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'bind-mismatch' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-real-bind');

      bindWhatsAppBridgeConversation('agent-wrong-bind', 'conv-wrong');

      const sent = await forwardWhatsAppAssistantMessage('conv-wrong', 'nope');
      expect(sent).toBe(false);
    });

    test('should do nothing when no active session exists', () => {
      bindWhatsAppBridgeConversation('agent-none', 'conv-none');
      // Should not throw
    });
  });

  // ===========================================================================
  // forwardWhatsAppAssistantMessage
  // ===========================================================================
  describe('forwardWhatsAppAssistantMessage', () => {
    test('should send outbound message via sendWhatsAppMessageWithRetry', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'fwd-test' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-fwd');
      bindWhatsAppBridgeConversation('agent-fwd', 'conv-fwd');

      sendMessageMock.mockClear();
      const sent = await forwardWhatsAppAssistantMessage('conv-fwd', 'agent says hi');
      expect(sent).toBe(true);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock.mock.calls[0][0].text).toBe('agent says hi');
      expect(sendMessageMock.mock.calls[0][0].chatId).toBe(SELF_JID);
    });

    test('should return false for empty text', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'empty-fwd' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-empty-fwd');
      bindWhatsAppBridgeConversation('agent-empty-fwd', 'conv-empty');

      const sent = await forwardWhatsAppAssistantMessage('conv-empty', '   ');
      expect(sent).toBe(false);
    });

    test('should return false for mismatched conversationId', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'mismatch-fwd' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-mis-fwd');
      bindWhatsAppBridgeConversation('agent-mis-fwd', 'conv-real');

      const sent = await forwardWhatsAppAssistantMessage('conv-wrong', 'nope');
      expect(sent).toBe(false);
    });

    test('should return false when no active session', async () => {
      const sent = await forwardWhatsAppAssistantMessage('conv-none', 'hello');
      expect(sent).toBe(false);
    });
  });

  // ===========================================================================
  // Outbound echo suppression
  // ===========================================================================
  describe('outbound echo suppression', () => {
    test('should suppress inbound echo matching forwarded text signature', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'echo-setup' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-echo');
      bindWhatsAppBridgeConversation('agent-echo', 'conv-echo');

      await forwardWhatsAppAssistantMessage('conv-echo', 'agent-unique-reply-001');

      notifySpy.mockClear();
      broadcastSpy.mockClear();

      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'agent-unique-reply-001' }));
      await waitForBatchFlush();

      expect(notifySpy).not.toHaveBeenCalled();
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    test('should suppress echo when inbound JID has a device suffix', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'echo-suffix-setup' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-echo-suffix');
      bindWhatsAppBridgeConversation('agent-echo-suffix', 'conv-echo-suffix');

      await forwardWhatsAppAssistantMessage('conv-echo-suffix', 'agent-unique-reply-004');

      notifySpy.mockClear();
      broadcastSpy.mockClear();

      fakeConnectionEvents.emit('message', makeSelfChatMessage({
        chatId: '15551234567:42@s.whatsapp.net',
        fromId: '15551234567:42@s.whatsapp.net',
        body: 'agent-unique-reply-004',
      }));
      await waitForBatchFlush();

      expect(notifySpy).not.toHaveBeenCalled();
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    test('should NOT suppress inbound message with different text', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'echo-diff-setup' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-echo-diff');
      bindWhatsAppBridgeConversation('agent-echo-diff', 'conv-echo-diff');

      await forwardWhatsAppAssistantMessage('conv-echo-diff', 'agent-unique-reply-002');

      notifySpy.mockClear();

      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'user typed something new' }));
      await waitForBatchFlush();

      expect(notifySpy).toHaveBeenCalledWith('agent-echo-diff', 'user typed something new', 'whatsapp');
    });

    test('should suppress echo by message ID when mock returns matching ID', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'echo-id-setup' }));
      await waitForBatchFlush();
      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-echo-id');
      bindWhatsAppBridgeConversation('agent-echo-id', 'conv-echo-id');

      let capturedMessageId = '';
      sendMessageMock.mockImplementationOnce(async (params: any) => {
        const text = params.text?.trim() || '';
        capturedMessageId = 'echo-id-test-fixed';
        const part = { kind: 'text', textForEcho: text, messageId: capturedMessageId };
        params.options?.onBeforeSend?.(part);
        params.options?.onSent?.(part);
        return { parts: [part] };
      });

      await forwardWhatsAppAssistantMessage('conv-echo-id', 'unique-reply-id-003');

      notifySpy.mockClear();
      broadcastSpy.mockClear();

      fakeConnectionEvents.emit('message', makeSelfChatMessage({
        id: capturedMessageId,
        body: 'unique-reply-id-003',
      }));
      await waitForBatchFlush();

      expect(notifySpy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Inbound batching
  // ===========================================================================
  describe('inbound batching', () => {
    test('should coalesce rapid messages into a single dispatch', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'batch-line-1' }));
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'batch-line-2' }));
      await waitForBatchFlush();

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      const payload = broadcastSpy.mock.calls[0][1] as any;
      expect(payload.initialMessage).toContain('batch-line-1');
      expect(payload.initialMessage).toContain('batch-line-2');
    });

    test('should join batched text parts with newline', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'line-a' }));
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'line-b' }));
      await waitForBatchFlush();

      const payload = broadcastSpy.mock.calls[0][1] as any;
      expect(payload.initialMessage).toBe('line-a\nline-b');
    });

    test('should dispatch separately when messages arrive after batch flush', async () => {
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'first-batch' }));
      await waitForBatchFlush();
      expect(broadcastSpy).toHaveBeenCalledTimes(1);

      const requestId = extractRequestId();
      onWhatsAppBridgeTabCreated(requestId, 'agent-batch-sep');

      notifySpy.mockClear();
      fakeConnectionEvents.emit('message', makeSelfChatMessage({ body: 'second-batch' }));
      await waitForBatchFlush();
      expect(notifySpy).toHaveBeenCalledWith('agent-batch-sep', 'second-batch', 'whatsapp');
    });
  });
});
