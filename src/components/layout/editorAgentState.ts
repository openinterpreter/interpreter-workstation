import type { Pane, Tab } from '../../../shared/types/layout';

export function shouldShowEditorAgentEmptyState(params: {
  isSidebar?: boolean;
  hasConversationThread?: boolean;
  messageCount: number;
  isStreaming: boolean;
}): boolean {
  if (params.isSidebar) return false;
  if (params.hasConversationThread) return false;
  if (params.messageCount > 0) return false;
  if (params.isStreaming) return false;
  return true;
}

export function shouldReplaceEditorAgentTabWithTerminalProfile(params: {
  isSidebar?: boolean;
  hasConversationThread?: boolean;
  messageCount: number;
  isStreaming: boolean;
}): boolean {
  return shouldShowEditorAgentEmptyState(params);
}

export function shouldShowCenteredAgentLogo(params: {
  isSidebar?: boolean;
  hasConversationThread?: boolean;
  messageCount: number;
  isStreaming: boolean;
}): boolean {
  if (params.isSidebar) {
    return params.messageCount === 0;
  }

  if (shouldShowEditorAgentEmptyState(params)) {
    return false;
  }

  return params.messageCount === 0;
}

export function getEditorEmptyStateJustifyContent(showEditorEmptyState: boolean): 'safe center' | undefined {
  if (!showEditorEmptyState) {
    return undefined;
  }

  // "safe center" keeps the current centered empty-state layout, but
  // falls back to start alignment when content is taller than the viewport.
  return 'safe center';
}

export function shouldHideSingleAgentTabBar(params: {
  pane: Pane;
  tabs: Record<string, Tab>;
  isSinglePane: boolean;
}): boolean {
  if (!params.isSinglePane || params.pane.tabIds.length !== 1) {
    return false;
  }

  const onlyTabId = params.pane.tabIds[0];
  const onlyTab = params.tabs[onlyTabId];
  return onlyTab?.type === 'agent';
}
