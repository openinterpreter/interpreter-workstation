import type { Tab } from '../../shared/types/layout';
import { isAgentTab } from '../../shared/types/layout';

export function syncIdleAgentTabsToWindowWorkspace(params: {
  tabs: Record<string, Tab>;
  previousWorkspacePath: string | null;
  nextWorkspacePath: string | null;
  getMessageCount: (tabId: string) => number;
}): Record<string, Tab> | null {
  const nextWorkspacePath = params.nextWorkspacePath ?? undefined;
  let nextTabs: Record<string, Tab> | null = null;

  for (const [tabId, tab] of Object.entries(params.tabs)) {
    if (!isAgentTab(tab)) {
      continue;
    }

    const isIdleAgent = !tab.agent.session.codexThreadId && params.getMessageCount(tabId) === 0;
    const followsWindowWorkspace =
      !tab.agent.runtime.workspacePath
      || tab.agent.runtime.workspacePath === params.previousWorkspacePath;

    if (!isIdleAgent || !followsWindowWorkspace) {
      continue;
    }

    if (tab.agent.runtime.workspacePath === nextWorkspacePath) {
      continue;
    }

    if (!nextTabs) {
      nextTabs = { ...params.tabs };
    }

    nextTabs[tabId] = {
      ...tab,
      agent: {
        ...tab.agent,
        runtime: {
          ...tab.agent.runtime,
          workspacePath: nextWorkspacePath,
        },
      },
    };
  }

  return nextTabs;
}
