import { afterEach, describe, expect, test } from 'bun:test';

import {
  buildStructuredAgentRuntimeLogEvent,
  ensureOpenAIOAuthAccountReady,
  formatStructuredAgentRuntimeLogLine,
  logAgentTranscriptEvent,
  resolveCodexProfileFromModelConfig,
  resolveAgentInterpreterCliTransport,
  resolveCodexProfileForStreamRequest,
  runCodexAgentTurn,
  selectAgentRuntimeLogEvent,
  summarizeVisibleRuntimeSkills,
} from './codexRuntime';
import { overlaySessionManager } from '../overlaySessionManager';
import { agentTabManager } from '../agentTabManager';
import { clearConfigCache, setConfigOverride, type AppConfig } from '../configStore';
import type { JsonValue } from '../handlers/codex-generated-types/serde_json/JsonValue';
import {
  SERVER_METHOD,
  type AppServerNotification,
  type NotificationOfMethod,
} from '../../src/lib/codex/protocol';
import type { CodexService, StreamEvent } from '../../src/lib/codex/service';
import {
  buildAppManagedModelProviderId,
  type Profile as CodexProfile,
} from '../../src/lib/codex/profiles';

const TEST_CALLER_TOKENS = [
  'test-overlay-caller-1',
  'test-overlay-caller-2',
];
const LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR =
  'stream disconnected before completion: Error rendering prompt with jinja template: "This model only supports single tool-calls at once!". This is usually an issue with the model\'s chat template.';
const IMAGE_INPUT_ROUTE_UNAVAILABLE_MESSAGE =
  'This model is not available through an image-capable route, so it cannot inspect screenshots or images.';
const INVALID_INPUT_UNION_ERROR_MESSAGE = JSON.stringify({
  error: {
    message: "Invalid type for 'input'.",
    type: 'invalid_request_error',
    param: 'input',
    code: 'invalid_union',
  },
});

afterEach(() => {
  overlaySessionManager.setDriver(null);
  overlaySessionManager.clearAll();
  setConfigOverride(null);
  clearConfigCache();
  delete process.env.INTERPRETER_INJECT_APP_TOOLS_AS_MCP;
  delete process.env.INTERPRETER_INJECT_APP_TOOLS_AS_MCP_SERVERS;
  delete process.env.WORKSTATION_TEST_OPENAI_API_KEY;
  for (const callerToken of TEST_CALLER_TOKENS) {
    agentTabManager.disposeBinding(callerToken);
  }
});

describe('selectAgentRuntimeLogEvent', () => {
  test('keeps thread, turn, and meaningful lifecycle notifications', () => {
    expect(
      selectAgentRuntimeLogEvent({
        kind: 'thread',
        threadId: 'thread-1',
      } as any),
    ).toEqual({
      kind: 'thread',
      threadId: 'thread-1',
    });

    expect(
      selectAgentRuntimeLogEvent({
        kind: 'turn',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'in_progress',
      } as any),
    ).toEqual({
      kind: 'turn',
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'in_progress',
    });

    expect(
      selectAgentRuntimeLogEvent({
        kind: 'notification',
        notification: {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'cmd-1',
              type: 'commandExecution',
              status: 'completed',
              command: ['interpreter', 'tools', 'list'],
            },
          },
        },
      } as any),
    ).toEqual({
      kind: 'notification',
      method: 'item/completed',
      notification: {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'cmd-1',
            type: 'commandExecution',
            status: 'completed',
            command: ['interpreter', 'tools', 'list'],
          },
        },
      },
    });
  });

  test('drops high-volume delta notifications', () => {
    expect(
      selectAgentRuntimeLogEvent({
        kind: 'notification',
        notification: {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'msg-1',
            delta: 'hello',
          },
        },
      } as any),
    ).toBeNull();

    expect(
      selectAgentRuntimeLogEvent({
        kind: 'notification',
        notification: {
          method: 'item/commandExecution/outputDelta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'cmd-1',
            delta: 'stdout',
          },
        },
      } as any),
    ).toBeNull();
  });

  test('keeps stream errors and thread metadata updates', () => {
    expect(
      selectAgentRuntimeLogEvent({
        kind: 'notification',
        notification: {
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            message: 'boom',
          },
        },
      } as any),
    ).toEqual({
      kind: 'notification',
      method: 'error',
      notification: {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          message: 'boom',
        },
      },
    });

    expect(
      selectAgentRuntimeLogEvent({
        kind: 'notification',
        notification: {
          method: 'thread/name/updated',
          params: {
            threadId: 'thread-1',
            name: 'Helpful thread',
          },
        },
      } as any),
    ).toEqual({
      kind: 'notification',
      method: 'thread/name/updated',
      notification: {
        method: 'thread/name/updated',
        params: {
          threadId: 'thread-1',
          name: 'Helpful thread',
        },
      },
    });
  });

  test('adds normalized turn error summaries to structured error events', () => {
    expect(
      buildStructuredAgentRuntimeLogEvent({
        kind: 'notification',
        notification: {
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            willRetry: false,
            error: {
              message: 'High demand right now.',
              codexErrorInfo: {
                responseTooManyFailedAttempts: { httpStatusCode: 500 },
              },
              additionalDetails: 'provider trace',
            },
          },
        },
      } as any),
    ).toEqual({
      kind: 'notification',
      method: 'error',
      notification: {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: false,
          error: {
            message: 'High demand right now.',
            codexErrorInfo: {
              responseTooManyFailedAttempts: { httpStatusCode: 500 },
            },
            additionalDetails: 'provider trace',
          },
        },
      },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
      errorSummary: {
        codexErrorInfo: 'responseTooManyFailedAttempts',
        httpStatusCode: 500,
        rawMessagePreview: 'High demand right now.',
        formattedMessagePreview: 'High demand right now.',
        formattedChanged: false,
        additionalDetailsPreview: 'provider trace',
      },
    });
  });

  test('formats concise session-log lines for tool and error events', () => {
    expect(
      formatStructuredAgentRuntimeLogLine({
        kind: 'notification',
        notification: {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'call-1',
              type: 'mcpToolCall',
              tool: 'read_file',
              server: 'builtin-fs',
            },
          },
        },
      } as any),
    ).toEqual({
      level: 'log',
      prefix: 'TOOL',
      message: 'phase=dispatch threadId=thread-1 turnId=turn-1 toolCallId=call-1 tool=read_file server=builtin-fs status=in_progress',
    });

    expect(
      formatStructuredAgentRuntimeLogLine({
        kind: 'notification',
        notification: {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'cmd-1',
              type: 'commandExecution',
              status: 'completed',
              command: '/bin/zsh -lc "sed -n \'1,40p\' README.md"',
              aggregatedOutput: '# Interpreter\n\nDeveloper app',
              exitCode: 0,
              durationMs: 84,
            },
          },
        },
      } as any),
    ).toEqual({
      level: 'log',
      prefix: 'CMD',
      message: 'phase=result threadId=thread-1 turnId=turn-1 itemId=cmd-1 status=completed ok=true command="/bin/zsh -lc \\"sed -n \'1,40p\' README.md\\"" exitCode=0 durationMs=84 outputPreview="# Interpreter Developer app"',
    });

    expect(
      formatStructuredAgentRuntimeLogLine({
        kind: 'notification',
        notification: {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'msg-1',
              type: 'agentMessage',
              phase: 'final_answer',
              text: 'Created the README and updated the examples section.',
            },
          },
        },
      } as any),
    ).toEqual({
      level: 'log',
      prefix: 'AGENT',
      message: 'kind=assistant_message phase=completed threadId=thread-1 turnId=turn-1 itemId=msg-1 messagePhase=final_answer chars=52 preview="Created the README and updated the examples section."',
    });

    expect(
      formatStructuredAgentRuntimeLogLine({
        kind: 'notification',
        notification: {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'user-1',
              type: 'userMessage',
              content: [{ type: 'text', text: 'Please audit the logging path.', text_elements: [] }],
            },
          },
        },
      } as any),
    ).toEqual({
      level: 'log',
      prefix: 'AGENT',
      message: 'kind=user_message phase=completed threadId=thread-1 turnId=turn-1 itemId=user-1 chars=30 preview="Please audit the logging path."',
    });

    const streamErrorLogLine = formatStructuredAgentRuntimeLogLine({
      kind: 'notification',
      notification: {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: false,
          error: {
            message: 'High demand right now.',
            codexErrorInfo: {
              responseTooManyFailedAttempts: { httpStatusCode: 500 },
            },
            additionalDetails: null,
          },
        },
      },
    } as any);

    expect(streamErrorLogLine).not.toBeNull();
    expect(streamErrorLogLine).toMatchObject({
      level: 'error',
      prefix: 'AGENT_EVT',
    });
    expect(streamErrorLogLine?.message).toContain('kind=stream_error');
    expect(streamErrorLogLine?.message).toContain('willRetry=false');
    expect(streamErrorLogLine?.message).toContain(
      'codexErrorInfo=responseTooManyFailedAttempts httpStatusCode=500',
    );
    expect(streamErrorLogLine?.message).toContain(
      'rawMessagePreview="High demand right now."',
    );
    expect(streamErrorLogLine?.message).toContain(
      'formattedMessagePreview="High demand right now."',
    );
    expect(streamErrorLogLine?.message).toContain('formattedChanged=false');

    const chatGptRefreshTokenEvent: StreamEvent = {
      kind: 'notification',
      notification: {
        method: 'error',
        params: {
          threadId: 'thread-chatgpt-refresh',
          turnId: 'turn-chatgpt-refresh',
          willRetry: false,
          error: {
            message: 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
            codexErrorInfo: 'unauthorized',
            additionalDetails: null,
          },
        },
      },
    };
    const chatGptRefreshTokenLogLine = formatStructuredAgentRuntimeLogLine(
      chatGptRefreshTokenEvent,
      { isChatGptProfile: true },
    );

    expect(chatGptRefreshTokenLogLine).not.toBeNull();
    expect(chatGptRefreshTokenLogLine?.message).toContain('codexErrorInfo=unauthorized');
    expect(chatGptRefreshTokenLogLine?.message).toContain(
      'formattedMessagePreview="Your ChatGPT sign-in expired. Sign in with ChatGPT again in Settings > Models, then retry."',
    );
    expect(chatGptRefreshTokenLogLine?.message).toContain('formattedChanged=true');

    const lmStudioTemplateErrorLogLine = formatStructuredAgentRuntimeLogLine({
      kind: 'notification',
      notification: {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: false,
          error: {
            message: LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR,
            codexErrorInfo: null,
            additionalDetails: null,
          },
        },
      },
    } as any, {
      modelProvider: 'lmstudio-5a96e840',
      providerLabel: 'LM Studio',
    });

    expect(lmStudioTemplateErrorLogLine).not.toBeNull();
    expect(lmStudioTemplateErrorLogLine?.message).toContain('kind=stream_error');
    expect(lmStudioTemplateErrorLogLine?.message).toContain(
      'rawMessagePreview="stream disconnected before completion: Error rendering prompt with jinja template:',
    );
    expect(lmStudioTemplateErrorLogLine?.message).toContain(
      'formattedMessagePreview="stream disconnected before completion: Error rendering prompt with jinja template:',
    );
    expect(lmStudioTemplateErrorLogLine?.message).toContain(
      "The selected model from LM Studio doesn't support Interpreter tools.",
    );
    expect(lmStudioTemplateErrorLogLine?.message).toContain('formattedChanged=true');

    const imageInputUnionErrorLogLine = formatStructuredAgentRuntimeLogLine({
      kind: 'notification',
      notification: {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: false,
          error: {
            message: INVALID_INPUT_UNION_ERROR_MESSAGE,
            codexErrorInfo: 'other',
            additionalDetails: null,
          },
        },
      },
    } as any, {
      hasImageInput: true,
      modelProvider: 'lmstudio-5a96e840',
      providerLabel: 'LM Studio',
    });

    expect(imageInputUnionErrorLogLine).not.toBeNull();
    expect(imageInputUnionErrorLogLine?.message).toContain(
      `formattedMessagePreview="${IMAGE_INPUT_ROUTE_UNAVAILABLE_MESSAGE}"`,
    );

    const turnCompletedLogLine = formatStructuredAgentRuntimeLogLine(
      {
        kind: 'notification',
        notification: {
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: 'turn-1',
              status: 'failed',
              error: {
                message: "Error running remote compact task: You've hit your usage limit.",
                codexErrorInfo: 'usageLimitExceeded',
                additionalDetails: null,
              },
            },
          },
        },
      } as any,
      { isChatGptProfile: true },
    );

    expect(turnCompletedLogLine).not.toBeNull();
    expect(turnCompletedLogLine).toMatchObject({
      level: 'warn',
      prefix: 'AGENT_EVT',
    });
    expect(turnCompletedLogLine?.message).toContain('kind=turn_completed');
    expect(turnCompletedLogLine?.message).toContain('status=failed');
    expect(turnCompletedLogLine?.message).toContain('codexErrorInfo=usageLimitExceeded');
    expect(turnCompletedLogLine?.message).toContain(
      `rawMessagePreview="Error running remote compact task: You've hit your usage limit."`,
    );
    expect(turnCompletedLogLine?.message).toContain(
      `formattedMessagePreview="You've hit your ChatGPT usage limit. This limit is set by your ChatGPT account and is separate from Interpreter plan usage shown in Settings."`,
    );
    expect(turnCompletedLogLine?.message).toContain('formattedChanged=true');
  });
});

