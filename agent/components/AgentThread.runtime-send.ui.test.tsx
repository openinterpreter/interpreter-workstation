import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ChatMessage } from '../../src/hooks/use-chat';
import i18n, { tr } from '../../src/i18n';
import {
  INSUFFICIENT_INTERPRETER_TOKENS_KEY,
  INSUFFICIENT_INTERPRETER_TOKENS_MESSAGE,
} from '../../src/lib/codex/errors';
import { clearAgentPendingInputs } from '../../src/stores/agentPendingInputStore';
import type { AgentModelConfig } from '../../shared/types/model';
import { AgentThread } from './AgentThread';

const rawSendMessage = vi.hoisted(() => vi.fn());
const stopGeneration = vi.hoisted(() => vi.fn());
const stopBackgroundProcess = vi.hoisted(() => vi.fn());
const showError = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
const getApiUrl = vi.hoisted(() => vi.fn(async (path: string) => path));
const reportActivity = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const consumeStartup = vi.hoisted(() => vi.fn(async () => ({
  success: true,
  startup: {
    initialMessage: 'Fill the selected client intake fields.',
    completionDisposition: 'keep_open' as const,
  },
})));

const useChatState = vi.hoisted(() => ({
  current: {
    messages: [] as ChatMessage[],
    streamingMessage: {
      id: 'assistant-draft',
      role: 'assistant' as const,
      serverMessageId: 'turn_active',
      parts: [],
    } satisfies ChatMessage,
    historyLoaded: true,
    isStreaming: true,
    error: null as string | null,
    errorDetails: null as string | null,
    errorEndpointBaseUrl: null as string | null,
    retrying: null as string | null,
    planChecklist: null,
    showError,
    sendMessage: rawSendMessage,
    stopGeneration,
    stopBackgroundProcess,
    threadId: 'thread_active',
  },
}));

vi.mock('../../src/hooks/use-chat', () => ({
  useChat: () => useChatState.current,
  textContent: (message: ChatMessage) => message.parts
    .map((part) => (part.kind === 'text' ? part.content : ''))
    .join(''),
}));

vi.mock('../../src/ipc', () => ({
  getApiUrl,
  agentTabs: {
    consumeStartup,
    reportActivity,
  },
  tts: {
    getSettings: vi.fn(async () => ({
      settings: {
        voiceResetEnabled: false,
        voiceResetPhrase: '',
      },
    })),
    onSettingsChanged: vi.fn(() => () => undefined),
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: false, user: null }),
}));

vi.mock('@/hooks/useInterpreterTokenUsage', () => ({
  useInterpreterTokenUsage: () => ({ totalCredits: null }),
}));

