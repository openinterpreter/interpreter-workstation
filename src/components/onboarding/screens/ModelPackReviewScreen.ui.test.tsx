import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { OpenRouterModelCatalogResult } from '../../../../shared/types/provider';
import { ModelPackReviewScreen } from './ModelPackReviewScreen';
import type { ModelPackReviewState } from './ModelSetupScreen';

const hostedCatalog: OpenRouterModelCatalogResult = {
  fetchedAt: Date.now(),
  stale: false,
  models: [
    {
      id: 'cohere/command-a',
      name: 'Command A',
      provider: 'cohere',
      description: 'Cohere hosted model',
      contextLength: 256_000,
    },
  ],
};

const providersMocks = vi.hoisted(() => ({
  listOpenRouterModels: vi.fn(async () => hostedCatalog),
  getOllamaStatus: vi.fn(async () => ({ running: false })),
  getLmStudioStatus: vi.fn(async () => ({ running: false })),
}));

const apiMocks = vi.hoisted(() => ({
  createProfile: vi.fn(async () => undefined),
  downloadLmStudioModel: vi.fn(async () => ({ success: true })),
  getProfiles: vi.fn(async (): Promise<{ profiles: unknown[] }> => ({ profiles: [] })),
  pullOllamaModel: vi.fn(async () => ({ success: true })),
  setDefaultProfile: vi.fn(async () => undefined),
  setFastProfile: vi.fn(async () => undefined),
  updateProfile: vi.fn(async () => undefined),
}));

const onboardingMocks = vi.hoisted(() => ({
  setFooterConfig: vi.fn(),
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      variants: _variants,
      ...props
    }: HTMLAttributes<HTMLDivElement> & {
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      variants?: unknown;
    }) => <div {...props}>{children}</div>,
  },
}));

vi.mock('../../../ipc', () => ({
  providers: providersMocks,
}));

vi.mock('../../../api', () => ({
  createProfile: apiMocks.createProfile,
  downloadLmStudioModel: apiMocks.downloadLmStudioModel,
  getProfiles: apiMocks.getProfiles,
  pullOllamaModel: apiMocks.pullOllamaModel,
  setDefaultProfile: apiMocks.setDefaultProfile,
  setFastProfile: apiMocks.setFastProfile,
  updateProfile: apiMocks.updateProfile,
}));

vi.mock('../../../utils/telemetry', () => ({
  trackModelsConfigured: vi.fn(),
  trackOnboardingError: vi.fn(),
}));

vi.mock('../OnboardingContext', () => ({
  useOnboarding: () => ({
    currentStep: 0,
    setFooterConfig: onboardingMocks.setFooterConfig,
  }),
}));

const hostedReviewState: ModelPackReviewState = {
  packId: 'hosted',
  title: 'Interpreter Managed',
  subtitle: 'Choose which models to add from this provider.',
  defaultProfileId: 'onboarding:interpreter-smart',
  fastProfileId: 'onboarding:interpreter-fast',
  errorMessage: 'Unable to add Interpreter Managed models.',
  profiles: [
    {
      id: 'onboarding:interpreter-smart',
      name: 'Smart',
      provider: 'hosted',
      providerId: 'builtin:hosted',
      modelId: 'interpreter-smart',
      isBuiltin: false,
    },
    {
      id: 'onboarding:interpreter-fast',
      name: 'Fast',
      provider: 'hosted',
      providerId: 'builtin:hosted',
      modelId: 'interpreter-fast',
      isBuiltin: false,
    },
  ],
};

