/**
 * EditorLayout (SplitTreeRenderer)
 *
 * Renders the split-tree layout recursively.
 * Leaf nodes (panes) render PaneView with a tab bar.
 * Split nodes render SplitView with two recursive children.
 */

import React, { useCallback, useMemo, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, Globe, Mail, Settings, FileText, FilePlus, FolderOpen } from 'lucide-react';
import { useLayout } from '../../hooks/useLayout';
import type { TreeNode, Pane, Tab } from '../../../shared/types/layout';
import { isAgentTab, isPane } from '../../../shared/types/layout';
import { SplitView } from './SplitView';
import { PaneView } from './PaneView';
import { EDITOR_LAYOUT_ID, NEW_TAB_BUTTON_ID } from '../../../shared/element-ids';
import { getTerminalIcon } from '../../utils/terminalIcons';
import { useCommandOverlay } from '../../contexts/CommandOverlayContext';
import { buildGlobalTabNumbers } from '../../utils/tabNavigation';
import { usePendingApprovalsByAgent } from '../../hooks/usePendingApprovalsByAgent';
import { useAgentActivityMap } from '../../hooks/useAgentActivityMap';
import {
  clearActivePaneTabDragData,
  createPaneTabDragData,
  resolvePaneTabDragData,
  setActivePaneTabDragData,
  type PaneTabDragData,
} from '../../utils/paneTabDrag';
import { AgentAttentionIndicator } from '../AgentAttentionIndicator';
import { TooltipWrapper } from '../ui/tooltip-wrapper';
import type { AgentActivityState } from '../../../shared/utils/agentAttention';
import { getAgentIndicatorTone } from '../../../shared/utils/agentAttention';
import { formatPrimaryShortcut } from '../../utils/platformShortcuts';
import { getRuntimeSystemInfo, showContextMenu, showItemInFolder, type ContextMenuItem } from '@/ipc';
import { getDragRegionStyle } from '../../utils/titlebarLayout';
import { getRevealInFileManagerLabel } from '../../utils/workspacePickerMenu';
import { shouldHideSingleAgentTabBar } from './editorAgentState';
import { isRemoteWorkstationMode } from '../../remote/remoteWorkstation';
import { isWorkstationReadOnly } from '../../remote/workstationConnection';
import { canUseHostNativeFileManager } from '../../remote/workstationConnection';

// Find the top-left pane (always follow first child)
function getTopLeftPaneId(node: TreeNode): string {
  if (isPane(node)) return node.id;
  return getTopLeftPaneId(node.children[0]);
}

// Find the top-right pane
function getTopRightPaneId(node: TreeNode): string {
  if (isPane(node)) return node.id;
  if (node.direction === 'horizontal') return getTopRightPaneId(node.children[1]);
  return getTopRightPaneId(node.children[0]);
}

function isNewTabLike(tab: Tab | undefined | null): boolean {
  if (!tab) return false;
  return isAgentTab(tab) && tab.label === 'New Tab' && !tab.agent.session.codexThreadId && !tab.agent.session.initialMessage;
}

// ============================================================================
// Tab Bar
// ============================================================================

interface PaneShellMetrics {
  width: number;
  height: number;
  contentTop: number;
  tabLeft: number;
  tabWidth: number;
  radius: number;
  borderWidth: number;
  flushLeadingEdge: boolean;
}

function buildPaneShellPath({
  width,
  height,
  contentTop,
  tabLeft,
  tabWidth,
  radius,
  borderWidth,
  flushLeadingEdge: _flushLeadingEdge,
}: PaneShellMetrics): string {
  const inset = borderWidth / 2;
  const left = inset;
  const top = inset + 3.5;
  const right = Math.max(left, width - inset);
  const bottom = Math.max(top, height - inset);
  const contentY = Math.max(top + radius, contentTop);
  const shellRadius = Math.max(0, Math.min(radius, (right - left) / 2, (bottom - top) / 2));
  // Always allow tab to reach the left wall — the leftFactor morphing handles the rest
  const activeLeft = Math.max(left, tabLeft + inset);
  const activeRight = Math.min(right - shellRadius, tabLeft + tabWidth - inset);
  const joinRadius = Math.max(0, Math.min(shellRadius, (activeRight - activeLeft) / 2, Math.max(1, contentY - top)));

  // How far the tab's left edge is from the wall — drives smooth morphing of left-side radii
  const leftInset = activeLeft - left;
  const leftFactor = Math.min(1, leftInset / Math.max(shellRadius, 1));
  // Left junction and content corner morph to 0 as tab approaches the left wall
  const clr = shellRadius * leftFactor;  // content area top-left corner
  const ljr = joinRadius * leftFactor;   // left junction curve
  // Tab top corners and bottom-left content corner: ALWAYS rounded
  const tlr = shellRadius;
  const blr = shellRadius;

  return [
    `M ${left + clr} ${contentY}`,
    `L ${activeLeft - ljr} ${contentY}`,
    `Q ${activeLeft} ${contentY} ${activeLeft} ${contentY - ljr}`,
    `L ${activeLeft} ${top + tlr}`,
    `Q ${activeLeft} ${top} ${activeLeft + tlr} ${top}`,
    `L ${activeRight - shellRadius} ${top}`,
    `Q ${activeRight} ${top} ${activeRight} ${top + shellRadius}`,
    `L ${activeRight} ${contentY - joinRadius}`,
    `Q ${activeRight} ${contentY} ${activeRight + joinRadius} ${contentY}`,
    `L ${right - shellRadius} ${contentY}`,
    `Q ${right} ${contentY} ${right} ${contentY + shellRadius}`,
    `L ${right} ${bottom - shellRadius}`,
    `Q ${right} ${bottom} ${right - shellRadius} ${bottom}`,
    `L ${left + blr} ${bottom}`,
    `Q ${left} ${bottom} ${left} ${bottom - blr}`,
    `L ${left} ${contentY + clr}`,
    `Q ${left} ${contentY} ${left + clr} ${contentY}`,
    'Z',
  ].join(' ');
}

