import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  UsageBreakdownRow,
  clampUsagePercentage,
} from './PlanUsageBreakdown';

describe('clampUsagePercentage', () => {
  test('clamps invalid values into the visible progress range', () => {
    assert.equal(clampUsagePercentage(Number.NaN), 0);
    assert.equal(clampUsagePercentage(-14), 0);
    assert.equal(clampUsagePercentage(42.5), 42.5);
    assert.equal(clampUsagePercentage(140), 100);
  });
});

describe('UsageBreakdownRow', () => {
  test('renders detail text and caps the progress width at 100%', () => {
    const html = renderToStaticMarkup(
      React.createElement(UsageBreakdownRow, {
        label: 'gpt-5.4-mini',
        percentage: 140,
        summary: '100% of usage',
        detail: '2 requests / 1,500 tokens',
        accentColor: '#20639B',
        icon: React.createElement('span', { 'data-icon': 'provider' }, 'O'),
      }),
    );

    assert.match(html, /data-icon="provider"/);
    assert.match(html, /gpt-5\.4-mini/);
    assert.match(html, /2 requests \/ 1,500 tokens/);
    assert.match(html, /width:100%/);
  });

  test('renders an empty progress bar for negative values', () => {
    const html = renderToStaticMarkup(
      React.createElement(UsageBreakdownRow, {
        label: 'gpt-5.4-nano',
        percentage: -10,
        summary: '0%',
      }),
    );

    assert.match(html, /width:0%/);
  });
});
