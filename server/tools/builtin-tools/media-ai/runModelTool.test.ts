import { afterEach, beforeEach, describe, test, expect, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clearConfigCache, setConfigOverride } from '../../../configStore';
mock.module('../../../utils/hostedProvider', () => ({
  HOSTED_LLM_SERVER: 'https://api.example.test',
}));

const {
  buildValidationFailureMessage,
  normalizeLocalPathInput,
  parseRunMediaModelInputArg,
  runMediaModelTool,
  shouldUploadParam,
} = await import('./runModelTool');

beforeEach(() => {
  clearConfigCache();
  setConfigOverride({
    agents: {},
    authToken: 'test-access-token',
  } as any);
});

afterEach(() => {
  setConfigOverride(null);
  clearConfigCache();
});

function getExampleLocalPath(): string {
  return process.platform === 'win32'
    ? 'C:\\Users\\example\\image.png'
    : '/Users/example/image.png';
}

describe('parseRunMediaModelInputArg', () => {
  test('parses valid JSON object string', () => {
    const parsed = parseRunMediaModelInputArg('{"prompt":"bike gear","num_images":1}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({ prompt: 'bike gear', num_images: 1 });
    }
  });

  test('rejects non-string input', () => {
    const parsed = parseRunMediaModelInputArg({ prompt: 'bike gear' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain('input must be a JSON string');
    }
  });

  test('rejects invalid JSON input string', () => {
    const parsed = parseRunMediaModelInputArg('{"prompt":"bike gear"');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain('input must be valid JSON');
    }
  });

  test('rejects JSON that does not decode to object', () => {
    const parsed = parseRunMediaModelInputArg('"just a string"');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain('must decode to an object');
    }
  });
});

describe('buildValidationFailureMessage', () => {
  test('returns fallback guidance when schema is unavailable', () => {
    const message = buildValidationFailureMessage({
      endpointId: 'fal-ai/flux-2',
      falErrorMessage: 'fal request failed (GET ...): 422 Unprocessable Entity',
      providedInput: {},
      inputParameters: null,
    });

    expect(message).toContain('Failed to run media model for "fal-ai/flux-2"');
    expect(message).toContain('provided_input_keys: (none)');
    expect(message).toContain('expected_input_parameters: unavailable for this endpoint');
  });

  test('highlights missing required fields and shows example', () => {
    const message = buildValidationFailureMessage({
      endpointId: 'fal-ai/flux-2',
      falErrorMessage: 'fal request failed (GET ...): input.prompt: Field required',
      providedInput: {},
      inputParameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'The prompt to generate an image from.',
        },
        num_images: {
          type: 'integer',
          required: false,
          default: 1,
        },
      },
    });

    expect(message).toContain('missing_required_input_keys: prompt');
    expect(message).toContain('- prompt (required, string');
    expect(message).toContain('minimal_valid_tool_call:');
    expect(message).toContain('\\"prompt\\"');
  });

  test('does not report missing required fields when provided', () => {
    const message = buildValidationFailureMessage({
      endpointId: 'fal-ai/flux-2',
      falErrorMessage: 'fal request failed (GET ...): input.num_images: should be >= 1',
      providedInput: { prompt: 'gear photo' },
      inputParameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'The prompt to generate an image from.',
        },
      },
    });

    expect(message).toContain('provided_input_keys: prompt');
    expect(message).toContain('missing_required_input_keys: (none)');
  });
});

describe('shouldUploadParam', () => {
  test('accepts singular _url key with local file path', () => {
    expect(shouldUploadParam('image_url', '/Users/example/image.png')).toBe(true);
  });

  test('accepts plural _urls key with indexed local file path', () => {
    expect(shouldUploadParam('image_urls[0]', '/Users/example/image.png')).toBe(true);
  });

  test('accepts nested plural _urls key with indexed local file path', () => {
    expect(shouldUploadParam('input.image_urls[1]', '/Users/example/image.png')).toBe(true);
  });

  test('rejects URL values (already remote)', () => {
    expect(shouldUploadParam('image_urls[0]', 'https://example.com/image.png')).toBe(false);
  });

  test('rejects non-url parameter names', () => {
    expect(shouldUploadParam('prompt', '/Users/example/image.png')).toBe(false);
  });
});

describe('normalizeLocalPathInput', () => {
  test('passes through normal file path', () => {
    const localPath = getExampleLocalPath();
    expect(normalizeLocalPathInput(localPath)).toBe(localPath);
  });

  test('converts file URL to local path', () => {
    const localPath = getExampleLocalPath();
    const fileUrl = pathToFileURL(localPath).href;
    expect(normalizeLocalPathInput(fileUrl)).toBe(localPath);
  });
});

