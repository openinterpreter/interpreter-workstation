import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi, beforeEach } from 'vitest';

import { ProfileManager } from './ProfileManager';
import type { EnvApiKeysResult } from '../../shared/types/provider';
import type { v2 } from '../../server/handlers/codex-generated-types/index';
import en from '../../shared/locales/en.json';

// Interpreter app-server provider list driving the settings preset picker. These
// are real oix provider ids; buildVisibleProfilePresets maps them to app presets.
function makeProvider(overrides: Partial<v2.InterpreterProvider> & { id: string }): v2.InterpreterProvider {
  return {
    name: overrides.id,
    description: '',
    isCurrent: false,
    configured: false,
    isDefault: false,
    ...overrides,
  };
}

const DEFAULT_RUNTIME_PROVIDERS: v2.InterpreterProvider[] = [
  makeProvider({ id: 'openai', name: 'OpenAI', configured: true }),
  makeProvider({ id: 'openrouter', name: 'OpenRouter' }),
  makeProvider({ id: 'groq', name: 'Groq' }),
  makeProvider({ id: 'deepseek', name: 'DeepSeek' }),
  makeProvider({
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models',
    baseUrl: 'https://api.anthropic.com/v1',
    wireApi: 'messages',
    envKey: 'ANTHROPIC_API_KEY',
  }),
  makeProvider({ id: 'ollama', name: 'Ollama' }),
  makeProvider({ id: 'lmstudio', name: 'LM Studio' }),
  makeProvider({ id: 'openinterpreter_add_compatible_provider', name: 'Custom endpoint' }),
];
import {
  API_BASE_URL_PICKER_EDIT_INPUT_ID,
  API_BASE_URL_PICKER_TRIGGER_ID,
} from '../../shared/element-ids';

const apiMocks = vi.hoisted(() => ({
  getProfiles: vi.fn(async () => ({ profiles: [], fastProfileId: null })),
  createProfile: vi.fn(async (profile: unknown) => ({ profile })),
  updateProfile: vi.fn(async (_id: unknown, profile: unknown) => ({ profile })),
  deleteProfile: vi.fn(async () => undefined),
  setFastProfile: vi.fn(async (fastProfileId: unknown) => ({ fastProfileId })),
  resetProfile: vi.fn(async () => undefined),
}));

const providersMocks = vi.hoisted(() => ({
  getEnvApiKeys: vi.fn(async (): Promise<EnvApiKeysResult> => ({
    openai: { found: false },
    anthropic: { found: false },
    openrouter: { found: false },
    groq: { found: false },
    deepseek: { found: false },
  })),
  getEnvApiKey: vi.fn(async (): Promise<{ key: string | null }> => ({ key: null })),
  listInterpreterProviders: vi.fn(async () => ({ providers: [] as v2.InterpreterProvider[] })),
  listInterpreterModels: vi.fn(async (providerId?: string) => {
    // OIX exposes one OpenAI provider for both ChatGPT login and API-key auth.
    if (providerId === 'openai') {
      return { models: [{ id: 'gpt-5.4', name: 'GPT-5.4', isDefault: true }] };
    }
    if (providerId === 'groq') {
      return { models: [{ id: 'llama-3.3-70b', name: 'Llama 3.3 70B', isDefault: true }] };
    }
    return { models: [] };
  }),
  listInterpreterHarnesses: vi.fn(async () => ({
    harnesses: [{
      label: 'Native Codex',
      description: 'Use the native Codex harness.',
      isRecommended: true,
    }] as v2.InterpreterHarness[],
  })),
  listOpenAIOAuthModels: vi.fn(async () => ({ models: [] })),
  listOpenRouterModels: vi.fn(async () => ({ models: [], fetchedAt: Date.now(), stale: false })),
  getOllamaStatus: vi.fn(async () => ({ running: false, models: [] })),
  getLmStudioStatus: vi.fn(async () => ({ running: false, models: [] })),
  getOAuthStatus: vi.fn(async () => ({ isConnected: false })),
  probeResponsesApiSupport: vi.fn(async () => ({ reachable: true, supported: true })),
  initiateOAuth: vi.fn(async () => ({ authUrl: 'https://example.com', flowId: 'flow-1' })),
  disconnectOAuth: vi.fn(async () => undefined),
  runClaudeLogin: vi.fn(async () => undefined),
  getClaudeCodeStatus: vi.fn(async () => ({ installed: true, loggedIn: true })),
  getCodexStatus: vi.fn(async () => ({ installed: true, loggedIn: true })),
}));

