import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { OnboardingProvider, useOnboarding } from '../OnboardingContext';
import { WorkspaceChoiceScreen } from './WorkspaceChoiceScreen';

const ipcMocks = vi.hoisted(() => ({
  workspaceCreateSample: vi.fn(),
  workspaceSet: vi.fn(),
  openFolderDialog: vi.fn(),
  pathBasename: vi.fn((inputPath: string) => inputPath.split(/[\\/]/).pop() ?? inputPath),
}));

const apiMocks = vi.hoisted(() => ({
  detectNoteWorkspaces: vi.fn(),
}));

vi.mock('@/ipc', () => ({
  workspace: {
    createSample: ipcMocks.workspaceCreateSample,
    set: ipcMocks.workspaceSet,
  },
  openFolderDialog: ipcMocks.openFolderDialog,
  pathBasename: ipcMocks.pathBasename,
}));

vi.mock('../../../api', () => ({
  detectNoteWorkspaces: apiMocks.detectNoteWorkspaces,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ContinueHarness() {
  const { footerConfig } = useOnboarding();

  return (
    <button
      type="button"
      data-testid="workspace-choice-continue"
      disabled={!footerConfig?.continueAction || footerConfig.continueDisabled || footerConfig.continueLoading}
      onClick={() => footerConfig?.continueAction?.()}
    >
      Continue
    </button>
  );
}

function renderWorkspaceChoiceScreen(onFinish = vi.fn()) {
  render(
    <OnboardingProvider totalSteps={19}>
      <WorkspaceChoiceScreen onFinish={onFinish} />
      <ContinueHarness />
    </OnboardingProvider>,
  );

  return { onFinish };
}

describe('WorkspaceChoiceScreen', () => {
  const originalHasPointerCapture = Element.prototype.hasPointerCapture;
  const originalSetPointerCapture = Element.prototype.setPointerCapture;
  const originalReleasePointerCapture = Element.prototype.releasePointerCapture;

  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
  });

  afterAll(() => {
    Element.prototype.hasPointerCapture = originalHasPointerCapture;
    Element.prototype.setPointerCapture = originalSetPointerCapture;
    Element.prototype.releasePointerCapture = originalReleasePointerCapture;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.detectNoteWorkspaces.mockResolvedValue({ workspaces: [] });
    ipcMocks.workspaceCreateSample.mockResolvedValue({ success: true, workspacePath: '/sample-workspace' });
    ipcMocks.workspaceSet.mockResolvedValue({ success: true });
    ipcMocks.openFolderDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  });

  test('prevents duplicate sample workspace creation while activation is pending', async () => {
    const user = userEvent.setup();
    const createSampleDeferred = createDeferred<{ success: boolean; workspacePath: string }>();
    ipcMocks.workspaceCreateSample.mockReturnValue(createSampleDeferred.promise);
    const { onFinish } = renderWorkspaceChoiceScreen();

    const continueButton = await screen.findByTestId('workspace-choice-continue');

    await user.click(continueButton);

    await waitFor(() => {
      expect(ipcMocks.workspaceCreateSample).toHaveBeenCalledTimes(1);
      expect(continueButton).toBeDisabled();
    });

    await user.click(continueButton);

    expect(ipcMocks.workspaceCreateSample).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();

    createSampleDeferred.resolve({ success: true, workspacePath: '/sample-workspace' });

    await waitFor(() => {
      expect(onFinish).toHaveBeenCalledTimes(1);
    });
  });

  test('only scans for detected workspaces after the user asks', async () => {
    const user = userEvent.setup();
    apiMocks.detectNoteWorkspaces.mockResolvedValue({
      workspaces: [{ name: 'Personal Notes', path: '/notes', source: 'obsidian' }],
    });

    renderWorkspaceChoiceScreen();

    expect(apiMocks.detectNoteWorkspaces).not.toHaveBeenCalled();
    expect(screen.queryByText('Personal Notes')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /scan computer/i }));

    expect(apiMocks.detectNoteWorkspaces).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Personal Notes')).toBeInTheDocument();
  });

  test('prevents duplicate workspace switches while activation is pending', async () => {
    const user = userEvent.setup();
    const setWorkspaceDeferred = createDeferred<{ success: boolean }>();
    apiMocks.detectNoteWorkspaces.mockResolvedValue({
      workspaces: [{ name: 'Personal Notes', path: '/notes', source: 'obsidian' }],
    });
    ipcMocks.workspaceSet.mockReturnValue(setWorkspaceDeferred.promise);
    const { onFinish } = renderWorkspaceChoiceScreen();

    await user.click(screen.getByRole('button', { name: /scan computer/i }));

    const detectedWorkspaceCard = (await screen.findByText('Personal Notes')).closest('button');
    expect(detectedWorkspaceCard).not.toBeNull();

    await user.click(detectedWorkspaceCard as HTMLButtonElement);

    const continueButton = await screen.findByTestId('workspace-choice-continue');
    await user.click(continueButton);

    await waitFor(() => {
      expect(ipcMocks.workspaceSet).toHaveBeenCalledTimes(1);
      expect(ipcMocks.workspaceSet).toHaveBeenCalledWith({ workspacePath: '/notes' });
      expect(continueButton).toBeDisabled();
    });

    await user.click(continueButton);

    expect(ipcMocks.workspaceSet).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();

    setWorkspaceDeferred.resolve({ success: true });

    await waitFor(() => {
      expect(onFinish).toHaveBeenCalledTimes(1);
    });
  });
});
