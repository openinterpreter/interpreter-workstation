import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AgentAttentionIndicator } from '../../src/components/AgentAttentionIndicator';
import { TooltipButton } from '../../src/components/ui/tooltip-button';
import { useCommandOverlay } from '../../src/contexts/CommandOverlayContext';
import { useAgentActivityMap } from '../../src/hooks/useAgentActivityMap';
import { useLayout } from '../../src/hooks/useLayout';
import { usePendingApprovalsByAgent } from '../../src/hooks/usePendingApprovalsByAgent';
import {
  clearActivePaneTabDragData,
  createPaneTabDragData,
  resolvePaneTabDragData,
  setActivePaneTabDragData,
} from '../../src/utils/paneTabDrag';
import { buildGlobalTabNumbers } from '../../src/utils/tabNavigation';
import { getTerminalIcon } from '../../src/utils/terminalIcons';
import {
  formatPrimaryShortcut,
  formatShiftedPrimaryShortcut,
} from '../../src/utils/platformShortcuts';
import {
  AGENT_TAB_ID,
  CLOSE_AGENT_ID,
  NEW_AGENT_BUTTON_ID,
  SIDEBAR_TAB_DROP_INDICATOR_ID,
  TERMINAL_TAB_ID,
} from '../../shared/element-ids';
import { isAgentTab, type Tab } from '../../shared/types/layout';
import type { TerminalConfig } from '../../shared/types/model';
import { getAgentIndicatorTone } from '../../shared/utils/agentAttention';

const SIDEBAR_TABS_MAX_HEIGHT = 'min(420px, 50vh)';
const GRADIENT_SIZE = 16;

