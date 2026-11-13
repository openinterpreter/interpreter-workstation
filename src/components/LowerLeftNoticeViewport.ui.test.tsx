import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const notices = vi.hoisted(() => ({ value: [] as Array<{
  id: string;
  createdAt: number;
  side: 'left' | 'right';
  content: React.ReactNode;
}> }));

vi.mock('../contexts/LowerLeftNoticesContext', () => ({
  useLowerLeftNotices: () => ({ notices: notices.value }),
}));

import { LowerLeftNoticeViewport } from './LowerLeftNoticeViewport';

describe('LowerLeftNoticeViewport', () => {
  it('aligns right-side notices against the actual right inset', () => {
    notices.value = [
      { id: 'left', createdAt: 1, side: 'left', content: <span>Left notice</span> },
      { id: 'right', createdAt: 2, side: 'right', content: <span>Right notice</span> },
    ];
    render(<LowerLeftNoticeViewport leftSidebarOpen={false} leftSidebarWidth={300} />);

    const rightViewport = screen.getByText('Right notice').parentElement?.parentElement;
    expect(rightViewport).toHaveClass('items-end');
    expect(rightViewport).toHaveStyle({ right: '16px', bottom: '16px' });

    const leftViewport = screen.getByText('Left notice').parentElement?.parentElement;
    expect(leftViewport).toHaveClass('items-start');
  });
});
