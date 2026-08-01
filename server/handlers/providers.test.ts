/**
 * providers.test.ts -- OAuth error surfacing tests
 *
 * IMPORTANT: bun mock.module() pitfall
 * =====================================
 * bun's mock.module() is PROCESS-GLOBAL, not file-scoped. When bun runs
 * multiple test files in a single process (the default for `bun test`),
 * a mock.module('some/path', ...) in THIS file replaces that module for
 * ALL test files in the run. If the mock only re-exports a subset of the
 * real module's exports, every other test that imports a missing export
 * will fail with:
 *
 *   SyntaxError: Export named 'Foo' not found in module 'some/path'
 *
 * There is no jest.requireActual() equivalent in bun, and calling
 * require() inside the mock factory returns the mock itself (circular).
 *
 * Workaround used here:
 *   providers.ts imports getCodexService/getCodexClient from a thin
 *   re-export bridge (server/utils/codexServiceBridge.ts) rather than
 *   directly from src/lib/codex/service.ts. This test mocks the BRIDGE
 *   module, so the real service.ts module is never replaced and other
 *   tests that import CodexService, THREAD_LIST_DEFAULTS, etc. are
 *   unaffected.
 *
 * If you need to mock additional modules here, either:
 *   1. Create a bridge re-export and mock that instead, OR
 *   2. Include ALL runtime exports of the real module in your mock
 *      factory (check with: grep '^export' path/to/module.ts)
 *
 * Symptoms of getting this wrong:
 *   - Tests pass individually (`bun test thisFile.test.ts`) but fail
 *     when run with the full suite (`pnpm run test:unit`)
 *   - Errors like "Cannot access 'X' before initialization" or
 *     "Export named 'X' not found" in UNRELATED test files
 *   - Adding/removing a test file changes which other tests break
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';

let subscribeCallback: (notification: any) => void;

const mockGetCodexClient = mock(() => ({
  subscribe: (cb: (notification: any) => void) => { subscribeCallback = cb; },
  onAuthInvalidated: () => () => {},
}));

const mockGetAccount = mock(async () => ({ account: null, requiresOpenaiAuth: false }));
const mockLoginWithChatGPT = mock(async () => ({ loginId: 'lid_1', authUrl: 'https://example.com' }));
const mockCancelLogin = mock(async () => {});
const mockLogout = mock(async () => {});
const mockListModels = mock(async () => ({ data: [], nextCursor: null }));

const mockGetCodexService = mock(() => ({
  loginWithChatGPT: mockLoginWithChatGPT,
  getAccount: mockGetAccount,
  cancelLogin: mockCancelLogin,
  logout: mockLogout,
  listModels: mockListModels,
}));

mock.module('../utils/codexServiceBridge', () => ({
  getCodexClient: mockGetCodexClient,
  getCodexService: mockGetCodexService,
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

const { getOAuthStatus, initiateOAuth, listOpenAIOAuthModels, lastOAuthErrors } = await import('./providers');

describe('OAuth error surfacing', () => {
  beforeEach(() => {
    lastOAuthErrors.clear();
    mockGetAccount.mockReset();
    mockGetAccount.mockImplementation(async () => ({ account: null, requiresOpenaiAuth: false }));
    mockLoginWithChatGPT.mockReset();
    mockLoginWithChatGPT.mockImplementation(async () => ({ loginId: 'lid_1', authUrl: 'https://example.com' }));
    mockCancelLogin.mockReset();
    mockCancelLogin.mockImplementation(async () => {});
    mockListModels.mockReset();
    mockListModels.mockImplementation(async () => ({ data: [], nextCursor: null }));
  });

  test('should surface error from failed account/login/completed notification', async () => {
    await initiateOAuth('openai');

    subscribeCallback({
      method: 'account/login/completed',
      params: { loginId: 'lid_1', success: false, error: 'unsupported_country_region_territory' },
    });

    const status = await getOAuthStatus('openai');
    expect(status).toEqual({ isConnected: false, error: 'unsupported_country_region_territory' });
  });

  test('should clear error after first read (consume-once)', async () => {
    lastOAuthErrors.set('openai', 'some_error');

    const first = await getOAuthStatus('openai');
    expect(first.error).toBe('some_error');

    const second = await getOAuthStatus('openai');
    expect(second.error).toBeUndefined();
    expect(second.isConnected).toBe(false);
  });

  test('should not store error on successful login notification', async () => {
    await initiateOAuth('openai');

    subscribeCallback({
      method: 'account/login/completed',
      params: { loginId: 'lid_1', success: true, error: null },
    });

    const status = await getOAuthStatus('openai');
    expect(status.error).toBeUndefined();
  });

  test('should ignore stale login errors after a new OAuth attempt starts', async () => {
    mockLoginWithChatGPT
      .mockImplementationOnce(async () => ({ loginId: 'lid_1', authUrl: 'https://example.com/1' }))
      .mockImplementationOnce(async () => ({ loginId: 'lid_2', authUrl: 'https://example.com/2' }));

    await initiateOAuth('openai');
    await initiateOAuth('openai');

    subscribeCallback({
      method: 'account/login/completed',
      params: { loginId: 'lid_1', success: false, error: 'Login server error: Login was not completed' },
    });

    const status = await getOAuthStatus('openai');
    expect(status).toEqual({ isConnected: false });
    expect(mockCancelLogin).toHaveBeenCalledWith('lid_1');
  });

  test('should clear stored error when initiating new OAuth flow', async () => {
    lastOAuthErrors.set('openai', 'old_error');

    await initiateOAuth('openai');

    expect(lastOAuthErrors.has('openai')).toBe(false);
  });

  test('lists visible OpenAI OAuth models from Codex model/list', async () => {
    mockGetAccount.mockImplementation(async () => ({
      account: { type: 'chatgpt', email: 'user@example.com' },
      requiresOpenaiAuth: false,
    }));
    mockListModels
      .mockImplementationOnce(async () => ({
        data: [
          {
            id: 'gpt-5.4',
            displayName: 'GPT 5.4',
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fastest' },
              { reasoningEffort: 'medium', description: 'Balanced' },
              { reasoningEffort: 'high', description: 'Deepest' },
            ],
            defaultReasoningEffort: 'medium',
          },
          {
            id: ' GPT-5.5-Codex ',
            displayName: ' GPT 5.5 Codex ',
            hidden: false,
            availabilityNux: {
              message: 'GPT-5.5 is now available in Codex.',
            },
            upgrade: null,
            upgradeInfo: null,
            isDefault: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fastest' },
              { reasoningEffort: 'medium', description: 'Balanced' },
              { reasoningEffort: 'high', description: 'Deepest' },
              { reasoningEffort: 'xhigh', description: 'Max effort' },
            ],
            defaultReasoningEffort: 'medium',
          },
          {
            id: 'gpt-5.3-codex',
            displayName: 'GPT 5.3 Codex',
            hidden: false,
            availabilityNux: null,
            upgrade: 'gpt-5.5-codex',
            upgradeInfo: {
              model: 'gpt-5.5-codex',
              upgradeCopy: 'Upgrade to GPT 5.5 Codex',
              modelLink: null,
              migrationMarkdown: 'Introducing GPT-5.5.',
            },
            isDefault: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fastest' },
              { reasoningEffort: 'medium', description: 'Balanced' },
              { reasoningEffort: 'high', description: 'Deepest' },
              { reasoningEffort: 'xhigh', description: 'Max effort' },
            ],
            defaultReasoningEffort: 'medium',
          },
        ],
        nextCursor: '2',
      }))
      .mockImplementationOnce(async () => ({
        data: [
          {
            id: 'gpt-5.4',
            displayName: 'GPT 5.4',
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
          },
          {
            id: 'gpt-5.2',
            displayName: 'GPT 5.2',
            hidden: false,
            isDefault: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fastest' },
              { reasoningEffort: 'medium', description: 'Balanced' },
              { reasoningEffort: 'high', description: 'Deepest' },
              { reasoningEffort: 'xhigh', description: 'Max effort' },
            ],
            defaultReasoningEffort: 'medium',
          },
          {
            id: 'hidden-model',
            displayName: 'Hidden Model',
            hidden: true,
            availabilityNux: {
              message: 'Hidden model announcement',
            },
            upgrade: 'gpt-5.5-codex',
            upgradeInfo: {
              model: 'gpt-5.5-codex',
              upgradeCopy: 'Upgrade to GPT 5.5 Codex',
              modelLink: null,
              migrationMarkdown: null,
            },
            isDefault: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
          },
          {
            id: 'gpt-5.5-codex',
            displayName: 'Duplicate GPT 5.5 Codex',
            hidden: false,
            availabilityNux: null,
            upgrade: null,
            upgradeInfo: null,
            isDefault: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
          },
          {
            id: '  ',
            displayName: 'Blank Model',
            hidden: false,
            availabilityNux: null,
            upgrade: null,
            upgradeInfo: null,
            isDefault: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
          },
          {
            id: 'gpt-5.1-codex-max',
            displayName: 'GPT 5.1 Codex Max',
            hidden: false,
            availabilityNux: null,
            upgrade: 'pro',
            upgradeInfo: {
              model: 'gpt-5.1-codex-max',
              upgradeCopy: 'Upgrade to use this model',
              modelLink: null,
              migrationMarkdown: null,
            },
            isDefault: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
          },
          {
            id: 'upgrade-only-model',
            displayName: 'Upgrade Only Model',
            hidden: false,
            availabilityNux: null,
            upgrade: 'pro',
            upgradeInfo: null,
            isDefault: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
          },
          {
            id: 'upgrade-info-only-model',
            displayName: 'Upgrade Info Only Model',
            hidden: false,
            availabilityNux: null,
            upgrade: null,
            upgradeInfo: {
              model: 'upgrade-info-only-model',
              upgradeCopy: 'Upgrade to use this model',
              modelLink: null,
              migrationMarkdown: null,
            },
            isDefault: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
          },
          {
            id: 'fallback-name-model',
            displayName: '   ',
            hidden: false,
            availabilityNux: null,
            upgrade: null,
            upgradeInfo: null,
            isDefault: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
          },
        ],
        nextCursor: null,
      }));

    const result = await listOpenAIOAuthModels();

    expect(result.models).toEqual([
      {
        id: 'gpt-5.4',
        name: 'GPT 5.4',
        isDefault: true,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.5-codex',
        name: 'GPT 5.5 Codex',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.3-codex',
        name: 'GPT 5.3 Codex',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.2',
        name: 'GPT 5.2',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.1-codex-max',
        name: 'GPT 5.1 Codex Max',
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'upgrade-only-model',
        name: 'Upgrade Only Model',
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'upgrade-info-only-model',
        name: 'Upgrade Info Only Model',
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'fallback-name-model',
        name: 'fallback-name-model',
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: 'medium',
      },
    ]);
    expect(mockListModels).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(mockListModels).toHaveBeenNthCalledWith(2, { limit: 100, cursor: '2' });
  });
});