function renderInlineMarkdown(text: string): ReactNode {
  if (!text) return text;

  const cleaned = text
    .replace(/!\[[^\]]*\]\(<[^>]*>\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(<[^>]*>\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/\|[^|\n]*\|/g, '')
    .replace(/[-:]+\|[-:|]+/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/^[-*_]{3,}$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return text.replace(/\s+/g, ' ').trim();
  }

  const parts: ReactNode[] = [];
  let remaining = cleaned;
  let key = 0;
  const inlinePattern = /(\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\*(.+?)\*|(?<![a-zA-Z])_([^_]+)_(?![a-zA-Z]))/;

  while (remaining) {
    const match = remaining.match(inlinePattern);
    if (!match || match.index === undefined) {
      parts.push(remaining);
      break;
    }

    if (match.index > 0) {
      parts.push(remaining.slice(0, match.index));
    }

    const fullMatch = match[0];
    if (match[2] !== undefined) {
      parts.push(<strong key={key++}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      parts.push(<strong key={key++}>{match[3]}</strong>);
    } else if (match[4] !== undefined) {
      parts.push(<code key={key++} className="rounded bg-muted px-1 text-[0.9em]">{match[4]}</code>);
    } else if (match[5] !== undefined) {
      parts.push(<em key={key++}>{match[5]}</em>);
    } else if (match[6] !== undefined) {
      parts.push(<em key={key++}>{match[6]}</em>);
    } else {
      parts.push(fullMatch);
    }

    remaining = remaining.slice(match.index + fullMatch.length);
  }

  return parts;
}

function NewPinnedAgentButton({ onNewAgent }: { onNewAgent: () => void }) {
  const { isCommandHeld, activatedKey } = useCommandOverlay();
  const { t } = useTranslation();
  const shortcutLabel = formatShiftedPrimaryShortcut('L');

  return (
    <div className="flex items-center gap-1">
      <TooltipButton
        variant="ghost"
        size="row"
        className="gap-1.5 hover:bg-foreground/10 hover:border-transparent aria-expanded:bg-foreground/10"
        onClick={onNewAgent}
        data-testid={NEW_AGENT_BUTTON_ID}
        tooltip={t('help.sidebar.newAgent.title')}
        helpDescription={t('help.sidebar.newAgent.description')}
        shortcut={shortcutLabel}
        tooltipSide="bottom"
      >
        <Plus className="size-3.5" strokeWidth={2.5} />
        {t('common.newAgent')}
      </TooltipButton>
      <span
        className={`text-ui-xs font-mono transition-opacity duration-150 ease-out ${
          activatedKey === 'L' ? 'text-foreground/60' : 'text-muted-foreground/40'
        }`}
        style={{ opacity: isCommandHeld ? 1 : 0 }}
      >
        {shortcutLabel}
      </span>
    </div>
  );
}

type SidebarDropIndicator = {
  tabId: string;
  side: 'top' | 'bottom';
} | null;

function SidebarTabItem({
  tab,
  index,
  isActive,
  showDropTop,
  showDropBottom,
  pendingApprovalCount,
  shortcutNumber,
  isCommandHeld,
  activatedKey,
  onActivate,
  onClose,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  tab: Tab;
  index: number;
  isActive: boolean;
  showDropTop: boolean;
  showDropBottom: boolean;
  pendingApprovalCount: number;
  shortcutNumber: number | null;
  isCommandHeld: boolean;
  activatedKey: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>, tabId: string, index: number) => void;
  onDragEnd: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>, tabId: string) => void;
  onDragLeave: (tabId: string) => void;
  onDrop: (event: DragEvent<HTMLDivElement>, tabId: string) => void;
}) {
  const activityByAgent = useAgentActivityMap();
  const { t } = useTranslation();
  const defaultAgentLabel = t('common.newAgent');
  const renderedLabel = useMemo(() => renderInlineMarkdown(tab.label || defaultAgentLabel), [defaultAgentLabel, tab.label]);
  const isWhatsAppBridge = tab.agent?.session.agentChannel === 'whatsapp';
  const activity = activityByAgent.get(tab.id);
  const shortcutKey = shortcutNumber ? String(shortcutNumber) : null;
  const shortcutLabel = shortcutKey ? formatPrimaryShortcut(shortcutKey) : null;
  const isShortcutActive = shortcutKey != null && activatedKey === shortcutKey;

  const icon = isAgentTab(tab)
    ? (
      <AgentAttentionIndicator
        tone={getAgentIndicatorTone({
          hasPendingApproval: pendingApprovalCount > 0,
          isRunning: activity?.isRunning ?? false,
          unreadCount: activity?.unreadCount ?? 0,
        })}
        className="size-1.5"
      />
    )
    : (() => {
      const terminalConfig = tab.modelConfig?.provider === 'terminal'
        ? tab.modelConfig.providerConfig as TerminalConfig | undefined
        : undefined;
      const TerminalIcon = getTerminalIcon(terminalConfig, tab.terminalAgent);
      return (
        <TerminalIcon
          className="size-3.5 flex-shrink-0"
          style={{ color: isActive ? 'var(--foreground)' : 'var(--muted-foreground)' }}
        />
      );
    })();

  return (
    <div
      draggable
      onDragStart={(event) => onDragStart(event, tab.id, index)}
      onDragEnd={onDragEnd}
      onDragOver={(event) => onDragOver(event, tab.id)}
      onDragLeave={() => onDragLeave(tab.id)}
      onDrop={(event) => onDrop(event, tab.id)}
      onMouseDown={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        onClose(tab.id);
      }}
      onClick={() => onActivate(tab.id)}
      data-testid={tab.type === 'terminal' ? TERMINAL_TAB_ID(tab.id) : AGENT_TAB_ID(tab.id)}
      data-active={isActive}
      data-help-title={tab.label || defaultAgentLabel}
      data-help-description={t('help.sidebar.pinnedTab.description')}
      style={{
        height: 'var(--unit-element-height)',
        paddingLeft: 'var(--unit-padding)',
        paddingRight: 'var(--unit-padding)',
        borderRadius: 'var(--control-radius-md)',
      }}
      className={`
        group relative flex items-center gap-[var(--unit-padding)] overflow-hidden
        cursor-default select-none text-ui-sm font-normal
        agent-tab ${isActive ? 'agent-tab-active' : ''}
      `}
      role="tab"
      aria-selected={isActive}
    >
      {showDropTop ? (
        <div
          data-testid={SIDEBAR_TAB_DROP_INDICATOR_ID(tab.id, 'top')}
          className="pointer-events-none absolute left-[var(--unit-padding)] right-[var(--unit-padding)] top-0 rounded-full"
          style={{
            height: 'var(--border-width)',
            background: 'color-mix(in srgb, var(--border) 72%, var(--foreground) 28%)',
          }}
        />
      ) : null}
      {showDropBottom ? (
        <div
          data-testid={SIDEBAR_TAB_DROP_INDICATOR_ID(tab.id, 'bottom')}
          className="pointer-events-none absolute left-[var(--unit-padding)] right-[var(--unit-padding)] bottom-0 rounded-full"
          style={{
            height: 'var(--border-width)',
            background: 'color-mix(in srgb, var(--border) 72%, var(--foreground) 28%)',
          }}
        />
      ) : null}
      <span className="relative flex size-4 flex-shrink-0 items-center justify-center">
        <span className="transition-opacity duration-150 ease-out" style={{ opacity: isCommandHeld && shortcutKey ? 0 : 1 }}>
          {icon}
        </span>
        {shortcutKey ? (
          <span
            data-command-overlay-shortcut={shortcutLabel ?? undefined}
            className={`absolute inset-0 flex items-center justify-center text-ui-xs font-mono transition-opacity duration-150 ease-out ${
              isShortcutActive ? 'text-foreground/60' : 'text-muted-foreground/50'
            }`}
            style={{ opacity: isCommandHeld ? 1 : 0 }}
          >
            {shortcutLabel}
          </span>
        ) : null}
      </span>
      <div
        className="flex-1 min-w-0 overflow-hidden"
        style={{
          maskImage: 'linear-gradient(to right, black 70%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to right, black 70%, transparent 100%)',
        }}
      >
        <span className="whitespace-nowrap">{renderedLabel}</span>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {isWhatsAppBridge ? (
          <span
            className="text-ui-xs rounded-full px-1.5 py-0.5"
            style={{
              backgroundColor: 'rgba(34, 197, 94, 0.08)',
              border: 'var(--border-width) solid rgba(34, 197, 94, 0.24)',
              color: 'var(--foreground)',
            }}
          >
            {t('settings.inbox.whatsapp')}
          </span>
        ) : null}
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onClose(tab.id);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            onClose(tab.id);
          }}
          data-testid={CLOSE_AGENT_ID(tab.id)}
          className={`size-5 flex items-center justify-center agent-tab-close ${
            isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          aria-label={t('sidebar.closeAgentAria', { label: tab.label || defaultAgentLabel })}
        >
          <X className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

interface SidebarTabStripProps {
  onNewAgent: () => void;
}

export function SidebarTabStrip({ onNewAgent }: SidebarTabStripProps) {
  const { state, closeTab, moveSidebarTab, moveTabToSidebar, setSidebarActiveTab } = useLayout();
  const { isCommandHeld, activatedKey } = useCommandOverlay();
  const pendingApprovalsByAgent = usePendingApprovalsByAgent();
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevTabCountRef = useRef(0);
  const [scrollState, setScrollState] = useState({ atTop: true, atBottom: true, canScroll: false });
  const [dropIndicator, setDropIndicator] = useState<SidebarDropIndicator>(null);

  const tabIds = state.sidebarPane?.tabIds ?? [];
  const activeTabId = state.sidebarPane?.activeTabId ?? tabIds[0] ?? null;

  const tabs = useMemo(
    () => tabIds.map((tabId) => state.tabs[tabId]).filter(Boolean),
    [state.tabs, tabIds],
  );
  const globalTabNumbers = useMemo(
    () => buildGlobalTabNumbers({ tree: state.tree, sidebarPane: state.sidebarPane }),
    [state.tree, state.sidebarPane],
  );

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setScrollState({
      atTop: element.scrollTop <= 1,
      atBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      canScroll: element.scrollHeight > element.clientHeight,
    });
  }, []);

  useEffect(() => {
    if (tabs.length > prevTabCountRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
    prevTabCountRef.current = tabs.length;
  }, [tabs.length]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    updateScrollState();
    element.addEventListener('scroll', updateScrollState);
    return () => element.removeEventListener('scroll', updateScrollState);
  }, [updateScrollState, tabs.length]);

  useEffect(() => {
    const clearDropIndicator = () => {
      setDropIndicator(null);
    };

    window.addEventListener('dragend', clearDropIndicator, true);
    window.addEventListener('drop', clearDropIndicator, true);
    return () => {
      window.removeEventListener('dragend', clearDropIndicator, true);
      window.removeEventListener('drop', clearDropIndicator, true);
    };
  }, []);

  const getMaskImage = useCallback(() => {
    if (!scrollState.canScroll) return undefined;

    const topMask = scrollState.atTop
      ? 'black'
      : `linear-gradient(to bottom, transparent, black ${GRADIENT_SIZE}px)`;
    const bottomMask = scrollState.atBottom
      ? 'black'
      : `linear-gradient(to top, transparent, black ${GRADIENT_SIZE}px)`;

    if (scrollState.atTop && scrollState.atBottom) return undefined;
    if (scrollState.atTop) return bottomMask;
    if (scrollState.atBottom) return topMask;

    return `linear-gradient(to bottom, transparent, black ${GRADIENT_SIZE}px, black calc(100% - ${GRADIENT_SIZE}px), transparent)`;
  }, [scrollState.atBottom, scrollState.atTop, scrollState.canScroll]);

  const handleDragStart = useCallback((event: DragEvent<HTMLDivElement>, tabId: string, index: number) => {
    const tab = state.tabs[tabId];
    if (!tab) return;

    const currentTarget = event.currentTarget;
    const dragData = createPaneTabDragData({
      tabId,
      sourcePaneId: 'sidebar',
      sourceIndex: index,
      tab,
      sidebarMeta: {
        tabType: tab.type,
        label: tab.label,
        agentTabId: tab.type === 'terminal' ? (tab.agentTabId ?? tab.id) : tab.id,
        terminalAgent: tab.terminalAgent,
      },
    });

    setActivePaneTabDragData(dragData);
    event.dataTransfer.setData('text/plain', tabId);
    event.dataTransfer.setData('application/json', JSON.stringify(dragData));
    event.dataTransfer.effectAllowed = 'move';

    requestAnimationFrame(() => {
      currentTarget.style.opacity = '0.4';
    });
  }, [state.tabs]);

  const handleDragEnd = useCallback((event: DragEvent<HTMLDivElement>) => {
    const currentTarget = event.currentTarget;
    clearActivePaneTabDragData();
    setDropIndicator(null);
    currentTarget.style.opacity = '';
  }, []);

  const handleTabDragOver = useCallback((event: DragEvent<HTMLDivElement>, tabId: string) => {
    const dragData = resolvePaneTabDragData(event.dataTransfer);
    if (!dragData || dragData.tabId === tabId) {
      setDropIndicator(null);
      return;
    }

    const draggedTab = state.tabs[dragData.tabId];
    if (!draggedTab) {
      setDropIndicator(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const side = event.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom';
    setDropIndicator({ tabId, side });
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
  }, [state.tabs]);

  const handleTabDragLeave = useCallback((tabId: string) => {
    setDropIndicator((previous) => previous?.tabId === tabId ? null : previous);
  }, []);

  const handleTabDrop = useCallback((event: DragEvent<HTMLDivElement>, tabId: string) => {
    const dragData = resolvePaneTabDragData(event.dataTransfer);
    setDropIndicator(null);
    if (!dragData || dragData.tabId === tabId) {
      return;
    }

    const draggedTab = state.tabs[dragData.tabId];
    if (!draggedTab) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const insertAfter = event.clientY >= rect.top + rect.height / 2;
    const targetIndex = tabIds.indexOf(tabId);
    const insertIndex = insertAfter ? targetIndex + 1 : targetIndex;

    event.preventDefault();
    event.stopPropagation();

    if (dragData.sourcePaneId === 'sidebar') {
      moveSidebarTab(dragData.tabId, insertIndex);
      return;
    }

    moveTabToSidebar(dragData.tabId, {
      fallbackPaneId: dragData.sourcePaneId,
      fallbackIndex: dragData.sourceIndex,
      index: insertIndex,
    });
  }, [moveSidebarTab, moveTabToSidebar, state.tabs, tabIds]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="w-full">
      <div
        ref={scrollRef}
        className="overflow-y-auto"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--unit-padding-small)',
          paddingLeft: 'var(--unit-padding)',
          paddingRight: 'var(--unit-padding)',
          paddingBottom: 'var(--unit-padding)',
          maxHeight: SIDEBAR_TABS_MAX_HEIGHT,
          minHeight: 0,
          maskImage: getMaskImage(),
          WebkitMaskImage: getMaskImage(),
        }}
      >
        {tabs.map((tab, index) => (
          <div key={tab.id} className="flex-shrink-0">
            <SidebarTabItem
              tab={tab}
              index={index}
              isActive={activeTabId === tab.id}
              showDropTop={dropIndicator?.tabId === tab.id && dropIndicator.side === 'top'}
              showDropBottom={dropIndicator?.tabId === tab.id && dropIndicator.side === 'bottom'}
              pendingApprovalCount={pendingApprovalsByAgent.get(tab.id) ?? 0}
              shortcutNumber={globalTabNumbers.get(tab.id) ?? null}
              isCommandHeld={isCommandHeld}
              activatedKey={activatedKey}
              onActivate={setSidebarActiveTab}
              onClose={closeTab}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={handleTabDragOver}
              onDragLeave={handleTabDragLeave}
              onDrop={handleTabDrop}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-center pb-[var(--unit-padding)]">
        <NewPinnedAgentButton onNewAgent={onNewAgent} />
      </div>
    </div>
  );
}
