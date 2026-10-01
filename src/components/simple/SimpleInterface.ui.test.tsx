import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const client = vi.hoisted(() => ({ projectRefresh: vi.fn(), projectAction: vi.fn(), projectDelivery: vi.fn() }));
vi.mock('./simpleInterfaceClient', () => ({ simpleInterfaceClient: client }));
vi.mock('../../remote/workstationConnection', () => ({ isWorkstationReadOnly: () => false }));

import { SimpleInterface, projectDocument } from './SimpleInterface';

const projectId = 'e789617d-032e-4412-87cc-99fbcf0953cb';
const windowId = '8b998041-3299-43c3-8cc0-49486998e6aa';
const snapshot = { projectPath: '/Documents/Interfaces/First', revision: 'good-one',
  bundle: 'document.getElementById("root").textContent = "Ready";', diagnostic: null };

beforeEach(() => {
  client.projectRefresh.mockReset().mockResolvedValue(snapshot);
  client.projectAction.mockReset().mockResolvedValue({ id: 'action-1', message: 'Choose' });
  client.projectDelivery.mockReset().mockResolvedValue({ success: true });
});

describe('sandboxed executable interface', () => {
  test('renders actual compiled JavaScript in a sandbox, not a declarative JSON page', async () => {
    render(<SimpleInterface projectId={projectId} windowId={windowId} />);
    const frame = await screen.findByTitle('Generated interface') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.srcdoc).toContain('Ready');
    expect(frame.srcdoc).toContain("connect-src 'none'");
    expect(frame.srcdoc).toContain('interpreter-simple-interact');
    expect(frame.srcdoc).toContain('.interpreter-file');
    expect(frame.srcdoc).toContain('color-scheme: dark');
    expect(client.projectRefresh).toHaveBeenCalledWith(windowId, projectId);
    expect(projectDocument('</script><script>alert(1)</script>')).not.toContain('</script><script>alert(1)');
  });

  test('persists a scoped action before sending to the primary conversation', async () => {
    const onMessage = vi.fn();
    render(<SimpleInterface projectId={projectId} windowId={windowId} onMessage={onMessage} />);
    const frame = await screen.findByTitle('Generated interface') as HTMLIFrameElement;
    await act(async () => {
      fireEvent(window, new MessageEvent('message', { source: frame.contentWindow,
        data: { type: 'interpreter-simple-action', message: 'Choose' } }));
    });
    await waitFor(() => expect(client.projectDelivery).toHaveBeenCalledWith({ windowId, projectId, id: 'action-1', status: 'dispatched' }));
    expect(client.projectAction).toHaveBeenCalledWith({ windowId, projectId, revision: 'good-one', message: 'Choose' });
    expect(onMessage).toHaveBeenCalledWith('Choose', 'project:action-1');
  });

  test('rejects messages from another frame and retains last-good on a failed edit', async () => {
    client.projectRefresh.mockResolvedValueOnce(snapshot).mockResolvedValue({ ...snapshot, diagnostic: 'Build failed' });
    render(<SimpleInterface projectId={projectId} windowId={windowId} onMessage={vi.fn()} />);
    const frame = await screen.findByTitle('Generated interface') as HTMLIFrameElement;
    fireEvent(window, new MessageEvent('message', { data: { type: 'interpreter-simple-action', message: 'Forged' } }));
    expect(client.projectAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('last working version remains visible'), { timeout: 2500 });
    expect(screen.getByTitle('Generated interface')).toBe(frame);
  });

  test('a click in the generated frame closes the attached drawer without submitting an action', async () => {
    const interact = vi.fn();
    window.addEventListener('simple-interface:interact', interact);
    render(<SimpleInterface projectId={projectId} windowId={windowId} onMessage={vi.fn()} />);
    const frame = await screen.findByTitle('Generated interface') as HTMLIFrameElement;
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow,
      data: { type: 'interpreter-simple-interact' } }));
    expect(interact).toHaveBeenCalledOnce();
    expect(client.projectAction).not.toHaveBeenCalled();
    window.removeEventListener('simple-interface:interact', interact);
  });
});
