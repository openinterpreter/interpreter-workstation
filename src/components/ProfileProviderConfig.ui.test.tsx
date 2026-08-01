import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import {
  API_BASE_URL_PICKER_EDIT_INPUT_ID,
  API_BASE_URL_PICKER_TRIGGER_ID,
  HOSTED_MODEL_PICKER_POPOVER_ID,
  PROFILE_CUSTOM_MODEL_INPUT_ID,
  PROFILE_MODEL_SELECT_ID,
} from '../../shared/element-ids';
import type { Profile } from '../../shared/types/profile';
import { ProfileProviderConfig } from './ProfileProviderConfig';

const providersMocks = vi.hoisted(() => ({
  listOpenAIOAuthModels: vi.fn(async () => ({ models: [] })),
  listOpenRouterModels: vi.fn(async () => ({ models: [], fetchedAt: Date.now(), stale: false })),
  listInterpreterModels: vi.fn(async (providerId?: string) => {
    // The app-server serves the bundled deepseek catalog without a key.
    if (providerId === 'deepseek') {
      return {
        models: [
          { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', isDefault: true },
        ] as Array<{ id: string; name: string; isDefault: boolean }>,
      };
    }
    return { models: [] as Array<{ id: string; name: string; isDefault: boolean }> };
  }),
  listDeepSeekModels: vi.fn(async () => ({ models: [] as Array<{ id: string; name: string }> })),
  getOllamaStatus: vi.fn(async () => ({
    running: true,
    models: ['qwen3.5:4b'],
    ollamaModels: [{
      id: 'qwen3.5:4b',
      displayName: 'Qwen3.5 4B',
      toolUseSupport: 'supported',
    }],
    totalChatModels: 1,
  })),
  getLmStudioStatus: vi.fn(async () => ({
    running: true,
    models: ['qwen/qwen3.5-4b'],
    lmStudioModels: [{
      id: 'qwen/qwen3.5-4b',
      displayName: 'Qwen3.5 4B',
      toolUseSupport: 'supported',
    }],
    totalChatModels: 1,
  })),
  getClaudeCodeStatus: vi.fn(async () => ({ installed: true, loggedIn: true })),
  getCodexStatus: vi.fn(async () => ({ installed: true, loggedIn: true })),
  getOAuthStatus: vi.fn(async () => ({ isConnected: false })),
  initiateOAuth: vi.fn(async () => ({ authUrl: 'https://example.com', flowId: 'flow-1' })),
  disconnectOAuth: vi.fn(async () => undefined),
  runClaudeLogin: vi.fn(async () => undefined),
}));

vi.mock('@/ipc', () => ({
  openExternal: vi.fn(),
  providers: providersMocks,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('./settings/PlanSection', () => ({
  PlanSectionContent: () => <div>Plan section</div>,
}));

vi.mock('../api', () => ({
  downloadLmStudioModel: vi.fn(async () => ({ success: true })),
  pullOllamaModel: vi.fn(async () => ({ success: true })),
}));

function Harness({ profile, onChangeSpy }: { profile: Profile; onChangeSpy: (updates: Partial<Profile>) => void }) {
  const [currentProfile, setCurrentProfile] = useState(profile);

  return (
    <ProfileProviderConfig
      profile={currentProfile}
      onChange={(updates) => {
        onChangeSpy(updates);
        setCurrentProfile((previous) => ({ ...previous, ...updates }));
      }}
    />
  );
}

describe('ProfileProviderConfig', () => {
  test('allows a local profile to switch to a custom model id', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();

    render(
      <Harness
        profile={{
          id: 'local-profile',
          name: 'Local Profile',
          modelId: 'qwen3.5:4b',
          isBuiltin: false,
          provider: 'local',
          providerId: 'builtin:local',
          baseURL: 'http://localhost:11434/v1',
        }}
        onChangeSpy={onChangeSpy}
      />,
    );

    const select = await screen.findByTestId(PROFILE_MODEL_SELECT_ID);
    await user.selectOptions(select, '__custom_model__');

    const customInput = await screen.findByTestId(PROFILE_CUSTOM_MODEL_INPUT_ID);
    await user.type(customInput, 'qwen3.5:14b-custom');

    await waitFor(() => {
      expect(screen.getByTestId(PROFILE_CUSTOM_MODEL_INPUT_ID)).toHaveValue('qwen3.5:14b-custom');
    });

    const updates = onChangeSpy.mock.calls.map(([update]) => update);

    expect(updates).toContainEqual({ modelId: '', name: '' });
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      modelId: 'qwen3.5:14b-custom',
      name: 'Qwen3.5:14b Custom',
    });
  });

  test('maps known LM Studio model ids when switching a local profile to Ollama', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();

    render(
      <Harness
        profile={{
          id: 'local-profile',
          name: 'Local Profile',
          modelId: 'qwen3.5-0.8b',
          isBuiltin: false,
          provider: 'local',
          providerId: 'builtin:local',
          codexProfileId: 'lmstudio',
          baseURL: 'http://localhost:1234/v1',
        }}
        onChangeSpy={onChangeSpy}
      />,
    );

    const runtimeSelect = await screen.findByDisplayValue('LM Studio');
    await user.selectOptions(runtimeSelect, 'ollama');

    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenCalledWith({
        baseURL: 'http://localhost:11434/v1',
        codexProfileId: 'ollama',
        wireApi: 'chat',
        useResponsesApi: false,
        modelId: 'qwen3.5:0.8b',
      });
    });
  });

  test('defaults the local wire API toggle to the Ollama preset (Chat Completions) and lets it switch to Responses', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();

    render(
      <Harness
        profile={{
          id: 'local-profile',
          name: 'Local Profile',
          modelId: 'qwen3.5:4b',
          isBuiltin: false,
          provider: 'local',
          providerId: 'builtin:local',
          codexProfileId: 'ollama',
          baseURL: 'http://localhost:11434/v1',
        }}
        onChangeSpy={onChangeSpy}
      />,
    );

    const toggle = await screen.findByRole('switch', { name: 'Use Chat Completions' });
    expect(toggle).toBeChecked();

    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenCalledWith(expect.objectContaining({ wireApi: 'chat', useResponsesApi: false }));
    });

    await user.click(toggle);

    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ wireApi: 'responses', useResponsesApi: true }));
    });
  });

  test('defaults the local wire API toggle to the LM Studio preset (Chat Completions) and lets it switch to Responses', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();

    render(
      <Harness
        profile={{
          id: 'local-profile',
          name: 'Local Profile',
          modelId: 'qwen/qwen3.5-4b',
          isBuiltin: false,
          provider: 'local',
          providerId: 'builtin:local',
          codexProfileId: 'lmstudio',
          baseURL: 'http://localhost:1234/v1',
        }}
        onChangeSpy={onChangeSpy}
      />,
    );

    const toggle = await screen.findByRole('switch', { name: 'Use Chat Completions' });
    expect(toggle).toBeChecked();

    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenCalledWith(expect.objectContaining({ wireApi: 'chat', useResponsesApi: false }));
    });

    await user.click(toggle);

    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ wireApi: 'responses', useResponsesApi: true }));
    });
  });

  test('keeps custom API base url edits in the controlled profile state', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();

    render(
      <Harness
        profile={{
          id: 'api-profile',
          name: 'API Profile',
          modelId: 'openai/gpt-5.4-mini',
          isBuiltin: false,
          provider: 'api',
          baseURL: 'https://api.openai.com/v1',
          apiFormat: 'openai',
        }}
        onChangeSpy={onChangeSpy}
      />,
    );

    const input = await screen.findByTestId(API_BASE_URL_PICKER_EDIT_INPUT_ID);
    await user.clear(input);
    await user.type(input, 'https://llm.example.internal/v1');

    await waitFor(() => {
      expect(screen.getByTestId(API_BASE_URL_PICKER_EDIT_INPUT_ID)).toHaveValue('https://llm.example.internal/v1');
    });

    const updates = onChangeSpy.mock.calls.map(([update]) => update);

    expect(updates).toContainEqual({
      apiFormat: 'openai',
      apiKey: '',
      baseURL: 'https://api.openai.com/v1',
      codexProfileId: 'openai-api',
      wireApi: 'responses',
      useResponsesApi: true,
    });
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      apiFormat: 'openai',
      apiKey: '',
      baseURL: 'https://llm.example.internal/v1',
      codexProfileId: 'custom',
      wireApi: 'responses',
      useResponsesApi: true,
    });
  });

  test('only enables Chat Completions for API profiles after the explicit toggle is checked', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();

    render(
      <Harness
        profile={{
          id: 'api-profile',
          name: 'API Profile',
          modelId: 'openai/gpt-5.4-mini',
          isBuiltin: false,
          provider: 'api',
          baseURL: 'https://llm.example.internal/v1',
          apiFormat: 'openai',
        }}
        onChangeSpy={onChangeSpy}
      />,
    );

    const toggle = await screen.findByRole('switch', { name: 'Use Chat Completions' });
    expect(toggle).not.toBeChecked();

    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenCalledWith(expect.objectContaining({ wireApi: 'responses' }));
    });

    await user.click(toggle);

    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ wireApi: 'chat' }));
    });
  });

  test('hides Chat Completions for known API base URL presets', async () => {
    const onChangeSpy = vi.fn();

    render(
      <Harness
        profile={{
          id: 'api-profile',
          name: 'API Profile',
          modelId: 'openai/gpt-5.4-mini',
          isBuiltin: false,
          provider: 'api',
          baseURL: 'https://api.openai.com/v1',
          apiFormat: 'openai',
          wireApi: 'chat',
        }}
        onChangeSpy={onChangeSpy}
      />,
    );

    expect(await screen.findByTestId(API_BASE_URL_PICKER_TRIGGER_ID)).toHaveTextContent('OpenAI');
    expect(screen.queryByRole('switch', { name: 'Use Chat Completions' })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenCalledWith(expect.objectContaining({ wireApi: 'responses' }));
    });
  });

  test('uses Chat Completions for DeepSeek API endpoints', async () => {
    const onChangeSpy = vi.fn();

    render(
      <Harness
        profile={{
          id: 'api-profile',
          name: 'DeepSeek V4 Flash',
          modelId: '',
          isBuiltin: false,
          provider: 'api',
          baseURL: 'https://api.deepseek.com',
          codexProfileId: 'deepseek',
          apiFormat: 'openai',
          wireApi: 'chat',
        }}
        onChangeSpy={onChangeSpy}
      />,
    );

    expect(await screen.findByTestId(API_BASE_URL_PICKER_TRIGGER_ID)).toHaveTextContent('Custom endpoint');
    expect(screen.getByRole('switch', { name: 'Use Chat Completions' })).toBeChecked();

    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenCalledWith(expect.objectContaining({
        codexProfileId: 'deepseek',
        wireApi: 'chat',
        useResponsesApi: false,
      }));
      expect(onChangeSpy).toHaveBeenCalledWith(expect.objectContaining({
        modelId: 'deepseek-v4-flash',
      }));
    });
  });

  test('replaces the DeepSeek model dropdown with the live /models result once a key is present', async () => {
    providersMocks.listDeepSeekModels.mockResolvedValueOnce({
      models: [
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-turbo', name: 'deepseek-v4-turbo' },
      ],
    });

    render(
      <Harness
        profile={{
          id: 'api-profile',
          name: 'DeepSeek V4 Flash',
          modelId: 'deepseek-v4-flash',
          isBuiltin: false,
          provider: 'api',
          baseURL: 'https://api.deepseek.com',
          codexProfileId: 'deepseek',
          apiFormat: 'openai',
          wireApi: 'chat',
          apiKey: 'sk-deepseek-test',
        }}
        onChangeSpy={vi.fn()}
      />,
    );

    const select = await screen.findByTestId(PROFILE_MODEL_SELECT_ID);

    // The key-authenticated /models result fully replaces the dropdown.
    await waitFor(() => {
      expect(within(select).getByRole('option', { name: 'deepseek-v4-turbo' })).toBeInTheDocument();
    });
    expect(within(select).getByRole('option', { name: 'deepseek-v4-flash' })).toBeInTheDocument();
    expect(providersMocks.listDeepSeekModels).toHaveBeenCalledWith('sk-deepseek-test');
  });

  test('shows an error with retry (no shipped fallback) when the live DeepSeek /models fetch fails', async () => {
    providersMocks.listDeepSeekModels.mockRejectedValueOnce(new Error('HTTP 401'));

    render(
      <Harness
        profile={{
          id: 'api-profile',
          name: 'DeepSeek V4 Flash',
          modelId: 'deepseek-v4-flash',
          isBuiltin: false,
          provider: 'api',
          baseURL: 'https://api.deepseek.com',
          codexProfileId: 'deepseek',
          apiFormat: 'openai',
          wireApi: 'chat',
          apiKey: 'sk-bad-key',
        }}
        onChangeSpy={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(providersMocks.listDeepSeekModels).toHaveBeenCalledWith('sk-bad-key');
    });
    // No silent fallback: the error surfaces and a retry control is offered.
    expect(await screen.findByText(/HTTP 401/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'deepseek-v4-pro' })).not.toBeInTheDocument();
  });

  test('keeps OpenAI base URL in custom endpoint mode when codex profile is custom', async () => {
    const onChangeSpy = vi.fn();

    render(
      <Harness
        profile={{
          id: 'api-profile',
          name: 'GPT-5.4 nano',
          modelId: 'gpt-5.4-nano',
          isBuiltin: false,
          provider: 'api',
          baseURL: 'https://api.openai.com/v1',
          codexProfileId: 'custom',
          apiFormat: 'openai',
        }}
        onChangeSpy={onChangeSpy}
      />,
    );

    expect(await screen.findByTestId(API_BASE_URL_PICKER_TRIGGER_ID)).toHaveTextContent('Custom endpoint');
    expect(screen.getByTestId(API_BASE_URL_PICKER_EDIT_INPUT_ID)).toHaveValue('https://api.openai.com/v1');
    expect(screen.getByPlaceholderText('model-id')).toHaveValue('gpt-5.4-nano');
    expect(screen.getByRole('switch', { name: 'Use Chat Completions' })).toBeVisible();

    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenCalledWith(expect.objectContaining({
        codexProfileId: 'custom',
        wireApi: 'responses',
      }));
    });
  });

  test('describes API endpoints as supporting Chat Completions or Responses', async () => {
    render(
      <Harness
        profile={{
          id: 'api-profile',
          name: 'API Profile',
          modelId: 'openai/gpt-5.4-mini',
          isBuiltin: false,
          provider: 'api',
          baseURL: 'https://llm.example.internal/v1',
          apiFormat: 'openai',
        }}
        onChangeSpy={vi.fn()}
      />,
    );

    expect(await screen.findByText('Use a supported Chat Completions or Responses API endpoint. Your API key is stored locally.')).toBeVisible();
    expect(screen.getByText('Turn this on for Chat Completions endpoints. Leave it off for Responses API endpoints.')).toBeVisible();
  });

  test('fetches the runtime OpenRouter catalog for hosted model browsing', async () => {
    const user = userEvent.setup();
    providersMocks.listInterpreterModels.mockResolvedValue({
      models: [{ id: 'anthropic/claude-3.5-haiku', name: 'Claude Haiku 3.5', isDefault: false }],
    });

    render(
      <Harness
        profile={{
          id: 'hosted-profile',
          name: 'Hosted Profile',
          modelId: 'interpreter-smart',
          isBuiltin: false,
          provider: 'hosted',
          providerId: 'builtin:hosted',
        }}
        onChangeSpy={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /more models/i }));
    await screen.findByTestId(HOSTED_MODEL_PICKER_POPOVER_ID);

    expect(providersMocks.listInterpreterModels).toHaveBeenCalledWith('openrouter');
    expect(await screen.findByText('Claude Haiku 3.5')).toBeVisible();
  });

  test('fetches the runtime OpenRouter catalog for openrouter api model browsing', async () => {
    providersMocks.listInterpreterModels.mockResolvedValue({
      models: [{ id: 'anthropic/claude-3.5-haiku', name: 'Claude Haiku 3.5', isDefault: false }],
    });

    render(
      <Harness
        profile={{
          id: 'openrouter-api-profile',
          name: 'OpenRouter API',
          modelId: 'openai/gpt-5.4',
          isBuiltin: false,
          provider: 'api',
          baseURL: 'https://openrouter.ai/api/v1',
          apiFormat: 'openai',
        }}
        onChangeSpy={vi.fn()}
      />,
    );

    await screen.findByTestId(HOSTED_MODEL_PICKER_POPOVER_ID);
    expect(await screen.findByText('Claude Haiku 3.5')).toBeVisible();
  });

  test('requests OpenAI API-key models from OIX unified openai provider', async () => {
    providersMocks.listInterpreterModels.mockResolvedValue({
      models: [{ id: 'gpt-5.4', name: 'GPT-5.4', isDefault: true }],
    });

    render(
      <Harness
        profile={{
          id: 'openai-api-profile',
          name: 'OpenAI API',
          modelId: 'gpt-5.4',
          isBuiltin: false,
          provider: 'api',
          baseURL: 'https://api.openai.com/v1',
          apiFormat: 'openai',
        }}
        onChangeSpy={vi.fn()}
      />,
    );

    // OIX 0.0.34 exposes one OpenAI provider for both auth experiences.
    await waitFor(() => {
      const requestedProviderIds = providersMocks.listInterpreterModels.mock.calls.map(
        ([providerId]) => providerId,
      );
      expect(requestedProviderIds).toContain('openai');
    });
    const requestedProviderIds = providersMocks.listInterpreterModels.mock.calls.map(
      ([providerId]) => providerId,
    );
    expect(requestedProviderIds).not.toContain('openai_api_key');
  });
});
