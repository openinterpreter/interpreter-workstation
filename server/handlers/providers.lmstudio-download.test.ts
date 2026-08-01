import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';

mock.module('../utils/codexServiceBridge', () => ({
  getCodexClient: mock(() => ({ subscribe: () => {} })),
  getCodexService: mock(() => ({})),
}));

mock.module('./profiles', () => ({
  ensureProviderProfiles: mock(async () => ({ created: false })),
  listProfiles: mock(async () => ({ profiles: [], defaultProfileId: null })),
  getProfile: mock(async () => null),
  createProfile: mock(async () => ({ profile: null })),
  updateProfile: mock(async () => ({ profile: null })),
  deleteProfile: mock(async () => ({ success: true })),
  setDefaultProfile: mock(async () => ({})),
  resetProfile: mock(async () => ({})),
}));

const originalFetch = globalThis.fetch;
const capturedRequests: { url: string; init: RequestInit }[] = [];

const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
  capturedRequests.push({ url: String(url), init: init || {} });
  return {
    ok: false,
    status: 503,
    json: async () => ({}),
  };
});
globalThis.fetch = mockFetch as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const { downloadLmStudioModel } = await import('./providers');

describe('downloadLmStudioModel auth headers', () => {
  beforeEach(() => {
    capturedRequests.length = 0;
    mockFetch.mockClear();
    mockFetch.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      capturedRequests.push({ url: String(url), init: init || {} });
      return { ok: false, status: 503, json: async () => ({}) };
    });
  });

  test('should_send_bearer_lm_studio_on_status_check', async () => {
    const gen = downloadLmStudioModel('test-model');
    const result = await gen.next();

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const statusReq = capturedRequests[0];
    expect((statusReq.init.headers as Record<string, string>).Authorization).toBe('Bearer lm-studio');
    expect(result.value?.code).toBe('LM_STUDIO_NOT_RUNNING');
  });

  test('should_send_bearer_lm_studio_on_download_start', async () => {
    mockFetch.mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
      capturedRequests.push({ url: String(url), init: init || {} });
      return { ok: true, json: async () => ({ data: [] }) };
    });
    mockFetch.mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
      capturedRequests.push({ url: String(url), init: init || {} });
      return { ok: false, status: 500, json: async () => ({ error: 'test' }) };
    });

    const gen = downloadLmStudioModel('test-model');
    // Consume until we get a result with an error or it finishes
    let result = await gen.next();
    while (!result.done && !result.value?.error) {
      result = await gen.next();
    }

    const downloadReq = capturedRequests.find(r => r.url.includes('/download') && !r.url.includes('/status'));
    expect(downloadReq).toBeDefined();
    expect((downloadReq!.init.headers as Record<string, string>).Authorization).toBe('Bearer lm-studio');
  });

  test('should_send_model_field_on_download_start_request', async () => {
    mockFetch.mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
      capturedRequests.push({ url: String(url), init: init || {} });
      return { ok: true, json: async () => ({ data: [] }) };
    });
    mockFetch.mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
      capturedRequests.push({ url: String(url), init: init || {} });
      return { ok: false, status: 400, json: async () => ({ error: 'missing model' }) };
    });

    const gen = downloadLmStudioModel('OmniCoder-9B-GGUF');
    let result = await gen.next();
    while (!result.done && !result.value?.error) {
      result = await gen.next();
    }

    const downloadReq = capturedRequests.find(r => r.url.includes('/download') && !r.url.includes('/status'));
    expect(downloadReq).toBeDefined();

    const parsedBody = JSON.parse(String(downloadReq!.init.body || '{}')) as { model?: string; modelKey?: string };
    expect(parsedBody.model).toBe('OmniCoder-9B-GGUF');
    expect(parsedBody.modelKey).toBeUndefined();
  });
});
