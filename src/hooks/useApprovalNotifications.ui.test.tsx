import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ created: null as null | ((event: any) => void), show: vi.fn(), web: vi.fn(), toast: vi.fn() }));
vi.mock('@/ipc', () => ({ approvals: { onCreated: (callback: (event: any) => void) => { state.created = callback; return () => { state.created = null; }; } }, desktopNotification: { show: state.show, onClicked: () => () => {} } }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast: state.toast }) }));
import { useApprovalNotifications } from './useApprovalNotifications';

function Surface() {
  useApprovalNotifications();
  return <div data-simple-shell="true" data-simple-thread-id="same-thread">Composer and approvals</div>;
}

function approveEvent(id: string) {
  return { approval: { id, toolName: 'Google list-apps', serverId: 'google', owner: { identity: { threadId: 'same-thread' } }, context: { threadId: 'same-thread' }, isSimpleApproval: true } };
}

describe('Simple approval notification focus rules', () => {
  beforeEach(() => {
    state.show.mockReset().mockResolvedValue(undefined);
    state.web.mockReset(); state.toast.mockReset();
    vi.stubGlobal('Notification', class { static permission = 'granted'; constructor(title: string) { state.web(title); } });
  });

  it('keeps an in-app approval without redundant OS notification while focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const rendered = render(<Surface />);
    expect(screen.getByText('Composer and approvals')).toBeVisible();
    state.created?.(approveEvent('approval-focused'));
    expect(state.show).not.toHaveBeenCalled();
    expect(state.web).not.toHaveBeenCalled();
    rendered.unmount();
    expect(state.created).toBeNull();
  });

  it('notifies while unfocused and does not notify again for the same ID', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render(<Surface />);
    state.created?.(approveEvent('approval-background'));
    state.created?.(approveEvent('approval-background'));
    expect(state.show.mock.calls.length + state.web.mock.calls.length).toBe(1);
  });
});