describe('ensureOpenAIOAuthAccountReady', () => {
  test('proactively refreshes ChatGPT auth for OpenAI OAuth profiles', async () => {
    const refreshRequests: boolean[] = [];
    await ensureOpenAIOAuthAccountReady({
      async getAccount(refreshToken?: boolean) {
        refreshRequests.push(Boolean(refreshToken));
        return {
          account: {
            type: 'chatgpt',
            email: 'user@example.com',
            planType: 'plus' as any,
          },
          requiresOpenaiAuth: false,
        };
      },
    }, true);

    expect(refreshRequests).toEqual([true]);
  });

  test('fails before the turn when an OpenAI OAuth profile has no connected account', async () => {
    await expect(ensureOpenAIOAuthAccountReady({
      async getAccount(refreshToken?: boolean) {
        expect(refreshToken).toBe(true);
        return {
          account: null,
          requiresOpenaiAuth: true,
        };
      },
    }, true)).rejects.toThrow(
      'OpenAI account is not connected. Sign in with OpenAI in Settings > Models and try again.',
    );
  });

  test('does not read account state for non-OpenAI-OAuth profiles', async () => {
    let calls = 0;
    await ensureOpenAIOAuthAccountReady({
      async getAccount() {
        calls += 1;
        return {
          account: null,
          requiresOpenaiAuth: false,
        };
      },
    }, false);

    expect(calls).toBe(0);
  });
});

describe('resolveAgentInterpreterCliTransport', () => {
  test('uses the Windows-supported Interpreter CLI transport on Windows', () => {
    expect(resolveAgentInterpreterCliTransport('win32')).toBe('http');
    expect(resolveAgentInterpreterCliTransport('darwin')).toBe('file');
    expect(resolveAgentInterpreterCliTransport('linux')).toBe('file');
  });
});

describe('logAgentTranscriptEvent', () => {
  test('preserves the full user message in transcript logging', () => {
    const originalAgentLogging = (globalThis as any).__agentLogging;
    const loggedUsers: string[] = [];
    (globalThis as any).__agentLogging = {
      logUser(message: string) {
        loggedUsers.push(message);
      },
    };

    const longPrompt = `${'Please inspect the transcript logging path carefully. '.repeat(6)}Do not truncate this sentence.`;

    try {
      logAgentTranscriptEvent({
        kind: 'notification',
        notification: {
          method: 'item/completed',
          params: {
            item: {
              id: 'user-1',
              type: 'userMessage',
              content: [{ type: 'text', text: longPrompt, text_elements: [] }],
            },
          },
        },
      } as any);
    } finally {
      (globalThis as any).__agentLogging = originalAgentLogging;
    }

    expect(loggedUsers).toEqual([longPrompt]);
    expect(loggedUsers[0].length).toBeGreaterThan(160);
  });

  test('includes attached skills in transcript logging for user messages', () => {
    const originalAgentLogging = (globalThis as any).__agentLogging;
    const loggedUsers: string[] = [];
    (globalThis as any).__agentLogging = {
      logUser(message: string) {
        loggedUsers.push(message);
      },
    };

    try {
      logAgentTranscriptEvent({
        kind: 'notification',
        notification: {
          method: 'item/completed',
          params: {
            item: {
              id: 'user-2',
              type: 'userMessage',
              content: [
                { type: 'text', text: 'Update the workbook.', text_elements: [] },
                { type: 'skill', name: 'Excel', path: '/skills/Excel/SKILL.md' },
                { type: 'skill', name: 'pdf', path: '/skills/pdf/SKILL.md' },
              ],
            },
          },
        },
      } as any);
    } finally {
      (globalThis as any).__agentLogging = originalAgentLogging;
    }

    expect(loggedUsers).toEqual([
      'Update the workbook.\n\n[attached_skills]\n- Excel: /skills/Excel/SKILL.md\n- pdf: /skills/pdf/SKILL.md\n[/attached_skills]',
    ]);
  });

  test('logs completed web searches with the real query instead of blank dispatch placeholders', () => {
    const originalAgentLogging = (globalThis as any).__agentLogging;
    const toolCalls: Array<{ toolName: string; input: unknown }> = [];
    const toolResults: Array<{ toolName: string; output: unknown; failed: boolean }> = [];
    (globalThis as any).__agentLogging = {
      logToolCall(toolName: string, input: unknown) {
        toolCalls.push({ toolName, input });
      },
      logToolResult(toolName: string, output: unknown, failed: boolean) {
        toolResults.push({ toolName, output, failed });
      },
    };

    try {
      logAgentTranscriptEvent({
        kind: 'notification',
        notification: {
          method: 'item/started',
          params: {
            item: {
              id: 'search-1',
              type: 'webSearch',
              status: 'in_progress',
              query: '',
              action: { type: 'other' },
            },
          },
        },
      } as any);

      logAgentTranscriptEvent({
        kind: 'notification',
        notification: {
          method: 'item/completed',
          params: {
            item: {
              id: 'search-1',
              type: 'webSearch',
              status: 'completed',
              query: 'West Palm Beach v. Moelis Delaware 311 A.3d 809',
              action: {
                type: 'search',
                query: 'West Palm Beach v. Moelis Delaware 311 A.3d 809',
                queries: ['West Palm Beach v. Moelis Delaware 311 A.3d 809'],
              },
            },
          },
        },
      } as any);
    } finally {
      (globalThis as any).__agentLogging = originalAgentLogging;
    }

    expect(toolCalls).toEqual([
      {
        toolName: 'web_search',
        input: {
          query: 'West Palm Beach v. Moelis Delaware 311 A.3d 809',
        },
      },
    ]);
    expect(toolResults).toEqual([
      {
        toolName: 'web_search',
        output: {
          type: 'search',
          query: 'West Palm Beach v. Moelis Delaware 311 A.3d 809',
          queries: ['West Palm Beach v. Moelis Delaware 311 A.3d 809'],
        },
        failed: false,
      },
    ]);
  });

  test('logs update_plan notifications as tool calls in readable transcripts', () => {
    const originalAgentLogging = (globalThis as any).__agentLogging;
    const toolCalls: Array<{ toolName: string; input: unknown }> = [];
    const toolResults: Array<{ toolName: string; output: unknown; failed: boolean }> = [];
    (globalThis as any).__agentLogging = {
      logToolCall(toolName: string, input: unknown) {
        toolCalls.push({ toolName, input });
      },
      logToolResult(toolName: string, output: unknown, failed: boolean) {
        toolResults.push({ toolName, output, failed });
      },
    };

    try {
      logAgentTranscriptEvent({
        kind: 'notification',
        notification: {
          method: 'turn/plan/updated',
          params: {
            threadId: 'thread-plan-1',
            turnId: 'turn-plan-1',
            explanation: 'Track the deliverable requirements.',
            plan: [
              { step: 'Read the source document', status: 'completed' },
              { step: 'Create the edited deliverable', status: 'in_progress' },
            ],
          },
        },
      } as any);
    } finally {
      (globalThis as any).__agentLogging = originalAgentLogging;
    }

    expect(toolCalls).toEqual([
      {
        toolName: 'update_plan',
        input: {
          explanation: 'Track the deliverable requirements.',
          plan: [
            { step: 'Read the source document', status: 'completed' },
            { step: 'Create the edited deliverable', status: 'in_progress' },
          ],
        },
      },
    ]);
    expect(toolResults).toEqual([
      {
        toolName: 'update_plan',
        output: 'Plan updated',
        failed: false,
      },
    ]);
  });
});

