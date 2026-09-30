import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SimpleInterfaceSnapshot } from '../../../shared/simpleInterface';

const client = vi.hoisted(() => ({
  refresh: vi.fn(),
  input: vi.fn(),
  action: vi.fn(),
  delivery: vi.fn(),
  assetUrl: vi.fn(),
}));

vi.mock('./simpleInterfaceClient', () => ({ simpleInterfaceClient: client }));
vi.mock('../../remote/workstationConnection', () => ({ isWorkstationReadOnly: () => false }));

import { SimpleInterface } from './SimpleInterface';

const snapshot: SimpleInterfaceSnapshot = {
  revision: 'accepted-1',
  diagnostic: null,
  data: { name: 'Ada' },
  inputs: { question: 'Original answer' },
  page: { version: 1, title: 'Welcome', blocks: [
    { type: 'heading', id: 'title', text: 'Hello {{data.name}}' },
    { type: 'button', id: 'choose', label: 'Choose', message: 'Go to the next step' },
    { type: 'input', id: 'question', label: 'Question', message: 'Question: {{value}}' },
  ] },
};

beforeEach(() => {
  client.refresh.mockResolvedValue(snapshot);
  client.input.mockResolvedValue({ success: true });
  client.action.mockResolvedValue({ id: 'event-1', message: 'Go to the next step' });
  client.delivery.mockResolvedValue({ success: true });
});
afterEach(() => vi.clearAllMocks());

describe('Simple generated interface', () => {
  test('renders trusted components with live data and persisted input state', async () => {
    render(<SimpleInterface onMessage={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Hello Ada' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Question' }) as HTMLInputElement).value).toBe('Original answer');
    expect(screen.getByRole('button', { name: 'Choose' })).toBeTruthy();
  });

  test('persists an action before dispatching it, then records dispatch acknowledgment', async () => {
    const order: string[] = [];
    client.action.mockImplementation(async () => { order.push('persist'); return { id: 'event-1', message: 'Go to the next step' }; });
    client.delivery.mockImplementation(async () => { order.push('receipt'); return { success: true }; });
    const onMessage = vi.fn(async () => { order.push('dispatch'); });
    render(<SimpleInterface onMessage={onMessage} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose' }));
    await waitFor(() => expect(client.delivery).toHaveBeenCalledWith({ id: 'event-1', status: 'dispatched' }));
    expect(order).toEqual(['persist', 'dispatch', 'receipt']);
    expect(onMessage).toHaveBeenCalledWith('Go to the next step', 'interface:choose');
  });

  test('input submission persists edited value and forwards the validated message', async () => {
    const onMessage = vi.fn();
    client.action.mockResolvedValue({ id: 'event-2', message: 'Question: New answer' });
    render(<SimpleInterface onMessage={onMessage} />);
    const input = await screen.findByRole('textbox', { name: 'Question' });
    fireEvent.change(input, { target: { value: 'New answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('Question: New answer', 'interface:question'));
    expect(client.input).toHaveBeenCalledWith({ id: 'question', revision: 'accepted-1', value: 'New answer' });
    expect(client.action).toHaveBeenCalledWith({ actionId: 'question', revision: 'accepted-1', value: 'New answer' });
  });

  test('surfaces dispatch failure and records failed delivery instead of false success', async () => {
    const onMessage = vi.fn(async () => { throw new Error('Primary conversation unavailable'); });
    render(<SimpleInterface onMessage={onMessage} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Primary conversation unavailable');
    expect(client.delivery).toHaveBeenCalledWith({ id: 'event-1', status: 'failed', error: 'Primary conversation unavailable' });
  });

  test('keeps accepted page visible on invalid edit, then recovers after valid edit', async () => {
    vi.useFakeTimers();
    client.refresh.mockResolvedValueOnce({ ...snapshot, diagnostic: 'Invalid interface/page.json: bad JSON' })
      .mockResolvedValue({ ...snapshot, diagnostic: null, page: { ...snapshot.page, blocks: [{ type: 'heading', id: 'repaired', text: 'Repaired interface' }] } });
    render(<SimpleInterface onMessage={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('heading', { name: 'Hello Ada' })).toBeTruthy();
    expect(screen.getByText(/last working page is still shown/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByRole('heading', { name: 'Repaired interface' })).toBeTruthy();
    expect(screen.queryByText(/last working page is still shown/)).toBeNull();
    vi.useRealTimers();
  });
});
