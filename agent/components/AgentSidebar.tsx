import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { Plus } from 'lucide-react';
import { tr } from '../../src/i18n';

import { getProfiles } from '../../src/api';
import { useLayout } from '../../src/hooks/useLayout';
import { createAgentCallerToken } from '../../src/utils/layoutHelpers';
import { findPaneByTabId } from '../../src/utils/treeOperations';
import { markActiveFileDragHandled } from '../../src/utils/fileDragData';
import { isComposerFileDrag, resolveComposerFileDropData } from '../../src/utils/composerDrop';
import {
  trackPinnedAgentCreated,
  trackPinnedAgentFileDropped,
  trackShortcutInvoked,
} from '../../src/utils/telemetry';
import { AGENT_SIDEBAR_ID, CREATE_SIDEBAR_AGENT_BUTTON_ID } from '../../shared/element-ids';
import { isAgentTab, SIDEBAR_TAB_TYPES, type Tab } from '../../shared/types/layout';
import type { MessagingChannel } from '../../shared/types/messaging';
import type { AgentModelConfig } from '../../shared/types/model';
import type { Profile } from '../../shared/types/profile';
import { getDefaultModelConfig, profileToModelConfig } from '../../shared/types/profile';
import {
  profiles,
  quickActions,
  workspace,
} from '@/ipc';
import {
  resolvePaneTabDragData,
  type PaneTabDragData,
} from '../../src/utils/paneTabDrag';
import { focusComposer } from '../utils/focusComposer';
import { SidebarTabStrip } from './SidebarTabStrip';

export { parsePaneTabDragData } from '../../src/utils/paneTabDrag';

interface AgentSidebarProps {
  className?: string;
}

interface CreatePinnedAgentOptions {
  agentId?: string;
  label?: string;
  requestId?: string;
  startupId?: string;
  initialMessage?: string;
  systemPrompt?: string;
  conversationId?: string;
  threadId?: string;
  callerToken?: string;
  workspacePath?: string;
  agentChannel?: MessagingChannel;
  agentChannelThreadId?: string;
  modelConfig?: AgentModelConfig;
  activate?: boolean;
}

function getPinnedAgentCreationSource(options?: CreatePinnedAgentOptions): string {
  if (options?.agentChannel) return 'channel_bridge';
  if (options?.conversationId) return 'conversation_history';
  if (options?.requestId?.startsWith('help-panel-')) return 'help_panel';
  if (options?.requestId) return 'programmatic';
  return 'manual';
}

export function canAcceptSidebarPaneTabDrag(params: {
  dragTypes: readonly string[];
  dragData: PaneTabDragData | null;
  tabs: Record<string, Tab>;
}): boolean {
  if (!params.dragData) return false;

  const draggedTab = params.tabs[params.dragData.tabId];
  return Boolean(
    draggedTab
    && params.dragData.sourcePaneId !== 'sidebar'
    && SIDEBAR_TAB_TYPES.has(draggedTab.type),
  );
}

function buildPinnedAgentTab(
  modelConfig: AgentModelConfig,
  currentWorkspacePath: string | undefined,
  options?: CreatePinnedAgentOptions,
): Tab {
  return {
    id: options?.agentId ?? `agent-${Date.now()}`,
    type: 'agent',
    label: options?.label ?? tr('common.newAgent'),
    createdAt: Date.now(),
    agent: {
      runtime: {
        modelConfig,
        workspacePath: options?.workspacePath ?? currentWorkspacePath,
        systemPrompt: options?.systemPrompt,
      },
      session: {
        startupId: options?.startupId,
        requestId: options?.startupId ? undefined : options?.requestId,
        initialMessage: options?.startupId ? undefined : options?.initialMessage,
        conversationId: options?.conversationId,
        codexThreadId: options?.threadId,
        callerToken: options?.callerToken ?? createAgentCallerToken(),
        agentChannel: options?.agentChannel,
        agentChannelThreadId: options?.agentChannelThreadId,
      },
    },
  };
}

