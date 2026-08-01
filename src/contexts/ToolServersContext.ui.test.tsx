import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

import { ToolServersProvider, useToolServers } from './ToolServersContext';
import type { ToolServer } from '../api';
import { ToolsGrid } from '../components/tools/ToolsGrid';

type ToolServersChangedEvent = { servers: ToolServer[] };

const apiMocks = vi.hoisted(() => ({
  listAllToolServers: vi.fn(),
  addToolServer: vi.fn(),
  deleteToolServer: vi.fn(),
  toggleToolServer: vi.fn(),
}));

const ipcMocks = vi.hoisted(() => ({
  getSnapshot: vi.fn<() => Promise<ToolServersChangedEvent | null>>(async () => null),
  onChanged: vi.fn<(callback: (event: ToolServersChangedEvent) => void) => () => void>(() => () => {}),
}));

vi.mock('../api', () => ({
  listAllToolServers: apiMocks.listAllToolServers,
  addToolServer: apiMocks.addToolServer,
  deleteToolServer: apiMocks.deleteToolServer,
  toggleToolServer: apiMocks.toggleToolServer,
  toolServerNeedsAuth: (server: { state: { status: string; needsAuth?: boolean } }) =>
    server.state.status === 'failed' && server.state.needsAuth === true,
}));

vi.mock('@/ipc', () => ({
  toolServers: {
    getSnapshot: ipcMocks.getSnapshot,
    onChanged: ipcMocks.onChanged,
  },
}));

vi.mock('../demo/marketingDemo', () => ({
  isMarketingDemoMode: () => false,
}));

function Harness() {
  const { loading, error, servers } = useToolServers();

  return (
    <div>
      <div data-testid="loading">{loading ? 'loading' : 'idle'}</div>
      <div data-testid="error">{error ?? ''}</div>
      <div data-testid="count">{String(servers.length)}</div>
      <div data-testid="names">{servers.map((server) => server.name).join(',')}</div>
    </div>
  );
}

function GridHarness() {
  const { servers } = useToolServers();

  return (
    <ToolsGrid
      tools={servers}
      mode="edit"
      onAddFromStore={() => {}}
      onCompleteAuth={() => {}}
    />
  );
}

describe('ToolServersProvider', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    ipcMocks.getSnapshot.mockResolvedValue(null);
    apiMocks.listAllToolServers.mockResolvedValue({ servers: [] });
    apiMocks.addToolServer.mockResolvedValue({ serverId: 'server-1' });
    apiMocks.deleteToolServer.mockResolvedValue(undefined);
    apiMocks.toggleToolServer.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
  });

  test('clears loading when the initial refresh fails', async () => {
    apiMocks.listAllToolServers.mockRejectedValueOnce(new Error('list failed'));

    render(
      <ToolServersProvider>
        <Harness />
      </ToolServersProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('idle');
    });

    expect(screen.getByTestId('error')).toHaveTextContent('list failed');
    expect(apiMocks.listAllToolServers).toHaveBeenCalledTimes(1);
  });

  test('uses a toolServers changed snapshot to unblock a hung initial refresh', async () => {
    let emitChanged: ((event: ToolServersChangedEvent) => void) | undefined;
    ipcMocks.onChanged.mockImplementationOnce((callback) => {
      emitChanged = callback;
      return () => {};
    });
    apiMocks.listAllToolServers.mockImplementationOnce(
      () => new Promise(() => {}),
    );

    render(
      <ToolServersProvider>
        <Harness />
      </ToolServersProvider>,
    );

    expect(screen.getByTestId('loading')).toHaveTextContent('loading');

    if (!emitChanged) {
      throw new Error('Expected toolServers.onChanged callback to be registered');
    }

    emitChanged({
      servers: [
        {
          id: 'sentry',
          name: 'Sentry',
          state: {
            status: 'connected',
            tools: [],
            resources: [],
            prompts: [],
          },
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('idle');
    });

    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('names')).toHaveTextContent('Sentry');
  });

  test('uses the cached toolServers snapshot before the live refresh resolves', async () => {
    ipcMocks.getSnapshot.mockResolvedValueOnce({
      servers: [
        {
          id: 'github',
          name: 'GitHub',
          state: {
            status: 'connected',
            tools: [],
            resources: [],
            prompts: [],
          },
        },
      ],
    });
    apiMocks.listAllToolServers.mockImplementationOnce(
      () => new Promise(() => {}),
    );

    render(
      <ToolServersProvider>
        <Harness />
      </ToolServersProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('idle');
    });

    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('names')).toHaveTextContent('GitHub');
  });

  test('reconciles a normalized MCP runtime server into the installed store card', async () => {
    let emitChanged: ((event: ToolServersChangedEvent) => void) | undefined;
    ipcMocks.onChanged.mockImplementationOnce((callback) => {
      emitChanged = callback;
      return () => {};
    });
    apiMocks.listAllToolServers.mockImplementationOnce(
      () => new Promise(() => {}),
    );

    render(
      <ToolServersProvider>
        <GridHarness />
      </ToolServersProvider>,
    );

    expect(await screen.findByRole('button', { name: 'Add Sentry' })).toBeVisible();

    if (!emitChanged) {
      throw new Error('Expected toolServers.onChanged callback to be registered');
    }

    emitChanged({
      servers: [
        {
          id: 'sentry',
          name: 'Sentry',
          state: {
            status: 'failed',
            error: 'OAuth login required',
            needsAuth: true,
          },
          config: {
            transport: 'http',
            url: 'https://mcp.sentry.dev',
            enabled: true,
          },
        },
      ],
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Add Sentry' })).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Complete auth for Sentry' })).toBeVisible();
  });
});
