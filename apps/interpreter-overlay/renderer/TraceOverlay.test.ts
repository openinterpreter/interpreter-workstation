import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ReviewAction } from '../shared/ipc';
import { TraceOverlay } from './TraceOverlay';

const STYLES_PATH = new URL('./styles.css', import.meta.url);
const REVIEW_PANEL_PATH = new URL('./ReviewPanel.tsx', import.meta.url);

function action(overrides: Partial<ReviewAction> = {}): ReviewAction {
  return {
    id: 'action-1',
    type: 'click',
    description: 'Submit button',
    bounds: { x: 20, y: 30, width: 120, height: 40 },
    hasBounds: true,
    ...overrides,
  };
}

function renderTrace(actions: ReviewAction[]): string {
  return renderToStaticMarkup(React.createElement(TraceOverlay, {
    actions,
    viewport: { width: 800, height: 600 },
    primaryColor: '#2979ff',
  }));
}

describe('TraceOverlay', () => {
  test('does not label ordinary bounded trace actions', () => {
    expect(renderTrace([action()])).not.toContain('Submit button');
  });

  test('labels explicit drawing annotations', () => {
    expect(renderTrace([action({ showLabel: true })])).toContain('Submit button');
  });

  test('uses soft trace and review animations instead of hard blink timing', () => {
    const stylesSource = readFileSync(STYLES_PATH, 'utf8');
    const reviewPanelSource = readFileSync(REVIEW_PANEL_PATH, 'utf8');

    expect(stylesSource).toContain('traceRevealSoft');
    expect(stylesSource).toContain('traceExecutePulse');
    expect(stylesSource).toContain('overlaySoftPulse');
    expect(reviewPanelSource).toContain('overlaySoftPulse');

    expect(stylesSource).not.toContain('overlayHardBlink');
    expect(stylesSource).not.toContain('traceRevealBlink');
    expect(stylesSource).not.toContain('traceExecuteBlink');
    expect(stylesSource).not.toContain('steps(1');
    expect(reviewPanelSource).not.toContain('overlayHardBlink');
    expect(reviewPanelSource).not.toContain('steps(1');
  });
});