describe('summarizeVisibleRuntimeSkills', () => {
  test('keeps only enabled visible skills and prefers higher-precedence scopes', () => {
    expect(summarizeVisibleRuntimeSkills([
      {
        name: 'doc',
        description: 'system doc skill',
        shortDescription: 'system',
        path: '/skills/system/doc/SKILL.md',
        scope: 'system',
        enabled: true,
      },
      {
        name: 'doc',
        description: 'repo doc override',
        shortDescription: 'repo',
        path: '/workspace/skills/doc/SKILL.md',
        scope: 'repo',
        enabled: true,
      },
      {
        name: 'Excel',
        description: '',
        shortDescription: 'spreadsheet fallback description',
        path: '/skills/Excel/SKILL.md',
        scope: 'user',
        enabled: true,
      },
      {
        name: 'PowerPoint',
        description: 'disabled skill should not appear',
        shortDescription: 'disabled',
        path: '/skills/PowerPoint/SKILL.md',
        scope: 'system',
        enabled: false,
      },
    ])).toEqual([
      {
        name: 'doc',
        description: 'repo doc override',
        path: '/workspace/skills/doc/SKILL.md',
        scope: 'repo',
      },
      {
        name: 'Excel',
        description: 'spreadsheet fallback description',
        path: '/skills/Excel/SKILL.md',
        scope: 'user',
      },
    ]);
  });
});

describe('resolveCodexProfileForStreamRequest', () => {
  test('routes a provider added by OIX without a Workstation profile allowlist', async () => {
    setConfigOverride({
      agents: {},
      profiles: [
        {
          id: 'custom:future-oix-provider',
          name: 'Future OIX Provider',
          provider: 'api',
          modelId: 'future-model-1',
          apiFormat: 'openai',
          apiKey: 'future-secret',
          baseURL: 'https://future.example/v1',
          codexProfileId: 'future-provider',
          wireApi: 'chat',
          isBuiltin: false,
        },
      ],
      providers: {},
    } as any);

    const result = await resolveCodexProfileForStreamRequest({
      selection: 'stored-profile',
      profileId: 'custom:future-oix-provider',
      message: 'hello',
      attachments: [],
      skills: [],
    });

    expect(result.profile.modelProvider).toBe(buildAppManagedModelProviderId('future-provider'));
    expect(result.profile.providerConfig?.base_url).toBe('https://future.example/v1');
    expect(result.profile.providerConfig?.wire_api).toBe('chat');
    expect(result.profile.providerConfig?.experimental_bearer_token).toBe('future-secret');
    expect(result.requestedModel).toBe('future-model-1');
  });

  test('preserves OIX built-in provider auth when the key comes from its environment', async () => {
    setConfigOverride({
      agents: {},
      profiles: [
        {
          id: 'custom:anthropic-env',
          name: 'Anthropic',
          provider: 'api',
          modelId: 'claude-sonnet-4-6',
          apiFormat: 'anthropic',
          baseURL: 'https://api.anthropic.com/v1',
          codexProfileId: 'anthropic',
          wireApi: 'messages',
          isBuiltin: false,
        },
      ],
      providers: {},
    } as any);

    const result = await resolveCodexProfileForStreamRequest({
      selection: 'stored-profile',
      profileId: 'custom:anthropic-env',
      message: 'hello',
      attachments: [],
      skills: [],
    });

    expect(result.profile.modelProvider).toBe('anthropic');
    expect(result.profile.providerConfig).toBeUndefined();
    expect(result.requestedModel).toBe('claude-sonnet-4-6');
  });

  test('preserves inline OpenRouter auth from a stored API profile', async () => {
    setConfigOverride({
      agents: {},
      profiles: [
        {
          id: 'custom:inline-openrouter',
          name: 'Inline OpenRouter',
          provider: 'api',
          modelId: 'google/gemini-3-flash-preview',
          apiFormat: 'openai',
          apiKey: 'or-inline-key',
          baseURL: 'https://openrouter.ai/api/v1',
          codexProfileId: 'openrouter',
          useResponsesApi: false,
          isBuiltin: false,
        },
      ],
      providers: {},
    } as any);

    const result = await resolveCodexProfileForStreamRequest({
      selection: 'stored-profile',
      profileId: 'custom:inline-openrouter',
      message: 'hello',
      attachments: [],
      skills: [],
    });

    expect(result.profile.modelProvider).toBe(buildAppManagedModelProviderId('openrouter'));
    expect(result.profile.providerConfig?.base_url).toBe('https://openrouter.ai/api/v1');
    expect(result.profile.providerConfig?.experimental_bearer_token).toBe('or-inline-key');
    expect(result.profile.providerConfig?.http_headers?.Authorization).toBe('Bearer or-inline-key');
    expect(result.profile.providerConfig?.wire_api).toBe('responses');
    expect(result.requestedModel).toBe('google/gemini-3-flash-preview');
  });

  test('preserves explicit Chat Completions wire API from stored API profiles', async () => {
    setConfigOverride({
      agents: {},
      profiles: [
        {
          id: 'custom:chat-api',
          name: 'Chat API',
          provider: 'api',
          modelId: 'chat-compatible-model',
          apiFormat: 'openai',
          apiKey: 'chat-api-key',
          baseURL: 'https://llm.example.internal/v1',
          codexProfileId: 'custom',
          wireApi: 'chat',
          useResponsesApi: true,
          isBuiltin: false,
        },
      ],
      providers: {},
    } as any);

    const result = await resolveCodexProfileForStreamRequest({
      selection: 'stored-profile',
      profileId: 'custom:chat-api',
      message: 'hello',
      attachments: [],
      skills: [],
    });

    expect(result.profile.providerConfig?.wire_api).toBe('chat');
    expect(result.requestedModel).toBe('chat-compatible-model');
  });

  test('defaults stored DeepSeek API profiles to Chat Completions', async () => {
    setConfigOverride({
      agents: {},
      profiles: [
        {
          id: 'custom:deepseek',
          name: 'DeepSeek',
          provider: 'api',
          modelId: 'deepseek-v4-flash',
          apiFormat: 'openai',
          apiKey: 'sk-deepseek',
          baseURL: 'https://api.deepseek.com',
          codexProfileId: 'deepseek',
          isBuiltin: false,
        },
      ],
      providers: {},
    } as any);

    const result = await resolveCodexProfileForStreamRequest({
      selection: 'stored-profile',
      profileId: 'custom:deepseek',
      message: 'hello',
      attachments: [],
      skills: [],
    });

    expect(result.profile.modelProvider).toBe(buildAppManagedModelProviderId('deepseek'));
    expect(result.profile.providerConfig?.base_url).toBe('https://api.deepseek.com');
    expect(result.profile.providerConfig?.wire_api).toBe('chat');
    expect(result.requestedModel).toBe('deepseek-v4-flash');
  });

  test('routes stale custom DeepSeek API profiles through Chat Completions', async () => {
    setConfigOverride({
      agents: {},
      profiles: [
        {
          id: 'custom:deepseek-stale',
          name: 'DeepSeek',
          provider: 'api',
          modelId: 'deepseek-v4-flash',
          apiFormat: 'openai',
          apiKey: 'sk-deepseek',
          baseURL: 'https://api.deepseek.com',
          codexProfileId: 'custom',
          wireApi: 'responses',
          useResponsesApi: true,
          isBuiltin: false,
        },
      ],
      providers: {},
    } as any);

    const result = await resolveCodexProfileForStreamRequest({
      selection: 'stored-profile',
      profileId: 'custom:deepseek-stale',
      message: 'hello',
      attachments: [],
      skills: [],
    });

    expect(result.profile.modelProvider).toBe(buildAppManagedModelProviderId('deepseek'));
    expect(result.profile.providerConfig?.base_url).toBe('https://api.deepseek.com');
    expect(result.profile.providerConfig?.wire_api).toBe('chat');
    expect(result.requestedModel).toBe('deepseek-v4-flash');
  });

  test('keeps Claude-family custom API profiles on their configured Responses wire API', async () => {
    setConfigOverride({
      agents: {},
      profiles: [
        {
          id: 'custom:claude-family',
          name: 'Claude Custom Endpoint',
          provider: 'api',
          modelId: 'anthropic/claude-sonnet-4.6',
          apiFormat: 'openai',
          apiKey: 'sk-zveno',
          baseURL: 'https://api.zveno.ai/v1',
          codexProfileId: 'custom',
          wireApi: 'responses',
          useResponsesApi: true,
          isBuiltin: false,
        },
      ],
      providers: {},
    } satisfies AppConfig);

    const result = await resolveCodexProfileForStreamRequest({
      selection: 'stored-profile',
      profileId: 'custom:claude-family',
      message: 'hello',
      attachments: [],
      skills: [],
    });

    expect(result.profile.modelProvider).toBe(buildAppManagedModelProviderId('custom'));
    expect(result.profile.providerConfig?.base_url).toBe('https://api.zveno.ai/v1');
    expect(result.profile.providerConfig?.wire_api).toBe('responses');
    expect(result.requestedModel).toBe('anthropic/claude-sonnet-4.6');
  });

  test('routes DeepSeek model configs through Chat Completions even when replayed as custom profiles', () => {
    const profile = resolveCodexProfileFromModelConfig({
      provider: 'api',
      modelId: 'deepseek-v4-flash',
      apiFormat: 'openai',
      apiKey: 'sk-deepseek',
      baseURL: 'https://api.deepseek.com',
      codexProfileId: 'custom',
      wireApi: 'responses',
      useResponsesApi: true,
    });

    expect(profile.modelProvider).toBe(buildAppManagedModelProviderId('deepseek'));
    expect(profile.providerConfig?.base_url).toBe('https://api.deepseek.com');
    expect(profile.providerConfig?.wire_api).toBe('chat');
  });

  test('honors an explicit Responses override for local Ollama model configs', () => {
    const profile = resolveCodexProfileFromModelConfig({
      provider: 'local',
      modelId: 'qwen3.5:4b',
      apiFormat: 'openai',
      baseURL: 'http://localhost:11434/v1',
      codexProfileId: 'ollama',
      wireApi: 'responses',
    });

    expect(profile.providerConfig?.wire_api).toBe('responses');
  });

  test('falls back to the Ollama preset default (Chat Completions) when local wireApi is unset', () => {
    const profile = resolveCodexProfileFromModelConfig({
      provider: 'local',
      modelId: 'qwen3.5:4b',
      apiFormat: 'openai',
      baseURL: 'http://localhost:11434/v1',
      codexProfileId: 'ollama',
    });

    expect(profile.providerConfig?.wire_api).toBe('chat');
  });

  test('honors an explicit Chat Completions override for local LM Studio model configs', () => {
    const profile = resolveCodexProfileFromModelConfig({
      provider: 'local',
      modelId: 'qwen/qwen3.5-4b',
      apiFormat: 'openai',
      baseURL: 'http://localhost:1234/v1',
      codexProfileId: 'lmstudio',
      wireApi: 'chat',
    });

    expect(profile.providerConfig?.wire_api).toBe('chat');
  });

  test('falls back to the LM Studio preset default (Chat Completions) when local wireApi is unset', () => {
    const profile = resolveCodexProfileFromModelConfig({
      provider: 'local',
      modelId: 'qwen/qwen3.5-4b',
      apiFormat: 'openai',
      baseURL: 'http://localhost:1234/v1',
      codexProfileId: 'lmstudio',
    });

    expect(profile.providerConfig?.wire_api).toBe('chat');
  });

  test('preserves model-config harness overrides across subagent runtime resolution', () => {
    const profile = resolveCodexProfileFromModelConfig({
      provider: 'api',
      modelId: 'claude-sonnet-4-6',
      apiFormat: 'anthropic',
      baseURL: 'https://api.anthropic.com/v1',
      codexProfileId: 'anthropic',
      wireApi: 'messages',
      harness: 'claude-code',
    });

    expect(profile.modelProvider).toBe('anthropic');
    expect(profile.harness).toBe('claude-code');
  });

  test('hydrates provider-backed API profiles before building the runtime provider config', async () => {
    setConfigOverride({
      agents: {},
      profiles: [
        {
          id: 'custom:provider-openrouter',
          name: 'Provider-backed OpenRouter',
          provider: 'api',
          providerId: 'provider:openrouter',
          modelId: 'google/gemini-3-flash-preview',
          codexProfileId: 'openrouter',
          isBuiltin: false,
        },
      ],
      providers: {
        'provider:openrouter': {
          id: 'provider:openrouter',
          name: 'OpenRouter',
          type: 'api',
          apiKey: 'or-provider-key',
          baseURL: 'https://openrouter.ai/api/v1',
          api: { preset: 'openrouter' },
          createdAt: 0,
          updatedAt: 0,
        },
      },
    } as any);

    const result = await resolveCodexProfileForStreamRequest({
      selection: 'stored-profile',
      profileId: 'custom:provider-openrouter',
      message: 'hello',
      attachments: [],
      skills: [],
    });

    expect(result.profile.modelProvider).toBe(buildAppManagedModelProviderId('openrouter'));
    expect(result.profile.providerConfig?.base_url).toBe('https://openrouter.ai/api/v1');
    expect(result.profile.providerConfig?.experimental_bearer_token).toBe('or-provider-key');
    expect(result.profile.providerConfig?.http_headers?.Authorization).toBe('Bearer or-provider-key');
    expect(result.requestedModel).toBe('google/gemini-3-flash-preview');
    expect(result.isChatGptProfile).toBe(false);
  });

  test('resolves stored profile environment keys only for the runtime request', async () => {
    process.env.WORKSTATION_TEST_OPENAI_API_KEY = 'sk-runtime-only';
    const storedProfile = {
      id: 'custom:env-openai',
      name: 'OpenAI from environment',
      provider: 'api' as const,
      modelId: 'gpt-5.6-sol',
      codexProfileId: 'openai-api',
      baseURL: 'https://api.openai.com/v1',
      wireApi: 'responses' as const,
      environmentKey: 'WORKSTATION_TEST_OPENAI_API_KEY',
      isBuiltin: false,
    };
    setConfigOverride({
      agents: {},
      profiles: [storedProfile],
      providers: {},
    } as any);

    const result = await resolveCodexProfileForStreamRequest({
      selection: 'stored-profile',
      profileId: storedProfile.id,
      message: 'hello',
      attachments: [],
      skills: [],
    });

    expect(result.profile.modelProvider).toBe(buildAppManagedModelProviderId('openai-api'));
    expect(result.profile.providerConfig?.experimental_bearer_token).toBe('sk-runtime-only');
    expect(result.profile.providerConfig?.http_headers?.Authorization).toBe('Bearer sk-runtime-only');
    expect(result.requestedModel).toBe('gpt-5.6-sol');
    expect(storedProfile).not.toHaveProperty('apiKey');
  });

  test('resolves model-config environment keys without mutating persisted config', () => {
    process.env.WORKSTATION_TEST_OPENAI_API_KEY = 'sk-runtime-only';
    const modelConfig = {
      provider: 'api' as const,
      modelId: 'gpt-5.6-sol',
      codexProfileId: 'openai-api',
      baseURL: 'https://api.openai.com/v1',
      wireApi: 'responses' as const,
      environmentKey: 'WORKSTATION_TEST_OPENAI_API_KEY',
    };

    const profile = resolveCodexProfileFromModelConfig(modelConfig);

    expect(profile.modelProvider).toBe(buildAppManagedModelProviderId('openai-api'));
    expect(profile.providerConfig?.experimental_bearer_token).toBe('sk-runtime-only');
    expect(profile.providerConfig?.http_headers?.Authorization).toBe('Bearer sk-runtime-only');
    expect(modelConfig).not.toHaveProperty('apiKey');
  });

  test('flags stored ChatGPT-backed profiles in the shared stream resolver', async () => {
    setConfigOverride({
      agents: {},
      profiles: [
        {
          id: 'custom:chatgpt',
          name: 'ChatGPT',
          provider: 'openai-oauth',
          modelId: 'gpt-5.4',
          isBuiltin: false,
        },
      ],
      providers: {},
    } as any);

    const result = await resolveCodexProfileForStreamRequest({
      selection: 'stored-profile',
      profileId: 'custom:chatgpt',
      message: 'hello',
      attachments: [],
      skills: [],
    });

    expect(result.profile.modelProvider).toBe('openai');
    expect(result.requestedModel).toBe('gpt-5.4');
    expect(result.isChatGptProfile).toBe(true);
  });
});

