import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ capabilities: vi.fn(), readInterface: vi.fn(), conversation: vi.fn(), send: vi.fn(),
  stop: vi.fn(), eventsUrl: vi.fn() }));
vi.mock('./remoteSimpleClient', () => ({ remoteSimpleClient: api }));
vi.mock('./RemoteWorkstationsSection', () => ({ RemoteWorkstationsSection: () => <p>Paired connections</p> }));
vi.mock('./simpleInterfaceClient', () => ({ simpleInterfaceClient: {} }));
vi.mock('../../remote/workstationConnection', () => ({ isWorkstationReadOnly: () => false }));

import { RemoteSimpleShell } from './RemoteSimpleShell';

const projectId = 'e789617d-032e-4412-87cc-99fbcf0953cb';
const windowId = '8b998041-3299-43c3-8cc0-49486998e6aa';
const threadId = '91addb76-f4d9-4671-8222-a24f57b29789';
const connection = { id: 'local-connection', projectId, threadId, status: 'connected' as const };

class FakeEvents {
  static instances: FakeEvents[] = [];
  listeners = new Map<string, (event: MessageEvent) => void>();
  onerror: (() => void) | null = null;
  constructor(_url: string) { FakeEvents.instances.push(this); }
  addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.set(name, listener as (event: MessageEvent) => void);
  }
  close() {}
  fire(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent); }
}

beforeEach(() => {
  FakeEvents.instances = [];
  vi.stubGlobal('EventSource', FakeEvents);
  api.capabilities.mockReset().mockResolvedValue({ version: 1, projectId, threadId, host: 'remote' });
  api.readInterface.mockReset().mockResolvedValue({ version: 1, projectId, revision: 'good',
    bundle: 'document.body.textContent = "Remote project";', diagnostic: null });
  api.conversation.mockReset().mockResolvedValue({ messages: [{ role: 'agent', text: 'Previous turn' }] });
  api.send.mockReset().mockResolvedValue({ eventId: 'event', status: 'queued' });
  api.stop.mockReset().mockResolvedValue({ stopped: true });
  api.eventsUrl.mockReset().mockResolvedValue('http://127.0.0.1:18000/events');
});

describe('independent remote Simple instrument', () => {
  test('has one remote-accented pill, scoped project, own conversation and action dispatch', async () => {
    render(<RemoteSimpleShell connection={connection} windowId={windowId} onClose={() => {}} />);
    expect(await screen.findByTitle('Remote generated interface')).toHaveAttribute('sandbox', 'allow-scripts');
    expect(screen.getAllByRole('region', { name: 'Remote conversation' })).toHaveLength(1);
    expect(screen.getByText(/Remote · e789617d · connected/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Expand remote conversation' }));
    expect(screen.getByText(/Previous turn/)).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message remote Interpreter' }), { target: { value: 'Continue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(connection.id, windowId, 'Continue', 'composer'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop remote turn' }));
    await waitFor(() => expect(api.stop).toHaveBeenCalledWith(connection.id));
  });

  test('rejects changed project identity and exposes a reconnect recovery action', async () => {
    api.capabilities.mockResolvedValue({ version: 1, projectId: 'different-project', threadId, host: 'remote' });
    render(<RemoteSimpleShell connection={connection} windowId={windowId} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Remote project identity changed');
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message remote Interpreter' })).toBeDisabled();
  });

  test('streams a hot-reloaded revision without substituting a second conversation', async () => {
    render(<RemoteSimpleShell connection={connection} windowId={windowId} onClose={() => {}} />);
    await screen.findByTitle('Remote generated interface');
    await waitFor(() => expect(FakeEvents.instances).toHaveLength(1));
    api.readInterface.mockResolvedValue({ version: 1, projectId, revision: 'next-good', bundle: 'next UI', diagnostic: null });
    await act(async () => { FakeEvents.instances[0].fire('interface', { version: 1, projectId, revision: 'next-good' }); });
    await waitFor(() => expect((screen.getByTitle('Remote generated interface') as HTMLIFrameElement).srcdoc).toContain('next UI'));
  });

  test('a remote canvas click closes the drawer without adding a message', async () => {
    render(<RemoteSimpleShell connection={connection} windowId={windowId} onClose={() => {}} />);
    const frame = await screen.findByTitle('Remote generated interface') as HTMLIFrameElement;
    fireEvent.click(screen.getByRole('button', { name: 'Expand remote conversation' }));
    expect(screen.getByLabelText('Remote conversation drawer')).toBeVisible();
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow,
      data: { type: 'interpreter-simple-interact' } }));
    expect(screen.queryByLabelText('Remote conversation drawer')).not.toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled();
  });
});
