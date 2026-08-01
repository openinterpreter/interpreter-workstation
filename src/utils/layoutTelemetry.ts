import type { TreeNode } from '../../shared/types/layout';
import { isPane } from '../../shared/types/layout';

export interface SplitViewTelemetrySnapshot {
  hasSplitView: boolean;
  paneCount: number;
  splitCount: number;
  horizontalSplitCount: number;
  verticalSplitCount: number;
  maxSplitDepth: number;
  rootDirection: 'horizontal' | 'vertical' | 'none';
  signature: string;
}

interface SplitViewWalkSummary {
  paneCount: number;
  splitCount: number;
  horizontalSplitCount: number;
  verticalSplitCount: number;
  maxSplitDepth: number;
}

function summarizeSplitTree(node: TreeNode, splitDepth: number): SplitViewWalkSummary {
  if (isPane(node)) {
    return {
      paneCount: 1,
      splitCount: 0,
      horizontalSplitCount: 0,
      verticalSplitCount: 0,
      maxSplitDepth: splitDepth,
    };
  }

  const nextDepth = splitDepth + 1;
  const left = summarizeSplitTree(node.children[0], nextDepth);
  const right = summarizeSplitTree(node.children[1], nextDepth);

  return {
    paneCount: left.paneCount + right.paneCount,
    splitCount: left.splitCount + right.splitCount + 1,
    horizontalSplitCount: left.horizontalSplitCount + right.horizontalSplitCount + (node.direction === 'horizontal' ? 1 : 0),
    verticalSplitCount: left.verticalSplitCount + right.verticalSplitCount + (node.direction === 'vertical' ? 1 : 0),
    maxSplitDepth: Math.max(nextDepth, left.maxSplitDepth, right.maxSplitDepth),
  };
}

export function summarizeSplitViewTelemetry(tree: TreeNode): SplitViewTelemetrySnapshot {
  const summary = summarizeSplitTree(tree, 0);
  const rootDirection = isPane(tree) ? 'none' : tree.direction;
  const snapshot = {
    hasSplitView: summary.splitCount > 0,
    paneCount: summary.paneCount,
    splitCount: summary.splitCount,
    horizontalSplitCount: summary.horizontalSplitCount,
    verticalSplitCount: summary.verticalSplitCount,
    maxSplitDepth: summary.maxSplitDepth,
    rootDirection,
  } satisfies Omit<SplitViewTelemetrySnapshot, 'signature'>;

  return {
    ...snapshot,
    signature: JSON.stringify(snapshot),
  };
}