describe('runCodexAgentTurn overlay continuation', () => {
  function installOverlayDriver() {
    overlaySessionManager.setDriver({
      async captureContext(session) {
        return session.latestContext;
      },
      async click() {},
      async type() {},
      async hotkey() {},
      async scroll() {},
      async detach() {},
      async complete() {},
    });
  }

  test('normalizes local Qwen aliases before validation and turn execution', async () => {
    const originalFetch = globalThis.fetch;
    const showBodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      showBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ capabilities: ['tools'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const runTurnCalls: Array<{ model?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({ model: options.model });
        return {
          threadId: 'thread-local-qwen',
          turnId: 'turn-local-qwen',
          status: 'completed',
        };
      },
    } as any;

    try {
      const result = await runCodexAgentTurn({
        service: fakeService,
        profile: {
          modelProvider: 'ollama-62be5c93',
          model: 'qwen3.5-0.8b',
          providerConfig: {
            base_url: 'http://localhost:11434/v1',
          },
        } as any,
        workspacePath: '/tmp',
        message: 'Say hello.',
        binding: {
          agentId: 'agent-local-qwen',
        },
      });

      expect(result.resolvedModel).toBe('qwen3.5:0.8b');
      expect(runTurnCalls).toEqual([{ model: 'qwen3.5:0.8b' }]);
      expect(showBodies).toEqual([
        { model: 'qwen3.5:0.8b' },
        { name: 'qwen3.5:0.8b' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('continues a completed turn until the agent explicitly completes the live overlay session', async () => {
    installOverlayDriver();
    const agentId = 'overlay-agent-test-1';
    const callerToken = TEST_CALLER_TOKENS[0];
    overlaySessionManager.createSession({
      agentId,
      callerToken,
      displayId: 'display-1',
      scopeBoundsDIP: null,
      initialContext: {
        agentMode: 'ax',
        formattedText: '<window></window>',
        elementCount: 1,
        elements: [],
      },
    });

    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        if (runTurnCalls.length === 2) {
          await overlaySessionManager.complete(agentId);
        }
        return {
          threadId: 'thread-overlay-1',
          turnId: `turn-${runTurnCalls.length}`,
          status: 'completed',
        };
      },
    } as any;

    const result = await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Fill the form.',
      binding: {
        agentId,
        callerToken,
      },
    });

    expect(runTurnCalls).toHaveLength(2);
    expect(runTurnCalls[0]).toEqual({
      threadId: undefined,
      message: 'Fill the form.',
    });
    expect(runTurnCalls[1]?.threadId).toBe('thread-overlay-1');
    expect(runTurnCalls[1]?.message).toContain('overlay_complete');
    expect(result.completion.turnId).toBe('turn-2');
    expect(overlaySessionManager.getDebugSnapshotForAgent(agentId)).toBeNull();
    expect(agentTabManager.getBindingForCallerToken(callerToken)).toBeDefined();
  });

  test('fails loudly and preserves the binding if the live overlay session never detaches', async () => {
    installOverlayDriver();
    const agentId = 'overlay-agent-test-2';
    const callerToken = TEST_CALLER_TOKENS[1];
    overlaySessionManager.createSession({
      agentId,
      callerToken,
      displayId: 'display-1',
      scopeBoundsDIP: null,
      initialContext: {
        agentMode: 'ax',
        formattedText: '<window></window>',
        elementCount: 1,
        elements: [],
      },
    });

    let callCount = 0;
    const fakeService = {
      async ensureProvider() {},
      async runTurn() {
        callCount += 1;
        return {
          threadId: 'thread-overlay-2',
          turnId: `turn-${callCount}`,
          status: 'completed',
        };
      },
    } as any;

    await expect(runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Keep going.',
      binding: {
        agentId,
        callerToken,
      },
    })).rejects.toThrow(
      'Live Interpreter Overlay session remained attached after 3 completed turn(s). The agent must call overlay_complete or overlay_detach before finishing.',
    );

    expect(callCount).toBe(4);
    expect(overlaySessionManager.getDebugSnapshotForAgent(agentId)).not.toBeNull();
    expect(agentTabManager.getBindingForCallerToken(callerToken)).toBeDefined();
  });

  test('passes through only explicitly requested skills', async () => {
    const listSkillsCalls: Array<{ cwds: string[] }> = [];
    const runTurnCalls: Array<{ skills: unknown; developerInstructions?: string }> = [];
    const fakeService = {
      async listSkills(options: { cwds: string[] }) {
        listSkillsCalls.push(options);
        return {
          data: [{
            cwd: '/tmp',
            skills: [{
              name: 'repo-review',
              description: 'Review the repository contract.',
              shortDescription: 'Review the repository.',
              path: '/tmp/.agents/skills/repo-review/SKILL.md',
              scope: 'repo',
              enabled: true,
            }],
          }],
        };
      },
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          skills: options.skills,
          developerInstructions: options.developerInstructions,
        });
        return {
          threadId: 'thread-skills-1',
          turnId: 'turn-skills-1',
          status: 'completed',
        };
      },
    } as any;

    const explicitSkills = [
      {
        id: 'skill-doc',
        label: 'doc',
        name: 'doc',
        path: '/skills/doc/SKILL.md',
      },
    ];

    await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Edit the document.',
      skills: explicitSkills,
      binding: {
        agentId: 'skills-agent-test-1',
      },
    });

    expect(listSkillsCalls).toEqual([{ cwds: ['/tmp'] }]);
    expect(runTurnCalls).toHaveLength(1);
    expect(runTurnCalls[0]?.skills).toEqual(explicitSkills);
    expect(runTurnCalls[0]?.developerInstructions).toContain('repo-review');
  });

  test('does not inject interpreter app tools as direct MCP tools by default', async () => {
    const runTurnCalls: Array<{ config: Record<string, any> | null | undefined }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({ config: options.config });
        return {
          threadId: 'thread-mcp-1',
          turnId: 'turn-mcp-1',
          status: 'completed',
        };
      },
    } as any;

    await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp/workspace',
      message: 'Update the spreadsheet.',
      binding: {
        agentId: 'agent-tab-123',
        callerToken: 'agtok_test_mcp',
        workspacePath: '/tmp/workspace',
        allowedToolNames: ['builtin-cells__read_spreadsheet', 'builtin-cells__write_data_to_excel'],
        toolProfileId: 'benchmark:run-main',
      },
    });

    expect(runTurnCalls).toHaveLength(1);
    expect(runTurnCalls[0]?.config?.mcp_servers?.interpreter).toBeUndefined();
    expect(runTurnCalls[0]?.config?.shell_environment_policy?.set?.INTERPRETER_CLI_PATH).toBeString();
    expect(runTurnCalls[0]?.config?.shell_environment_policy?.set?.INTERPRETER_CLI_SERVER_CONNECTION)
      .toStartWith(process.platform === 'win32' ? 'http:' : 'file:');
  });

  test('strips caller-provided direct MCP servers from agent turn config', async () => {
    const runTurnCalls: Array<{ config: Record<string, any> | null | undefined }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({ config: options.config });
        return {
          threadId: 'thread-mcp-strip-1',
          turnId: 'turn-mcp-strip-1',
          status: 'completed',
        };
      },
    } as any;

    await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp/workspace',
      message: 'Use a tool.',
      config: {
        mcp_servers: {
          direct: {
            url: 'https://direct.example.com/mcp',
          },
        },
      },
      binding: {
        agentId: 'agent-tab-strip-mcp',
        callerToken: 'agtok_strip_mcp',
        workspacePath: '/tmp/workspace',
      },
    });

    expect(runTurnCalls).toHaveLength(1);
    expect(runTurnCalls[0]?.config?.mcp_servers).toEqual({});
  });

  test('preserves an explicit app-server harness for app-managed turns', async () => {
    type RunTurnOptions = Parameters<CodexService['runTurn']>[0];
    const runTurnCalls: Array<{ config: Record<string, JsonValue> | null | undefined }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: RunTurnOptions) {
        runTurnCalls.push({ config: options.config });
        return {
          threadId: 'thread-native-harness-1',
          turnId: 'turn-native-harness-1',
          status: 'completed',
        };
      },
    } as Pick<CodexService, 'ensureProvider' | 'runTurn'> as CodexService;
    const profile = {
      label: 'Custom Endpoint',
      modelProvider: 'custom',
      model: 'anthropic/claude-sonnet-4.6',
      providerConfig: {
        base_url: 'https://api.zveno.ai/v1',
        name: 'Custom Endpoint',
        requires_openai_auth: false,
        wire_api: 'responses',
      },
    } satisfies CodexProfile;

    await runCodexAgentTurn({
      service: fakeService,
      profile,
      workspacePath: '/tmp/workspace',
      message: 'Hello',
      config: {
        harness: 'claude-code',
      },
      binding: {
        agentId: 'agent-tab-native-harness',
        callerToken: 'agtok_native_harness',
        workspacePath: '/tmp/workspace',
      },
    });

    expect(runTurnCalls).toHaveLength(1);
    expect(runTurnCalls[0]?.config?.harness).toBe('claude-code');
  });

  test('lets OIX automatically select the provider/model harness by default', async () => {
    const runTurnCalls: Array<{ config: Record<string, any> | null | undefined }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({ config: options.config });
        return {
          threadId: 'thread-auto-harness-1',
          turnId: 'turn-auto-harness-1',
          status: 'completed',
        };
      },
    } as any;

    await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openrouter',
        model: 'moonshotai/kimi-k2.5',
      } as any,
      workspacePath: '/tmp/workspace',
      message: 'Hello',
      binding: {
        agentId: 'agent-tab-auto-harness',
        callerToken: 'agtok_auto_harness',
        workspacePath: '/tmp/workspace',
      },
    });

    expect(runTurnCalls).toHaveLength(1);
    expect(runTurnCalls[0]?.config).not.toHaveProperty('harness');
  });

  test('forces ChatGPT auth for OpenAI OAuth turns', async () => {
    const runTurnCalls: Array<{ config: Record<string, any> | null | undefined }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({ config: options.config });
        return {
          threadId: 'thread-chatgpt-auth-1',
          turnId: 'turn-chatgpt-auth-1',
          status: 'completed',
        };
      },
    } as any;

    await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.3-codex',
      } as any,
      requestedModel: 'gpt-5.3-codex',
      usesChatGptAuth: true,
      workspacePath: '/tmp/workspace',
      message: 'Hello',
      config: {
        forced_login_method: 'api',
      },
      binding: {
        agentId: 'agent-tab-chatgpt-auth',
        callerToken: 'agtok_chatgpt_auth',
        workspacePath: '/tmp/workspace',
      },
    });

    expect(runTurnCalls).toHaveLength(1);
    expect(runTurnCalls[0]?.config?.forced_login_method).toBe('chatgpt');
  });

  test('does not expose configured or disabled app tools as native model tools', async () => {
    const runTurnCalls: Array<{ config: Record<string, any> | null | undefined }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({ config: options.config });
        return {
          threadId: 'thread-mcp-deferred-1',
          turnId: 'turn-mcp-deferred-1',
          status: 'completed',
        };
      },
    } as any;

    await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp/workspace',
      message: 'Say hello.',
      config: {
        mcp_servers: {
          enabledSpreadsheetServer: {
            url: 'https://tools.example.com/mcp',
            tools: [
              {
                name: 'issue_942_huge_spreadsheet_tool',
                description: 'ISSUE_942_EAGER_TOOL_DESCRIPTION_SHOULD_NOT_REACH_MODEL',
              },
            ],
          },
          disabledBrowserServer: {
            url: 'https://disabled.example.com/mcp',
            enabled: false,
            disabled_tools: ['issue_942_disabled_tool'],
          },
        },
      },
      binding: {
        agentId: 'agent-tab-deferred-mcp',
        callerToken: 'agtok_deferred_mcp',
        workspacePath: '/tmp/workspace',
        allowedToolNames: ['builtin-cells__read_spreadsheet'],
      },
    });

    const serializedConfig = JSON.stringify(runTurnCalls[0]?.config ?? {});

    expect(runTurnCalls).toHaveLength(1);
    expect(runTurnCalls[0]?.config?.mcp_servers).toEqual({});
    expect(serializedConfig).not.toContain('issue_942_huge_spreadsheet_tool');
    expect(serializedConfig).not.toContain('ISSUE_942_EAGER_TOOL_DESCRIPTION_SHOULD_NOT_REACH_MODEL');
    expect(serializedConfig).not.toContain('issue_942_disabled_tool');
  });

});

