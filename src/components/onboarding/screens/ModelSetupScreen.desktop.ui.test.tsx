import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { createDefaultOnboardingState } from '../../../../shared/types/onboardingState';
import { DESKTOP_HOST_CAPABILITIES } from '../../../../shared/types/hostCapabilities';

const mock = vi.hoisted(() => ({ download: vi.fn(() => undefined),
  oauth: vi.fn(async () => ({ isConnected: false })),
  env: vi.fn(async () => null),
  ollama: vi.fn(async () => ({ running: false })),
  lmStudio: vi.fn(async () => ({ running: false })),
}));
vi.mock('../../../ipc', async original => {
  const ipc = await original<typeof import('../../../ipc')>();
  return { ...ipc,
    getHostCapabilities: () => DESKTOP_HOST_CAPABILITIES,
    getBrowserProjectModelDownload: mock.download,
    onboardingState: { ...ipc.onboardingState,
      get: async () => ({ state: createDefaultOnboardingState() }) },
    providers: { ...ipc.providers,
      listInterpreterProviders: async () => ({ providers: [
        { id: 'ollama', name: 'Ollama', description: '', configured: true,
          isDefault: false, isCurrent: false },
        { id: 'lmstudio', name: 'LM Studio', description: '', configured: true,
          isDefault: false, isCurrent: false },
      ] }),
      getOAuthStatus: mock.oauth, getEnvApiKeys: mock.env,
      getOllamaStatus: mock.ollama, getLmStudioStatus: mock.lmStudio,
    },
  };
});

import { OnboardingProvider } from '../OnboardingContext';
import { ModelSetupScreen } from './ModelSetupScreen';

test('desktop onboarding retains its existing account, local and custom options without browser download', async () => {
  render(<OnboardingProvider><ModelSetupScreen onOpenPackReview={() => {}} /></OnboardingProvider>);
  expect(await screen.findByText('ChatGPT')).toBeTruthy();
  expect(await screen.findByText('Ollama')).toBeTruthy();
  expect(await screen.findByText('LM Studio')).toBeTruthy();
  expect(await screen.findByText('Custom model')).toBeTruthy();
  expect(mock.ollama).toHaveBeenCalled();
  expect(mock.lmStudio).toHaveBeenCalled();
  expect(mock.download).not.toHaveBeenCalled();
});
