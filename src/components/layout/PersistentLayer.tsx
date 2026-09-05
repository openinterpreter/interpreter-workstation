/**
 * PersistentLayer Component
 *
 * Renders all stateful tab components (terminal, browser)
 * in a flat list of absolutely positioned divs at the root.
 * Each div is sized/positioned to match its pane's bounding rect.
 *
 * Active tab: visibility: visible. Inactive: visibility: hidden.
 * This keeps audio playing, preserves layout, and prevents unmounting.
 *
 * Cross-pane tab moves never unmount because the React key (tab.id)
 * doesn't change.
 *
 * Positioning uses direct DOM manipulation (not React state) so that
 * overlays stay perfectly in sync with sidebar animations that run
 * via requestAnimationFrame.
 *
 * During drag operations, all overlays become pointer-events: none
 * so drop zones underneath (e.g., ChatDropZone in sidebar) can
 * receive drag events.
 */

import React, { useMemo, useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import type { Tab, Pane, TreeNode } from '../../../shared/types/layout';
import { isAgentTab, STATEFUL_TAB_TYPES } from '../../../shared/types/layout';
import { getAllPanes } from '../../utils/treeOperations';
import { useLayout, useLayoutActions } from '../../hooks/useLayout';
import { BrowserView } from '../BrowserView';
import { TerminalView } from '../../../agent/components/TerminalView';
import { AgentThread } from '../../../agent/components/AgentThread';
import { RemoteThreadViewer } from '../../../agent/components/RemoteThreadViewer';
import { AgentMetadataProvider } from '../../../agent/contexts/AgentMetadataContext';
import { AgentErrorProvider } from '../../../agent/contexts/AgentErrorContext';
import { ComposerArea } from '../../../agent/components/ComposerArea';
import { AgentLogo } from '../../../agent/components/AgentLogo';
import { PlanChecklistCard } from '../../../agent/components/PlanChecklistCard';
import { SettingsPopover } from '../../../agent/components/composer/SettingsPopover';
import { useTtsPlayback } from '../../../agent/hooks/useTtsPlayback';
import { AgentEmptyState } from './AgentEmptyState';
import { ApprovalsContainer } from './new-tab/ApprovalsContainer';
import { ConversationHistoryPanel } from '../ConversationHistoryPanel';
import { ProgressiveBlurOverlay } from '../ui/ProgressiveBlurOverlay';
import { agentTabs as agentTabsIpc } from '@/ipc';
import { isMarketingDemoMode } from '../../demo/marketingDemo';
import {
  getRemoteWorkstationEndpoint,
  isRemoteWorkstationMode,
  REMOTE_WORKSTATION_THREAD_MARKER,
} from '../../remote/remoteWorkstation';
import { isWorkstationReadOnly } from '../../remote/workstationConnection';
import {
  getEditorEmptyStateJustifyContent,
  shouldShowCenteredAgentLogo,
  shouldShowEditorAgentEmptyState,
} from './editorAgentState';
import { TabContent } from './TabContent';
import { RemoteWorkstationHome } from './RemoteWorkstationHome';
import type { AgentModelConfig } from '../../../shared/types/model';
import type { PlanChecklistState } from '../../hooks/use-chat';
import { EDITOR_AGENT_SURFACE_ID, PERSISTENT_LAYER_ID } from '../../../shared/element-ids';
import { useSettledReveal } from './useSettledReveal';
import type {
  AgentTabSendRequestedEvent,
  AgentTabStopRequestedEvent,
} from '../../../electron/ipc/registry';

interface PaneRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * For each stateful tab, find which pane it's in and whether it's the active tab in that pane.
 */
function getStatefulTabPlacements(
  tabs: Record<string, Tab>,
  tree: TreeNode,
  sidebarPane: Pane | null,
): Array<{ tab: Tab; paneId: string; isActive: boolean }> {
  const placements: Array<{ tab: Tab; paneId: string; isActive: boolean }> = [];

  // Collect from main tree panes
  const allPanes = getAllPanes(tree);
  for (const pane of allPanes) {
    for (const tabId of pane.tabIds) {
      const tab = tabs[tabId];
      if (tab && STATEFUL_TAB_TYPES.has(tab.type)) {
        placements.push({
          tab,
          paneId: pane.id,
          isActive: pane.activeTabId === tabId,
        });
      }
    }
  }

  // Collect from sidebar pane
  if (sidebarPane) {
    for (const tabId of sidebarPane.tabIds) {
      const tab = tabs[tabId];
      if (tab && STATEFUL_TAB_TYPES.has(tab.type)) {
        placements.push({
          tab,
          paneId: sidebarPane.id,
          isActive: sidebarPane.activeTabId === tabId,
        });
      }
    }
  }

  return placements;
}

// Inset overlay divs by this many px on each side so they never cover
// the 4px resize handles between adjacent panes.
const OVERLAY_INSET = 0;

const RenderStatefulTab = React.memo(function RenderStatefulTab({ tab, isVisible, isSidebar }: { tab: Tab; paneId: string; isVisible: boolean; isSidebar: boolean }) {
  const { closeTab, updateSidebarTabLabel, updateTab } = useLayoutActions();
  const readOnlyWorkstation = isWorkstationReadOnly();

  // Stable callbacks for agent event dispatching — must be declared before early returns
  // to satisfy React's rules of hooks (no conditional hook calls).
  const handleLabelUpdate = useCallback((agentId: string, label: string, isRunning: boolean) => {
    window.dispatchEvent(new CustomEvent('persistent-layer:label-update', {
      detail: { agentId, label, isRunning }
    }));
  }, []);
  const handleMessageCountChange = useCallback((agentId: string, count: number) => {
    window.dispatchEvent(new CustomEvent('persistent-layer:message-count-change', {
      detail: { agentId, count }
    }));
  }, []);
  const handleCodexThreadIdAssigned = useCallback((agentId: string, threadId: string) => {
    updateTab(agentId, (previousTab) => {
      if (!isAgentTab(previousTab)) return previousTab;
      if (previousTab.agent.session.conversationId === threadId) {
        return previousTab;
      }
      void agentTabsIpc.registerThread({
        agentId,
        threadId,
        callerToken: previousTab.agent.session.callerToken,
        workspacePath: previousTab.agent.runtime.workspacePath,
        modelConfig: previousTab.agent.runtime.modelConfig,
        toolProfileId: previousTab.agent.runtime.modelConfig.profileId,
      });
      return {
        ...previousTab,
        agent: {
          ...previousTab.agent,
          session: {
            ...previousTab.agent.session,
            codexThreadId: threadId,
          },
          runtime: {
            ...previousTab.agent.runtime,
            didSwitchRuntimeDuringConversation: undefined,
          },
        },
      };
    });
    window.dispatchEvent(new CustomEvent('persistent-layer:thread-id-assigned', {
      detail: { agentId, threadId }
    }));
  }, [updateTab]);
  const handleModelConfigUpdate = useCallback((agentId: string, modelConfig: AgentModelConfig) => {
    window.dispatchEvent(new CustomEvent('persistent-layer:model-config-update', {
      detail: { agentId, modelConfig }
    }));
  }, []);
  const handleStartupConsumed = useCallback((agentId: string, startupId: string) => {
    updateTab(agentId, (previousTab) => {
      if (!isAgentTab(previousTab) || previousTab.agent.session.startupId !== startupId) {
        return previousTab;
      }
      return {
        ...previousTab,
        agent: {
          ...previousTab.agent,
          session: {
            ...previousTab.agent.session,
            startupId: undefined,
          },
        },
      };
    });
  }, [updateTab]);

  if (tab.type === 'browser' && tab.url) {
    return (
      <BrowserView
        key={tab.id}
        tabId={tab.id}
        initialUrl={tab.url}
        browserId={tab.browserId}
        faviconUrl={tab.faviconUrl}
        isVisible={isVisible}
      />
    );
  }

  if (tab.type === 'terminal') {
    const tc = tab.modelConfig?.provider === 'terminal' ? tab.modelConfig.providerConfig as import('../../../shared/types/model').TerminalConfig | undefined : undefined;
    return (
      <TerminalView
        tabId={tab.id}
        isVisible={isVisible}
        cwd={tab.cwd}
        terminalAgent={tab.terminalAgent}
        command={tc?.command}
        profileId={tab.modelConfig?.profileId}
        richInput={tc?.richInput}
        hideInput={tc?.hideInput}
        inputMarker={tc?.inputMarker}
        titleMarker={tc?.titleMarker}
        onClose={() => closeTab(tab.id)}
        onTitleChange={(title) => updateSidebarTabLabel(tab.id, title)}
      />
    );
  }

  if (isAgentTab(tab)) {
    const remoteWorkstationMode = isRemoteWorkstationMode();
    if (remoteWorkstationMode && tab.agent.session.codexThreadId === REMOTE_WORKSTATION_THREAD_MARKER) {
      const endpoint = getRemoteWorkstationEndpoint();
      return endpoint ? (
        <RemoteThreadViewer
          endpoint={endpoint}
          pageSize={10}
          embedded
          onTitleChange={(title) => {
            if (title === tab.label) return;
            updateTab(tab.id, (previousTab) => ({ ...previousTab, label: title }));
          }}
        />
      ) : null;
    }
    if (remoteWorkstationMode) {
      return (
        <RemoteWorkstationHome
          onOpenConversation={(conversation) => {
            updateTab(tab.id, (previousTab) => {
              if (!isAgentTab(previousTab)) return previousTab;
              return {
                ...previousTab,
                label: conversation.title,
                agent: {
                  ...previousTab.agent,
                  session: {
                    ...previousTab.agent.session,
                    conversationId: REMOTE_WORKSTATION_THREAD_MARKER,
                    codexThreadId: REMOTE_WORKSTATION_THREAD_MARKER,
                  },
                },
              };
            });
          }}
        />
      );
    }

    // console.log('[PersistentLayer] Rendering agent tab', {
    //   tabId: tab.id,
    //   requestId: tab.agent.session.requestId,
    //   initialMessage: tab.agent.session.initialMessage?.slice(0, 50),
    //   hasModelConfig: !!tab.agent.runtime.modelConfig,
    //   morphTransition: tab.morphTransition,
    // });

    const agentThread = (
      <AgentThread
        agentId={tab.id}
        conversationId={tab.agent.session.conversationId}
        codexThreadId={tab.agent.session.codexThreadId}
        callerToken={tab.agent.session.callerToken}
        agentChannel={tab.agent.session.agentChannel}
        isVisible={isVisible}
        onLabelUpdate={handleLabelUpdate}
        onMessageCountChange={handleMessageCountChange}
        onCodexThreadIdAssigned={handleCodexThreadIdAssigned}
        workspacePath={tab.agent.runtime.workspacePath}
        modelConfig={tab.agent.runtime.modelConfig}
        didSwitchRuntimeDuringConversation={tab.agent.runtime.didSwitchRuntimeDuringConversation}
        onModelConfigUpdate={handleModelConfigUpdate}
        startupId={tab.agent.session.startupId}
        requestId={tab.agent.session.requestId}
        initialMessage={tab.agent.session.initialMessage}
        systemPrompt={tab.agent.runtime.systemPrompt}
        isEditorPane={!isSidebar}
        onStartupConsumed={handleStartupConsumed}
        readOnly={readOnlyWorkstation}
      />
    );

    // Same component renders in both sidebar and editor pane.
    // The thread + logo + composer are always bundled together so
    // state is fully preserved when dragging between areas.
    return (
      <AgentMetadataProvider agent={{
        id: tab.id,
        createdAt: tab.createdAt ?? Date.now(),
        agent: tab.agent,
      }}>
        <AgentErrorProvider>
          <EditorAgentPane
            agentId={tab.id}
            modelConfig={tab.agent.runtime.modelConfig}
            workspacePath={tab.agent.runtime.workspacePath}
            morphTransition={tab.morphTransition}
            isSidebar={isSidebar}
            isVisible={isVisible}
            hasConversationThread={Boolean(tab.agent.session.codexThreadId)}
            autoStartVoiceMode={tab.autoStartVoiceMode}
          >
            {agentThread}
          </EditorAgentPane>
        </AgentErrorProvider>
      </AgentMetadataProvider>
    );
  }

  // All other stateful tabs (file, email, chat, settings) — render via TabContent
  return <TabContent activeTab={tab} />;
});

/**
 * Full editor pane wrapper for agent tabs (not sidebar).
 * Renders: logo overlay (when empty) + thread (children) + composer at bottom.
 * Tracks streaming/message state via events.
 */
const EditorAgentPane = React.memo(function EditorAgentPane({ agentId, modelConfig, workspacePath, morphTransition, isSidebar, isVisible, hasConversationThread, autoStartVoiceMode, children }: {
  agentId: string;
  modelConfig: AgentModelConfig;
  workspacePath?: string;
  morphTransition?: boolean;
  isSidebar?: boolean;
  isVisible: boolean;
  hasConversationThread?: boolean;
  autoStartVoiceMode?: boolean;
  children: React.ReactNode;
}) {
  const { updateTab } = useLayoutActions();
  const marketingDemoMode = isMarketingDemoMode();
  const readOnlyWorkstation = isWorkstationReadOnly();
  const [isStreaming, setIsStreaming] = useState(false);
  const [messageCount, setMessageCount] = useState(morphTransition ? 1 : 0);
  const [fadeIn, setFadeIn] = useState(morphTransition ? true : false);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<import('../../../agent/components/composer/BaseTiptapComposer').BaseTiptapComposerRef>(null);
  const composerWrapperRef = useRef<HTMLDivElement>(null);
  const settledRevealRef = useRef<HTMLDivElement>(null);
  const flipFirstRectRef = useRef<DOMRect | null>(null);
  const prevShowEmptyRef = useRef(true);
  const [showFirstStartupNudge, setShowFirstStartupNudge] = useState(false);
  const [composerShellHeight, setComposerShellHeight] = useState(
    isSidebar ? 108 : 116,
  );
  const [suggestionOverlayHeight, setSuggestionOverlayHeight] = useState(0);
  const [suggestionOverlayOpacity, setSuggestionOverlayOpacity] = useState(1);
  const [planChecklist, setPlanChecklist] = useState<PlanChecklistState | null>(null);
  const [dismissedPlanKey, setDismissedPlanKey] = useState<string | null>(null);
  const [conversationHistoryLoadState, setConversationHistoryLoadState] = useState<{
    key: string | null;
    loading: boolean;
  }>({ key: null, loading: true });

  const getComposerFlipElement = useCallback((): HTMLElement | null => {
    const wrapper = composerWrapperRef.current;
    if (!wrapper) return null;
    return wrapper.querySelector<HTMLElement>('[data-file-drop-surface="composer"]') ?? wrapper;
  }, []);

  useEffect(() => {
    const handler = () => setShowFirstStartupNudge(true);
    window.addEventListener('onboarding:first-startup-nudge', handler);
    return () => window.removeEventListener('onboarding:first-startup-nudge', handler);
  }, []);

  useEffect(() => {
    if (!morphTransition) return;
    const id1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setFadeIn(false);
      });
    });
    return () => {
      cancelAnimationFrame(id1);
    };
  }, [morphTransition]);

  useEffect(() => {
    const handleLabel = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.agentId === agentId) {
        setIsStreaming(detail.isRunning);
      }
    };
    const handleCount = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.agentId === agentId) {
        setMessageCount(prev => {
          // Capture composer position BEFORE state change for FLIP animation
          if (prev === 0 && detail.count > 0) {
            const flipEl = getComposerFlipElement();
            if (flipEl) {
              flipFirstRectRef.current = flipEl.getBoundingClientRect();
            }
          }
          return detail.count;
        });
      }
    };
    const handlePlan = (e: Event) => {
      const detail = (e as CustomEvent<{
        agentId: string;
        planChecklist: PlanChecklistState | null;
      }>).detail;
      if (detail.agentId === agentId) {
        setPlanChecklist(detail.planChecklist);
      }
    };

    window.addEventListener('persistent-layer:label-update', handleLabel);
    window.addEventListener('persistent-layer:message-count-change', handleCount);
    window.addEventListener('persistent-layer:plan-update', handlePlan);
    return () => {
      window.removeEventListener('persistent-layer:label-update', handleLabel);
      window.removeEventListener('persistent-layer:message-count-change', handleCount);
      window.removeEventListener('persistent-layer:plan-update', handlePlan);
    };
  }, [agentId, getComposerFlipElement]);

  const handleSend = useCallback((
    text: string,
    options?: {
      workspacePath?: string | null;
      attachments?: import('../../lib/codex/api-types').StreamImageAttachment[];
      messageSource?: import('../../../shared/types/messageSendSource').MessageSendSource | null;
    },
  ) => {
    window.dispatchEvent(new CustomEvent('agent-runtime:send', {
      detail: {
        tabId: agentId,
        text,
        workspacePath: options?.workspacePath,
        attachments: options?.attachments,
        messageSource: options?.messageSource,
      }
    }));
  }, [agentId]);

  useEffect(() => {
    const unsubscribe = agentTabsIpc.onSendRequested((event: AgentTabSendRequestedEvent) => {
      if (event.agentId !== agentId) {
        return;
      }
      handleSend(event.message, {
        workspacePath: event.workspacePath,
        messageSource: event.messageSource,
      });
    });
    return unsubscribe;
  }, [agentId, handleSend]);

  useEffect(() => {
    const unsubscribe = agentTabsIpc.onStopRequested((event: AgentTabStopRequestedEvent) => {
      if (event.agentId !== agentId) {
        return;
      }
      window.dispatchEvent(new CustomEvent('agent-runtime:cancel', {
        detail: {
          tabId: agentId,
        },
      }));
    });
    return unsubscribe;
  }, [agentId]);

  const handleOpenConversation = useCallback((conversation: import('../ConversationHistoryPanel').ConversationPreview) => {
    const threadId = conversation.threadId;
    if (!threadId) return;
    updateTab(agentId, (previousTab) => {
      if (!isAgentTab(previousTab)) return previousTab;
      return {
        ...previousTab,
        label: conversation.title,
        agent: {
          ...previousTab.agent,
          session: {
            ...previousTab.agent.session,
            conversationId: conversation.conversationId,
            codexThreadId: threadId,
          },
          runtime: {
            ...previousTab.agent.runtime,
            workspacePath: conversation.workspacePath || previousTab.agent.runtime.workspacePath,
          },
        },
      };
    });
  }, [agentId, updateTab]);

  const settingsContent = modelConfig ? (
    <SettingsPopover
      agentId={agentId}
      modelConfig={modelConfig}
      messageCount={messageCount}
      hasCodexThread={Boolean(hasConversationThread)}
      isStreaming={isStreaming}
      workspacePath={workspacePath}
      isSidebar={isSidebar}
    />
  ) : undefined;

  const showEditorEmptyState = shouldShowEditorAgentEmptyState({
    isSidebar,
    hasConversationThread,
    messageCount,
    isStreaming,
  });
  const showCenteredAgentLogo = !readOnlyWorkstation && shouldShowCenteredAgentLogo({
    isSidebar,
    hasConversationThread,
    messageCount,
    isStreaming,
  });
  const shouldWaitForSettledReveal = Boolean(!isSidebar && isVisible && showEditorEmptyState);
  const conversationHistoryLoadKey = shouldWaitForSettledReveal && !marketingDemoMode
    ? agentId
    : null;
  const isConversationHistoryReady = conversationHistoryLoadKey === null
    || (conversationHistoryLoadState.key === conversationHistoryLoadKey && !conversationHistoryLoadState.loading);
  const isSettledRevealReady = useSettledReveal({
    enabled: shouldWaitForSettledReveal,
    targetRef: settledRevealRef,
    blockersReady: isConversationHistoryReady,
  });
  const hideUntilReady = fadeIn || (shouldWaitForSettledReveal && !isSettledRevealReady);

  const handleConversationHistoryLoadingChange = useCallback((loading: boolean) => {
    if (!conversationHistoryLoadKey) return;
    setConversationHistoryLoadState((current) => {
      if (
        loading
        && current.key === conversationHistoryLoadKey
        && !current.loading
      ) {
        return current;
      }

      return {
        key: conversationHistoryLoadKey,
        loading,
      };
    });
  }, [conversationHistoryLoadKey]);

  // FLIP animation: when composer moves from centered (in-flow) to bottom (absolute)
  useLayoutEffect(() => {
    const wasEmpty = prevShowEmptyRef.current;
    prevShowEmptyRef.current = showEditorEmptyState;

    const flipEl = getComposerFlipElement();
    if (wasEmpty && !showEditorEmptyState && flipEl && flipFirstRectRef.current) {
      const first = flipFirstRectRef.current;
      const last = flipEl.getBoundingClientRect();
      flipFirstRectRef.current = null;

      const deltaY = first.top - last.top;

      const el = flipEl;
      el.style.transform = `translateY(${deltaY}px)`;
      el.style.transition = 'none';

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.style.transition = 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)';
          el.style.transform = 'translate(0, 0)';

          const cleanup = () => {
            el.style.transition = '';
            el.style.transform = '';
            el.removeEventListener('transitionend', cleanup);
          };
          el.addEventListener('transitionend', cleanup);
        });
      });
    }
  }, [getComposerFlipElement, showEditorEmptyState]);

  useLayoutEffect(() => {
    const shell = composerShellRef.current;
    if (!shell) return;

    const updateHeight = () => {
      const measuredHeight = Math.ceil(shell.getBoundingClientRect().height);
      if (measuredHeight > 0) {
        setComposerShellHeight(measuredHeight);
      }
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const allowsComposerShadowOverflow = !isSidebar;
  const planKey = planChecklist?.turnId ?? null;
  const visiblePlan = planChecklist && planKey !== dismissedPlanKey
    ? planChecklist
    : null;
  const conversationBottomGap = isSidebar ? 28 : 48;
  const planConversationGap = visiblePlan ? (isSidebar ? 10 : 16) : 0;
  const composerClearance = readOnlyWorkstation
    ? '0px'
    : `${composerShellHeight + conversationBottomGap + planConversationGap}px`;
  const composerBlurHeight = `${
    composerShellHeight + (isSidebar ? 22 : 28) + planConversationGap
  }px`;
  const threadContent = React.isValidElement<{
    suggestionOverlayHeight?: number;
    onSuggestionOverlayOpacityChange?: (opacity: number) => void;
  }>(children)
    ? React.cloneElement(children, {
        suggestionOverlayHeight,
        onSuggestionOverlayOpacityChange: setSuggestionOverlayOpacity,
      })
    : children;

  return (
    <div
      data-testid={isSidebar ? undefined : EDITOR_AGENT_SURFACE_ID(agentId)}
      data-agent-surface={agentId}
      ref={settledRevealRef}
      className={`relative flex h-full w-full min-h-0 flex-col transition-opacity duration-120 ease-out ${allowsComposerShadowOverflow ? 'overflow-x-hidden overflow-y-visible' : 'overflow-hidden'} ${hideUntilReady ? 'opacity-0' : 'opacity-100'}`}
      style={{
        '--thread-max-width': '56rem',
        '--thread-scroll-bottom-clearance': composerClearance,
        pointerEvents: hideUntilReady ? 'none' : undefined,
      }}
    >
      <div
        className={`relative flex-1 min-h-0 flex flex-col ${showEditorEmptyState ? 'overflow-auto' : (allowsComposerShadowOverflow ? 'overflow-x-hidden overflow-y-visible' : 'overflow-hidden')}`}
        style={{
          justifyContent: getEditorEmptyStateJustifyContent(showEditorEmptyState),
        }}
      >
        <AgentLogo
          visible={showCenteredAgentLogo}
          centerY={isSidebar ? 'calc(50vh - var(--persistent-pane-top) - 1%)' : undefined}
        />

        {/* Thread — always mounted, display toggled */}
        <div
          className={showEditorEmptyState ? '' : 'flex-1 min-h-0'}
          style={{
            display: showEditorEmptyState ? 'none' : 'block',
            pointerEvents: showEditorEmptyState ? 'none' : 'auto',
          }}
        >
          {threadContent}
        </div>

        {/* Empty state content (greeting + cards) — always mounted, display toggled */}
        {!readOnlyWorkstation ? <div
          className="pointer-events-auto"
          data-empty-agent-surface={showEditorEmptyState ? 'true' : undefined}
          style={showEditorEmptyState ? { display: 'block' } : { display: 'none' }}
        >
          <AgentEmptyState
            agentId={agentId}
            onAgentSend={handleSend}
            composerRef={composerRef}
          />
        </div> : null}

        {/* Blur overlay — only when messages visible */}
        {!readOnlyWorkstation && !showEditorEmptyState && !isSidebar ? (
          <ProgressiveBlurOverlay
            direction="bottom"
            tintOpacity={0.94}
            className="inset-x-0 bottom-0 z-10"
            style={{ height: composerBlurHeight }}
          />
        ) : null}

        {/* COMPOSER — always at this tree position (keyed for stability).
            In empty state: in-flow, centered.
            With messages: absolute bottom. */}
        {!readOnlyWorkstation ? <div
          key="composer-shell"
          ref={composerWrapperRef}
          className={showEditorEmptyState
            ? 'relative z-20 new-tab-composer-wrapper mx-auto mt-5 w-full max-w-[660px]'
            : 'pointer-events-none absolute inset-x-0 bottom-0 z-20'}
        >
          <div ref={composerShellRef} className={showEditorEmptyState ? '' : 'pointer-events-auto'}>
            <ApprovalsContainer
              ownerAgentId={agentId}
              className="mx-auto mb-2 w-full max-w-[48rem] px-2 sm:px-[var(--unit-padding-medium)]"
            />
            <ComposerArea
              ref={composerRef}
              isTerminal={false}
              agentId={agentId}
              workspacePath={workspacePath}
              isStreaming={isStreaming}
              autoStartVoiceMode={autoStartVoiceMode}
              messageCount={messageCount}
              onAgentSend={handleSend}
              topAccessory={!showEditorEmptyState && visiblePlan && planKey ? (
                <PlanChecklistCard
                  plan={visiblePlan}
                  isRunning={isStreaming}
                  onDismiss={() => setDismissedPlanKey(planKey)}
                />
              ) : null}
              onWorkspacePathChange={(nextWorkspacePath) => {
                updateTab(agentId, (previousTab) => {
                  if (!isAgentTab(previousTab)) return previousTab;
                  return {
                    ...previousTab,
                    agent: {
                      ...previousTab.agent,
                      runtime: {
                        ...previousTab.agent.runtime,
                        workspacePath: nextWorkspacePath,
                      },
                    },
                  };
                });
              }}
              settingsContent={settingsContent}
              showSuggestionChips={!showEditorEmptyState && !visiblePlan}
              onSuggestionOverlayHeightChange={setSuggestionOverlayHeight}
              suggestionOverlayOpacity={suggestionOverlayOpacity}
              showQueuedMessages={!showEditorEmptyState}
              showResizeHandle={!showEditorEmptyState}
              showFirstStartupNudge={showEditorEmptyState && showFirstStartupNudge}
              noBorderPadding={showEditorEmptyState}
              morphTarget={Boolean(morphTransition && !showEditorEmptyState)}
            />
          </div>
        </div> : null}

        {/* Conversation history — only visible in empty state, below composer */}
        {showEditorEmptyState && !marketingDemoMode ? (
          <div className={`mx-auto w-full max-w-[520px] px-6 pb-8 ${readOnlyWorkstation ? 'pt-8 sm:pt-10' : 'pt-12 sm:pt-14'}`}>
            <ConversationHistoryPanel
              fillHeight={false}
              onOpenConversation={handleOpenConversation}
              onLoadingChange={handleConversationHistoryLoadingChange}
              readOnly={readOnlyWorkstation}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function PersistentLayer() {
  "use no memo";

  useTtsPlayback();

  const { state, paneRects: contextPaneRects } = useLayout();
  const { setActivePaneId, setActiveTabRegion } = useLayoutActions();
  const { tabs, tree, sidebarPane } = state;
  const paneRects = contextPaneRects as Record<string, PaneRect>;

  const placements = useMemo(
    () => getStatefulTabPlacements(tabs, tree, sidebarPane),
    [tabs, tree, sidebarPane],
  );

  // Store refs to each tab container div for imperative DOM updates
  const tabRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());

  // Track whether a drag operation is in progress
  const [isDragging, setIsDragging] = useState(false);
  const dragCountRef = useRef(0);

  // Resize snapshot overlay
  const [resizePhase, setResizePhase] = useState<'idle' | 'active' | 'crossfade' | 'sharpening'>('idle');
  const snapshotsRef = useRef<Map<string, { dataUrl: string; width: number; height: number }>>(new Map());
  const resizeCountRef = useRef(0);
  const phaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const snapshotImgRefs = useRef<Map<string, HTMLImageElement>>(new Map());
  const dropSnapshotPendingRef = useRef(false);

  // Shared snapshot capture function
  const captureSnapshots = useCallback(() => {
    const newSnapshots = new Map<string, { dataUrl: string; width: number; height: number }>();
    for (const [tabId, el] of tabRefsMap.current.entries()) {
      if (el.style.display === 'none' || el.style.visibility === 'hidden') continue;
      const canvases = el.querySelectorAll('canvas');
      if (canvases.length === 0) continue;
      try {
        const composite = document.createElement('canvas');
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w === 0 || h === 0) continue;
        composite.width = w * window.devicePixelRatio;
        composite.height = h * window.devicePixelRatio;
        const ctx = composite.getContext('2d');
        if (!ctx) continue;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        const elRect = el.getBoundingClientRect();
        let drew = false;
        canvases.forEach((c) => {
          const cRect = c.getBoundingClientRect();
          try {
            ctx.drawImage(c, cRect.left - elRect.left, cRect.top - elRect.top, cRect.width, cRect.height);
            drew = true;
          } catch { /* WebGL without preserveDrawingBuffer */ }
        });
        if (drew) {
          const dataUrl = composite.toDataURL('image/png');
          if (dataUrl && dataUrl.length > 6) {
            newSnapshots.set(tabId, { dataUrl, width: w, height: h });
          }
        }
      } catch { /* skip */ }
    }
    return newSnapshots;
  }, []);

  useEffect(() => {
    const handleDragStart = () => {
      dragCountRef.current++;
      setIsDragging(true);
      snapshotsRef.current = captureSnapshots();
      dropSnapshotPendingRef.current = true;
    };
    const handleDragEnd = () => {
      dragCountRef.current = 0;
      setIsDragging(false);
      if (dropSnapshotPendingRef.current && snapshotsRef.current.size > 0) {
        dropSnapshotPendingRef.current = false;
        setResizePhase('active');
        phaseTimerRef.current = setTimeout(() => {
          setResizePhase('crossfade');
          phaseTimerRef.current = setTimeout(() => {
            snapshotsRef.current = new Map();
            setResizePhase('idle');
            phaseTimerRef.current = null;
          }, 50);
        }, 100);
      }
    };
    window.addEventListener('dragstart', handleDragStart, true);
    window.addEventListener('dragend', handleDragEnd, true);
    window.addEventListener('drop', handleDragEnd, true);
    return () => {
      window.removeEventListener('dragstart', handleDragStart, true);
      window.removeEventListener('dragend', handleDragEnd, true);
      window.removeEventListener('drop', handleDragEnd, true);
    };
  }, [captureSnapshots]);

  // Listen for layout resize events
  useEffect(() => {
    const clearTimers = () => {
      if (phaseTimerRef.current) { clearTimeout(phaseTimerRef.current); phaseTimerRef.current = null; }
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    };

    const handleResizePrepare = () => {
      snapshotsRef.current = captureSnapshots();
    };

    const handleResizeStart = () => {
      clearTimers();
      resizeCountRef.current++;
      if (resizeCountRef.current === 1) {
        if (snapshotsRef.current.size === 0) {
          snapshotsRef.current = captureSnapshots();
        }
        setResizePhase('active');
      }
    };

    const handleResizeEnd = () => {
      resizeCountRef.current = Math.max(0, resizeCountRef.current - 1);
      if (resizeCountRef.current === 0) {
        clearTimers();
        setResizePhase('crossfade');
        phaseTimerRef.current = setTimeout(() => {
          snapshotsRef.current = new Map();
          setResizePhase('idle');
          phaseTimerRef.current = null;
        }, 50);
      }
    };

    window.addEventListener('layout:resize-prepare', handleResizePrepare);
    window.addEventListener('layout:resize-start', handleResizeStart);
    window.addEventListener('layout:resize-end', handleResizeEnd);
    return () => {
      clearTimers();
      window.removeEventListener('layout:resize-prepare', handleResizePrepare);
      window.removeEventListener('layout:resize-start', handleResizeStart);
      window.removeEventListener('layout:resize-end', handleResizeEnd);
    };
  }, [captureSnapshots]);

  // Refs to terminal content wrapper divs for imperative blur control
  const contentWrapperRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Imperatively manage blur transitions
  useEffect(() => {
    if (resizePhase === 'active') {
      for (const wrapper of contentWrapperRefs.current.values()) {
        wrapper.style.opacity = '0';
        wrapper.style.transition = 'none';
      }
    } else if (resizePhase === 'crossfade') {
      for (const wrapper of contentWrapperRefs.current.values()) {
        wrapper.style.opacity = '0';
        wrapper.style.transition = 'none';
      }
      const id1 = requestAnimationFrame(() => {
        const id2 = requestAnimationFrame(() => {
          for (const wrapper of contentWrapperRefs.current.values()) {
            wrapper.style.transition = 'opacity 50ms ease-in-out';
            wrapper.style.opacity = '1';
          }
          for (const img of snapshotImgRefs.current.values()) {
            img.style.transition = 'opacity 50ms ease-in-out';
            img.style.opacity = '0';
          }
        });
        rafRef.current = id2;
      });
      rafRef.current = id1;
    } else if (resizePhase === 'idle') {
      for (const wrapper of contentWrapperRefs.current.values()) {
        wrapper.style.transition = '';
        wrapper.style.opacity = '';
      }
      for (const img of snapshotImgRefs.current.values()) {
        img.style.transition = '';
        img.style.opacity = '';
      }
    }
    return () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    };
  }, [resizePhase]);

  const rectsRef = useRef<Record<string, PaneRect>>(paneRects);

  // Imperatively update all tab container positions from current rects
  const syncPositions = useCallback(() => {
    for (const { tab, paneId, isActive } of placements) {
      const el = tabRefsMap.current.get(tab.id);
      if (!el) continue;
      const rect = rectsRef.current[paneId];
      const isVisible = isActive && rect != null;

      el.style.top = `${(rect?.top ?? 0) + OVERLAY_INSET}px`;
      el.style.left = `${(rect?.left ?? 0) + OVERLAY_INSET}px`;
      el.style.width = `${(rect?.width ?? 0) - OVERLAY_INSET * 2}px`;
      el.style.height = `${(rect?.height ?? 0) - OVERLAY_INSET * 2}px`;
      el.style.display = isVisible ? 'flex' : 'none';
      el.style.visibility = isVisible ? 'visible' : 'hidden';
    }
  }, [placements]);

  useLayoutEffect(() => {
    rectsRef.current = paneRects;
  }, [paneRects]);

  useLayoutEffect(() => {
    syncPositions();
  });

  // Expose syncPositions globally
  useEffect(() => {
    (window as any).__persistentLayerSync = syncPositions;
    return () => { delete (window as any).__persistentLayerSync; };
  }, [syncPositions]);

  // Allow imperative rect updates from animation frames
  useEffect(() => {
    (window as any).__updatePaneRectImperative = (paneId: string, rect: PaneRect | null) => {
      if (rect) {
        rectsRef.current = { ...rectsRef.current, [paneId]: rect };
      } else {
        const next = { ...rectsRef.current };
        delete next[paneId];
        rectsRef.current = next;
      }
      syncPositions();
    };
    return () => { delete (window as any).__updatePaneRectImperative; };
  }, [syncPositions]);

  if (placements.length === 0) return null;

  return (
    <div
      data-testid={PERSISTENT_LAYER_ID}
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 20,
      }}
    >
      {placements.map(({ tab, paneId, isActive }) => {
        const rect = paneRects[paneId];
        const isVisible = isActive && rect != null;
        const isSidebar = sidebarPane != null && paneId === sidebarPane.id;
        const allowsVerticalOverflow = tab.type === 'agent' && !isSidebar;

        return (
          <div
            key={tab.id}
            className="app-persistent-pane"
            ref={(el) => {
              if (el) tabRefsMap.current.set(tab.id, el);
              else tabRefsMap.current.delete(tab.id);
            }}
            data-persistent-tab={tab.id}
            data-persistent-pane={paneId}
            data-persistent-region={isSidebar ? 'sidebar' : 'pane'}
            data-persistent-visible={isVisible || undefined}
            onMouseDownCapture={() => {
              if (!isVisible) return;
              if (isSidebar) {
                setActiveTabRegion('sidebar');
                return;
              }
              setActivePaneId(paneId);
            }}
            onFocusCapture={() => {
              if (!isVisible) return;
              if (isSidebar) {
                setActiveTabRegion('sidebar');
                return;
              }
              setActivePaneId(paneId);
            }}
            style={{
              position: 'absolute',
              top: (rect?.top ?? 0) + OVERLAY_INSET,
              left: (rect?.left ?? 0) + OVERLAY_INSET,
              width: (rect?.width ?? 0) - OVERLAY_INSET * 2,
              height: (rect?.height ?? 0) - OVERLAY_INSET * 2,
              '--persistent-pane-top': `${rect?.top ?? 0}px`,
              minHeight: 0,
              display: isVisible ? 'flex' : 'none',
              visibility: isVisible ? 'visible' : 'hidden',
              pointerEvents: isDragging ? 'none' : (isVisible ? 'auto' : 'none'),
              overflowX: 'hidden',
              overflowY: allowsVerticalOverflow ? 'visible' : 'hidden',
              flexDirection: 'column',
              ...(isSidebar ? {} : {
                borderRadius: 'var(--control-radius-lg)',
              }),
            }}
          >
            {/* Content wrapper — all animated props imperative */}
            <div
              className="app-persistent-pane-content"
              ref={(el) => {
                if (el) contentWrapperRefs.current.set(tab.id, el);
                else contentWrapperRefs.current.delete(tab.id);
              }}
              style={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflowX: 'hidden',
                overflowY: allowsVerticalOverflow ? 'visible' : 'hidden',
              }}
            >
              <RenderStatefulTab tab={tab} paneId={paneId} isVisible={isVisible} isSidebar={isSidebar} />
            </div>
            {/* Snapshot overlay */}
            {(() => {
              const snap = resizePhase !== 'idle' && resizePhase !== 'sharpening'
                ? snapshotsRef.current.get(tab.id)
                : undefined;
              if (!snap) return null;
              return (
                <img
                  ref={(el) => {
                    if (el) snapshotImgRefs.current.set(tab.id, el);
                    else snapshotImgRefs.current.delete(tab.id);
                  }}
                  src={snap.dataUrl}
                  alt=""
                  data-snapshot-img={tab.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: snap.width,
                    height: snap.height,
                    minWidth: snap.width,
                    minHeight: snap.height,
                    maxWidth: snap.width,
                    maxHeight: snap.height,
                    zIndex: 50,
                    pointerEvents: 'none',
                  }}
                />
              );
            })()}
          </div>
        );
      })}
    </div>
  );
}
