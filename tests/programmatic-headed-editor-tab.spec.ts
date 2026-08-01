import { test, expect } from './fixtures';

test('programmatic headed agents open as editor tabs instead of sidebar-pinned agents', async ({ page }) => {
  test.setTimeout(60000);

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  const response = await page.evaluate(async () => {
    return await (window as typeof window & {
      electron: {
        programmaticTasks: {
          startHeaded: (request: {
            message?: string;
            timeoutMs?: number;
          }) => Promise<{
            success: boolean;
            result?: {
              agentId?: string;
            };
            error?: string;
          }>;
        };
      };
    }).electron.programmaticTasks.startHeaded({
      message: 'Reply with only PROGRAMMATIC=1.',
      timeoutMs: 30000,
    });
  });

  expect(response.success).toBe(true);
  expect(response.result?.agentId).toBeTruthy();

  const agentId = response.result?.agentId as string;

  await page.waitForFunction(({ activeAgentId }) => {
    const layout = (window as any).__layoutContext?.getState?.() as {
      tree: { kind: 'pane' | 'split'; tabIds?: string[]; children?: unknown[] };
      sidebarPane?: { tabIds?: string[] } | null;
    };
    if (!layout?.tree) return false;

    const containsTab = (node: { kind: 'pane' | 'split'; tabIds?: string[]; children?: unknown[] } | null | undefined): boolean => {
      if (!node) return false;
      if (node.kind === 'pane') {
        return (node.tabIds ?? []).includes(activeAgentId);
      }
      return Array.isArray(node.children)
        && node.children.some((child) => containsTab(child as { kind: 'pane' | 'split'; tabIds?: string[]; children?: unknown[] }));
    };

    return containsTab(layout.tree);
  }, { activeAgentId: agentId }, { timeout: 10000 });

  const placement = await page.evaluate(({ activeAgentId }) => {
    const layout = (window as any).__layoutContext?.getState?.() as {
      tree?: { kind: 'pane' | 'split'; tabIds?: string[]; children?: unknown[] };
      sidebarPane?: { tabIds?: string[] } | null;
    };
    if (!layout?.tree) {
      return { inTree: false, inSidebar: false };
    }

    const containsTab = (node: { kind: 'pane' | 'split'; tabIds?: string[]; children?: unknown[] } | null | undefined): boolean => {
      if (!node) return false;
      if (node.kind === 'pane') {
        return (node.tabIds ?? []).includes(activeAgentId);
      }
      return Array.isArray(node.children)
        && node.children.some((child) => containsTab(child as { kind: 'pane' | 'split'; tabIds?: string[]; children?: unknown[] }));
    };

    return {
      inTree: containsTab(layout.tree),
      inSidebar: (layout.sidebarPane?.tabIds ?? []).includes(activeAgentId),
    };
  }, { activeAgentId: agentId });

  expect(placement.inTree).toBe(true);
  expect(placement.inSidebar).toBe(false);
});
