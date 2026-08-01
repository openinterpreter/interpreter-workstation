import { describe, expect, test } from 'bun:test';
import type { TreeNode } from '../../shared/types/layout';
import { summarizeSplitViewTelemetry } from './layoutTelemetry';

describe('summarizeSplitViewTelemetry', () => {
  test('reports a single-pane layout without split view usage', () => {
    const tree: TreeNode = {
      kind: 'pane',
      id: 'pane-root',
      tabIds: ['tab-1'],
      activeTabId: 'tab-1',
    };

    expect(summarizeSplitViewTelemetry(tree)).toEqual({
      hasSplitView: false,
      paneCount: 1,
      splitCount: 0,
      horizontalSplitCount: 0,
      verticalSplitCount: 0,
      maxSplitDepth: 0,
      rootDirection: 'none',
      signature: JSON.stringify({
        hasSplitView: false,
        paneCount: 1,
        splitCount: 0,
        horizontalSplitCount: 0,
        verticalSplitCount: 0,
        maxSplitDepth: 0,
        rootDirection: 'none',
      }),
    });
  });

  test('counts nested horizontal and vertical splits', () => {
    const tree: TreeNode = {
      kind: 'split',
      id: 'split-root',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        {
          kind: 'pane',
          id: 'pane-left',
          tabIds: ['tab-left'],
          activeTabId: 'tab-left',
        },
        {
          kind: 'split',
          id: 'split-right',
          direction: 'vertical',
          ratio: 0.6,
          children: [
            {
              kind: 'pane',
              id: 'pane-top',
              tabIds: ['tab-top'],
              activeTabId: 'tab-top',
            },
            {
              kind: 'pane',
              id: 'pane-bottom',
              tabIds: ['tab-bottom'],
              activeTabId: 'tab-bottom',
            },
          ],
        },
      ],
    };

    expect(summarizeSplitViewTelemetry(tree)).toEqual({
      hasSplitView: true,
      paneCount: 3,
      splitCount: 2,
      horizontalSplitCount: 1,
      verticalSplitCount: 1,
      maxSplitDepth: 2,
      rootDirection: 'horizontal',
      signature: JSON.stringify({
        hasSplitView: true,
        paneCount: 3,
        splitCount: 2,
        horizontalSplitCount: 1,
        verticalSplitCount: 1,
        maxSplitDepth: 2,
        rootDirection: 'horizontal',
      }),
    });
  });
});
