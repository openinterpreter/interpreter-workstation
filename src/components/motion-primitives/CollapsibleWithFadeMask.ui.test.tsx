import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ReactNode, HTMLAttributes } from 'react';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => children ?? null,
  motion: {
    div: ({
      children,
      animate: _animate,
      exit: _exit,
      initial: _initial,
      transition: _transition,
      ...props
    }: HTMLAttributes<HTMLDivElement> & {
      animate?: unknown;
      exit?: unknown;
      initial?: unknown;
      transition?: unknown;
    }) => <div {...props}>{children}</div>,
  },
  useReducedMotion: () => true,
}));

import { CollapsibleWithFadeMask } from './CollapsibleWithFadeMask';

describe('CollapsibleWithFadeMask', () => {
  test('renders children when open', () => {
    const { getByText } = render(
      <CollapsibleWithFadeMask isOpen>
        <p>panel body</p>
      </CollapsibleWithFadeMask>,
    );
    expect(getByText('panel body')).toBeInTheDocument();
  });

  test('renders nothing when closed and no previewHeight', () => {
    const { queryByText } = render(
      <CollapsibleWithFadeMask isOpen={false}>
        <p>hidden body</p>
      </CollapsibleWithFadeMask>,
    );
    expect(queryByText('hidden body')).not.toBeInTheDocument();
  });

  test('renders a clipped peek with fade mask when closed and previewHeight > 0', () => {
    const { getByText, container } = render(
      <CollapsibleWithFadeMask isOpen={false} previewHeight={120}>
        <p>peek body</p>
      </CollapsibleWithFadeMask>,
    );
    expect(getByText('peek body')).toBeInTheDocument();

    const outer = container.firstElementChild as HTMLElement | null;
    expect(outer).not.toBeNull();
    expect(outer?.style.maxHeight).toBe('120px');
    expect(outer?.style.overflow).toBe('hidden');

    // Fade mask div exists and has a linear-gradient background.
    const fade = outer?.querySelector('[aria-hidden="true"]') as HTMLElement | null;
    expect(fade).not.toBeNull();
    expect(fade?.style.background).toMatch(/linear-gradient/);
  });

  test('respects custom fadeToColor in the mask gradient', () => {
    const { container } = render(
      <CollapsibleWithFadeMask isOpen={false} previewHeight={80} fadeToColor="#ff00aa">
        <p>peek</p>
      </CollapsibleWithFadeMask>,
    );
    const fade = container.querySelector('[aria-hidden="true"]') as HTMLElement | null;
    // jsdom normalizes hex to rgb in computed `style.background`.
    expect(fade?.style.background).toMatch(/rgb\(\s*255,\s*0,\s*170\s*\)/);
  });
});
