import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ThreadWakeSources, wakeLocalDateTime } from './ThreadWakeSources';

vi.mock('../../src/ipc', () => ({ getApiUrl: async (path: string) => path }));

afterEach(() => { vi.unstubAllGlobals(); });

test('schedule edit preserves the same instant in a non-UTC timezone', async () => {
  const oldTimezone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  const at = '2026-09-27T14:00:00.000Z';
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({
      sources: [{ id: 'morning', kind: 'schedule', status: 'waiting', at, nextAt: at, message: 'check' }],
      events: [],
    }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    expect(wakeLocalDateTime(at)).toBe('2026-09-27T07:00');
    render(<ThreadWakeSources threadId="thread-one" />);
    fireEvent.click(await screen.findByText('Edit'));
    expect(screen.getByLabelText('Upcoming time')).toHaveValue('2026-09-27T07:00');
    await act(async () => { fireEvent.click(screen.getByText('Save')); });
    await waitFor(() => expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).at).toBe(at);
  } finally {
    if (oldTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = oldTimezone;
  }
});

test('a thread-shaped response cannot crash the wake rows', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ thread: { id: 'thread-one' } }) })));
  render(<ThreadWakeSources threadId="thread-one" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid wake source response');
  expect(screen.getByText(/Automations · 0/)).toBeInTheDocument();
});
