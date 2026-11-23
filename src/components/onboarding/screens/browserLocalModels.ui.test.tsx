import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { OnboardingProvider, useOnboarding } from '../OnboardingContext';
import { BROWSER_PROJECT_CAPABILITIES } from '../../../../shared/types/hostCapabilities';

const ipc = vi.hoisted(() => ({
  listInterpreterModels: vi.fn(async () => ({ models: [
    { id: 'active-model', name: 'Active model', isDefault: true },
    { id: 'unacquired-model', name: 'Unacquired model', isDefault: false },
  ] })),
  getOllamaStatus: vi.fn(),
  getLmStudioStatus: vi.fn(),
  getOAuthStatus: vi.fn(),
  download: vi.fn(async (_provider: string, _model: string,
    callback: (progress: { total: number; completed: number }) => void,
    _signal?: AbortSignal) => {
    callback({ total: 100, completed: 30 });
  }),
}));
const api = vi.hoisted(() => ({
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  createProfile: vi.fn(async (profile: unknown) => ({ success: true, profile })),
  updateProfile: vi.fn(),
  setDefaultProfile: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../../ipc', async importOriginal => ({
  ...await importOriginal<typeof import('../../../ipc')>(),
  getHostCapabilities: () => BROWSER_PROJECT_CAPABILITIES,
  getBrowserProjectModelDownload: () => ipc.download,
  providers: { listInterpreterModels: ipc.listInterpreterModels,
    getOllamaStatus: ipc.getOllamaStatus, getLmStudioStatus: ipc.getLmStudioStatus,
    getOAuthStatus: ipc.getOAuthStatus },
}));
vi.mock('../../../hooks/use-interpreter-models', () => ({
  useInterpreterProviders: () => ({ data: [{ id: 'local', name: 'Browser-local models',
    configured: true }], loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('../../../api', async importOriginal => ({
  ...await importOriginal<typeof import('../../../api')>(), ...api,
}));

import { ModelSetupScreen, type ModelPackReviewState } from './ModelSetupScreen';
import { ModelPackReviewScreen } from './ModelPackReviewScreen';

function Footer() {
  const { footerConfig } = useOnboarding();
  return <button type="button" onClick={() => footerConfig?.continueAction?.()}>
    {footerConfig?.continueLabel || 'Continue'}
  </button>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

test('browser model setup renders only the runtime provider and does not probe desktop runtimes', async () => {
  const open = vi.fn();
  render(<OnboardingProvider totalSteps={4}><ModelSetupScreen onOpenPackReview={open} /></OnboardingProvider>);
  expect(screen.getByText('Local browser models')).toBeTruthy();
  expect(screen.queryByText('ChatGPT')).toBeNull();
  fireEvent.click(screen.getByText('Local browser models'));
  await waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(open.mock.calls[0][0].profiles).toHaveLength(2);
  expect(open.mock.calls[0][0].profiles[0].modelId).toBe('active-model');
  expect(open.mock.calls[0][0].profiles[1].modelId).toBe('unacquired-model');
  expect(open.mock.calls[0][0].initialSelectedProfileIds).toEqual(['onboarding:browser-local-active-model']);
  expect(ipc.getOllamaStatus).not.toHaveBeenCalled();
  expect(ipc.getLmStudioStatus).not.toHaveBeenCalled();
  expect(ipc.getOAuthStatus).not.toHaveBeenCalled();
});

test('browser review uses host acquisition progress and never named desktop download endpoints', async () => {
  const done = vi.fn();
  const review: ModelPackReviewState = { packId: 'browser:local', browserProviderId: 'local',
    title: 'Browser-local models', subtitle: 'Review model',
    profiles: [{ id: 'browser-active', provider: 'local', modelId: 'active-model',
      name: 'Active model', isBuiltin: false },
    { id: 'browser-other', provider: 'local', modelId: 'unacquired-model',
      name: 'Unacquired model', isBuiltin: false }], defaultProfileId: 'browser-active',
    initialSelectedProfileIds: ['browser-active'], errorMessage: 'Failed' };
  render(<OnboardingProvider totalSteps={4}>
    <ModelPackReviewScreen reviewState={review} onReviewComplete={done} /><Footer />
  </OnboardingProvider>);
  await act(async () => { fireEvent.click(screen.getByText('Install 1 model')); });
  await waitFor(() => expect(done).toHaveBeenCalledWith('browser:local'));
  expect(ipc.download).toHaveBeenCalledWith('local', 'active-model', expect.any(Function), expect.any(AbortSignal));
  expect(ipc.download).toHaveBeenCalledTimes(1);
  expect(api.createProfile).toHaveBeenCalledOnce();
  expect(api.setDefaultProfile).toHaveBeenCalledWith('browser-active');
});

test('leaving review aborts acquisition without saving or finishing onboarding', async () => {
  const done = vi.fn();
  let signal: AbortSignal | undefined;
  ipc.download.mockImplementationOnce(async (_provider, _model, _progress, abortSignal?: AbortSignal) => {
    signal = abortSignal;
    await new Promise<void>((_resolve, reject) => {
      abortSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true });
    });
  });
  const review: ModelPackReviewState = { packId: 'browser:local', browserProviderId: 'local',
    title: 'Browser-local models', subtitle: 'Review model',
    profiles: [{ id: 'browser-active', provider: 'local', modelId: 'active-model',
      name: 'Active model', isBuiltin: false }], defaultProfileId: 'browser-active',
    initialSelectedProfileIds: ['browser-active'], errorMessage: 'Failed' };
  const view = render(<OnboardingProvider totalSteps={4}>
    <ModelPackReviewScreen reviewState={review} onReviewComplete={done} /><Footer />
  </OnboardingProvider>);
  fireEvent.click(screen.getByText('Install 1 model'));
  await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
  view.rerender(<OnboardingProvider totalSteps={4}>
    <ModelPackReviewScreen reviewState={null} onReviewComplete={done} /><Footer />
  </OnboardingProvider>);
  await waitFor(() => expect(signal?.aborted).toBe(true));
  expect(api.createProfile).not.toHaveBeenCalled();
  expect(done).not.toHaveBeenCalled();
});

test('a failed browser profile write leaves review open with a visible error', async () => {
  const done = vi.fn();
  api.createProfile.mockRejectedValueOnce(new Error('Storage blocked'));
  const review: ModelPackReviewState = { packId: 'browser:local', browserProviderId: 'local',
    title: 'Browser-local models', subtitle: 'Review model',
    profiles: [{ id: 'browser-active', provider: 'local', modelId: 'active-model',
      name: 'Active model', isBuiltin: false }], defaultProfileId: 'browser-active',
    initialSelectedProfileIds: ['browser-active'], errorMessage: 'Failed' };
  render(<OnboardingProvider totalSteps={4}>
    <ModelPackReviewScreen reviewState={review} onReviewComplete={done} /><Footer />
  </OnboardingProvider>);
  fireEvent.click(screen.getByText('Install 1 model'));
  expect(await screen.findByText('Storage blocked')).toBeTruthy();
  expect(api.setDefaultProfile).not.toHaveBeenCalled();
  expect(done).not.toHaveBeenCalled();
});
