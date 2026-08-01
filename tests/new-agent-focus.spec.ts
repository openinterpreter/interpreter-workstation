import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { clearLayoutState, setupPageLogging, waitForAppReady } from './helpers';
import { testId } from './selectors';

async function expectVisibleComposerFocused(page: Page) {
  await page.waitForFunction((composerTestId: string) => {
    const composer = document.querySelector<HTMLElement>(
      `[data-persistent-visible="true"] [data-testid="${composerTestId}"]`,
    );
    const active = document.activeElement as HTMLElement | null;

    if (!composer || !active) {
      return false;
    }

    return active === composer || composer.contains(active);
  }, testId('mainComposerInput'));
}

test('new blank agent tabs focus the composer', async ({ page }) => {
  await clearLayoutState(page);
  setupPageLogging(page, 'NewAgentFocus');
  await waitForAppReady(page);

  const newTabId = await page.evaluate(() => {
    const layout = (window as typeof window & {
      __layoutContext?: {
        openNewTab: () => string;
      };
    }).__layoutContext;

    if (!layout) {
      throw new Error('__layoutContext is not available');
    }

    return layout.openNewTab();
  });

  expect(newTabId).toBeTruthy();
  await expectVisibleComposerFocused(page);

  const blankAgentId = await page.evaluate(() => {
    const layout = (window as typeof window & {
      __layoutContext?: {
        openAgentTab: (agentTabId: string, label: string) => void;
        getState: () => {
          activePaneId: string | null;
          tree: any;
        };
      };
    }).__layoutContext;

    if (!layout) {
      throw new Error('__layoutContext is not available');
    }

    layout.openAgentTab(`test-agent-${Date.now()}`, 'Agent');

    const state = layout.getState();
    const getActiveTabId = (node: any): string | null => {
      if (node.kind === 'pane') {
        return node.id === state.activePaneId ? (node.activeTabId ?? null) : null;
      }

      return getActiveTabId(node.first) ?? getActiveTabId(node.second);
    };

    return getActiveTabId(state.tree);
  });

  expect(blankAgentId).toBeTruthy();
  await expectVisibleComposerFocused(page);
});
