import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ completed: false, modelId: 'model', failProfiles: false,
  onDefaultChanged: null as null | (() => void) }));
vi.mock('../api', () => ({
  getOnboardingState: async () => ({ state: { version: 1, completed: state.completed,
    completedStepIds: [] } }),
  getProfiles: async () => {
    if (state.failProfiles) throw new Error('Profile temporarily unavailable');
    return { profiles: [{ id: 'selected', modelId: state.modelId }],
      defaultProfileId: 'selected' };
  },
}));
vi.mock('../components/simple/SimpleShell', () => ({
  SimpleShell: () => <div>Real Simple shell seam</div>,
}));
vi.mock('../components/onboarding/OnboardingOverlay', () => ({
  OnboardingOverlay: ({ onComplete }: { onComplete: () => void }) =>
    <button onClick={onComplete}>Normal onboarding overlay</button>,
}));
vi.mock('./host', () => ({
  activateBrowserProjectBackend: vi.fn(),
  createBrowserProjectHost: (session: unknown) => ({ session, workspacePath: 'browser-project:project',
    capabilities: {} }),
  BrowserProjectHostProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../ipc', () => ({ restoreBrowserProjectNativeEvents: vi.fn(),
  profiles: { onDefaultChanged: (listener: () => void) => {
    state.onDefaultChanged = listener;
    return () => { if (state.onDefaultChanged === listener) state.onDefaultChanged = null; };
  } } }));

import { AppSimpleBrowserProject as SimpleBrowserProject } from './AppSimpleBrowserProject';
import { SimpleBrowserProject as EmbeddedBrowserProject } from './SimpleBrowserProject';

const props = {
  backend: { projectId: 'project', request: vi.fn(), downloadModel: vi.fn(),
    openSession: vi.fn(async (modelId: string) => ({ projectId: 'project', threadId: 'thread',
      model: { id: modelId, name: 'Model' },
      appServer: { request: vi.fn(), subscribe: vi.fn() }, stream: vi.fn(), dispose: vi.fn() })) },
  projectFiles: { isDirectory: vi.fn() }, canvas: null,
  onOpenSettings: vi.fn(), onCloseSettings: vi.fn(), onLeaveFeedback: vi.fn(),
};

beforeEach(() => { state.completed = false; state.modelId = 'model'; state.failProfiles = false;
  state.onDefaultChanged = null; vi.clearAllMocks(); });

test('embedder without an onboarding renderer opens without importing the app overlay', async () => {
  render(<EmbeddedBrowserProject {...props} />);
  await screen.findByText('Real Simple shell seam');
  expect(screen.queryByText('Normal onboarding overlay')).toBeNull();
  expect(props.backend.openSession).toHaveBeenCalledWith('model');
});

test('embedder can retry after profile discovery fails without the app onboarding overlay', async () => {
  state.failProfiles = true;
  render(<EmbeddedBrowserProject {...props} />);
  await screen.findByText('Profile temporarily unavailable');
  expect(screen.queryByText('Normal onboarding overlay')).toBeNull();
  state.failProfiles = false;
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  await screen.findByText('Real Simple shell seam');
  expect(props.backend.openSession).toHaveBeenCalledWith('model');
});

test('embedder can retry a failed model opening without the app onboarding overlay', async () => {
  props.backend.openSession.mockRejectedValueOnce(new Error('Session temporarily unavailable'));
  render(<EmbeddedBrowserProject {...props} />);
  await screen.findByText('Session temporarily unavailable');
  expect(screen.queryByText('Normal onboarding overlay')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  await screen.findByText('Real Simple shell seam');
  expect(props.backend.openSession).toHaveBeenCalledTimes(2);
});

test('browser Simple host uses normal onboarding and hides it after persisted completion on remount', async () => {
  const first = render(<SimpleBrowserProject {...props} />);
  await waitFor(() => expect(screen.getByText('Normal onboarding overlay')).toBeTruthy());
  expect(screen.queryByText('Real Simple shell seam')).toBeNull();
  fireEvent.click(screen.getByText('Normal onboarding overlay'));
  await waitFor(() => expect(screen.getByText('Real Simple shell seam')).toBeTruthy());
  expect(props.backend.openSession).toHaveBeenCalledWith('model');
  state.completed = true;
  first.unmount();
  render(<SimpleBrowserProject {...props} />);
  await waitFor(() => expect(screen.getByText('Real Simple shell seam')).toBeTruthy());
  expect(screen.queryByText('Normal onboarding overlay')).toBeNull();
});

test('browser restart re-enters onboarding without retaining a model session', async () => {
  state.completed = true;
  render(<SimpleBrowserProject {...props} />);
  await screen.findByText('Real Simple shell seam');
  window.dispatchEvent(new Event('settings:restart-onboarding'));
  await screen.findByText('Normal onboarding overlay');
  expect(screen.queryByText('Real Simple shell seam')).toBeNull();
  expect((await props.backend.openSession.mock.results[0].value).dispose).toHaveBeenCalledOnce();
});

test('StrictMode reuses one model opening and disposes the session on real unmount', async () => {
  state.completed = true;
  const view = render(<StrictMode><SimpleBrowserProject {...props} /></StrictMode>);
  await screen.findByText('Real Simple shell seam');
  expect(props.backend.openSession).toHaveBeenCalledTimes(1);
  const opened = await props.backend.openSession.mock.results[0].value;
  expect(opened.dispose).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(opened.dispose).toHaveBeenCalledOnce());
});

test('changing the default profile closes the former session before opening the new model', async () => {
  state.completed = true;
  render(<SimpleBrowserProject {...props} />);
  await screen.findByText('Real Simple shell seam');
  await waitFor(() => expect(state.onDefaultChanged).toBeTypeOf('function'));
  const first = await props.backend.openSession.mock.results[0].value;
  state.modelId = 'other-model';
  state.onDefaultChanged?.();
  await waitFor(() => expect(props.backend.openSession).toHaveBeenCalledWith('other-model'));
  expect(first.dispose).toHaveBeenCalledOnce();
  await screen.findByText('Real Simple shell seam');
});

test('changing project identity cannot retain the former project session or opening', async () => {
  state.completed = true;
  const view = render(<SimpleBrowserProject {...props} />);
  await screen.findByText('Real Simple shell seam');
  const previous = await props.backend.openSession.mock.results[0].value;
  const nextBackend = { ...props.backend, projectId: 'different-project',
    openSession: vi.fn(async (modelId: string) => ({
      projectId: 'different-project', threadId: 'other-thread',
      model: { id: modelId, name: 'Model' },
      appServer: { request: vi.fn(), subscribe: vi.fn() },
      stream: vi.fn(), dispose: vi.fn(),
    })) };
  view.rerender(<SimpleBrowserProject {...props} backend={nextBackend} />);
  await waitFor(() => expect(nextBackend.openSession).toHaveBeenCalledWith('model'));
  await waitFor(() => expect(previous.dispose).toHaveBeenCalledOnce());
  expect(screen.queryByText('Normal onboarding overlay')).toBeNull();
  expect(screen.getByText('Real Simple shell seam')).toBeTruthy();
});
