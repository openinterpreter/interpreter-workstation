import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { NativeToolsSection } from './NativeToolsSection';

const nativeToolsMocks = vi.hoisted(() => ({
  getNetworkAccess: vi.fn(async () => ({ enabled: true })),
  getApprovalPolicy: vi.fn(async () => ({ policy: 'on-request' as 'never' | 'on-failure' | 'on-request' | 'untrusted' })),
  getSandboxMode: vi.fn(async () => ({ mode: 'workspace-write' as const })),
  getReadAccessMode: vi.fn(async () => ({ mode: 'workspace-only' as const })),
  getMacosTempAccess: vi.fn(async () => ({ enabled: true })),
  getMacosScreenshotAccess: vi.fn(async () => ({ enabled: true })),
  getCuaAccessPolicy: vi.fn(async () => ({
    policy: {
      permissions: {
        inspect: { mode: 'ask' as const },
        control: { mode: 'ask' as const },
      },
      appPolicies: [],
    },
  })),
  setApprovalPolicy: vi.fn(async () => ({ success: true })),
  setSandboxMode: vi.fn(async () => ({ success: true })),
  setReadAccessMode: vi.fn(async () => ({ success: true })),
  setMacosTempAccess: vi.fn(async () => ({ success: true })),
  setMacosScreenshotAccess: vi.fn(async () => ({ success: true })),
  setCuaAccessPolicy: vi.fn(async (policy: unknown) => ({ success: true, policy })),
  setNetworkAccess: vi.fn(async () => ({ success: true })),
  restart: vi.fn(async () => ({ success: true })),
}));

const runtimeSystemInfoMock = vi.hoisted(() => ({
  platform: 'linux',
}));

vi.mock('@/ipc', () => ({
  getRuntimeSystemInfo: () => runtimeSystemInfoMock,
  nativeTools: nativeToolsMocks,
}));

vi.mock('@/hooks/useAgentActivityMap', () => ({
  useAgentActivityMap: () => new Map(),
}));

