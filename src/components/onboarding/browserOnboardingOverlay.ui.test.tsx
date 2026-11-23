import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { BROWSER_PROJECT_CAPABILITIES } from '../../../shared/types/hostCapabilities';
import { createDefaultOnboardingState } from '../../../shared/types/onboardingState';

const mock = vi.hoisted(() => ({
  completed: false,
  getSimple: vi.fn(),
  themeGet: vi.fn(),
  detect: vi.fn(),
  discover: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('../../api', async importOriginal => ({
  ...await importOriginal<typeof import('../../api')>(),
  getOnboardingState: async () => ({ state: {
    ...createDefaultOnboardingState(), completed: mock.completed,
  } }),
  setOnboardingState: async (state: { completed: boolean }) => {
    mock.completed = state.completed;
    mock.setState(state);
    return { success: true, state };
  },
  getUserName: async () => ({ userName: null }),
  setUserName: async (name: string) => ({ success: true, userName: name }),
  getProfiles: async () => ({ profiles: [{ id: 'active', modelId: 'model',
    name: 'Active', provider: 'local' }] }),
}));
vi.mock('../../ipc', async importOriginal => ({
  ...await importOriginal<typeof import('../../ipc')>(),
  getHostCapabilities: () => BROWSER_PROJECT_CAPABILITIES,
  environmentDetection: { detect: mock.detect },
  workspace: { getSimple: mock.getSimple },
  theme: { get: mock.themeGet },
  telemetry: { set: async () => ({}), track: async () => ({}),
    trackOnboarding: async () => ({}) },
}));
vi.mock('./simpleSetupDiscovery', async importOriginal => ({
  ...await importOriginal<typeof import('./simpleSetupDiscovery')>(),
  discoverSimpleMcps: mock.discover,
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: null, session: null }) }));
vi.mock('../../hooks/useInterpreterTokenUsage', () => ({
  useInterpreterTokenUsage: () => ({ totalCredits: null }),
}));
vi.mock('./screens/NameScreen', () => ({
  NameScreen: ({ onNext }: { onNext: (name: string) => void }) =>
    <button onClick={() => onNext('Browser user')}>Name screen</button>,
}));
vi.mock('./screens/PrivacyScreen', () => ({
  PrivacyScreen: ({ onNext }: { onNext: (enabled: boolean) => void }) =>
    <button onClick={() => onNext(false)}>Privacy screen</button>,
}));
vi.mock('./screens/ModelSetupScreen', () => ({
  ModelSetupScreen: ({ onOpenPackReview }: { onOpenPackReview: (review: unknown) => void }) =>
    <button onClick={() => onOpenPackReview({ packId: 'browser:local', profiles: [{ id: 'active' }] })}>
      Model setup screen
    </button>,
}));
vi.mock('./screens/ModelPackReviewScreen', () => ({
  ModelPackReviewScreen: ({ onReviewComplete }: { onReviewComplete: (id: string) => void }) =>
    <button onClick={() => onReviewComplete('browser:local')}>Model review screen</button>,
}));
vi.mock('./components/NavigationFooter', () => ({ NavigationFooter: () => null }));

import { OnboardingOverlay } from './OnboardingOverlay';

test('browser host follows normal overlay through exactly four active screens and finishes without native probes', async () => {
  mock.completed = false;
  vi.clearAllMocks();
  const complete = vi.fn();
  render(<OnboardingOverlay simpleMode onComplete={complete} />);
  fireEvent.contextMenu(await screen.findByText('Name screen'));
  expect(mock.themeGet).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByText('Name screen'));
  fireEvent.click(await screen.findByText('Privacy screen'));
  fireEvent.click(await screen.findByText('Model setup screen'));
  fireEvent.click(await screen.findByText('Model review screen'));
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(mock.completed).toBe(true);
  expect(mock.detect).not.toHaveBeenCalled();
  expect(mock.discover).not.toHaveBeenCalled();
  expect(mock.getSimple).not.toHaveBeenCalled();
});