describe('runCodexAgentTurn idle recovery', () => {
  const progressThreadId = 'thread-idle-progress-from-notification';

  function progressNotification(notification: AppServerNotification): StreamEvent {
    return {
      kind: 'notification',
      notification,
    };
  }

  const progressNotificationScenarios = [
    {
      name: 'turn plan update',
      idleActivity: 'turn/plan/updated',
      notification: progressNotification({
        method: SERVER_METHOD.turnPlanUpdated,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-plan-update-1',
          explanation: 'Keep the implementation checklist current.',
          plan: [{ step: 'Write remaining files', status: 'in_progress' }],
        },
      }),
    },
    {
      name: 'item started',
      idleActivity: 'item/started:commandExecution',
      notification: progressNotification({
        method: SERVER_METHOD.itemStarted,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-item-started-1',
          item: {
            id: 'cmd-started-1',
            type: 'commandExecution',
          },
        },
      }),
    },
    {
      name: 'item completed',
      idleActivity: 'item/completed:commandExecution',
      notification: progressNotification({
        method: SERVER_METHOD.itemCompleted,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-item-completed-1',
          item: {
            id: 'cmd-completed-1',
            type: 'commandExecution',
          },
        },
      }),
    },
    {
      name: 'raw reasoning item completed',
      idleActivity: 'rawResponseItem/completed:reasoning',
      notification: progressNotification({
        method: SERVER_METHOD.rawResponseItemCompleted,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-raw-reasoning-1',
          item: {
            type: 'reasoning',
            summary: [],
            content: [],
            encrypted_content: null,
          },
        },
      }),
    },
    {
      name: 'assistant message delta',
      idleActivity: 'item/agentMessage/delta',
      notification: progressNotification({
        method: SERVER_METHOD.agentMessageDelta,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-agent-delta-1',
          itemId: 'msg-1',
          delta: 'I am checking the generated artifact.',
        },
      }),
    },
    {
      name: 'plan delta',
      idleActivity: 'item/plan/delta',
      notification: progressNotification({
        method: SERVER_METHOD.planDelta,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-plan-delta-1',
          itemId: 'plan-1',
          delta: 'Verifying output paths.',
        },
      }),
    },
    {
      name: 'reasoning summary delta',
      idleActivity: 'item/reasoning/summaryTextDelta',
      notification: progressNotification({
        method: SERVER_METHOD.reasoningSummaryTextDelta,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-reasoning-delta-1',
          itemId: 'reasoning-1',
          delta: 'Need to inspect the generated files.',
          summaryIndex: 0,
        },
      }),
    },
    {
      name: 'reasoning summary part',
      idleActivity: 'item/reasoning/summaryPartAdded',
      notification: progressNotification({
        method: SERVER_METHOD.reasoningSummaryPartAdded,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-reasoning-part-1',
          itemId: 'reasoning-1',
          summaryIndex: 1,
        },
      }),
    },
    {
      name: 'command output delta',
      idleActivity: 'item/commandExecution/outputDelta',
      notification: progressNotification({
        method: SERVER_METHOD.commandExecutionOutputDelta,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-command-output-1',
          itemId: 'cmd-1',
          delta: 'wrote report.pdf',
        },
      }),
    },
    {
      name: 'terminal interaction',
      idleActivity: 'item/commandExecution/terminalInteraction',
      notification: progressNotification({
        method: SERVER_METHOD.commandExecutionTerminalInteraction,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-terminal-1',
          itemId: 'cmd-1',
          processId: 'proc-1',
          stdin: 'y\n',
        },
      }),
    },
    {
      name: 'file change output delta',
      idleActivity: 'item/fileChange/outputDelta',
      notification: progressNotification({
        method: SERVER_METHOD.fileChangeOutputDelta,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-file-change-1',
          itemId: 'file-1',
          delta: 'updated src/report.ts',
        },
      }),
    },
    {
      name: 'mcp tool progress',
      idleActivity: 'item/mcpToolCall/progress',
      notification: progressNotification({
        method: SERVER_METHOD.mcpToolCallProgress,
        params: {
          threadId: progressThreadId,
          turnId: 'turn-progress-mcp-1',
          itemId: 'mcp-1',
          message: 'Downloading source document.',
        },
      }),
    },
  ];

  for (const scenario of progressNotificationScenarios) {
    test(`retries idle turns after ${scenario.name} protocol progress`, async () => {
      const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
      const fakeService = {
        async ensureProvider() {},
        async runTurn(options: any) {
          runTurnCalls.push({
            threadId: options.threadId,
            message: options.message,
          });

          if (runTurnCalls.length === 2) {
            return {
              threadId: progressThreadId,
              turnId: 'turn-idle-progress-recovered-2',
              status: 'completed',
            };
          }

          options.onEvent?.(scenario.notification);
          throw new Error(
            `Codex turn turn-idle-progress-1 went idle for 180000ms after ${scenario.idleActivity} without reaching turn/completed.`,
          );
        },
      } as any;

      const result = await runCodexAgentTurn({
        service: fakeService,
        profile: {
          modelProvider: 'openai',
          model: 'gpt-5.4',
        } as any,
        workspacePath: '/tmp',
        message: 'Finish the current artifact.',
        binding: {
          agentId: `idle-retry-${scenario.idleActivity}`,
        },
      });

      expect(runTurnCalls).toHaveLength(2);
      expect(runTurnCalls[0]).toEqual({
        threadId: undefined,
        message: 'Finish the current artifact.',
      });
      expect(runTurnCalls[1]?.threadId).toBe(progressThreadId);
      expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
      expect(result.completion.turnId).toBe('turn-idle-progress-recovered-2');
    });
  }

  test('does not retry non-idle runtime errors even after protocol progress', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const providerError = new Error('Provider rejected the request with status 429.');
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        options.onEvent?.(progressNotification({
          method: SERVER_METHOD.reasoningSummaryTextDelta,
          params: {
            threadId: 'thread-non-idle-progress-1',
            turnId: 'turn-non-idle-progress-1',
            itemId: 'reasoning-1',
            delta: 'Still thinking.',
            summaryIndex: 0,
          },
        }));
        throw providerError;
      },
    } as any;

    await expect(runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Finish the report.',
      binding: {
        agentId: 'idle-retry-non-idle-error',
      },
    })).rejects.toThrow(providerError);

    expect(runTurnCalls).toHaveLength(1);
  });

  test('retries once in the same thread when a turn idles before any tool call', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });

        if (runTurnCalls.length === 1) {
          options.onEvent?.({ kind: 'thread', threadId: 'thread-idle-1' });
          options.onEvent?.({
            kind: 'turn',
            threadId: 'thread-idle-1',
            turnId: 'turn-idle-1',
            status: 'inProgress',
          });
          options.onEvent?.({
            kind: 'notification',
            notification: {
              method: 'item/started',
              params: {
                threadId: 'thread-idle-1',
                turnId: 'turn-idle-1',
                item: {
                  id: 'reasoning-1',
                  type: 'reasoning',
                  summary: [],
                  content: [],
                },
              },
            },
          });
          throw new Error(
            'Codex turn turn-idle-1 went idle for 180000ms after rawResponseItem/completed:reasoning without reaching turn/completed.',
          );
        }

        return {
          threadId: 'thread-idle-1',
          turnId: 'turn-idle-2',
          status: 'completed',
        };
      },
    } as any;

    const result = await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create the workbook and deck.',
      binding: {
        agentId: 'idle-retry-agent-1',
      },
    });

    expect(runTurnCalls).toHaveLength(2);
    expect(runTurnCalls[0]).toEqual({
      threadId: undefined,
      message: 'Create the workbook and deck.',
    });
    expect(runTurnCalls[1]?.threadId).toBe('thread-idle-1');
    expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
    expect(runTurnCalls[1]?.message).toContain('Use bundled skills and available tools naturally');
    expect(result.completion.turnId).toBe('turn-idle-2');
  });

  test('retries idle turns after tool calls when no assistant output was emitted yet', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        if (runTurnCalls.length === 2) {
          return {
            threadId: 'thread-idle-tools-1',
            turnId: 'turn-idle-tools-2',
            status: 'completed',
          };
        }
        options.onEvent?.({ kind: 'thread', threadId: 'thread-idle-tools-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-idle-tools-1',
          turnId: 'turn-idle-tools-1',
          status: 'inProgress',
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/started',
            params: {
              threadId: 'thread-idle-tools-1',
              turnId: 'turn-idle-tools-1',
              item: {
                id: 'tool-1',
                type: 'mcpToolCall',
              },
            },
          },
        });
        throw new Error(
          'Codex turn turn-idle-tools-1 went idle for 180000ms after item/completed:mcpToolCall without reaching turn/completed.',
        );
      },
    } as any;

    const result = await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Update the file.',
      binding: {
        agentId: 'idle-retry-agent-2',
      },
    });

    expect(runTurnCalls).toHaveLength(2);
    expect(runTurnCalls[1]?.threadId).toBe('thread-idle-tools-1');
    expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
    expect(result.completion.turnId).toBe('turn-idle-tools-2');
  });

  test('retries a recovered idle turn again after command progress', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });

        if (runTurnCalls.length === 3) {
          return {
            threadId: 'thread-idle-pdf-1',
            turnId: 'turn-idle-pdf-3',
            status: 'completed',
          };
        }

        options.onEvent?.({ kind: 'thread', threadId: 'thread-idle-pdf-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-idle-pdf-1',
          turnId: `turn-idle-pdf-${runTurnCalls.length}`,
          status: 'inProgress',
        });

        if (runTurnCalls.length === 1) {
          options.onEvent?.({
            kind: 'notification',
            notification: {
              method: 'item/started',
              params: {
                threadId: 'thread-idle-pdf-1',
                turnId: 'turn-idle-pdf-1',
                item: {
                  id: 'reasoning-1',
                  type: 'reasoning',
                  summary: [],
                  content: [],
                },
              },
            },
          });
          throw new Error(
            'Codex turn turn-idle-pdf-1 went idle for 180000ms after rawResponseItem/completed:reasoning without reaching turn/completed.',
          );
        }

        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/started',
            params: {
              threadId: 'thread-idle-pdf-1',
              turnId: 'turn-idle-pdf-2',
              item: {
                id: 'cmd-1',
                type: 'commandExecution',
              },
            },
          },
        });
        throw new Error(
          'Codex turn turn-idle-pdf-2 went idle for 180000ms after rawResponseItem/completed:reasoning without reaching turn/completed.',
        );
      },
    } as any;

    const result = await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create a PDF after generating chart PNGs.',
      binding: {
        agentId: 'idle-retry-agent-1187',
      },
    });

    expect(runTurnCalls).toHaveLength(3);
    expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
    expect(runTurnCalls[2]?.message).toContain('The previous turn stalled before completing.');
    expect(result.completion.turnId).toBe('turn-idle-pdf-3');
  });

  test('retries a third recovered idle turn after fresh assistant delta progress', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });

        if (runTurnCalls.length === 4) {
          return {
            threadId: 'thread-idle-pdf-delta-1',
            turnId: 'turn-idle-pdf-delta-4',
            status: 'completed',
          };
        }

        options.onEvent?.({ kind: 'thread', threadId: 'thread-idle-pdf-delta-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-idle-pdf-delta-1',
          turnId: `turn-idle-pdf-delta-${runTurnCalls.length}`,
          status: 'inProgress',
        });

        if (runTurnCalls.length === 1) {
          options.onEvent?.({
            kind: 'notification',
            notification: {
              method: 'item/started',
              params: {
                threadId: 'thread-idle-pdf-delta-1',
                turnId: 'turn-idle-pdf-delta-1',
                item: {
                  id: 'reasoning-1',
                  type: 'reasoning',
                  summary: [],
                  content: [],
                },
              },
            },
          });
          throw new Error(
            'Codex turn turn-idle-pdf-delta-1 went idle for 180000ms after rawResponseItem/completed:reasoning without reaching turn/completed.',
          );
        }

        if (runTurnCalls.length === 2) {
          options.onEvent?.({
            kind: 'notification',
            notification: {
              method: 'item/started',
              params: {
                threadId: 'thread-idle-pdf-delta-1',
                turnId: 'turn-idle-pdf-delta-2',
                item: {
                  id: 'cmd-1',
                  type: 'commandExecution',
                },
              },
            },
          });
          throw new Error(
            'Codex turn turn-idle-pdf-delta-2 went idle for 180000ms after item/completed:commandExecution without reaching turn/completed.',
          );
        }

        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-idle-pdf-delta-1',
              turnId: 'turn-idle-pdf-delta-3',
              itemId: 'msg-1',
              delta: 'I generated the PDF file and am checking the output.',
            },
          },
        });
        throw new Error(
          'Codex turn turn-idle-pdf-delta-3 went idle for 180000ms after item/agentMessage/delta without reaching turn/completed.',
        );
      },
    } as any;

    const result = await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create a PDF after generating chart PNGs.',
      binding: {
        agentId: 'idle-retry-agent-1251',
      },
    });

    expect(runTurnCalls).toHaveLength(4);
    expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
    expect(runTurnCalls[2]?.message).toContain('The previous turn stalled before completing.');
    expect(runTurnCalls[3]?.message).toContain('The previous turn stalled before completing.');
    expect(result.completion.turnId).toBe('turn-idle-pdf-delta-4');
  });

  test('retries a recovered idle turn again after fresh reasoning summary delta progress', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });

        if (runTurnCalls.length === 4) {
          return {
            threadId: 'thread-idle-reasoning-delta-1',
            turnId: 'turn-idle-reasoning-delta-4',
            status: 'completed',
          };
        }

        options.onEvent?.({ kind: 'thread', threadId: 'thread-idle-reasoning-delta-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-idle-reasoning-delta-1',
          turnId: `turn-idle-reasoning-delta-${runTurnCalls.length}`,
          status: 'inProgress',
        });

        if (runTurnCalls.length === 1) {
          options.onEvent?.({
            kind: 'notification',
            notification: {
              method: SERVER_METHOD.itemStarted,
              params: {
                threadId: 'thread-idle-reasoning-delta-1',
                turnId: 'turn-idle-reasoning-delta-1',
                item: {
                  id: 'reasoning-1',
                  type: 'reasoning',
                  summary: [],
                  content: [],
                },
              },
            },
          });
          throw new Error(
            'Codex turn turn-idle-reasoning-delta-1 went idle for 180000ms after rawResponseItem/completed:reasoning without reaching turn/completed.',
          );
        }

        if (runTurnCalls.length === 2) {
          options.onEvent?.({
            kind: 'notification',
            notification: {
              method: SERVER_METHOD.itemStarted,
              params: {
                threadId: 'thread-idle-reasoning-delta-1',
                turnId: 'turn-idle-reasoning-delta-2',
                item: {
                  id: 'cmd-1',
                  type: 'commandExecution',
                },
              },
            },
          });
          throw new Error(
            'Codex turn turn-idle-reasoning-delta-2 went idle for 180000ms after item/completed:commandExecution without reaching turn/completed.',
          );
        }

        const reasoningSummaryDeltaEvent = {
          kind: 'notification',
          notification: {
            method: SERVER_METHOD.reasoningSummaryTextDelta,
            params: {
              threadId: 'thread-idle-reasoning-delta-1',
              turnId: 'turn-idle-reasoning-delta-3',
              itemId: 'reasoning-2',
              delta: 'Now I need to write the remaining module files.',
              summaryIndex: 0,
            },
          },
        } satisfies StreamEvent & {
          notification: NotificationOfMethod<typeof SERVER_METHOD.reasoningSummaryTextDelta>;
        };
        options.onEvent?.(reasoningSummaryDeltaEvent);
        throw new Error(
          'Codex turn turn-idle-reasoning-delta-3 went idle for 180000ms after item/reasoning/summaryTextDelta without reaching turn/completed.',
        );
      },
    } as any;

    const result = await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create the PrestaShop module files.',
      binding: {
        agentId: 'idle-retry-agent-1291',
      },
    });

    expect(runTurnCalls).toHaveLength(4);
    expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
    expect(runTurnCalls[2]?.message).toContain('The previous turn stalled before completing.');
    expect(runTurnCalls[3]?.message).toContain('The previous turn stalled before completing.');
    expect(result.completion.turnId).toBe('turn-idle-reasoning-delta-4');
  });

  test('retries a recovered idle turn again after other typed turn-progress notifications', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });

        if (runTurnCalls.length === 3) {
          return {
            threadId: 'thread-idle-plan-delta-1',
            turnId: 'turn-idle-plan-delta-3',
            status: 'completed',
          };
        }

        options.onEvent?.({ kind: 'thread', threadId: 'thread-idle-plan-delta-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-idle-plan-delta-1',
          turnId: `turn-idle-plan-delta-${runTurnCalls.length}`,
          status: 'inProgress',
        });

        if (runTurnCalls.length === 1) {
          options.onEvent?.({
            kind: 'notification',
            notification: {
              method: SERVER_METHOD.itemStarted,
              params: {
                threadId: 'thread-idle-plan-delta-1',
                turnId: 'turn-idle-plan-delta-1',
                item: {
                  id: 'reasoning-1',
                  type: 'reasoning',
                  summary: [],
                  content: [],
                },
              },
            },
          });
          throw new Error(
            'Codex turn turn-idle-plan-delta-1 went idle for 180000ms after rawResponseItem/completed:reasoning without reaching turn/completed.',
          );
        }

        const planDeltaEvent = {
          kind: 'notification',
          notification: {
            method: SERVER_METHOD.planDelta,
            params: {
              threadId: 'thread-idle-plan-delta-1',
              turnId: 'turn-idle-plan-delta-2',
              itemId: 'plan-1',
              delta: 'Checking the remaining implementation steps.',
            },
          },
        } satisfies StreamEvent & {
          notification: NotificationOfMethod<typeof SERVER_METHOD.planDelta>;
        };
        options.onEvent?.(planDeltaEvent);
        throw new Error(
          'Codex turn turn-idle-plan-delta-2 went idle for 180000ms after item/plan/delta without reaching turn/completed.',
        );
      },
    } as any;

    const result = await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Finish the implementation.',
      binding: {
        agentId: 'idle-retry-agent-plan-delta',
      },
    });

    expect(runTurnCalls).toHaveLength(3);
    expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
    expect(runTurnCalls[2]?.message).toContain('The previous turn stalled before completing.');
    expect(result.completion.turnId).toBe('turn-idle-plan-delta-3');
  });

  test('does not retry after final answer output even when assistant deltas follow', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const finalAnswerIdleError = new Error(
      'Codex turn turn-final-answer-1 went idle for 180000ms after item/agentMessage/delta without reaching turn/completed.',
    );
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        options.onEvent?.({ kind: 'thread', threadId: 'thread-final-answer-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-final-answer-1',
          turnId: 'turn-final-answer-1',
          status: 'inProgress',
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/started',
            params: {
              threadId: 'thread-final-answer-1',
              turnId: 'turn-final-answer-1',
              item: {
                id: 'msg-1',
                type: 'agentMessage',
                text: '',
                phase: 'final_answer',
              },
            },
          },
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-final-answer-1',
              turnId: 'turn-final-answer-1',
              itemId: 'msg-1',
              delta: 'Here is the PDF.',
            },
          },
        });
        throw finalAnswerIdleError;
      },
    } as any;

    await expect(runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create a PDF.',
      binding: {
        agentId: 'idle-retry-final-answer',
      },
    })).rejects.toThrow(finalAnswerIdleError);

    expect(runTurnCalls).toHaveLength(1);
  });

  test('does not retry after final answer output even when later tool progress arrives', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const finalAnswerIdleError = new Error(
      'Codex turn turn-final-answer-tool-progress-1 went idle for 180000ms after item/mcpToolCall/progress without reaching turn/completed.',
    );
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        options.onEvent?.({ kind: 'thread', threadId: 'thread-final-answer-tool-progress-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-final-answer-tool-progress-1',
          turnId: 'turn-final-answer-tool-progress-1',
          status: 'inProgress',
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: SERVER_METHOD.itemStarted,
            params: {
              threadId: 'thread-final-answer-tool-progress-1',
              turnId: 'turn-final-answer-tool-progress-1',
              item: {
                id: 'msg-1',
                type: 'agentMessage',
                text: '',
                phase: 'final_answer',
              },
            },
          },
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: SERVER_METHOD.mcpToolCallProgress,
            params: {
              threadId: 'thread-final-answer-tool-progress-1',
              turnId: 'turn-final-answer-tool-progress-1',
              itemId: 'mcp-1',
              message: 'Still flushing tool progress.',
            },
          },
        });
        throw finalAnswerIdleError;
      },
    } as any;

    await expect(runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create a PDF.',
      binding: {
        agentId: 'idle-retry-final-answer-tool-progress',
      },
    })).rejects.toThrow(finalAnswerIdleError);

    expect(runTurnCalls).toHaveLength(1);
  });

  test('does not retry after a completed final answer item', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const finalAnswerIdleError = new Error(
      'Codex turn turn-final-answer-completed-1 went idle for 180000ms after item/completed:agentMessage without reaching turn/completed.',
    );
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        options.onEvent?.({ kind: 'thread', threadId: 'thread-final-answer-completed-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-final-answer-completed-1',
          turnId: 'turn-final-answer-completed-1',
          status: 'inProgress',
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: SERVER_METHOD.itemCompleted,
            params: {
              threadId: 'thread-final-answer-completed-1',
              turnId: 'turn-final-answer-completed-1',
              item: {
                id: 'msg-1',
                type: 'agentMessage',
                text: 'Here is the PDF.',
                phase: 'final_answer',
                memoryCitation: null,
              },
            },
          },
        });
        throw finalAnswerIdleError;
      },
    } as any;

    await expect(runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create a PDF.',
      binding: {
        agentId: 'idle-retry-final-answer-completed',
      },
    })).rejects.toThrow(finalAnswerIdleError);

    expect(runTurnCalls).toHaveLength(1);
  });

  test('does not retry after a completed raw final answer message', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const finalAnswerIdleError = new Error(
      'Codex turn turn-final-answer-raw-1 went idle for 180000ms after rawResponseItem/completed:message without reaching turn/completed.',
    );
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        options.onEvent?.({ kind: 'thread', threadId: 'thread-final-answer-raw-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-final-answer-raw-1',
          turnId: 'turn-final-answer-raw-1',
          status: 'inProgress',
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: SERVER_METHOD.rawResponseItemCompleted,
            params: {
              threadId: 'thread-final-answer-raw-1',
              turnId: 'turn-final-answer-raw-1',
              item: {
                type: 'message',
                role: 'assistant',
                content: [],
                phase: 'final_answer',
              },
            },
          },
        });
        throw finalAnswerIdleError;
      },
    } as any;

    await expect(runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create a PDF.',
      binding: {
        agentId: 'idle-retry-final-answer-raw',
      },
    })).rejects.toThrow(finalAnswerIdleError);

    expect(runTurnCalls).toHaveLength(1);
  });

  test('does not retry after non-progress turn notifications', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const nonProgressIdleError = new Error(
      'Codex turn turn-thread-name-1 went idle for 180000ms after thread/name/updated without reaching turn/completed.',
    );
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        options.onEvent?.({ kind: 'thread', threadId: 'thread-thread-name-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-thread-name-1',
          turnId: 'turn-thread-name-1',
          status: 'inProgress',
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: SERVER_METHOD.threadNameUpdated,
            params: {
              threadId: 'thread-thread-name-1',
              threadName: 'Updated thread',
            },
          },
        });
        throw nonProgressIdleError;
      },
    } as any;

    await expect(runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create a PDF.',
      binding: {
        agentId: 'idle-retry-thread-name',
      },
    })).rejects.toThrow(nonProgressIdleError);

    expect(runTurnCalls).toHaveLength(1);
  });

  test('does not retry after stream errors without progress', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const streamErrorIdleError = new Error(
      'Codex turn turn-stream-error-1 went idle for 180000ms after error without reaching turn/completed.',
    );
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        options.onEvent?.({ kind: 'thread', threadId: 'thread-stream-error-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-stream-error-1',
          turnId: 'turn-stream-error-1',
          status: 'inProgress',
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: SERVER_METHOD.streamError,
            params: {
              threadId: 'thread-stream-error-1',
              turnId: 'turn-stream-error-1',
              willRetry: false,
              error: {
                message: 'Provider stream disconnected.',
                codexErrorInfo: null,
                additionalDetails: null,
              },
            },
          },
        });
        throw streamErrorIdleError;
      },
    } as any;

    await expect(runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create a PDF.',
      binding: {
        agentId: 'idle-retry-stream-error',
      },
    })).rejects.toThrow(streamErrorIdleError);

    expect(runTurnCalls).toHaveLength(1);
  });

  test('stops retrying when a recovered idle turn idles a fourth time', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const finalIdleError = new Error(
      'Codex turn turn-idle-pdf-4 went idle for 180000ms after rawResponseItem/completed:reasoning without reaching turn/completed.',
    );
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });

        options.onEvent?.({ kind: 'thread', threadId: 'thread-idle-pdf-loop-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-idle-pdf-loop-1',
          turnId: `turn-idle-pdf-${runTurnCalls.length}`,
          status: 'inProgress',
        });

        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/started',
            params: {
              threadId: 'thread-idle-pdf-loop-1',
              turnId: `turn-idle-pdf-${runTurnCalls.length}`,
              item: runTurnCalls.length === 1
                ? {
                    id: 'reasoning-1',
                    type: 'reasoning',
                    summary: [],
                    content: [],
                  }
                : {
                    id: `cmd-${runTurnCalls.length}`,
                    type: 'commandExecution',
                  },
            },
          },
        });

        if (runTurnCalls.length === 4) {
          throw finalIdleError;
        }

        throw new Error(
          `Codex turn turn-idle-pdf-${runTurnCalls.length} went idle for 180000ms after rawResponseItem/completed:reasoning without reaching turn/completed.`,
        );
      },
    } as any;

    await expect(runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create a PDF after generating chart PNGs.',
      binding: {
        agentId: 'idle-retry-agent-1187-limit',
      },
    })).rejects.toThrow(finalIdleError);

    expect(runTurnCalls).toHaveLength(4);
    expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
    expect(runTurnCalls[2]?.message).toContain('The previous turn stalled before completing.');
    expect(runTurnCalls[3]?.message).toContain('The previous turn stalled before completing.');
  });

  test('retries idle turns after the user message is accepted but no model output starts', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        if (runTurnCalls.length === 2) {
          return {
            threadId: 'thread-idle-user-message-1',
            turnId: 'turn-idle-user-message-2',
            status: 'completed',
          };
        }
        options.onEvent?.({ kind: 'thread', threadId: 'thread-idle-user-message-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-idle-user-message-1',
          turnId: 'turn-idle-user-message-1',
          status: 'inProgress',
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/completed',
            params: {
              threadId: 'thread-idle-user-message-1',
              turnId: 'turn-idle-user-message-1',
              item: {
                id: 'user-1',
                type: 'userMessage',
                content: [{ type: 'text', text: 'Show desktop apps.', text_elements: [] }],
              },
            },
          },
        });
        throw new Error(
          'Codex turn turn-idle-user-message-1 went idle for 180000ms after item/completed:userMessage without reaching turn/completed.',
        );
      },
    } as any;

    const result = await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Show me which desktop apps are open.',
      binding: {
        agentId: 'idle-retry-agent-user-message',
      },
    });

    expect(runTurnCalls).toHaveLength(2);
    expect(runTurnCalls[1]?.threadId).toBe('thread-idle-user-message-1');
    expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
    expect(result.completion.turnId).toBe('turn-idle-user-message-2');
  });

  test('retries again when the recovery user message is accepted but no model output starts', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        if (runTurnCalls.length === 3) {
          return {
            threadId: 'thread-idle-recovery-user-message-1',
            turnId: 'turn-idle-recovery-user-message-3',
            status: 'completed',
          };
        }

        const turnId = `turn-idle-recovery-user-message-${runTurnCalls.length}`;
        options.onEvent?.({ kind: 'thread', threadId: 'thread-idle-recovery-user-message-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-idle-recovery-user-message-1',
          turnId,
          status: 'inProgress',
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/completed',
            params: {
              threadId: 'thread-idle-recovery-user-message-1',
              turnId,
              item: {
                id: `user-${runTurnCalls.length}`,
                type: 'userMessage',
                content: [{ type: 'text', text: 'Continue.', text_elements: [] }],
              },
            },
          },
        });
        throw new Error(
          `Codex turn ${turnId} went idle for 180000ms after item/completed:userMessage without reaching turn/completed.`,
        );
      },
    } as any;

    const result = await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Do you understand this code?',
      binding: {
        agentId: 'idle-retry-agent-recovery-user-message',
      },
    });

    expect(runTurnCalls).toHaveLength(3);
    expect(runTurnCalls[1]?.threadId).toBe('thread-idle-recovery-user-message-1');
    expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
    expect(runTurnCalls[2]?.threadId).toBe('thread-idle-recovery-user-message-1');
    expect(runTurnCalls[2]?.message).toContain('The previous turn stalled before completing.');
    expect(result.completion.turnId).toBe('turn-idle-recovery-user-message-3');
  });

  test('retries idle turns after commentary-only output without a final answer', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        if (runTurnCalls.length === 2) {
          return {
            threadId: 'thread-idle-commentary-1',
            turnId: 'turn-idle-commentary-2',
            status: 'completed',
          };
        }
        options.onEvent?.({ kind: 'thread', threadId: 'thread-idle-commentary-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-idle-commentary-1',
          turnId: 'turn-idle-commentary-1',
          status: 'inProgress',
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/started',
            params: {
              threadId: 'thread-idle-commentary-1',
              turnId: 'turn-idle-commentary-1',
              item: {
                id: 'reasoning-1',
                type: 'reasoning',
                summary: [],
                content: [],
              },
            },
          },
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/started',
            params: {
              threadId: 'thread-idle-commentary-1',
              turnId: 'turn-idle-commentary-1',
              item: {
                id: 'msg-1',
                type: 'agentMessage',
                text: '',
                phase: 'commentary',
              },
            },
          },
        });
        throw new Error(
          'Codex turn turn-idle-commentary-1 went idle for 180000ms after item/completed:agentMessage without reaching turn/completed.',
        );
      },
    } as any;

    const result = await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create the workbook.',
      binding: {
        agentId: 'idle-retry-agent-3',
      },
    });

    expect(runTurnCalls).toHaveLength(2);
    expect(runTurnCalls[1]?.threadId).toBe('thread-idle-commentary-1');
    expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
    expect(runTurnCalls[1]?.message).toContain('do not repeat it');
    expect(result.completion.turnId).toBe('turn-idle-commentary-2');
  });

  test('retries idle turns after non-final assistant output without a phase', async () => {
    const runTurnCalls: Array<{ threadId?: string; message?: string }> = [];
    const fakeService = {
      async ensureProvider() {},
      async runTurn(options: any) {
        runTurnCalls.push({
          threadId: options.threadId,
          message: options.message,
        });
        if (runTurnCalls.length === 2) {
          return {
            threadId: 'thread-idle-assistant-1',
            turnId: 'turn-idle-assistant-2',
            status: 'completed',
          };
        }
        options.onEvent?.({ kind: 'thread', threadId: 'thread-idle-assistant-1' });
        options.onEvent?.({
          kind: 'turn',
          threadId: 'thread-idle-assistant-1',
          turnId: 'turn-idle-assistant-1',
          status: 'inProgress',
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/started',
            params: {
              threadId: 'thread-idle-assistant-1',
              turnId: 'turn-idle-assistant-1',
              item: {
                id: 'msg-1',
                type: 'agentMessage',
                text: '---',
              },
            },
          },
        });
        options.onEvent?.({
          kind: 'notification',
          notification: {
            method: 'item/started',
            params: {
              threadId: 'thread-idle-assistant-1',
              turnId: 'turn-idle-assistant-1',
              item: {
                id: 'reasoning-1',
                type: 'reasoning',
                summary: [],
                content: [],
              },
            },
          },
        });
        throw new Error(
          'Codex turn turn-idle-assistant-1 went idle for 180000ms after rawResponseItem/completed:reasoning without reaching turn/completed.',
        );
      },
    } as any;

    const result = await runCodexAgentTurn({
      service: fakeService,
      profile: {
        modelProvider: 'openai',
        model: 'gpt-5.4',
      } as any,
      workspacePath: '/tmp',
      message: 'Create a PDF.',
      binding: {
        agentId: 'idle-retry-agent-assistant',
      },
    });

    expect(runTurnCalls).toHaveLength(2);
    expect(runTurnCalls[1]?.threadId).toBe('thread-idle-assistant-1');
    expect(runTurnCalls[1]?.message).toContain('The previous turn stalled before completing.');
    expect(result.completion.turnId).toBe('turn-idle-assistant-2');
  });
});
