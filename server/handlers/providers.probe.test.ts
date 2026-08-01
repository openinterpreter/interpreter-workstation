import { afterEach, beforeEach, describe, test, mock } from 'bun:test';
import assert from 'node:assert/strict';

import { probeResponsesApiSupport } from './providers';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('probeResponsesApiSupport', () => {
  test('should_return_supported_when_endpoint_returns_401', async () => {
    globalThis.fetch = mock(async () => new Response('', { status: 401 })) as typeof fetch;
    const result = await probeResponsesApiSupport('https://api.openai.com/v1');
    assert.deepStrictEqual(result, { supported: true, reachable: true });
  });

  test('should_return_not_supported_when_endpoint_returns_404', async () => {
    globalThis.fetch = mock(async () => new Response('', { status: 404 })) as typeof fetch;
    const result = await probeResponsesApiSupport('https://generativelanguage.googleapis.com/v1beta/openai');
    assert.deepStrictEqual(result, { supported: false, reachable: true });
  });

  test('should_return_supported_when_endpoint_returns_400', async () => {
    globalThis.fetch = mock(async () => new Response('', { status: 400 })) as typeof fetch;
    const result = await probeResponsesApiSupport('https://some-provider.com/v1');
    assert.deepStrictEqual(result, { supported: true, reachable: true });
  });

  test('should_return_not_reachable_on_network_error', async () => {
    globalThis.fetch = mock(async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const result = await probeResponsesApiSupport('https://unreachable.example.com');
    assert.deepStrictEqual(result, { supported: true, reachable: false });
  });

  test('should_return_not_reachable_for_malformed_base_url', async () => {
    const mockFetch = mock(async () => new Response('', { status: 401 })) as typeof fetch;
    globalThis.fetch = mockFetch;
    const result = await probeResponsesApiSupport('not a url');
    assert.deepStrictEqual(result, { supported: true, reachable: false });
    assert.equal(mockFetch.mock.calls.length, 0);
  });

  test('should_append_responses_to_base_url', async () => {
    const mockFetch = mock(async () => new Response('', { status: 401 })) as typeof fetch;
    globalThis.fetch = mockFetch;
    await probeResponsesApiSupport('https://api.openai.com/v1');
    assert.equal(mockFetch.mock.calls.length, 1);
    assert.equal(mockFetch.mock.calls[0][0], 'https://api.openai.com/v1/responses');
  });

  test('should_handle_trailing_slash_without_duplicating', async () => {
    const mockFetch = mock(async () => new Response('', { status: 401 })) as typeof fetch;
    globalThis.fetch = mockFetch;
    await probeResponsesApiSupport('https://api.openai.com/v1/');
    assert.equal(mockFetch.mock.calls[0][0], 'https://api.openai.com/v1/responses');
  });

  test('should_use_post_method', async () => {
    const mockFetch = mock(async () => new Response('', { status: 401 })) as typeof fetch;
    globalThis.fetch = mockFetch;
    await probeResponsesApiSupport('https://api.openai.com/v1');
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    assert.equal(options.method, 'POST');
  });

  test('should_probe_with_invalid_shape_instead_of_fake_model_id', async () => {
    const mockFetch = mock(async () => new Response('', { status: 400 })) as typeof fetch;
    globalThis.fetch = mockFetch;
    await probeResponsesApiSupport('https://openrouter.ai/api/v1');
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    assert.equal(options.body, JSON.stringify({ input: 'probe' }));
  });

  test('should_not_include_model_field_in_probe_body', async () => {
    const mockFetch = mock(async () => new Response('', { status: 400 })) as typeof fetch;
    globalThis.fetch = mockFetch;
    await probeResponsesApiSupport('http://localhost:11434/v1');
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    assert.deepStrictEqual(body, { input: 'probe' });
    assert.equal('model' in body, false);
  });

  test('should_treat_openrouter_style_no_models_provided_400_as_supported', async () => {
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ error: { message: 'No models provided', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    const result = await probeResponsesApiSupport('https://openrouter.ai/api/v1');
    assert.deepStrictEqual(result, { supported: true, reachable: true });
  });

  test('should_treat_ollama_style_model_required_400_as_supported', async () => {
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ error: { message: 'model is required', type: 'invalid_request_error' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    const result = await probeResponsesApiSupport('http://localhost:11434/v1');
    assert.deepStrictEqual(result, { supported: true, reachable: true });
  });

  test('should_treat_lmstudio_style_missing_model_400_as_supported', async () => {
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({
        error: {
          message: "Missing required parameter: 'model'.",
          type: 'invalid_request_error',
          param: 'model',
          code: 'missing_required_parameter',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    const result = await probeResponsesApiSupport('http://localhost:1234/v1');
    assert.deepStrictEqual(result, { supported: true, reachable: true });
  });

  test('should_treat_openrouter_style_auth_401_as_supported', async () => {
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ error: { message: 'No cookie auth credentials found', code: 401 } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    const result = await probeResponsesApiSupport('https://openrouter.ai/api/v1');
    assert.deepStrictEqual(result, { supported: true, reachable: true });
  });
});
