import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ReviewAction } from '../shared/ipc';
import type { PillMode } from '../shared/types';
import { Pill, type PillExecutionProgress } from './Pill';

const STYLES_PATH = new URL('./styles.css', import.meta.url);

function reviewAction(overrides: Partial<ReviewAction> = {}): ReviewAction {
  return {
    id: 'action-1',
    type: 'click',
    description: 'Submit button',
    bounds: { x: 20, y: 30, width: 120, height: 40 },
    hasBounds: true,
    ...overrides,
  };
}

function renderPill(params: {
  mode: PillMode;
  reviewAction?: ReviewAction | null;
  reviewActionCount?: number;
  executionProgress?: PillExecutionProgress | null;
}): string {
  return renderToStaticMarkup(React.createElement(Pill, {
    mode: params.mode,
    reviewAction: params.reviewAction ?? null,
    reviewActionCount: params.reviewActionCount ?? 0,
    executionProgress: params.executionProgress ?? null,
    onAccept: () => {},
    onReject: () => {},
  }));
}

describe('Pill review state', () => {
  test('shows Ctrl-to-approve with the pending action count and the Esc deny hint', () => {
    const markup = renderPill({
      mode: { kind: 'review' },
      reviewAction: reviewAction(),
      reviewActionCount: 3,
    });

    expect(markup).toContain('⌃ Ctrl');
    expect(markup).toContain('to approve');
    expect(markup).toContain('· 3 actions');
    expect(markup).toContain('Esc');
    expect(markup).toContain('to deny');
    expect(markup).toContain('data-overlay-review-accept="true"');
    expect(markup).toContain('pill-shell');
  });

  test('uses singular wording for a single pending action', () => {
    const markup = renderPill({
      mode: { kind: 'review' },
      reviewAction: reviewAction(),
      reviewActionCount: 1,
    });

    expect(markup).toContain('· 1 action');
    expect(markup).not.toContain('· 1 actions');
  });

  test('renders nothing in review mode without a review action', () => {
    expect(renderPill({ mode: { kind: 'review' }, reviewAction: null })).toBe('');
  });
});

describe('Pill executing state', () => {
  test('shows the current action label with plan progress', () => {
    const markup = renderPill({
      mode: { kind: 'loading', label: 'Typing...' },
      executionProgress: { label: 'Typing', current: 3, total: 15 },
    });

    expect(markup).toContain('Typing');
    expect(markup).toContain('3/15');
    expect(markup).toContain('pill-execution-status');
    expect(markup).toContain('pill-shell');
  });

  test('is display-only: the executing content adds no clickable controls', () => {
    const markup = renderPill({
      mode: { kind: 'loading', label: 'Clicking...' },
      executionProgress: { label: 'Clicking', current: 1, total: 2 },
    });

    expect(markup).not.toContain('<button');
  });

  test('renders nothing while loading without execution progress (thinking state)', () => {
    expect(renderPill({ mode: { kind: 'loading' } })).toBe('');
  });
});

describe('Pill hidden states', () => {
  test('renders nothing for hidden and recording pill modes', () => {
    expect(renderPill({ mode: { kind: 'hidden' } })).toBe('');
    expect(renderPill({ mode: { kind: 'recording' } })).toBe('');
  });
});

describe('Pill state morph', () => {
  test('review and executing states share the same morphing pill shell', () => {
    const review = renderPill({
      mode: { kind: 'review' },
      reviewAction: reviewAction(),
      reviewActionCount: 2,
    });
    const executing = renderPill({
      mode: { kind: 'loading', label: 'Typing...' },
      executionProgress: { label: 'Typing', current: 1, total: 2 },
    });

    expect(review).toContain('pill-shell pill-shell-review');
    expect(executing).toContain('pill-shell pill-shell-loading');
  });

  test('pill styling stays natural case with soft transitions', () => {
    const stylesSource = readFileSync(STYLES_PATH, 'utf8');
    const executionBlock = stylesSource.slice(
      stylesSource.indexOf('.pill-execution-status'),
      stylesSource.indexOf('.pill-execution-progress'),
    );

    expect(executionBlock.length).toBeGreaterThan(0);
    expect(executionBlock).not.toContain('text-transform');
    expect(executionBlock).toContain('overlaySoftPulse');
  });
});