describe('runMediaModelTool progress reporting', () => {
  test('requires output_dir when saving outputs to workspace', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called when output_dir is missing');
    }) as typeof fetch;

    try {
      const result = await runMediaModelTool.handler({
        endpoint_id: 'fal-ai/ben/v2/video',
        input: '{"video_url":"https://example.com/input.mp4","output_format":"webm"}',
      }, {
        workspace: '/tmp/workspace',
      });

      expect(result.isError).toBeTrue();
      expect(result.content[0]?.type).toBe('text');
      expect((result.content[0] as { text?: string }).text)
        .toContain('output_dir is required when save_to_workspace is true');
      expect(fetchCalled).toBeFalse();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('emits queue status progress for long-running runs', async () => {
    const originalFetch = globalThis.fetch;
    const progress: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url === 'https://api.example.test/v0/media-ai/run') {
        const streamBody = [
          JSON.stringify({
            type: 'progress',
            fields: {
              phase: 'queue_submitted',
              endpointId: 'fal-ai/ben/v2/video',
              requestId: 'req_media_123',
            },
          }),
          JSON.stringify({
            type: 'progress',
            fields: {
              phase: 'queue_status',
              endpointId: 'fal-ai/ben/v2/video',
              requestId: 'req_media_123',
              status: 'IN_QUEUE',
              elapsedMs: 10,
            },
          }),
          JSON.stringify({
            type: 'progress',
            fields: {
              phase: 'queue_status',
              endpointId: 'fal-ai/ben/v2/video',
              requestId: 'req_media_123',
              status: 'IN_PROGRESS',
              elapsedMs: 25,
            },
          }),
          JSON.stringify({
            type: 'progress',
            fields: {
              phase: 'queue_completed',
              endpointId: 'fal-ai/ben/v2/video',
              requestId: 'req_media_123',
              elapsedMs: 50,
            },
          }),
          JSON.stringify({
            type: 'result',
            result: {
              endpoint_id: 'fal-ai/ben/v2/video',
              request_id: 'req_media_123',
              output: {
                video: {
                  url: 'https://storage.example.com/output.webm',
                },
              },
              output_urls: ['https://storage.example.com/output.webm'],
              billable_units: 1,
              cost_usd: 0.25,
              cost_unit: 'request',
              billing: {
                updated_monthly_tokens: 90,
                updated_purchased_tokens: 10,
                tokens_not_deducted: 0,
                estimated_interpreter_tokens: 90000,
                estimated_interpreter_charge_usd: 0.27,
                charged_interpreter_tokens: 90000,
                charged_interpreter_usd: 0.27,
                interpreter_token_price_usd: 0.000003,
                interpreter_profit_margin_percent: 8,
              },
            },
          }),
        ].join('\n');
        return new Response(streamBody, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }

      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }) as typeof fetch;

    try {
      const result = await runMediaModelTool.handler({
        endpoint_id: 'fal-ai/ben/v2/video',
        input: '{"video_url":"https://example.com/input.mp4","output_format":"webm"}',
        save_to_workspace: false,
        timeout_seconds: 30,
      }, {
        reportProgress: (text) => {
          progress.push(text.trim());
        },
      });

      expect(result.isError).toBeFalse();
      expect(progress.some((line) => line.includes('phase="prepare_input"') || line.includes('phase="queue_submitted"'))).toBeTrue();
      expect(progress.some((line) => line.includes('phase="queue_submitted"'))).toBeTrue();
      expect(progress.some((line) => line.includes('phase="queue_status"') && line.includes('status="IN_QUEUE"'))).toBeTrue();
      expect(progress.some((line) => line.includes('phase="queue_status"') && line.includes('status="IN_PROGRESS"'))).toBeTrue();
      expect(progress.some((line) => line.includes('phase="queue_completed"'))).toBeTrue();
      expect(progress.some((line) => line.includes('phase="completed"'))).toBeTrue();
      expect(result.content[0]?.type).toBe('text');
      expect((result.content[0] as { text?: string }).text).toContain('"success": true');
      expect((result.content[0] as { text?: string }).text).toContain('"cost_usd": 0.25');
      expect((result.content[0] as { text?: string }).text).toContain('"estimated_interpreter_charge_usd": 0.27');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('forwards abortSignal to hosted uploads and hosted runs', async () => {
    const originalFetch = globalThis.fetch;
    const tempDir = await mkdtemp(path.join(tmpdir(), 'media-ai-abort-'));
    const localPath = path.join(tempDir, 'input.png');
    const controller = new AbortController();
    const seenSignals: AbortSignal[] = [];

    await writeFile(localPath, 'image-bytes');

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (init?.signal) {
        seenSignals.push(init.signal);
      }

      if (url === 'https://api.example.test/v0/upload?bucket=user-uploads') {
        return new Response(JSON.stringify({ url: 'https://storage.example.com/input.png' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://api.example.test/v0/media-ai/run') {
        return new Response([
          JSON.stringify({
            type: 'result',
            result: {
              endpoint_id: 'fal-ai/flux-pro/v1.1-ultra',
              request_id: 'req_abort_123',
              output: {
                images: [{ url: 'https://storage.example.com/output.png' }],
              },
              output_urls: ['https://storage.example.com/output.png'],
              billable_units: 1,
              cost_usd: 0.25,
              cost_unit: 'request',
            },
          }),
        ].join('\n'), {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }

      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }) as typeof fetch;

    try {
      const result = await runMediaModelTool.handler({
        endpoint_id: 'fal-ai/flux-pro/v1.1-ultra',
        input: JSON.stringify({ image_url: localPath, prompt: 'demo' }),
        save_to_workspace: false,
      }, {
        abortSignal: controller.signal,
      });

      expect(result.isError).toBeFalse();
      expect(seenSignals).toEqual([controller.signal, controller.signal]);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