vi.mock('@/utils/supabase/client', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock('../../src/contexts/ToastContext', () => ({
  useToast: () => ({ showToast }),
}));

vi.mock('../hooks/useAgentNotifications', () => ({
  useAgentNotifications: () => undefined,
}));

vi.mock('./prompt-kit/thread-messages', () => ({
  ThreadMessages: () => <div data-testid="thread-messages" />,
}));

vi.mock('./composer/ContextPreview', () => ({
  setLastSentContext: vi.fn(),
}));

const modelConfig: AgentModelConfig = {
  provider: 'api',
  modelId: 'gpt-test',
  profileId: 'profile-test',
};

describe('AgentThread runtime sends', () => {
  beforeEach(() => {
    useChatState.current = {
      messages: [],
      streamingMessage: {
        id: 'assistant-draft',
        role: 'assistant',
        serverMessageId: 'turn_active',
        parts: [],
      } satisfies ChatMessage,
      historyLoaded: true,
      isStreaming: true,
      error: null,
      errorDetails: null,
      errorEndpointBaseUrl: null,
      retrying: null,
      planChecklist: null,
      showError,
      sendMessage: rawSendMessage,
      stopGeneration,
      stopBackgroundProcess,
      threadId: 'thread_active',
    };
    rawSendMessage.mockClear();
    stopGeneration.mockClear();
    stopBackgroundProcess.mockClear();
    showError.mockClear();
    showToast.mockClear();
    getApiUrl.mockClear();
    reportActivity.mockClear();
    consumeStartup.mockClear();
    clearAgentPendingInputs('agent-1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, turnId: 'turn_active' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
  });

  afterEach(() => {
    clearAgentPendingInputs('agent-1');
    vi.unstubAllGlobals();
  });

  test('routes follow-up runtime sends through steer while a turn is active', async () => {
    render(
      <AgentThread
        agentId="agent-1"
        callerToken="caller-token"
        workspacePath="/workspace"
        isVisible={true}
        modelConfig={modelConfig}
        onModelConfigUpdate={vi.fn()}
      />,
    );

    await act(async () => {
      window.dispatchEvent(new CustomEvent('agent-runtime:send', {
        detail: {
          tabId: 'agent-1',
          text: 'follow up while the model is still working',
          workspacePath: '/workspace',
        },
      }));
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/agent/chat/steer', expect.objectContaining({
        method: 'POST',
      }));
    });

    expect(rawSendMessage).not.toHaveBeenCalled();

    const steerCall = vi.mocked(fetch).mock.calls.find(([url, request]) => (
      url === '/api/agent/chat/steer' && request?.method === 'POST'
    ));
    expect(steerCall).toBeDefined();
    const [, request] = steerCall!;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      threadId: 'thread_active',
      turnId: 'turn_active',
      message: 'follow up while the model is still working',
      skills: [],
    });
  });

  test('consumes backend-owned startup payloads and sends the startup message', async () => {
    useChatState.current = {
      ...useChatState.current,
      streamingMessage: {
        id: 'assistant-idle',
        role: 'assistant',
        serverMessageId: 'turn_idle',
        parts: [],
      },
      isStreaming: false,
      threadId: '',
    };
    const onStartupConsumed = vi.fn();

    render(
      <AgentThread
        agentId="agent-1"
        callerToken="caller-token"
        startupId="startup-123"
        workspacePath="/workspace"
        isVisible={true}
        modelConfig={modelConfig}
        onModelConfigUpdate={vi.fn()}
        onStartupConsumed={onStartupConsumed}
      />,
    );

    await waitFor(() => {
      expect(consumeStartup).toHaveBeenCalledWith({
        agentId: 'agent-1',
        startupId: 'startup-123',
      });
    });

    expect(onStartupConsumed).toHaveBeenCalledWith('agent-1', 'startup-123');
    expect(rawSendMessage).toHaveBeenCalledWith(
      'Fill the selected client intake fields.',
      {
        attachments: undefined,
      },
    );
  });

  test('shows a toast when the thread reports exhausted Interpreter tokens', async () => {
    useChatState.current = {
      ...useChatState.current,
      isStreaming: false,
      error: INSUFFICIENT_INTERPRETER_TOKENS_MESSAGE,
    };

    render(
      <AgentThread
        agentId="agent-1"
        callerToken="caller-token"
        workspacePath="/workspace"
        isVisible={true}
        modelConfig={modelConfig}
        onModelConfigUpdate={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        INSUFFICIENT_INTERPRETER_TOKENS_MESSAGE,
        'error',
        8000,
      );
    });
  });

  test('reports compact agent activity through local agent tab IPC', async () => {
    useChatState.current = {
      ...useChatState.current,
      messages: [
        {
          id: 'assistant-one',
          role: 'assistant',
          parts: [{ kind: 'text', content: 'I found the selected form fields.' }],
        } satisfies ChatMessage,
      ],
      isStreaming: false,
    };

    render(
      <AgentThread
        agentId="agent-1"
        callerToken="caller-token"
        workspacePath="/workspace"
        isVisible={false}
        modelConfig={modelConfig}
        onModelConfigUpdate={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(reportActivity).toHaveBeenCalledWith({
        agentId: 'agent-1',
        activity: expect.objectContaining({
          label: 'New Agent',
          isRunning: false,
          lastMessagePreview: '',
        }),
      });
    });
    expect(reportActivity).toHaveBeenCalledWith({
      agentId: 'agent-1',
      activity: {
        messageCount: 1,
        unreadCount: 0,
      },
    });
  });

  test('localizes the insufficient-tokens toast to the active UI locale', async () => {
    useChatState.current = {
      ...useChatState.current,
      isStreaming: false,
      error: INSUFFICIENT_INTERPRETER_TOKENS_MESSAGE,
    };

    await i18n.changeLanguage('ru');
    try {
      const localized = tr(INSUFFICIENT_INTERPRETER_TOKENS_KEY);
      // Guard: the detection key still resolves to a non-English string under ru,
      // so a passing assertion below proves the toast follows the UI locale.
      expect(localized).not.toBe(INSUFFICIENT_INTERPRETER_TOKENS_MESSAGE);

      render(
        <AgentThread
          agentId="agent-1"
          callerToken="caller-token"
          workspacePath="/workspace"
          isVisible={true}
          modelConfig={modelConfig}
          onModelConfigUpdate={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(localized, 'error', 8000);
      });
    } finally {
      await i18n.changeLanguage('en');
    }
  });

});