describe('NativeToolsSection', () => {
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
    runtimeSystemInfoMock.platform = 'linux';
    nativeToolsMocks.getNetworkAccess.mockResolvedValue({ enabled: true });
    nativeToolsMocks.getApprovalPolicy.mockResolvedValue({ policy: 'on-request' });
    nativeToolsMocks.getSandboxMode.mockResolvedValue({ mode: 'workspace-write' });
    nativeToolsMocks.getReadAccessMode.mockResolvedValue({ mode: 'workspace-only' });
    nativeToolsMocks.getMacosTempAccess.mockResolvedValue({ enabled: true });
    nativeToolsMocks.getMacosScreenshotAccess.mockResolvedValue({ enabled: true });
    nativeToolsMocks.getCuaAccessPolicy.mockResolvedValue({
      policy: {
        permissions: {
          inspect: { mode: 'ask' },
          control: { mode: 'ask' },
        },
        appPolicies: [],
      },
    });
    nativeToolsMocks.setCuaAccessPolicy.mockImplementation(async (policy: unknown) => ({ success: true, policy }));
    nativeToolsMocks.restart.mockResolvedValue({ success: true });
  });

  test('requires an explicit confirmation before enabling Full Access', async () => {
    const user = userEvent.setup();

    render(<NativeToolsSection />);

    const changeFilesRow = (await screen.findByText('Change files')).closest('[data-help-title="Change files"]');
    expect(changeFilesRow).not.toBeNull();

    await user.click(within(changeFilesRow as HTMLElement).getByRole('combobox'));
    await user.click(await screen.findByText('Anywhere'));

    expect(await screen.findByText('Enable Full Access?')).toBeVisible();
    expect(screen.getByText(/Full Access is very dangerous\./)).toBeVisible();
    expect(nativeToolsMocks.setSandboxMode).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Enable Full Access' }));

    await waitFor(() => {
      expect(nativeToolsMocks.setApprovalPolicy).toHaveBeenCalledWith('never');
      expect(nativeToolsMocks.setReadAccessMode).toHaveBeenCalledWith('full-system');
      expect(nativeToolsMocks.setSandboxMode).toHaveBeenCalledWith('danger-full-access');
      expect(nativeToolsMocks.restart).toHaveBeenCalled();
    });
  });

  test('maps Current folder to workspace-write without ask-first approvals', async () => {
    const user = userEvent.setup();

    render(<NativeToolsSection />);

    const changeFilesRow = (await screen.findByText('Change files')).closest('[data-help-title="Change files"]');
    expect(changeFilesRow).not.toBeNull();

    await user.click(within(changeFilesRow as HTMLElement).getByRole('combobox'));
    const currentFolderOptions = await screen.findAllByText('Current folder');
    await user.click(currentFolderOptions[currentFolderOptions.length - 1]!);

    await waitFor(() => {
      expect(nativeToolsMocks.setApprovalPolicy).toHaveBeenCalledWith('never');
      expect(nativeToolsMocks.setSandboxMode).toHaveBeenCalledWith('workspace-write');
      expect(nativeToolsMocks.restart).toHaveBeenCalled();
    });
  });

  test('maps Ask first to workspace-write with untrusted approvals', async () => {
    const user = userEvent.setup();
    nativeToolsMocks.getApprovalPolicy.mockResolvedValue({ policy: 'never' });
    nativeToolsMocks.getSandboxMode.mockResolvedValue({ mode: 'workspace-write' });

    render(<NativeToolsSection />);

    const changeFilesRow = (await screen.findByText('Change files')).closest('[data-help-title="Change files"]');
    expect(changeFilesRow).not.toBeNull();

    await user.click(within(changeFilesRow as HTMLElement).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /Ask first/ }));

    await waitFor(() => {
      expect(nativeToolsMocks.setApprovalPolicy).toHaveBeenCalledWith('untrusted');
      expect(nativeToolsMocks.setSandboxMode).toHaveBeenCalledWith('workspace-write');
      expect(nativeToolsMocks.restart).toHaveBeenCalled();
    });
  });

  test('warns that turning off temporary files disables overlay screenshots', async () => {
    const user = userEvent.setup();
    runtimeSystemInfoMock.platform = 'darwin';
    nativeToolsMocks.getMacosTempAccess.mockResolvedValue({ enabled: false });
    nativeToolsMocks.getMacosScreenshotAccess.mockResolvedValue({ enabled: true });

    render(<NativeToolsSection />);

    const tempRow = (await screen.findByText('Temporary files')).closest('[data-help-title="Temporary files"]');
    expect(tempRow).not.toBeNull();
    expect(
      screen.getByText(/Interpreter cannot see saved screenshots in \/tmp, so pasted overlay images and Interpreter Overlay are unavailable\./),
    ).toBeVisible();

    await user.click(within(tempRow as HTMLElement).getByRole('combobox'));
    expect(
      await screen.findByText(/Interpreter cannot use \/tmp screenshots, so pasted overlay images and Interpreter Overlay are unavailable\./),
    ).toBeVisible();
  });

  test('defaults the Network switch to on when the backend value is unset', async () => {
    nativeToolsMocks.getNetworkAccess.mockResolvedValue({ enabled: undefined as unknown as boolean });

    render(<NativeToolsSection />);

    const networkRow = (await screen.findByText('Network')).closest('[data-help-title="Network"]');
    expect(networkRow).not.toBeNull();
    expect(within(networkRow as HTMLElement).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  test('saves global Computer Use app control policy without restarting', async () => {
    const user = userEvent.setup();

    render(<NativeToolsSection />);

    const controlAppsRow = (await screen.findByText('Control apps')).closest('[data-help-title="Control apps"]');
    expect(controlAppsRow).not.toBeNull();

    await user.click(within(controlAppsRow as HTMLElement).getByRole('combobox'));
    await user.click(await screen.findByText('Never'));

    await waitFor(() => {
      expect(nativeToolsMocks.setCuaAccessPolicy).toHaveBeenCalledWith({
        permissions: {
          inspect: { mode: 'ask' },
          control: { mode: 'deny' },
        },
        appPolicies: [],
      });
      expect(nativeToolsMocks.restart).not.toHaveBeenCalled();
    });
  });

  test('adds a named Computer Use app rule', async () => {
    const user = userEvent.setup();

    render(<NativeToolsSection />);

    await user.type(await screen.findByLabelText('Native app name'), 'TextEdit');
    await user.click(screen.getByRole('button', { name: 'Add app' }));

    await waitFor(() => {
      expect(nativeToolsMocks.setCuaAccessPolicy).toHaveBeenCalledWith({
        permissions: {
          inspect: { mode: 'ask' },
          control: { mode: 'ask' },
        },
        appPolicies: [{
          appId: 'TextEdit',
          displayName: 'TextEdit',
          permissions: {
            inspect: { mode: 'ask' },
            control: { mode: 'ask' },
          },
        }],
      });
    });
    expect(await screen.findByText('TextEdit')).toBeVisible();
  });
});
