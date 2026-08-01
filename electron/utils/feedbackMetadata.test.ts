import { describe, expect, test } from 'bun:test';

import { appendFeedbackMetadataDump, redactFeedbackMetadata } from './feedbackMetadata';

describe('feedbackMetadata', () => {
  test('redacts config secrets while preserving structure', () => {
    expect(redactFeedbackMetadata({
      authToken: 'auth-token',
      refreshToken: 'refresh-token',
      agents: {
        interpreter: {
          apiKeys: {
            openai: 'sk-openai',
            groq: 'sk-groq',
          },
        },
      },
      model_providers: {
        openrouter: {
          experimental_bearer_token: 'token',
          http_headers: {
            Authorization: 'Bearer token',
            'x-api-key': 'api-key',
            'X-Trace-Id': 'trace-id',
          },
          env_http_headers: {
            Authorization: 'OPENROUTER_AUTH_HEADER',
          },
        },
      },
      interpreter_app: {
        providers: {
          provider1: {
            apiKey: 'provider-key',
          },
        },
      },
    })).toEqual({
      authToken: '[REDACTED]',
      refreshToken: '[REDACTED]',
      agents: {
        interpreter: {
          apiKeys: {
            openai: '[REDACTED]',
            groq: '[REDACTED]',
          },
        },
      },
      model_providers: {
        openrouter: {
          experimental_bearer_token: '[REDACTED]',
          http_headers: {
            Authorization: '[REDACTED]',
            'x-api-key': '[REDACTED]',
            'X-Trace-Id': 'trace-id',
          },
          env_http_headers: {
            Authorization: 'OPENROUTER_AUTH_HEADER',
          },
        },
      },
      interpreter_app: {
        providers: {
          provider1: {
            apiKey: '[REDACTED]',
          },
        },
      },
    });
  });

  test('appends the metadata dump after the log body', () => {
    expect(appendFeedbackMetadataDump('line 1\nline 2\n', { ok: true })).toBe(
      'line 1\nline 2\n\n<feedback_metadata_dump>\n{"ok":true}\n</feedback_metadata_dump>\n'
    );
  });

  test('returns only the metadata dump when no logs exist', () => {
    expect(appendFeedbackMetadataDump('', { ok: true })).toBe(
      '<feedback_metadata_dump>\n{"ok":true}\n</feedback_metadata_dump>\n'
    );
  });
});