describe('ModelPackReviewScreen hosted model search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('focuses the search input when opening the hosted model search modal', async () => {
    const user = userEvent.setup();

    render(
      <ModelPackReviewScreen
        reviewState={hostedReviewState}
        onReviewComplete={() => {}}
      />,
    );

    await user.click(await screen.findByRole('button', { name: /search\s+browse all models\./i }));

    const searchInput = screen.getByPlaceholderText('Search models');
    await waitFor(() => {
      expect(searchInput).toHaveFocus();
    });
  });

  test('preserves DeepSeek Chat Completions settings when updating an existing profile', async () => {
    const reviewState: ModelPackReviewState = {
      packId: 'api:deepseek',
      title: 'DeepSeek API',
      subtitle: 'Choose which models to add from this provider.',
      requiredApiKeyProvider: 'deepseek',
      defaultProfileId: 'onboarding:deepseek-v4-flash',
      errorMessage: 'Unable to add DeepSeek models.',
      profiles: [
        {
          id: 'onboarding:deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          provider: 'api',
          modelId: 'deepseek-v4-flash',
          apiKey: 'sk-deepseek',
          apiFormat: 'openai',
          baseURL: 'https://api.deepseek.com',
          codexProfileId: 'deepseek',
          wireApi: 'chat',
          useResponsesApi: false,
          isBuiltin: false,
        },
      ],
    };
    apiMocks.getProfiles.mockResolvedValueOnce({
      profiles: [{ ...reviewState.profiles[0], wireApi: 'responses', useResponsesApi: true }],
    });

    render(
      <ModelPackReviewScreen
        reviewState={reviewState}
        onReviewComplete={() => {}}
      />,
    );

    const footerConfig = await waitFor(() => {
      const lastCall = onboardingMocks.setFooterConfig.mock.calls[onboardingMocks.setFooterConfig.mock.calls.length - 1];
      const config = lastCall?.[0];
      expect(config?.continueDisabled).toBe(false);
      return config;
    });

    await act(async () => {
      footerConfig.continueAction();
    });

    await waitFor(() => {
      expect(apiMocks.updateProfile).toHaveBeenCalledWith('onboarding:deepseek-v4-flash', expect.objectContaining({
        baseURL: 'https://api.deepseek.com',
        codexProfileId: 'deepseek',
        wireApi: 'chat',
        useResponsesApi: false,
      }));
    });
    expect(apiMocks.createProfile).not.toHaveBeenCalled();
  });

  test('persists an environment-key reference without copying the secret into the profile', async () => {
    const reviewState: ModelPackReviewState = {
      packId: 'api:openai',
      title: 'OpenAI API',
      subtitle: 'Choose which models to add from this provider.',
      defaultProfileId: 'onboarding:openai-gpt-5-6-sol',
      errorMessage: 'Unable to add OpenAI models.',
      profiles: [
        {
          id: 'onboarding:openai-gpt-5-6-sol',
          name: 'GPT-5.6-Sol',
          provider: 'api',
          modelId: 'gpt-5.6-sol',
          environmentKey: 'OPENAI_API_KEY',
          apiFormat: 'openai',
          baseURL: 'https://api.openai.com/v1',
          codexProfileId: 'openai',
          wireApi: 'responses',
          useResponsesApi: true,
          isBuiltin: false,
        },
      ],
    };

    render(
      <ModelPackReviewScreen
        reviewState={reviewState}
        onReviewComplete={() => {}}
      />,
    );

    const footerConfig = await waitFor(() => {
      const lastCall = onboardingMocks.setFooterConfig.mock.calls[onboardingMocks.setFooterConfig.mock.calls.length - 1];
      const config = lastCall?.[0];
      expect(config?.continueDisabled).toBe(false);
      return config;
    });

    await act(async () => {
      footerConfig.continueAction();
    });

    await waitFor(() => {
      expect(apiMocks.createProfile).toHaveBeenCalledWith(expect.objectContaining({
        modelId: 'gpt-5.6-sol',
        environmentKey: 'OPENAI_API_KEY',
      }));
    });
    const createProfileCall = apiMocks.createProfile.mock.calls[0] as unknown[] | undefined;
    expect(createProfileCall?.[0]).not.toHaveProperty('apiKey');
  });
});