vi.mock('../api', () => apiMocks);

vi.mock('../hooks/useProfileStatuses', () => ({
  useProfileStatuses: () => ({ statuses: {}, loading: false }),
}));

vi.mock('@/ipc', () => ({
  providers: providersMocks,
  openExternal: vi.fn(),
}));

describe('ProfileManager', () => {
  const noEnvKeys: EnvApiKeysResult = {
    openai: { found: false },
    anthropic: { found: false },
    openrouter: { found: false },
    groq: { found: false },
    deepseek: { found: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    providersMocks.getEnvApiKeys.mockResolvedValue(noEnvKeys);
    providersMocks.getEnvApiKey.mockResolvedValue({ key: null as string | null });
    providersMocks.listInterpreterProviders.mockResolvedValue({ providers: DEFAULT_RUNTIME_PROVIDERS });
    providersMocks.probeResponsesApiSupport.mockResolvedValue({ reachable: true, supported: true });
  });

  test('disables Create Model for API presets without a usable key until one is entered', async () => {
    const user = userEvent.setup();

    render(<ProfileManager startInNewProfile />);

    await user.click((await screen.findByText('OpenAI API')).closest('button') as HTMLButtonElement);

    const createButton = await screen.findByRole('button', { name: en['settings.profiles.detail.createModel'] });
    await waitFor(() => {
      expect(createButton).toBeDisabled();
    });

    await user.type(screen.getByPlaceholderText(en['settings.profiles.provider.api.apiKeyPlaceholder']), 'sk-entered');

    await waitFor(() => {
      expect(createButton).toBeEnabled();
    });
  });

  test('enables Create Model for API presets when a matching env key is available', async () => {
    const user = userEvent.setup();

    providersMocks.getEnvApiKeys.mockResolvedValue({
      openai: { found: true, masked: 'sk-e...env' },
      anthropic: { found: false },
      openrouter: { found: false },
      groq: { found: false },
      deepseek: { found: false },
    } as EnvApiKeysResult);
    providersMocks.getEnvApiKey.mockResolvedValue({ key: 'sk-env-openai' as string | null });

    render(<ProfileManager startInNewProfile />);

    await user.click((await screen.findByText('OpenAI API')).closest('button') as HTMLButtonElement);

    const createButton = await screen.findByRole('button', { name: en['settings.profiles.detail.createModel'] });
    await waitFor(() => {
      expect(createButton).toBeEnabled();
    });
  });

  test('skips Responses support probe when API profile explicitly uses Chat Completions', async () => {
    const user = userEvent.setup();
    providersMocks.probeResponsesApiSupport.mockResolvedValue({ reachable: true, supported: false });

    render(<ProfileManager startInNewProfile />);

    await user.click((await screen.findByText('Custom API')).closest('button') as HTMLButtonElement);
    await user.clear(screen.getByTestId(API_BASE_URL_PICKER_EDIT_INPUT_ID));
    await user.type(screen.getByTestId(API_BASE_URL_PICKER_EDIT_INPUT_ID), 'https://llm.example.internal/v1');
    await user.type(await screen.findByPlaceholderText(en['settings.profiles.provider.api.modelIdPlaceholder']), 'gpt-5.4-nano');
    await user.type(screen.getByPlaceholderText(en['settings.profiles.provider.api.apiKeyPlaceholder']), 'sk-entered');
    await user.click(await screen.findByRole('switch', { name: 'Use Chat Completions' }));

    const createButton = await screen.findByRole('button', { name: en['settings.profiles.detail.createModel'] });
    await waitFor(() => {
      expect(createButton).toBeEnabled();
    });
    await user.click(createButton);

    await waitFor(() => {
      expect(apiMocks.createProfile).toHaveBeenCalledWith(expect.objectContaining({ wireApi: 'chat' }));
    });
    expect(providersMocks.probeResponsesApiSupport).not.toHaveBeenCalled();
  });

  test('creates DeepSeek API profiles with Chat Completions without probing Responses support', async () => {
    const user = userEvent.setup();
    providersMocks.probeResponsesApiSupport.mockResolvedValue({ reachable: true, supported: false });

    render(<ProfileManager startInNewProfile />);

    await user.click((await screen.findByText('DeepSeek')).closest('button') as HTMLButtonElement);
    await user.type(screen.getByPlaceholderText(en['settings.profiles.provider.api.apiKeyPlaceholder']), 'sk-deepseek');

    const createButton = await screen.findByRole('button', { name: en['settings.profiles.detail.createModel'] });
    await waitFor(() => {
      expect(createButton).toBeEnabled();
    });
    await user.click(createButton);

    await waitFor(() => {
      expect(apiMocks.createProfile).toHaveBeenCalledWith(expect.objectContaining({
        baseURL: 'https://api.deepseek.com',
        codexProfileId: 'deepseek',
        modelId: 'deepseek-v4-flash',
        wireApi: 'chat',
        useResponsesApi: false,
      }));
    });
    expect(providersMocks.probeResponsesApiSupport).not.toHaveBeenCalled();
  });

  test('creates Anthropic Messages profiles without probing Responses support', async () => {
    const user = userEvent.setup();
    providersMocks.probeResponsesApiSupport.mockResolvedValue({ reachable: true, supported: false });

    render(<ProfileManager startInNewProfile />);

    await user.click((await screen.findByText('Anthropic')).closest('button') as HTMLButtonElement);
    await user.type(
      await screen.findByPlaceholderText(en['settings.profiles.provider.api.modelIdPlaceholder']),
      'claude-sonnet-4-6',
    );
    await user.type(
      screen.getByPlaceholderText(en['settings.profiles.provider.api.apiKeyPlaceholder']),
      'sk-ant-entered',
    );

    const createButton = await screen.findByRole('button', { name: en['settings.profiles.detail.createModel'] });
    await waitFor(() => {
      expect(createButton).toBeEnabled();
    });
    await user.click(createButton);

    await waitFor(() => {
      expect(apiMocks.createProfile).toHaveBeenCalledWith(expect.objectContaining({
        codexProfileId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        wireApi: 'messages',
      }));
    });
    expect(providersMocks.probeResponsesApiSupport).not.toHaveBeenCalled();
  });

  test('uses OIX-reported environment auth for providers outside the app preset map', async () => {
    const user = userEvent.setup();
    providersMocks.listInterpreterProviders.mockResolvedValue({
      providers: DEFAULT_RUNTIME_PROVIDERS.map((provider) => (
        provider.id === 'anthropic'
          ? { ...provider, configured: true, envKey: 'ANTHROPIC_API_KEY' }
          : provider
      )),
    });

    render(<ProfileManager startInNewProfile />);

    await user.click((await screen.findByText('Anthropic')).closest('button') as HTMLButtonElement);
    await user.type(
      await screen.findByPlaceholderText(en['settings.profiles.provider.api.modelIdPlaceholder']),
      'claude-sonnet-4-6',
    );

    const createButton = await screen.findByRole('button', { name: en['settings.profiles.detail.createModel'] });
    await waitFor(() => {
      expect(createButton).toBeEnabled();
    });
    await user.click(createButton);

    await waitFor(() => {
      expect(apiMocks.createProfile).toHaveBeenCalledWith(expect.objectContaining({
        codexProfileId: 'anthropic',
        environmentKey: 'ANTHROPIC_API_KEY',
        apiKey: undefined,
      }));
    });
  });

  test('describes custom API as supporting Chat Completions or Responses endpoints', async () => {
    render(<ProfileManager startInNewProfile />);

    await screen.findByText('Custom API');

    expect(screen.getByText('Use a supported Chat Completions or Responses API endpoint.')).toBeVisible();
  });

  test('prefills Custom API with OpenAI GPT-5.4 nano defaults', async () => {
    const user = userEvent.setup();

    render(<ProfileManager startInNewProfile />);

    await user.click((await screen.findByText('Custom API')).closest('button') as HTMLButtonElement);

    expect(await screen.findByPlaceholderText(en['settings.profiles.detail.modelNamePlaceholder'])).toHaveValue('GPT-5.4 nano');
    expect(screen.getByTestId(API_BASE_URL_PICKER_TRIGGER_ID)).toHaveTextContent('Custom endpoint');
    expect(screen.getByTestId(API_BASE_URL_PICKER_EDIT_INPUT_ID)).toHaveValue('https://api.openai.com/v1');
    expect(screen.getByPlaceholderText(en['settings.profiles.provider.api.modelIdPlaceholder'])).toHaveValue('gpt-5.4-nano');
    expect(screen.getByRole('switch', { name: 'Use Chat Completions' })).toBeVisible();
  });

  test('requires an explicit API key for Custom API even when an OpenAI env key exists', async () => {
    const user = userEvent.setup();
    providersMocks.getEnvApiKeys.mockResolvedValue({
      openai: { found: true, masked: 'sk-e...env' },
      anthropic: { found: false },
      openrouter: { found: false },
      groq: { found: false },
      deepseek: { found: false },
    } as EnvApiKeysResult);

    render(<ProfileManager startInNewProfile />);

    await user.click((await screen.findByText('Custom API')).closest('button') as HTMLButtonElement);

    const createButton = await screen.findByRole('button', { name: en['settings.profiles.detail.createModel'] });
    await waitFor(() => {
      expect(createButton).toBeDisabled();
    });

    await user.type(screen.getByPlaceholderText(en['settings.profiles.provider.api.apiKeyPlaceholder']), 'sk-entered');

    await waitFor(() => {
      expect(createButton).toBeEnabled();
    });
  });

  test('builds the preset list from the Interpreter app-server provider list', async () => {
    render(<ProfileManager startInNewProfile />);

    // API presets come from the runtime list (openai, groq, deepseek...).
    await screen.findByText('OpenAI API');
    expect(screen.getByText('Groq')).toBeVisible();
    expect(screen.getByText('DeepSeek')).toBeVisible();
    expect(screen.getByText('OpenRouter')).toBeVisible();
    // Providers unknown to Workstation still pass through from OIX.
    expect(screen.getByText('Anthropic')).toBeVisible();
    // Custom endpoint preset (openinterpreter_add_compatible_provider).
    expect(screen.getByText('Custom API')).toBeVisible();

    // Documented gap presets stay present (hosted + terminals via synthetic entries).
    expect(screen.getByText('Interpreter Models')).toBeVisible();
    expect(screen.getByText('Claude Code (Terminal)')).toBeVisible();
    expect(screen.getByText('Codex (Terminal)')).toBeVisible();

    expect(providersMocks.listInterpreterProviders).toHaveBeenCalledWith(true);
  });

  test('hides presets whose runtime provider is absent from the app-server list', async () => {
    providersMocks.listInterpreterProviders.mockResolvedValue({
      providers: [makeProvider({ id: 'groq', name: 'Groq' })],
    });

    render(<ProfileManager startInNewProfile />);

    await screen.findByText('Groq');
    // openai / deepseek / openrouter were not listed, so their cards are gone.
    expect(screen.queryByText('OpenAI API')).not.toBeInTheDocument();
    expect(screen.queryByText('DeepSeek')).not.toBeInTheDocument();
    expect(screen.queryByText('OpenRouter')).not.toBeInTheDocument();
  });

  test('shows an error with retry when the app-server provider list fails', async () => {
    const user = userEvent.setup();
    providersMocks.listInterpreterProviders
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ providers: DEFAULT_RUNTIME_PROVIDERS });

    render(<ProfileManager startInNewProfile />);

    await screen.findByText(en['settings.profiles.presetPicker.failedProviders']);

    await user.click(screen.getByRole('button', { name: en['common.tryAgain'] }));

    await screen.findByText('OpenAI API');
  });
});
