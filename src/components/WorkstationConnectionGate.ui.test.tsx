import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkstationConnectionGate } from './WorkstationConnectionGate';

const originalUrl = window.location.href;

afterEach(() => {
  window.history.replaceState({}, '', originalUrl);
  vi.restoreAllMocks();
});

function descriptor(authenticated: boolean, access: 'read-only' | 'read-write' = 'read-write') {
  return {
    schemaVersion: 1,
    host: 'remote',
    access,
    authentication: {
      method: 'password',
      required: true,
      authenticated,
    },
  };
}

describe('WorkstationConnectionGate', () => {
  test('opens an authenticated remote Workstation after password login', async () => {
    window.history.replaceState(
      {},
      '',
      '/?surface=workstation&endpoint=https%3A%2F%2Fcomputer.example&access=read-write&auth=password',
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(descriptor(false)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(descriptor(true)), { status: 200 }));

    render(
      <WorkstationConnectionGate>
        <div>Connected shell</div>
      </WorkstationConnectionGate>,
    );

    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Open this Workstation' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Open Workstation' }));

    expect(await screen.findByText('Connected shell')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://computer.example/api/workstation-connection/session',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(document.documentElement.dataset.workstationAccess).toBe('read-write');
  });

  test('refuses to mount a shell when browser and host access settings disagree', async () => {
    window.history.replaceState(
      {},
      '',
      '/?surface=workstation&endpoint=https%3A%2F%2Fcomputer.example&access=read-only&auth=password',
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(descriptor(true, 'read-write')), { status: 200 }),
    );

    render(
      <WorkstationConnectionGate>
        <div>Connected shell</div>
      </WorkstationConnectionGate>,
    );

    expect(await screen.findByText(/browser requests read-only access/i)).toBeInTheDocument();
    expect(screen.queryByText('Connected shell')).not.toBeInTheDocument();
  });

  test('mounts the public read-only publication without a login handshake', async () => {
    window.history.replaceState(
      {},
      '',
      '/?surface=remote-workstation&endpoint=%2Fapi%2Fscience&access=read-only&auth=none',
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    render(
      <WorkstationConnectionGate>
        <div>Public shell</div>
      </WorkstationConnectionGate>,
    );

    expect(screen.getByText('Public shell')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    expect(document.documentElement.dataset.workstationAccess).toBe('read-only');
  });
});