export function AgentSidebar({ className }: AgentSidebarProps) {
  const {
    state,
    registerSidebarTab,
    updateSidebarTabLabel,
    updateTabModelConfig,
    updateTab,
    updatePaneRect,
    moveTabToSidebar,
    setRightSidebarOpen,
    setActiveTabRegion,
  } = useLayout();
  const sidebarPaneId = state.sidebarPane?.id ?? 'sidebar';
  const sidebarRootRef = useRef<HTMLDivElement>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const handledWindowDropRef = useRef(false);
  const defaultProfileRef = useRef<Profile | null>(null);
  const [currentWorkspacePath, setCurrentWorkspacePath] = useState<string | undefined>(undefined);
  const [isDragTarget, setIsDragTarget] = useState(false);
  const [dragIntent, setDragIntent] = useState<'pin' | 'composer' | null>(null);
  const sidebarTabCount = state.sidebarPane?.tabIds.length ?? 0;
  const pinnedTabId = state.sidebarPane?.activeTabId ?? state.sidebarPane?.tabIds[0] ?? null;
  const pinnedTab = pinnedTabId ? state.tabs[pinnedTabId] : null;

  const clearDragTarget = useCallback(() => {
    dragDepthRef.current = 0;
    setIsDragTarget(false);
    setDragIntent(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    workspace.get()
      .then(({ workspace: workspacePath }: { workspace: string | null }) => {
        if (cancelled) return;
        setCurrentWorkspacePath(workspacePath ?? undefined);
      })
      .catch(() => {
        if (cancelled) return;
        setCurrentWorkspacePath(undefined);
      });

    const unsubscribe = workspace.onChanged((event: { workspacePath: string | null }) => {
      setCurrentWorkspacePath(event.workspacePath ?? undefined);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refreshDefaultProfile = async () => {
      let nextProfiles: Profile[] = [];
      let nextDefaultProfileId: string | null = null;
      let loadFailed = false;
      try {
        const data = await getProfiles();
        nextProfiles = data.profiles;
        nextDefaultProfileId = data.defaultProfileId;
      } catch {
        loadFailed = true;
      }
      if (cancelled) return;
      if (loadFailed) {
        defaultProfileRef.current = null;
        return;
      }
      defaultProfileRef.current = nextProfiles.find((profile) => profile.id === nextDefaultProfileId) ?? null;
    };

    void refreshDefaultProfile();

    const unsubscribe = profiles.onDefaultChanged(() => {
      void refreshDefaultProfile();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const isPointerInsideSidebar = useCallback((clientX: number, clientY: number) => {
    const rect = sidebarRootRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return (
      clientX >= rect.left
      && clientX <= rect.right
      && clientY >= rect.top
      && clientY <= rect.bottom
    );
  }, []);

  const resolveSidebarDragData = useCallback((dataTransfer: Pick<DataTransfer, 'getData' | 'types'>) => {
    return resolvePaneTabDragData(dataTransfer) ?? (() => {
      const tabId = dataTransfer.getData('text/plain');
      if (!tabId) return null;
      const sourcePane = findPaneByTabId(state.tree, tabId);
      return {
        type: 'pane-tab' as const,
        tabId,
        sourcePaneId: sourcePane?.id,
        sourceIndex: undefined,
      };
    })();
  }, [state.tree]);

  const updateDragTarget = useCallback((dataTransfer: Pick<DataTransfer, 'getData' | 'files' | 'types'>) => {
    if (pinnedTab?.type === 'agent' && isComposerFileDrag(dataTransfer, state.tabs)) {
      setIsDragTarget(true);
      setDragIntent('composer');
      return 'move' as const;
    }

    const dragData = resolveSidebarDragData(dataTransfer);
    if (canAcceptSidebarPaneTabDrag({
      dragTypes: Array.from(dataTransfer.types),
      dragData,
      tabs: state.tabs,
    })) {
      setIsDragTarget(true);
      setDragIntent('pin');
      return 'move' as const;
    }

    setIsDragTarget(false);
    setDragIntent(null);
    return null;
  }, [pinnedTab, resolveSidebarDragData, state.tabs]);

  const commitSidebarDrop = useCallback((dragData: PaneTabDragData | null) => {
    if (!dragData) {
      clearDragTarget();
      return false;
    }

    const draggedTab = state.tabs[dragData.tabId];
    if (!draggedTab || dragData.sourcePaneId === 'sidebar' || !SIDEBAR_TAB_TYPES.has(draggedTab.type)) {
      clearDragTarget();
      return false;
    }

    clearDragTarget();
    moveTabToSidebar(dragData.tabId, {
      fallbackPaneId: dragData.sourcePaneId,
      fallbackIndex: dragData.sourceIndex,
    });
    setRightSidebarOpen(true);
    setActiveTabRegion('sidebar');
    return true;
  }, [clearDragTarget, moveTabToSidebar, setActiveTabRegion, setRightSidebarOpen, state.tabs]);

  const routeSidebarFileDropToComposer = useCallback((dataTransfer: Pick<DataTransfer, 'getData' | 'files' | 'types'>) => {
    if (!pinnedTab || pinnedTab.type !== 'agent') {
      return false;
    }

    const composerDrop = resolveComposerFileDropData(dataTransfer, state.tabs);
    if (!composerDrop) {
      return false;
    }

    markActiveFileDragHandled('sidebar-drop', {
      agentId: pinnedTab.id,
      filePath: composerDrop.filePath,
    });
    trackPinnedAgentFileDropped({
      isDirectory: composerDrop.isDirectory,
    });
    clearDragTarget();
    window.dispatchEvent(new CustomEvent('agent-sidebar:file-drop', {
      detail: {
        filePath: composerDrop.filePath,
        fileName: composerDrop.fileName,
        isDirectory: composerDrop.isDirectory,
        agentId: pinnedTab.id,
      },
    }));
    return true;
  }, [clearDragTarget, pinnedTab, state.tabs]);

  useLayoutEffect(() => {
    if (!state.rightSidebar.isOpen) return;
    const element = sidebarContentRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    updatePaneRect(sidebarPaneId, new DOMRect(rect.x, rect.y, rect.width, rect.height));
  }, [sidebarPaneId, state.rightSidebar.isOpen, updatePaneRect, pinnedTabId]);

  useEffect(() => {
    const element = sidebarContentRef.current;
    if (!element || !state.rightSidebar.isOpen || !pinnedTabId) {
      updatePaneRect(sidebarPaneId, null);
      return;
    }

    const measure = () => {
      const rect = element.getBoundingClientRect();
      updatePaneRect(sidebarPaneId, new DOMRect(rect.x, rect.y, rect.width, rect.height));
    };

    let frameId: number | null = null;
    const scheduleMeasure = () => {
      if (frameId != null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        measure();
      });
    };

    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(element);
    measure();
    window.addEventListener('layout:resize-end', measure);
    window.addEventListener('layout:sidebar-settled', measure);
    window.addEventListener('resize', scheduleMeasure);

    return () => {
      observer.disconnect();
      window.removeEventListener('layout:resize-end', measure);
      window.removeEventListener('layout:sidebar-settled', measure);
      window.removeEventListener('resize', scheduleMeasure);
      if (frameId != null) {
        cancelAnimationFrame(frameId);
      }
      updatePaneRect(sidebarPaneId, null);
    };
  }, [pinnedTabId, sidebarPaneId, state.rightSidebar.isOpen, updatePaneRect]);

  useEffect(() => {
    const persistentSidebarTab = document.querySelector<HTMLElement>(
      `[data-persistent-pane="${sidebarPaneId}"][data-persistent-visible="true"]`,
    );
    if (!persistentSidebarTab) return;

    persistentSidebarTab.style.transition = '';
    persistentSidebarTab.style.opacity = dragIntent === 'composer' ? '0.72' : dragIntent ? '0.35' : '1';

    return () => {
      persistentSidebarTab.style.opacity = '1';
      persistentSidebarTab.style.transition = '';
    };
  }, [dragIntent, pinnedTabId, sidebarPaneId]);

  const createPinnedAgent = useCallback((options?: CreatePinnedAgentOptions) => {
    const modelConfig = options?.modelConfig ?? (
      defaultProfileRef.current ? profileToModelConfig(defaultProfileRef.current) : getDefaultModelConfig()
    );

    const tab = buildPinnedAgentTab(modelConfig, currentWorkspacePath, options);
    trackPinnedAgentCreated({
      source: getPinnedAgentCreationSource(options),
      hasInitialMessage: Boolean(options?.initialMessage),
      hasConversationId: Boolean(options?.conversationId),
      hasThreadId: Boolean(options?.threadId),
      channel: options?.agentChannel,
    });
    registerSidebarTab(tab);
    if (options?.activate !== false) {
      setRightSidebarOpen(true);
      setActiveTabRegion('sidebar');
      focusComposer({ agentId: tab.id, delay: 0 });
    }
    return tab.id;
  }, [currentWorkspacePath, registerSidebarTab, setActiveTabRegion, setRightSidebarOpen]);

  useEffect(() => {
    const unsubscribe = quickActions.onNewSidebarAgent(() => {
      trackShortcutInvoked({ shortcut: 'CmdOrCtrl+Shift+L', action: 'new_sidebar_agent', source: 'menu' });
      createPinnedAgent();
    });
    return unsubscribe;
  }, [createPinnedAgent]);

  useEffect(() => {
    const handleCreatePinnedAgent = (event: Event) => {
      const detail = (event as CustomEvent<CreatePinnedAgentOptions | undefined>).detail;
      createPinnedAgent(detail);
    };

    window.addEventListener('sidebar:create-pinned-agent', handleCreatePinnedAgent as EventListener);
    return () => {
      window.removeEventListener('sidebar:create-pinned-agent', handleCreatePinnedAgent as EventListener);
    };
  }, [createPinnedAgent]);

  useEffect(() => {
    const handleLabelUpdate = (event: Event) => {
      const { agentId, label } = (event as CustomEvent<{ agentId: string; label: string }>).detail;
      updateSidebarTabLabel(agentId, label);
    };

    const handleThreadIdAssigned = (event: Event) => {
      const { agentId, threadId } = (event as CustomEvent<{ agentId: string; threadId: string }>).detail;
      updateTab(agentId, (previousTab) => {
        if (!isAgentTab(previousTab)) return previousTab;
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
    };

    const handleModelConfigUpdate = (event: Event) => {
      const { agentId, modelConfig } = (event as CustomEvent<{ agentId: string; modelConfig: AgentModelConfig }>).detail;
      updateTabModelConfig(agentId, modelConfig);
    };

    const handleThreadNameUpdated = (event: Event) => {
      const { threadId, name } = (event as CustomEvent<{ threadId: string; name: string | null }>).detail;
      if (!threadId || !name) return;

      for (const tab of Object.values(state.tabs)) {
        if (isAgentTab(tab) && tab.agent.session.codexThreadId === threadId) {
          updateSidebarTabLabel(tab.id, name);
          break;
        }
      }
    };

    window.addEventListener('persistent-layer:label-update', handleLabelUpdate as EventListener);
    window.addEventListener('persistent-layer:thread-id-assigned', handleThreadIdAssigned as EventListener);
    window.addEventListener('persistent-layer:model-config-update', handleModelConfigUpdate as EventListener);
    window.addEventListener('agent-thread:name-updated', handleThreadNameUpdated as EventListener);

    return () => {
      window.removeEventListener('persistent-layer:label-update', handleLabelUpdate as EventListener);
      window.removeEventListener('persistent-layer:thread-id-assigned', handleThreadIdAssigned as EventListener);
      window.removeEventListener('persistent-layer:model-config-update', handleModelConfigUpdate as EventListener);
      window.removeEventListener('agent-thread:name-updated', handleThreadNameUpdated as EventListener);
    };
  }, [state.tabs, updateSidebarTabLabel, updateTab, updateTabModelConfig]);

  useEffect(() => {
    const handleWindowDragOver = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      if (!isPointerInsideSidebar(event.clientX, event.clientY)) {
        clearDragTarget();
        return;
      }

      const dropEffect = updateDragTarget(event.dataTransfer);
      if (!dropEffect) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = dropEffect;
    };

    const handleWindowDrop = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      if (!isPointerInsideSidebar(event.clientX, event.clientY)) {
        clearDragTarget();
        return;
      }

      const handled =
        routeSidebarFileDropToComposer(event.dataTransfer)
        || commitSidebarDrop(resolveSidebarDragData(event.dataTransfer));
      if (!handled) return;
      handledWindowDropRef.current = true;
      requestAnimationFrame(() => {
        handledWindowDropRef.current = false;
      });
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('dragover', handleWindowDragOver, true);
    window.addEventListener('dragend', clearDragTarget, true);
    window.addEventListener('drop', handleWindowDrop, true);
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver, true);
      window.removeEventListener('dragend', clearDragTarget, true);
      window.removeEventListener('drop', handleWindowDrop, true);
    };
  }, [clearDragTarget, commitSidebarDrop, isPointerInsideSidebar, resolveSidebarDragData, routeSidebarFileDropToComposer, updateDragTarget]);

  const handleSidebarDrop = useCallback((event: ReactDragEvent) => {
    if (handledWindowDropRef.current) {
      handledWindowDropRef.current = false;
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (routeSidebarFileDropToComposer(event.dataTransfer)) {
      return;
    }
    commitSidebarDrop(resolveSidebarDragData(event.dataTransfer));
  }, [commitSidebarDrop, resolveSidebarDragData, routeSidebarFileDropToComposer]);

  const handleSidebarDragEnter = useCallback((event: ReactDragEvent) => {
    dragDepthRef.current += 1;
    const dropEffect = updateDragTarget(event.dataTransfer);
    if (!dropEffect) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dropEffect;
  }, [updateDragTarget]);

  const handleSidebarDragOver = useCallback((event: ReactDragEvent) => {
    const dropEffect = updateDragTarget(event.dataTransfer);
    if (!dropEffect) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = dropEffect;
  }, [updateDragTarget]);

  const handleSidebarDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current > 0) return;
    clearDragTarget();
  }, [clearDragTarget]);

  return (
    <div
      ref={sidebarRootRef}
      className={`app-agent-sidebar-surface relative flex h-full w-full flex-col bg-transparent ${className || ''}`}
      data-testid={AGENT_SIDEBAR_ID}
      style={{
        color: 'var(--oa-text, var(--foreground))',
        paddingTop: 'var(--unit-height)',
      }}
      onMouseDownCapture={() => {
        if (state.rightSidebar.isOpen && sidebarTabCount > 0) {
          setActiveTabRegion('sidebar');
        }
      }}
      onDragEnter={handleSidebarDragEnter}
      onDragOver={handleSidebarDragOver}
      onDragLeave={handleSidebarDragLeave}
      onDrop={handleSidebarDrop}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {sidebarTabCount > 0 ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="rounded-sm overflow-visible">
              <SidebarTabStrip onNewAgent={() => createPinnedAgent()} />
            </div>
            <div className="relative min-h-0 flex-1">
              <div
                ref={sidebarContentRef}
                data-sidebar-content="true"
                data-pane-id={sidebarPaneId}
                className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
                style={{
                  background: 'var(--oa-sidebar-content-surface, transparent)',
                  border: 'none',
                  boxShadow: 'none',
                }}
              />
              {dragIntent ? (
                <div
                  className="absolute inset-0 z-20 flex items-center justify-center"
                  onDragEnter={handleSidebarDragEnter}
                  onDragOver={handleSidebarDragOver}
                  onDragLeave={handleSidebarDragLeave}
                  onDrop={handleSidebarDrop}
                  style={{
                    background: dragIntent === 'composer'
                      ? 'color-mix(in srgb, var(--oa-primary, var(--foreground)) 3%, transparent)'
                      : 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 18%, transparent)',
                    border: dragIntent === 'composer'
                      ? 'var(--border-width) dashed color-mix(in srgb, var(--oa-primary, var(--foreground)) 28%, transparent)'
                      : 'var(--border-width) dashed color-mix(in srgb, var(--oa-border, var(--border)) 72%, transparent)',
                    backdropFilter: 'blur(2px)',
                  }}
                >
                  <div
                    className="pointer-events-none rounded-full px-3 py-1.5 text-ui-xs font-medium tracking-[0.01em]"
                    style={{
                      background: dragIntent === 'composer'
                        ? 'var(--oa-primary, var(--foreground))'
                        : 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 90%, var(--oa-bg-subtle, var(--hover-bg)) 10%)',
                      color: dragIntent === 'composer'
                        ? 'var(--oa-primary-foreground, var(--background))'
                        : 'var(--oa-text-strong, var(--foreground))',
                      border: dragIntent === 'composer'
                        ? 'none'
                        : 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 92%, transparent)',
                    }}
                  >
                    {dragIntent === 'composer'
                      ? 'Drop file into composer'
                      : 'Drop agent tab here'}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 py-8 transition-colors">
            <div className="max-w-[248px] text-center">
              <p className="text-ui-base font-medium text-foreground">
                Drop agent tabs here
              </p>
              <p className="mt-2 text-ui-sm text-muted-foreground">
                Drag an agent tab from the main area into this sidebar to keep the conversation beside your work.
              </p>
              <button
                type="button"
                data-testid={CREATE_SIDEBAR_AGENT_BUTTON_ID}
                className="oa-hover-chip mt-4 inline-flex h-[var(--unit-element-height)] items-center gap-1.5 rounded-sm px-3 text-ui-sm font-medium text-foreground hover:bg-hover"
                style={{
                  border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 82%, transparent)',
                }}
                onClick={() => createPinnedAgent()}
              >
                <Plus className="size-3.5" />
                Create Agent in Sidebar
              </button>
              {isDragTarget ? (
                <div
                  className="mt-4 inline-flex rounded-full px-3 py-1.5 text-ui-xs font-medium"
                  style={{
                    background: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 90%, var(--oa-bg-subtle, var(--hover-bg)) 10%)',
                    color: 'var(--oa-text-strong, var(--foreground))',
                    border: 'var(--border-width) dashed color-mix(in srgb, var(--oa-border, var(--border)) 72%, transparent)',
                  }}
                >
                  Drop agent tab
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