function PaneShellChrome({ metrics, paneId }: { metrics: PaneShellMetrics | null; paneId: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const shadowPathRef = useRef<SVGPathElement>(null);
  const strokePathRef = useRef<SVGPathElement>(null);
  const animatedMetricsRef = useRef<PaneShellMetrics | null>(metrics);
  const previousMetricsRef = useRef<PaneShellMetrics | null>(metrics);
  const [baseMetrics, setBaseMetrics] = useState<PaneShellMetrics | null>(metrics);
  const activeFrameRef = useRef(0);

  // Shared animation runner — starts a rAF loop from current position to target
  const runAnimation = useCallback((
    targetMetrics: PaneShellMetrics,
    fromLeft: number,
    fromWidth: number,
    toLeft: number,
    toWidth: number,
  ) => {
    cancelAnimationFrame(activeFrameRef.current);

    const startedAt = performance.now();
    const duration = 220;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = ease(progress);
      const nextMetrics = {
        ...targetMetrics,
        tabLeft: fromLeft + ((toLeft - fromLeft) * eased),
        tabWidth: fromWidth + ((toWidth - fromWidth) * eased),
      };
      animatedMetricsRef.current = nextMetrics;

      // Imperative DOM update — no React re-render during animation
      const path = buildPaneShellPath(nextMetrics);
      if (shadowPathRef.current) {
        shadowPathRef.current.setAttribute('d', path);
      }
      if (strokePathRef.current) {
        strokePathRef.current.setAttribute('d', path);
        strokePathRef.current.setAttribute('stroke-width', String(Math.max(nextMetrics.borderWidth, 0.75)));
      }
      if (svgRef.current) {
        svgRef.current.setAttribute('viewBox', `0 0 ${nextMetrics.width} ${nextMetrics.height}`);
      }

      if (progress < 1) {
        activeFrameRef.current = requestAnimationFrame(step);
      } else {
        setBaseMetrics(nextMetrics);
      }
    };

    activeFrameRef.current = requestAnimationFrame(step);
  }, []);

  // Imperative update — bypasses React entirely for resize-driven changes
  const updateImperative = useCallback((m: PaneShellMetrics) => {
    const prev = previousMetricsRef.current;
    previousMetricsRef.current = m;

    // If dimensions/structural props changed, snap imperatively
    if (
      !prev
      || prev.width !== m.width
      || prev.height !== m.height
      || prev.contentTop !== m.contentTop
      || prev.radius !== m.radius
      || prev.borderWidth !== m.borderWidth
    ) {
      cancelAnimationFrame(activeFrameRef.current);
      animatedMetricsRef.current = m;
      const path = buildPaneShellPath(m);
      if (shadowPathRef.current) shadowPathRef.current.setAttribute('d', path);
      if (strokePathRef.current) {
        strokePathRef.current.setAttribute('d', path);
        strokePathRef.current.setAttribute('stroke-width', String(Math.max(m.borderWidth, 0.75)));
      }
      if (svgRef.current) svgRef.current.setAttribute('viewBox', `0 0 ${m.width} ${m.height}`);
      return;
    }

    // Tab position changed — animate
    const fromLeft = animatedMetricsRef.current?.tabLeft ?? prev.tabLeft;
    const fromWidth = animatedMetricsRef.current?.tabWidth ?? prev.tabWidth;
    if (Math.abs(fromLeft - m.tabLeft) < 0.5 && Math.abs(fromWidth - m.tabWidth) < 0.5) {
      animatedMetricsRef.current = m;
      const path = buildPaneShellPath(m);
      if (shadowPathRef.current) shadowPathRef.current.setAttribute('d', path);
      if (strokePathRef.current) {
        strokePathRef.current.setAttribute('d', path);
        strokePathRef.current.setAttribute('stroke-width', String(Math.max(m.borderWidth, 0.75)));
      }
      if (svgRef.current) svgRef.current.setAttribute('viewBox', `0 0 ${m.width} ${m.height}`);
      return;
    }
    runAnimation(m, fromLeft, fromWidth, m.tabLeft, m.tabWidth);
  }, [runAnimation]);

  // Expose imperative update keyed by paneId
  useEffect(() => {
    const paneShellWindow = window as any;
    if (!paneShellWindow.__paneShellImperative) {
      paneShellWindow.__paneShellImperative = new Map();
    }
    const map = paneShellWindow.__paneShellImperative as Map<string, (m: PaneShellMetrics) => void>;
    map.set(paneId, updateImperative);
    return () => { map.delete(paneId); };
  }, [paneId, updateImperative]);

  // Listen for imperative animation triggers from setActiveTab.
  // This starts the animation BEFORE React reconciles, so it runs at 60fps.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.paneId !== paneId) return;

      const current = animatedMetricsRef.current;
      if (!current) return;

      const fromLeft = current.tabLeft;
      const fromWidth = current.tabWidth;
      const toLeft = detail.tabLeft;
      const toWidth = detail.tabWidth;

      if (Math.abs(fromLeft - toLeft) < 0.5 && Math.abs(fromWidth - toWidth) < 0.5) return;

      runAnimation(current, fromLeft, fromWidth, toLeft, toWidth);
    };
    window.addEventListener('pane-shell:animate-tab', handler);
    return () => window.removeEventListener('pane-shell:animate-tab', handler);
  }, [paneId, runAnimation]);

  useEffect(() => {
    if (!metrics) {
      setBaseMetrics(null);
      animatedMetricsRef.current = null;
      previousMetricsRef.current = null;
      return;
    }

    const previous = previousMetricsRef.current;
    previousMetricsRef.current = metrics;

    if (
      !previous
      || previous.width !== metrics.width
      || previous.height !== metrics.height
      || previous.contentTop !== metrics.contentTop
      || previous.radius !== metrics.radius
      || previous.borderWidth !== metrics.borderWidth
    ) {
      cancelAnimationFrame(activeFrameRef.current);
      animatedMetricsRef.current = metrics;
      // Imperative DOM update — avoids React re-render cascade during sidebar animation
      const path = buildPaneShellPath(metrics);
      if (shadowPathRef.current) shadowPathRef.current.setAttribute('d', path);
      if (strokePathRef.current) {
        strokePathRef.current.setAttribute('d', path);
        strokePathRef.current.setAttribute('stroke-width', String(Math.max(metrics.borderWidth, 0.75)));
      }
      if (svgRef.current) svgRef.current.setAttribute('viewBox', `0 0 ${metrics.width} ${metrics.height}`);
      // Only trigger a React re-render on mount (no previous) so the initial render is correct
      if (!previous) setBaseMetrics(metrics);
      return;
    }

    const fromLeft = animatedMetricsRef.current?.tabLeft ?? previous.tabLeft;
    const fromWidth = animatedMetricsRef.current?.tabWidth ?? previous.tabWidth;
    const toLeft = metrics.tabLeft;
    const toWidth = metrics.tabWidth;

    if (Math.abs(fromLeft - toLeft) < 0.5 && Math.abs(fromWidth - toWidth) < 0.5) {
      animatedMetricsRef.current = metrics;
      // Imperative update — no React re-render needed for sub-pixel changes
      const path = buildPaneShellPath(metrics);
      if (shadowPathRef.current) shadowPathRef.current.setAttribute('d', path);
      if (strokePathRef.current) {
        strokePathRef.current.setAttribute('d', path);
        strokePathRef.current.setAttribute('stroke-width', String(Math.max(metrics.borderWidth, 0.75)));
      }
      if (svgRef.current) svgRef.current.setAttribute('viewBox', `0 0 ${metrics.width} ${metrics.height}`);
      return;
    }

    runAnimation(metrics, fromLeft, fromWidth, toLeft, toWidth);
    return () => cancelAnimationFrame(activeFrameRef.current);
  }, [
    metrics?.borderWidth,
    metrics?.contentTop,
    metrics?.flushLeadingEdge,
    metrics?.height,
    metrics?.radius,
    metrics?.tabLeft,
    metrics?.tabWidth,
    metrics?.width,
    runAnimation,
  ]);

  const resolvedMetrics = baseMetrics ?? metrics;

  if (!resolvedMetrics || resolvedMetrics.width <= 0 || resolvedMetrics.height <= 0 || resolvedMetrics.tabWidth <= 0) {
    return null;
  }


  const path = buildPaneShellPath(resolvedMetrics);

  return (
    <svg
      ref={svgRef}
      className="pane-shell-chrome absolute inset-0 h-full w-full overflow-visible"
      viewBox={`0 0 ${resolvedMetrics.width} ${resolvedMetrics.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        ref={shadowPathRef}
        d={path}
        className="pane-shell-shadow"
        fill="var(--oa-surface-center)"
        stroke="none"
      />
      <path
        ref={strokePathRef}
        d={path}
        fill="var(--oa-surface-center)"
        stroke="color-mix(in srgb, var(--oa-surface-center-border) 58%, var(--oa-border-strong, var(--border)) 42%)"
        strokeWidth={Math.max(resolvedMetrics.borderWidth, 0.75)}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

interface PaneTabBarProps {
  pane: Pane;
  tabs: Record<string, Tab>;
  isActivePane: boolean;
  isTopLeft?: boolean;
  isTopRight?: boolean;
  isSinglePane?: boolean;
  leftSidebarOpen: boolean;
  tabBarRef?: React.RefObject<HTMLDivElement | null>;
  onTopRightPaddingRef?: (ref: HTMLDivElement | null) => void;
  globalTabNumbers: Map<string, number>;
  pendingApprovalsByAgent: Map<string, number>;
  agentActivityById: Map<string, AgentActivityState>;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onActivatePane: () => void;
  onNewTab: () => void;
  onSplitRight?: (tabId: string) => void;
  onSplitDown?: (tabId: string) => void;
  onDrop?: (e: React.DragEvent) => void;
  onTabDrop?: (tabId: string, sourcePaneId: string | null, targetPaneId: string, zone: 'center' | 'left' | 'right' | 'top' | 'bottom', index?: number, sidebarMeta?: any, dragData?: PaneTabDragData | null) => void;
  onDetachTab?: (tabId: string) => void | Promise<void>;
}

function PaneTabBar({ pane, tabs, isActivePane: _isActivePane, isTopLeft, isTopRight, isSinglePane, leftSidebarOpen, tabBarRef, onTopRightPaddingRef, globalTabNumbers, pendingApprovalsByAgent, agentActivityById, onActivateTab, onCloseTab, onActivatePane, onNewTab, onSplitRight, onSplitDown, onDrop, onTabDrop, onDetachTab }: PaneTabBarProps) {
  const { t } = useTranslation();
  const [dropIndicator, setDropIndicator] = useState<{ tabId: string; side: 'left' | 'right' } | null>(null);
  const { isCommandHeld, activatedKey } = useCommandOverlay();
  const isFirstTabActive = pane.tabIds.length > 0 && pane.activeTabId === pane.tabIds[0];
  const shouldFlattenLeadingEdge = Boolean(isSinglePane && isTopLeft && leftSidebarOpen && isFirstTabActive);
  const shouldFillLeadingSpacer = Boolean(isFirstTabActive && !(isTopLeft && !leftSidebarOpen));
  const dragRegionStyle = getDragRegionStyle(getRuntimeSystemInfo().platform);
  const isWindowTopTabBar = isTopLeft || isTopRight;
  const tabBarDragRegionStyle = isWindowTopTabBar ? dragRegionStyle : 'no-drag';
  const remoteWorkstationMode = isRemoteWorkstationMode();
  const readOnlyWorkstation = isWorkstationReadOnly();
  const canUseNativeFileManager = canUseHostNativeFileManager();
  const newTabLabel = readOnlyWorkstation ? t('menu.file.newTab') : t('help.tabs.newAgent.title');
  const newTabDescription = readOnlyWorkstation
    ? 'Open an empty tab to browse active conversations.'
    : t('help.tabs.newAgent.description');

  const handleContextMenu = useCallback(async (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (readOnlyWorkstation) return;

    const tab = tabs[tabId];
    if (!tab) return;

    const canCloseTab = !(isSinglePane && pane.tabIds.length === 1 && isNewTabLike(tab));
    const items: ContextMenuItem[] = [];

    if (canCloseTab) {
      items.push({ label: 'Close Tab', action: 'close' });
    }
    if (onSplitRight) {
      items.push({ label: 'Split Right', action: 'split-right' });
    }
    if (onSplitDown) {
      items.push({ label: 'Split Down', action: 'split-down' });
    }
    if (tab.path) {
      if (items.length > 0) {
        items.push({ label: '', action: '', separator: true });
      }
      items.push({ label: 'Copy Path', action: 'copy-path' });
      if (canUseNativeFileManager) {
        items.push({ label: getRevealInFileManagerLabel(getRuntimeSystemInfo().platform), action: 'reveal' });
      }
    }

    if (items.length === 0) return;

    const action = await showContextMenu(items, 'pane_tab');

    if (action === 'close') {
      onCloseTab(tabId);
    } else if (action === 'split-right') {
      onSplitRight?.(tabId);
    } else if (action === 'split-down') {
      onSplitDown?.(tabId);
    } else if (action === 'copy-path' && tab.path) {
      await navigator.clipboard.writeText(tab.path);
    } else if (action === 'reveal' && tab.path) {
      await showItemInFolder(tab.path);
    }
  }, [canUseNativeFileManager, isSinglePane, onCloseTab, onSplitDown, onSplitRight, pane.tabIds.length, readOnlyWorkstation, tabs]);

  const getTabIcon = (tab: Tab, indicatorTone?: ReturnType<typeof getAgentIndicatorTone>) => {
    if (tab.thumbnail) return <img src={tab.thumbnail} alt="" className="size-3.5 rounded-[2px] object-cover" />;
    if (tab.type === 'folder') return <FolderOpen className="size-3.5" />;
    if (tab.type === 'browser') return tab.faviconUrl ? <img src={tab.faviconUrl} className="size-3.5 object-contain" alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <Globe className="size-3.5" />;
    if (tab.type === 'email') return <Mail className="size-3.5" />;
    if (tab.type === 'settings') return <Settings className="size-3.5" />;
    if (isNewTabLike(tab)) return <FilePlus className="size-3.5" />;
    if (tab.type === 'agent') return <AgentAttentionIndicator tone={indicatorTone ?? 'idle'} className="size-1.5" />;
    if (tab.type === 'terminal') { const tc = tab.modelConfig?.provider === 'terminal' ? tab.modelConfig.providerConfig as import('../../../shared/types/model').TerminalConfig | undefined : undefined; const Icon = getTerminalIcon(tc, tab.terminalAgent); return <Icon className="size-3.5" />; }
    return <FileText className="size-3.5" />;
  };

  const getTabHelpDescription = useCallback((tab: Tab) => {
    if (isNewTabLike(tab)) return t('help.tabs.newTab.description');
    switch (tab.type) {
      case 'file':
        return t('help.tabs.file.description');
      case 'folder':
        return t('help.explorer.folderDescription');
      case 'browser':
        return t('help.tabs.browser.description');
      case 'email':
        return t('help.tabs.email.description');
      case 'chat':
        return t('help.tabs.chat.description');
      case 'settings':
        return t('help.tabs.settings.description');
      case 'agent':
        return t('help.tabs.agent.description');
      case 'terminal':
        return t('help.tabs.terminal.description');
      default:
        return t('help.tabs.generic.description');
    }
  }, [t]);

  const handleTabDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, tab: Tab, sourcePaneId: string, sourceIndex: number) => {
    const tabRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const dragData = createPaneTabDragData({
      tabId: tab.id,
      tab,
      sourcePaneId,
      sourceIndex,
    });
    e.dataTransfer.setData('text/plain', tab.id);
    e.dataTransfer.setData('application/json', JSON.stringify(dragData));
    e.dataTransfer.effectAllowed = 'move';
    setActivePaneTabDragData(dragData);

    const tabInner = (e.currentTarget as HTMLElement).querySelector('.pane-tab-chip');
    if (!tabInner) return;

    const preview = tabInner.cloneNode(true) as HTMLElement;
    preview.style.position = 'fixed';
    preview.style.top = '-9999px';
    preview.style.left = '0';
    preview.style.height = 'var(--unit-element-height)';
    preview.style.width = `${tabRect.width}px`;
    preview.style.minWidth = `${tabRect.width}px`;
    preview.style.maxWidth = `${tabRect.width}px`;
    preview.style.boxSizing = 'border-box';
    preview.style.paddingLeft = 'var(--unit-padding)';
    preview.style.paddingRight = 'var(--unit-padding)';
    preview.style.backgroundColor = 'var(--background)';
    preview.style.border = 'var(--border-width) solid var(--border)';
    preview.style.borderRadius = 'var(--control-radius-lg)';
    preview.style.boxShadow = '0 8px 24px color-mix(in srgb, var(--foreground) 10%, transparent)';
    preview.style.display = 'flex';
    preview.style.alignItems = 'center';
    preview.style.gap = 'var(--unit-padding)';
    preview.style.pointerEvents = 'none';
    preview.querySelector('.tab-close-btn')?.remove();
    document.body.appendChild(preview);
    e.dataTransfer.setDragImage(preview, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    requestAnimationFrame(() => preview.remove());
  }, []);

  const handleTabDragEnd = useCallback((e: React.DragEvent<HTMLDivElement>, tabId: string) => {
    const endedOutsideViewport = (
      e.clientX <= 0
      || e.clientY <= 0
      || e.clientX >= window.innerWidth
      || e.clientY >= window.innerHeight
    );
    const shouldDetachTab = e.dataTransfer.dropEffect === 'none' && endedOutsideViewport;
    requestAnimationFrame(() => {
      clearActivePaneTabDragData();
    });
    if (!shouldDetachTab || !onDetachTab) {
      return;
    }
    void onDetachTab(tabId);
  }, [onDetachTab]);

  return (
    <div
      ref={tabBarRef}
      className="voice-focus-chrome voice-focus-chrome-collapse flex items-end gap-0 flex-shrink-0 overflow-visible"
      style={{ height: 'var(--unit-height)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      data-testid={`pane-tab-bar-${pane.id}`}
      data-animated-tab-strip="true"
      data-first-tab-active={shouldFillLeadingSpacer ? 'true' : undefined}
      data-leading-spacer-fill={shouldFillLeadingSpacer ? 'true' : undefined}
      data-flush-leading-edge={shouldFlattenLeadingEdge ? 'true' : undefined}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
      onDragLeave={() => setDropIndicator(null)}
      onDrop={(e) => { setDropIndicator(null); if (onDrop) onDrop(e); }}
    >
      {isTopLeft && <div className="tab-bar-leading-spacer flex-shrink-0 h-full" style={{ width: 'var(--tab-bar-left-spacer, 0px)', WebkitAppRegion: 'no-drag' } as React.CSSProperties} />}
      {pane.tabIds.map((tabId, index) => {
        const tab = tabs[tabId]; if (!tab) return null;
        const isActive = pane.activeTabId === tabId;
        const isRemoteEmptyTab = readOnlyWorkstation
          && isAgentTab(tab)
          && !tab.agent.session.codexThreadId
          && !tab.agent.session.initialMessage;
        const tabLabel = isRemoteEmptyTab ? t('menu.file.newTab') : tab.label;
        const canCloseTab = !(isSinglePane && pane.tabIds.length === 1 && isNewTabLike(tab));
        const activity = tab.type === 'agent' ? agentActivityById.get(tabId) : undefined;
        const agentIndicatorTone = tab.type === 'agent'
          ? getAgentIndicatorTone({
              hasPendingApproval: (pendingApprovalsByAgent.get(tabId) || 0) > 0,
              isRunning: activity?.isRunning ?? false,
              unreadCount: activity?.unreadCount ?? 0,
            })
          : undefined;
        const showLeft = dropIndicator?.tabId === tabId && dropIndicator.side === 'left';
        const showRight = dropIndicator?.tabId === tabId && dropIndicator.side === 'right';
        return (
          <div key={tabId}
            className={`content-tab group select-none relative ${isActive ? 'content-tab-active' : ''} ${index === 0 ? 'content-tab-first' : ''} ${index === 0 && isTopLeft ? 'content-tab-topleft' : ''} ${index === pane.tabIds.length - 1 ? 'content-tab-last' : ''}`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            data-testid={`pane-tab-${pane.id}-${tabId}`} data-tab-id={tabId} data-tab-path={tab.path || undefined} data-tab-label={tabLabel} data-tab-type={tab.type} data-active={isActive} role="tab" aria-selected={isActive} draggable={!remoteWorkstationMode}
            data-help-title={tabLabel}
            data-help-description={isRemoteEmptyTab ? t('help.tabs.newTab.description') : getTabHelpDescription(tab)}
            onClick={(e) => { e.stopPropagation(); onActivatePane(); onActivateTab(tabId); }}
            onMouseDown={(e) => {
              if (e.button !== 1 || !canCloseTab) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab(tabId);
            }}
            onContextMenu={(e) => handleContextMenu(e, tabId)}
            onDragStart={(e) => { if (!remoteWorkstationMode) handleTabDragStart(e, tab, pane.id, index); }}
            onDragEnd={(e) => { if (!remoteWorkstationMode) handleTabDragEnd(e, tabId); }}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); setDropIndicator({ tabId, side: e.clientX < rect.left + rect.width / 2 ? 'left' : 'right' }); }}
            onDragLeave={() => setDropIndicator(prev => prev?.tabId === tabId ? null : prev)}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDropIndicator(null); const draggedTabId = e.dataTransfer.getData('text/plain'); if (!draggedTabId || draggedTabId === tabId) return; const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); const insertAfter = e.clientX >= rect.left + rect.width / 2; const targetIndex = pane.tabIds.indexOf(tabId); const insertIndex = insertAfter ? targetIndex + 1 : targetIndex; const dragData = resolvePaneTabDragData(e.dataTransfer); const sourcePaneId = dragData?.sourcePaneId ?? null; const sidebarMeta = dragData?.sidebarMeta; if (onTabDrop) onTabDrop(draggedTabId, sourcePaneId, pane.id, 'center', insertIndex, sidebarMeta, dragData); }}>
            <div className="content-tab-inner pane-tab-chip cursor-default">
              <span className="size-4 flex items-center justify-center flex-shrink-0 relative">
                {(() => {
                  const globalNum = globalTabNumbers.get(tabId);
                  const sk = globalNum ? String(globalNum) : null;
                  const shortcutLabel = sk ? formatPrimaryShortcut(sk) : null;
                  const showKey = isCommandHeld && sk;
                  const isActivatedKey = sk ? activatedKey === sk : false;
                  return <>
                    <span className="transition-opacity duration-150 ease-out" style={{ opacity: showKey ? 0 : 1 }}>{getTabIcon(tab, agentIndicatorTone)}</span>
                    {sk && (
                      <span
                        data-command-overlay-shortcut={shortcutLabel ?? undefined}
                        className={`absolute inset-0 flex items-center justify-center text-ui-xs font-mono transition-opacity duration-150 ease-out ${isActivatedKey ? 'text-foreground/60' : 'text-muted-foreground/50'}`}
                        style={{ opacity: showKey ? 1 : 0 }}
                      >
                        {shortcutLabel}
                      </span>
                    )}
                  </>;
                })()}
              </span>
              <div className="flex-1 min-w-0 overflow-hidden text-ui-sm" style={{ maskImage: 'linear-gradient(to right, black 70%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to right, black 70%, transparent 100%)' }}>
                <span className="whitespace-nowrap">{tabLabel}</span>
              </div>
              {canCloseTab && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onCloseTab(tabId); }}
                  className="tab-close-btn size-4 flex items-center justify-center flex-shrink-0 text-muted-foreground hover:text-foreground rounded-sm hover:bg-hover"
                  aria-label={t('help.tabs.close.title', { label: tabLabel })}
                  data-help-title={t('help.tabs.close.title', { label: tabLabel })}
                  data-help-description={t('help.tabs.close.description')}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            {showLeft && <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full z-50 pointer-events-none" />}
            {showRight && <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full z-50 pointer-events-none" />}
          </div>
        );
      })}
      <div
        className="flex h-full flex-shrink-0 items-center"
        style={{ marginLeft: 'var(--unit-padding)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <TooltipWrapper
          tooltip={newTabLabel}
          helpDescription={newTabDescription}
          shortcut={formatPrimaryShortcut('T')}
          tooltipSide="right"
          tooltipSideOffset={1}
        >
          <button
            className="oa-hover-chip new-tab-button flex h-[var(--unit-element-height)] items-center justify-center px-[var(--unit-padding-small)] text-muted-foreground hover:text-foreground"
            onClick={(e) => { e.stopPropagation(); onNewTab(); }}
            aria-label={newTabLabel}
            data-testid={NEW_TAB_BUTTON_ID(pane.id)}
          >
            <span className="relative flex items-center justify-center px-[var(--unit-padding-small)]">
              <Plus className="size-4" />
              <span className={`absolute left-full ml-0.5 text-ui-xs font-mono transition-opacity duration-150 ease-out ${activatedKey === 'T' ? 'text-foreground/60' : 'text-muted-foreground/40'}`} style={{ opacity: isCommandHeld ? 1 : 0 }}>{formatPrimaryShortcut('T')}</span>
            </span>
          </button>
        </TooltipWrapper>
      </div>
      <div className="flex-1 h-full" style={{ WebkitAppRegion: tabBarDragRegionStyle } as React.CSSProperties} />
      {isTopRight && <div className="flex-shrink-0 h-full" ref={onTopRightPaddingRef} style={{ WebkitAppRegion: dragRegionStyle } as React.CSSProperties} />}
      <div className="flex-shrink-0 h-full" style={{ width: 40, WebkitAppRegion: 'no-drag' } as React.CSSProperties} />
    </div>
  );
}

// ============================================================================
// Tree Renderer
// ============================================================================

type TreeNodeRendererProps = {
  node: TreeNode; tabs: Record<string, Tab>; activePaneId: string | null; topLeftPaneId: string; topRightPaneId: string; isSinglePane: boolean; leftSidebarOpen: boolean; globalTabNumbers: Map<string, number>; pendingApprovalsByAgent: Map<string, number>; agentActivityById: Map<string, AgentActivityState>;
  onActivatePane: (paneId: string) => void; onActivateTab: (tabId: string) => void; onCloseTab: (tabId: string) => void;
  onNewTab: (paneId: string) => void; onSplitRight: (paneId: string, tabId: string) => void; onSplitDown: (paneId: string, tabId: string) => void;
  onRatioChange: (splitId: string, ratio: number) => void; onPaneRectChange: (paneId: string, rect: DOMRect | null) => void;
  onTabDrop: (tabId: string, sourcePaneId: string | null, targetPaneId: string, zone: 'center' | 'left' | 'right' | 'top' | 'bottom', index?: number, sidebarMeta?: any, dragData?: PaneTabDragData | null) => void;
  onDetachTab: (tabId: string) => void | Promise<void>;
  onTopRightPaddingRef?: (ref: HTMLDivElement | null) => void;
};

function PaneNodeRenderer({ node, tabs, activePaneId, topLeftPaneId, topRightPaneId, isSinglePane, leftSidebarOpen, globalTabNumbers, pendingApprovalsByAgent, agentActivityById, onActivatePane, onActivateTab, onCloseTab, onNewTab, onSplitRight, onSplitDown, onPaneRectChange, onTabDrop, onDetachTab, onTopRightPaddingRef }: TreeNodeRendererProps & { node: Pane }) {
  const isActivePane = activePaneId === node.id;
  const isTopLeft = node.id === topLeftPaneId;
  const hideTabBar = !isRemoteWorkstationMode()
    && shouldHideSingleAgentTabBar({ pane: node, tabs, isSinglePane });
  const isFirstTabActive = node.tabIds.length > 0 && node.activeTabId === node.tabIds[0];
  const firstTabAtEdge = isFirstTabActive && !(isTopLeft && !leftSidebarOpen);
  const flushLeadingEdge = isSinglePane && isTopLeft && leftSidebarOpen && isFirstTabActive;
  const paneShellRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const [shellMetrics, setShellMetrics] = useState<PaneShellMetrics | null>(null);
  const prevShellMetricsRef = useRef<PaneShellMetrics | null>(null);
  const tabIdsKey = useMemo(() => node.tabIds.join(','), [node.tabIds]);

  useLayoutEffect(() => {
    const shellEl = paneShellRef.current;
    const tabBarEl = tabBarRef.current;
    const contentEl = contentAreaRef.current;
    if (hideTabBar) {
      prevShellMetricsRef.current = null;
      setShellMetrics(null);
      return;
    }
    if (!shellEl || !tabBarEl || !contentEl) return;

    let frame = 0;
    let activeObserver: ResizeObserver | null = null;

    // Core measurement + update — can be called synchronously or from rAF
    const measureAndUpdate = () => {
      const activeTabEl = tabBarEl.querySelector<HTMLElement>('.content-tab-active');
      const tabBarRect = tabBarEl.getBoundingClientRect();
      const contentRect = contentEl.getBoundingClientRect();
      const activeRect = activeTabEl?.getBoundingClientRect();
      const styles = getComputedStyle(shellEl);
      const radius = parseFloat(styles.getPropertyValue('--control-radius-lg')) || 12;
      const borderWidth = parseFloat(styles.getPropertyValue('--border-width')) || 0.5;

      // Hard clamp: ensure the tab can NEVER be drawn under the traffic lights.
      // minTabLeft = how far right (in pane coords) the tab must be to clear the traffic lights.
      const paneLeft = tabBarRect.left;
      const trafficClearance = parseFloat(styles.getPropertyValue('--traffic-lights-width')) || 0;
      const minTabLeft = Math.max(0, trafficClearance + 8 - paneLeft);
      const rawTabLeft = activeRect ? activeRect.left - tabBarRect.left : 0;

      const next: PaneShellMetrics = {
        width: contentRect.width,
        height: tabBarRect.height + contentRect.height,
        contentTop: tabBarRect.height,
        tabLeft: Math.max(rawTabLeft, minTabLeft),
        tabWidth: activeRect?.width ?? 0,
        radius,
        borderWidth,
        flushLeadingEdge,
      };

      // Skip update if nothing actually changed
      const prev = prevShellMetricsRef.current;
      if (
        prev &&
        prev.width === next.width &&
        prev.height === next.height &&
        prev.contentTop === next.contentTop &&
        prev.tabLeft === next.tabLeft &&
        prev.tabWidth === next.tabWidth &&
        prev.radius === next.radius &&
        prev.borderWidth === next.borderWidth &&
        prev.flushLeadingEdge === next.flushLeadingEdge
      ) {
        return;
      }
      prevShellMetricsRef.current = next;

      // Use imperative update when SVG is mounted (bypasses React re-renders during animation).
      // First update must go through React state so PaneShellChrome renders the SVG.
      const imperativeMap = (window as any).__paneShellImperative as Map<string, (m: PaneShellMetrics) => void> | undefined;
      const imperativeFn = prev ? imperativeMap?.get(node.id) : undefined;
      if (imperativeFn) {
        imperativeFn(next);
      } else {
        setShellMetrics(next);
      }

      activeObserver?.disconnect();
      if (activeTabEl) {
        activeObserver = new ResizeObserver(scheduleUpdate);
        activeObserver.observe(activeTabEl);
      }
    };

    // Debounced version for ResizeObserver (avoids thrashing)
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measureAndUpdate);
    };

    // Register synchronous measure function so App.tsx can call it during sidebar animation
    const paneShellWindow = window as any;
    if (!paneShellWindow.__paneShellSync) {
      paneShellWindow.__paneShellSync = new Map();
    }
    const syncMap = paneShellWindow.__paneShellSync as Map<string, () => void>;
    syncMap.set(node.id, measureAndUpdate);

    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(shellEl);
    observer.observe(tabBarEl);
    observer.observe(contentEl);
    scheduleUpdate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      activeObserver?.disconnect();
      syncMap.delete(node.id);
    };
  }, [flushLeadingEdge, hideTabBar, node.activeTabId, node.id, tabIdsKey]);

  const handleActivatePane = useCallback(() => onActivatePane(node.id), [onActivatePane, node.id]);
  const handleNewTab = useCallback(() => onNewTab(node.id), [onNewTab, node.id]);
  const handleSplitRight = useCallback((tabId: string) => onSplitRight(node.id, tabId), [onSplitRight, node.id]);
  const handleSplitDown = useCallback((tabId: string) => onSplitDown(node.id, tabId), [onSplitDown, node.id]);
  const handleTabBarDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); const tabId = e.dataTransfer.getData('text/plain'); if (tabId) { const dragData = resolvePaneTabDragData(e.dataTransfer); onTabDrop(tabId, dragData?.sourcePaneId ?? null, node.id, 'center', undefined, dragData?.sidebarMeta, dragData); } }, [onTabDrop, node.id]);
  const handlePaneActivateTab = useCallback((_: string, tabId: string) => onActivateTab(tabId), [onActivateTab]);

  return (
    <div ref={paneShellRef} className="pane-shell flex flex-col h-full w-full relative overflow-visible" data-pane-id={node.id} data-single-agent-pane={hideTabBar || undefined}>
      {!hideTabBar && <PaneShellChrome metrics={shellMetrics} paneId={node.id} />}
      {!hideTabBar && (
        <PaneTabBar pane={node} tabs={tabs} isActivePane={isActivePane} isTopLeft={isTopLeft} isTopRight={node.id === topRightPaneId} isSinglePane={isSinglePane} leftSidebarOpen={leftSidebarOpen} tabBarRef={tabBarRef} onTopRightPaddingRef={onTopRightPaddingRef} globalTabNumbers={globalTabNumbers} pendingApprovalsByAgent={pendingApprovalsByAgent} agentActivityById={agentActivityById}
          onActivateTab={onActivateTab} onCloseTab={onCloseTab} onActivatePane={handleActivatePane} onNewTab={handleNewTab}
          onSplitRight={handleSplitRight} onSplitDown={handleSplitDown} onTabDrop={onTabDrop} onDetachTab={onDetachTab}
          onDrop={handleTabBarDrop} />
      )}
      <div ref={contentAreaRef} className="content-area-wrapper flex-1 min-h-0 relative" style={{ padding: 0, backgroundColor: 'transparent' }} data-first-tab-active={!hideTabBar && firstTabAtEdge || undefined} data-flush-leading-edge={!hideTabBar && flushLeadingEdge || undefined}>
        <div className="content-area-container h-full overflow-hidden flex flex-col">
          <PaneView pane={node} tabs={tabs} isActive={isActivePane} onActivatePane={onActivatePane} onActivateTab={handlePaneActivateTab} onCloseTab={onCloseTab} onPaneRectChange={onPaneRectChange} onTabDrop={onTabDrop} />
        </div>
      </div>
    </div>
  );
}

function TreeNodeRenderer({ node, tabs, activePaneId, topLeftPaneId, topRightPaneId, isSinglePane, leftSidebarOpen, globalTabNumbers, pendingApprovalsByAgent, agentActivityById, onActivatePane, onActivateTab, onCloseTab, onNewTab, onSplitRight, onSplitDown, onRatioChange, onPaneRectChange, onTabDrop, onDetachTab, onTopRightPaddingRef }: TreeNodeRendererProps) {
  if (isPane(node)) {
    return (
      <PaneNodeRenderer
        node={node}
        tabs={tabs}
        activePaneId={activePaneId}
        topLeftPaneId={topLeftPaneId}
        topRightPaneId={topRightPaneId}
        isSinglePane={isSinglePane}
        leftSidebarOpen={leftSidebarOpen}
               globalTabNumbers={globalTabNumbers}
        pendingApprovalsByAgent={pendingApprovalsByAgent}
        agentActivityById={agentActivityById}
        onActivatePane={onActivatePane}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        onRatioChange={onRatioChange}
        onPaneRectChange={onPaneRectChange}
        onTabDrop={onTabDrop}
        onDetachTab={onDetachTab}
        onTopRightPaddingRef={onTopRightPaddingRef}
      />
    );
  }
  return (
    <SplitView node={node} onRatioChange={onRatioChange}>
      {[
        <TreeNodeRenderer key={node.children[0].id} node={node.children[0]} tabs={tabs} activePaneId={activePaneId} topLeftPaneId={topLeftPaneId} topRightPaneId={topRightPaneId} isSinglePane={isSinglePane} leftSidebarOpen={leftSidebarOpen} globalTabNumbers={globalTabNumbers} pendingApprovalsByAgent={pendingApprovalsByAgent} agentActivityById={agentActivityById} onActivatePane={onActivatePane} onActivateTab={onActivateTab} onCloseTab={onCloseTab} onNewTab={onNewTab} onSplitRight={onSplitRight} onSplitDown={onSplitDown} onRatioChange={onRatioChange} onPaneRectChange={onPaneRectChange} onTabDrop={onTabDrop} onDetachTab={onDetachTab} onTopRightPaddingRef={onTopRightPaddingRef} />,
        <TreeNodeRenderer key={node.children[1].id} node={node.children[1]} tabs={tabs} activePaneId={activePaneId} topLeftPaneId={topLeftPaneId} topRightPaneId={topRightPaneId} isSinglePane={isSinglePane} leftSidebarOpen={leftSidebarOpen} globalTabNumbers={globalTabNumbers} pendingApprovalsByAgent={pendingApprovalsByAgent} agentActivityById={agentActivityById} onActivatePane={onActivatePane} onActivateTab={onActivateTab} onCloseTab={onCloseTab} onNewTab={onNewTab} onSplitRight={onSplitRight} onSplitDown={onSplitDown} onRatioChange={onRatioChange} onPaneRectChange={onPaneRectChange} onTabDrop={onTabDrop} onDetachTab={onDetachTab} onTopRightPaddingRef={onTopRightPaddingRef} />,
      ]}
    </SplitView>
  );
}

// ============================================================================
// EditorLayout (main export)
// ============================================================================

interface EditorLayoutProps {
  onTopRightPaddingRef?: (ref: HTMLDivElement | null) => void;
}

export default function EditorLayout({ onTopRightPaddingRef }: EditorLayoutProps) {
  const { state, closeTab, setActiveTab, setActivePaneId, openNewTab, splitPaneAction, updateSplitRatioAction, updatePaneRect, handleTabDrop, detachTabToNewWindow } = useLayout();
  const handleSplitRight = useCallback((paneId: string, tabId: string) => splitPaneAction(paneId, 'horizontal', 'after', tabId), [splitPaneAction]);
  const handleSplitDown = useCallback((paneId: string, tabId: string) => splitPaneAction(paneId, 'vertical', 'after', tabId), [splitPaneAction]);
  const handleDetachTab = useCallback((tabId: string) => {
    void detachTabToNewWindow(tabId);
  }, [detachTabToNewWindow]);
  const topLeftPaneId = getTopLeftPaneId(state.tree);
  const topRightPaneId = getTopRightPaneId(state.tree);
  const isSinglePane = isPane(state.tree);
  const globalTabNumbers = useMemo(
    () => buildGlobalTabNumbers({ tree: state.tree, sidebarPane: state.sidebarPane }),
    [state.tree, state.sidebarPane],
  );
  const pendingApprovalsByAgent = usePendingApprovalsByAgent();
  const agentActivityById = useAgentActivityMap();

  return (
    <div className="flex-1 flex flex-col h-full min-w-0" data-testid={EDITOR_LAYOUT_ID} style={{ padding: 0 }}>
      <TreeNodeRenderer node={state.tree} tabs={state.tabs} activePaneId={state.activePaneId} topLeftPaneId={topLeftPaneId} topRightPaneId={topRightPaneId} isSinglePane={isSinglePane} leftSidebarOpen={state.leftSidebar.isOpen} globalTabNumbers={globalTabNumbers} pendingApprovalsByAgent={pendingApprovalsByAgent} agentActivityById={agentActivityById}
        onActivatePane={setActivePaneId} onActivateTab={setActiveTab} onCloseTab={closeTab} onNewTab={openNewTab}
        onSplitRight={handleSplitRight} onSplitDown={handleSplitDown} onRatioChange={updateSplitRatioAction} onPaneRectChange={updatePaneRect} onTabDrop={handleTabDrop} onDetachTab={handleDetachTab} onTopRightPaddingRef={onTopRightPaddingRef} />
    </div>
  );
}

export { EditorLayout };
