import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { flushSync } from 'react-dom';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { InputPanel } from './InputPanel.js';
import { Pill } from './Pill.js';
import { ReviewPanel } from './ReviewPanel.js';
import { ScopeSelectionSheen } from './ScopeSelectionSheen.js';
import { TraceOverlay } from './TraceOverlay.js';
import { TypePreviewOverlay } from './TypePreviewOverlay.js';
import { AgentDashboardTrack } from './AgentDashboardTrack.js';
import { getNewContextSourceHighlights, type ContextSourceHighlight } from './context-source-highlight.js';
import { boundsIntersect, clampBoundsToBounds, hasMeaningfulScope, normalizeDragBounds } from '../shared/scope.js';
import type {
  Bounds,
  OverlayAction,
  OverlayBootstrapData,
  OverlayContextItem,
  OverlayRegionContextItem,
  OverlaySelectionElement,
  OverlayState,
  OverlayUserAttachment,
  OverlayVisualHealth,
  ReviewAction,
} from '../shared/ipc.js';
import {
  DEFAULT_OVERLAY_STATE,
} from '../shared/ipc.js';
import {
  getInterpreterOverlayScopeFillColor,
  INTERPRETER_OVERLAY_INPUT_DESIGN,
} from '../shared/design.js';
import './styles.css';

type OverlayContextSourceHighlightStyle = CSSProperties & {
  '--overlay-context-source-color': string;
};

const PILL_VIEWPORT_MARGIN = 12;
const PILL_BOTTOM_OFFSET = 24;
const SCOPE_TOOLTIP_OFFSET_X = 10;
const SCOPE_TOOLTIP_OFFSET_Y = 12;
const SCOPE_TOOLTIP_SIZE: Size = { width: 270, height: 34 };
const SCOPE_STATUS_TOOLTIP_SIZE: Size = { width: 236, height: 32 };
const CONTROL_TOOLTIP_GAP = 10;
const INPUT_TOOLTIP_SUPPRESS_HEIGHT = 180;
const OVERLAY_PRESENTATION_MS = 100;
const INPUT_OVERLAY_FADE_MS = OVERLAY_PRESENTATION_MS;
const SCOPE_SURFACE_FADE_MS = OVERLAY_PRESENTATION_MS;
const RENDERER_HEALTH_HEARTBEAT_MS = 1000;
const SCOPE_HANDLE_SIZE = 9;
const MIN_SCOPE_SIZE_PX = 24;
// Forgiving enough for trackpad click wobble; far below the minimum drag that
// creates a selection, so there is no ambiguity with box drawing.
const CLICK_DISMISS_MAX_DISTANCE_PX = 12;
const NO_WORKSPACE_VALUE = '__overlay-no-workspace__';
const SHARED_OBJECT_EASE = [0.16, 1, 0.3, 1] as const;
const SHARED_OBJECT_MOTION = {
  type: 'spring',
  stiffness: 520,
  damping: 40,
  mass: 0.86,
} as const;
const SHARED_OBJECT_OPACITY = {
  duration: OVERLAY_PRESENTATION_MS / 1000,
  ease: SHARED_OBJECT_EASE,
} as const;
const SHEEN_CONTAINER_ROLES = new Set([
  'AXLayoutArea',
  'AXScrollArea',
  'AXWebArea',
  'AXToolbar',
  'AXSplitGroup',
  'AXTabGroup',
  'AXList',
  'AXOutline',
  'AXTable',
]);
interface Size {
  width: number;
  height: number;
}

interface Point {
  left: number;
  top: number;
}

interface DragGestureState {
  pointerId: number;
  startX: number;
  startY: number;
  maxDistancePx: number;
}

interface ScopedSelectionPreview {
  id: string;
  role: string;
  label: string;
  bounds: Bounds;
}

interface HoverTooltipState {
  id: string;
  label: string;
  shortcut: string | null;
  shortcutPrefix: string | null;
  position: Point;
}

interface OverlayWorkspaceTarget {
  value: string;
  label: string;
  workspacePath: string | null;
  targetWindowSessionKey: string | null;
}

type ScopeResizeHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

interface ScopeEditorGesture {
  mode: 'move' | 'resize';
  pointerId: number;
  startPointer: { x: number; y: number };
  startBounds: Bounds;
  target: HTMLButtonElement;
  handle?: ScopeResizeHandle;
}

const SCOPE_RESIZE_HANDLES: ScopeResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function equalBounds(
  left: ReviewAction['bounds'] | null | undefined,
  right: ReviewAction['bounds'] | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
  );
}

function equalReviewAction(left: ReviewAction | null, right: ReviewAction | null): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.id === right.id
    && left.type === right.type
    && left.description === right.description
    && left.detail === right.detail
    && left.centerColor === right.centerColor
    && left.text === right.text
    && left.currentValue === right.currentValue
    && left.keys === right.keys
    && left.showLabel === right.showLabel
    && left.hasBounds === right.hasBounds
    && equalBounds(left.bounds, right.bounds)
  );
}

function hasRenderableTargetBounds(action: ReviewAction | null | undefined): action is ReviewAction {
  return Boolean(
    action
    && action.hasBounds
    && action.bounds.width > 0
    && action.bounds.height > 0,
  );
}

function equalReviewActions(left: ReviewAction[], right: ReviewAction[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }

  return left.every((action, index) => equalReviewAction(action, right[index] ?? null));
}

function equalPill(
  left: OverlayState['pill'],
  right: OverlayState['pill'],
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === 'loading' && right.kind === 'loading') {
    return left.label === right.label;
  }

  if (left.kind === 'review' && right.kind === 'review') {
    return left.hotkeyLabel === right.hotkeyLabel;
  }

  if (left.kind === 'error' && right.kind === 'error') {
    return left.message === right.message;
  }

  if (left.kind === 'message' && right.kind === 'message') {
    return left.message === right.message;
  }

  return true;
}

function equalSelectionElement(
  left: OverlaySelectionElement,
  right: OverlaySelectionElement,
): boolean {
  return (
    left.id === right.id
    && left.role === right.role
    && left.label === right.label
    && JSON.stringify(left.browser ?? null) === JSON.stringify(right.browser ?? null)
    && equalBounds(left.bounds, right.bounds)
  );
}

function equalSelectionElements(
  left: OverlaySelectionElement[],
  right: OverlaySelectionElement[],
): boolean {
  if (left === right) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  return left.every((element, index) => equalSelectionElement(element, right[index] ?? element));
}

function equalContextItem(left: OverlayContextItem, right: OverlayContextItem): boolean {
  if (left.kind !== right.kind || left.role !== right.role || left.id !== right.id) {
    return false;
  }
  if (left.kind === 'region' && right.kind === 'region') {
    return (
      left.label === right.label
      && left.displayId === right.displayId
      && left.targetWindowSessionKey === right.targetWindowSessionKey
      && JSON.stringify(left.targetIdentity) === JSON.stringify(right.targetIdentity)
      && JSON.stringify(left.snapshot) === JSON.stringify(right.snapshot)
      && left.previewText === right.previewText
      && left.previewImageDataUrl === right.previewImageDataUrl
      && equalBounds(left.bounds, right.bounds)
      && equalSelectionElements(left.selectableElements ?? [], right.selectableElements ?? [])
    );
  }
  if (left.kind === 'file' && right.kind === 'file') {
    return (
      left.name === right.name
      && left.mimeType === right.mimeType
      && left.sizeBytes === right.sizeBytes
      && left.filePath === right.filePath
      && left.dataUrl === right.dataUrl
      && left.sourceKind === right.sourceKind
      && left.sourceLabel === right.sourceLabel
      && left.sourceDisplayId === right.sourceDisplayId
      && equalBounds(left.sourceBounds ?? null, right.sourceBounds ?? null)
    );
  }
  return false;
}

function equalContextItems(left: OverlayContextItem[], right: OverlayContextItem[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => equalContextItem(item, right[index] ?? item));
}

function equalVisualProbe(
  left: OverlayState['debugVisualProbe'],
  right: OverlayState['debugVisualProbe'],
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.id === right.id
    && left.dataUrl === right.dataUrl
    && left.label === right.label
    && equalBounds(left.bounds, right.bounds)
  );
}

function workspaceValueForSession(sessionKey: string): string {
  return `window:${sessionKey}`;
}

function workspaceValueForPath(workspacePath: string): string {
  return `path:${workspacePath}`;
}

function buildWorkspaceTargets(
  bootstrap: OverlayBootstrapData | null,
): OverlayWorkspaceTarget[] {
  const targets: OverlayWorkspaceTarget[] = [{
    value: NO_WORKSPACE_VALUE,
    label: 'No workspace',
    workspacePath: null,
    targetWindowSessionKey: null,
  }];

  if (!bootstrap) {
    return targets;
  }

  const seenPaths = new Set<string>();

  for (const openWorkspace of bootstrap.openWorkspaces) {
    targets.push({
      value: workspaceValueForSession(openWorkspace.sessionKey),
      label: openWorkspace.label,
      workspacePath: openWorkspace.workspacePath,
      targetWindowSessionKey: openWorkspace.sessionKey,
    });
    seenPaths.add(openWorkspace.workspacePath);
  }

  const extraPathCandidates: Array<{ workspacePath: string; workspaceName: string; label: string }> = [
    ...bootstrap.recentWorkspaces,
  ];
  if (
    bootstrap.currentWorkspacePath
    && !seenPaths.has(bootstrap.currentWorkspacePath)
  ) {
    extraPathCandidates.unshift({
      workspacePath: bootstrap.currentWorkspacePath,
      workspaceName: bootstrap.currentWorkspaceName ?? bootstrap.currentWorkspacePath,
      label: bootstrap.currentWorkspaceName ?? bootstrap.currentWorkspacePath,
    });
  }
  if (
    bootstrap.preferredWorkspacePath
    && !bootstrap.preferredNoWorkspace
    && !seenPaths.has(bootstrap.preferredWorkspacePath)
  ) {
    extraPathCandidates.unshift({
      workspacePath: bootstrap.preferredWorkspacePath,
      workspaceName: bootstrap.preferredWorkspaceName ?? bootstrap.preferredWorkspacePath,
      label: bootstrap.preferredWorkspaceName ?? bootstrap.preferredWorkspacePath,
    });
  }
  const seenRecentPaths = new Set<string>();
  for (const workspaceOption of extraPathCandidates) {
    if (seenPaths.has(workspaceOption.workspacePath) || seenRecentPaths.has(workspaceOption.workspacePath)) {
      continue;
    }

    seenRecentPaths.add(workspaceOption.workspacePath);
    targets.push({
      value: workspaceValueForPath(workspaceOption.workspacePath),
      label: workspaceOption.label,
      workspacePath: workspaceOption.workspacePath,
      targetWindowSessionKey: null,
    });
  }

  return targets;
}

function selectDefaultWorkspaceValue(
  bootstrap: OverlayBootstrapData | null,
  workspaceTargets: OverlayWorkspaceTarget[],
): string {
  if (!bootstrap?.currentWorkspacePath) {
    return NO_WORKSPACE_VALUE;
  }

  const matchingOpenTarget = workspaceTargets.find((target) => (
    target.workspacePath === bootstrap.currentWorkspacePath
    && target.targetWindowSessionKey !== null
  ));
  if (matchingOpenTarget) {
    return matchingOpenTarget.value;
  }

  const matchingPathTarget = workspaceTargets.find((target) => (
    target.workspacePath === bootstrap.currentWorkspacePath
  ));
  if (matchingPathTarget) {
    return matchingPathTarget.value;
  }

  return NO_WORKSPACE_VALUE;
}

interface ProfileSelectionProfile {
  id: string;
  kind?: string;
}

interface ResolvePreferredProfileIdParams {
  profiles: ProfileSelectionProfile[];
  preferredProfileId: string | null;
  defaultProfileId: string | null;
}

function resolvePreferredProfileId(params: ResolvePreferredProfileIdParams): string {
  const { profiles, preferredProfileId, defaultProfileId } = params;
  const hasProfile = (id: string | null | undefined) => Boolean(id && profiles.some((profile) => profile.id === id));

  if (hasProfile(preferredProfileId)) {
    return preferredProfileId as string;
  }

  if (hasProfile(defaultProfileId)) {
    return defaultProfileId as string;
  }

  return (
    profiles.find((profile) => profile.kind === 'agent')?.id
    ?? profiles[0]?.id
    ?? ''
  );
}

function getScopeHoleRadius(bounds: Bounds): number {
  void bounds;
  return 0;
}

function getSheenTierForRole(role: string): 'container' | 'control' {
  return SHEEN_CONTAINER_ROLES.has(role) ? 'container' : 'control';
}

function equalRunningAgents(left: OverlayState['runningAgents'], right: OverlayState['runningAgents']): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((agent, index) => {
    const other = right[index];
    return Boolean(other)
      && agent.agentId === other.agentId
      && agent.threadId === other.threadId
      && agent.windowSessionKey === other.windowSessionKey
      && agent.workspacePath === other.workspacePath
      && agent.label === other.label
      && agent.latestAction === other.latestAction
      && agent.unreadCount === other.unreadCount
      && agent.updatedAt === other.updatedAt;
  });
}

function equalDashboardApprovals(
  left: OverlayState['dashboardApprovals'],
  right: OverlayState['dashboardApprovals'],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((approval, index) => {
    const other = right[index];
    return Boolean(other)
      && approval.id === other.id
      && approval.ownerAgentId === other.ownerAgentId
      && approval.ownerKind === other.ownerKind
      && approval.ownerDisplayName === other.ownerDisplayName
      && approval.ownerColor === other.ownerColor
      && approval.title === other.title
      && approval.detail === other.detail
      && approval.isSimpleApproval === other.isSimpleApproval
      && approval.supportsSessionApproval === other.supportsSessionApproval
      && approval.timestamp === other.timestamp;
  });
}

function equalOverlayState(left: OverlayState, right: OverlayState): boolean {
  return (
    left.mode === right.mode
    && equalPill(left.pill, right.pill)
    && equalReviewAction(left.action, right.action)
    && equalReviewActions(left.ghosts, right.ghosts)
    && left.screenshot === right.screenshot
    && left.transcript === right.transcript
    && left.isRecording === right.isRecording
    && left.amplitude === right.amplitude
    && left.ctrlPressed === right.ctrlPressed
    && left.shiftPressed === right.shiftPressed
    && equalBounds(left.scopeBounds, right.scopeBounds)
    && equalSelectionElements(left.selectableElements, right.selectableElements)
    && equalContextItems(left.contextItems, right.contextItems)
    && left.activeRegionRole === right.activeRegionRole
    && left.targetContextId === right.targetContextId
    && left.displayScaleFactor === right.displayScaleFactor
    && equalBounds(left.displayWorkArea, right.displayWorkArea)
    && left.tracePrimaryColor === right.tracePrimaryColor
    && left.worldPinActive === right.worldPinActive
    && equalBounds(left.worldTargetBounds, right.worldTargetBounds)
    && equalVisualProbe(left.debugVisualProbe, right.debugVisualProbe)
    && left.debugExecutionSentinel === right.debugExecutionSentinel
    && left.advancedVoiceActive === right.advancedVoiceActive
    && left.advancedVoiceSessionKind === right.advancedVoiceSessionKind
    && left.advancedVoiceCompletionNotice?.id === right.advancedVoiceCompletionNotice?.id
    && left.globalApproval?.id === right.globalApproval?.id
    && left.globalApproval?.title === right.globalApproval?.title
    && left.globalApproval?.detail === right.globalApproval?.detail
    && left.globalApproval?.supportsSessionApproval === right.globalApproval?.supportsSessionApproval
    && equalRunningAgents(left.runningAgents, right.runningAgents)
    && equalDashboardApprovals(left.dashboardApprovals, right.dashboardApprovals)
  );
}

function clampTooltipPosition(position: Point, tooltipSize: Size, viewportSize: Size): Point {
  return {
    left: Math.min(
      Math.max(PILL_VIEWPORT_MARGIN, position.left),
      Math.max(PILL_VIEWPORT_MARGIN, viewportSize.width - tooltipSize.width - PILL_VIEWPORT_MARGIN),
    ),
    top: Math.min(
      Math.max(PILL_VIEWPORT_MARGIN, position.top),
      Math.max(PILL_VIEWPORT_MARGIN, viewportSize.height - tooltipSize.height - PILL_VIEWPORT_MARGIN),
    ),
  };
}

function isPointInsideBounds(point: { x: number; y: number }, bounds: Bounds): boolean {
  return (
    point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height
  );
}

function clampScopeBounds(bounds: Bounds, container: Bounds): Bounds {
  const maxWidth = Math.max(MIN_SCOPE_SIZE_PX, container.width);
  const maxHeight = Math.max(MIN_SCOPE_SIZE_PX, container.height);
  const width = Math.min(Math.max(bounds.width, MIN_SCOPE_SIZE_PX), maxWidth);
  const height = Math.min(Math.max(bounds.height, MIN_SCOPE_SIZE_PX), maxHeight);

  return {
    x: clamp(bounds.x, container.x, container.x + container.width - width),
    y: clamp(bounds.y, container.y, container.y + container.height - height),
    width,
    height,
  };
}

function getPointerTravelDistance(start: { x: number; y: number }, current: { x: number; y: number }): number {
  return Math.hypot(current.x - start.x, current.y - start.y);
}

function buildCreateBounds(
  start: { x: number; y: number },
  current: { x: number; y: number },
  container: Bounds,
): Bounds {
  return clampBoundsToBounds(normalizeDragBounds(start, current), container);
}

function translateScopeBounds(bounds: Bounds, dx: number, dy: number, container: Bounds): Bounds {
  return clampScopeBounds(
    {
      x: bounds.x + dx,
      y: bounds.y + dy,
      width: bounds.width,
      height: bounds.height,
    },
    container,
  );
}

function resizeScopeBounds(
  bounds: Bounds,
  handle: ScopeResizeHandle,
  dx: number,
  dy: number,
  container: Bounds,
  centered: boolean,
): Bounds {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const containerRight = container.x + container.width;
  const containerBottom = container.y + container.height;

  if (centered) {
    let width = bounds.width;
    let height = bounds.height;

    if (handle.includes('e')) {
      width = (bounds.width / 2 + dx) * 2;
    } else if (handle.includes('w')) {
      width = (bounds.width / 2 - dx) * 2;
    }

    if (handle.includes('s')) {
      height = (bounds.height / 2 + dy) * 2;
    } else if (handle.includes('n')) {
      height = (bounds.height / 2 - dy) * 2;
    }

    const maxWidth = Math.min((centerX - container.x) * 2, (containerRight - centerX) * 2);
    const maxHeight = Math.min((centerY - container.y) * 2, (containerBottom - centerY) * 2);
    const clampedWidth = Math.min(Math.max(width, MIN_SCOPE_SIZE_PX), Math.max(MIN_SCOPE_SIZE_PX, maxWidth));
    const clampedHeight = Math.min(Math.max(height, MIN_SCOPE_SIZE_PX), Math.max(MIN_SCOPE_SIZE_PX, maxHeight));

    return {
      x: centerX - clampedWidth / 2,
      y: centerY - clampedHeight / 2,
      width: clampedWidth,
      height: clampedHeight,
    };
  }

  let left = bounds.x;
  let right = bounds.x + bounds.width;
  let top = bounds.y;
  let bottom = bounds.y + bounds.height;

  if (handle.includes('w')) {
    left = clamp(bounds.x + dx, container.x, right - MIN_SCOPE_SIZE_PX);
  }
  if (handle.includes('e')) {
    right = clamp(bounds.x + bounds.width + dx, left + MIN_SCOPE_SIZE_PX, containerRight);
  }
  if (handle.includes('n')) {
    top = clamp(bounds.y + dy, container.y, bottom - MIN_SCOPE_SIZE_PX);
  }
  if (handle.includes('s')) {
    bottom = clamp(bounds.y + bounds.height + dy, top + MIN_SCOPE_SIZE_PX, containerBottom);
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function getScopeStatusTooltipPosition(bounds: Bounds, viewportSize: Size): Point {
  const centeredLeft = bounds.x + (bounds.width / 2) - (SCOPE_STATUS_TOOLTIP_SIZE.width / 2);
  const aboveTop = bounds.y - SCOPE_STATUS_TOOLTIP_SIZE.height - CONTROL_TOOLTIP_GAP;
  const belowTop = bounds.y + bounds.height + CONTROL_TOOLTIP_GAP;
  const availableAbove = bounds.y - PILL_VIEWPORT_MARGIN;
  const availableBelow = viewportSize.height - (bounds.y + bounds.height) - PILL_VIEWPORT_MARGIN;
  const shouldPlaceBelow = availableAbove < SCOPE_STATUS_TOOLTIP_SIZE.height + CONTROL_TOOLTIP_GAP
    && availableBelow >= availableAbove;

  return clampTooltipPosition(
    {
      left: centeredLeft,
      top: shouldPlaceBelow ? belowTop : aboveTop,
    },
    SCOPE_STATUS_TOOLTIP_SIZE,
    viewportSize,
  );
}

function estimateHoverTooltipSize(
  label: string,
  shortcut: string | null,
  shortcutPrefix: string | null,
): Size {
  const shortcutWidth = shortcut ? (shortcut.length * 7) + (shortcutPrefix ? 42 : 28) : 0;
  return {
    width: Math.max(88, Math.min(260, Math.round((label.length * 7.4) + shortcutWidth + 26))),
    height: shortcut ? 38 : 32,
  };
}

function getHoverTooltipPosition(
  rect: DOMRect,
  viewportSize: Size,
  label: string,
  shortcut: string | null,
  shortcutPrefix: string | null,
): Point {
  const tooltipSize = estimateHoverTooltipSize(label, shortcut, shortcutPrefix);
  return clampTooltipPosition(
    {
      left: rect.left + (rect.width / 2) - (tooltipSize.width / 2),
      top: rect.top - tooltipSize.height - CONTROL_TOOLTIP_GAP,
    },
    tooltipSize,
    viewportSize,
  );
}

// Moving the selection grabs the border band, not the interior. The interior
// must stay click-through so a plain click inside a large selection (for
// example the automatic whole-window box) still dismisses the overlay, and a
// drag still starts a fresh selection.
function getScopeMoveEdgeBands(bounds: Bounds): Bounds[] {
  const band = Math.min(16, Math.max(10, Math.min(bounds.width, bounds.height) * 0.08));
  const innerHeight = Math.max(0, bounds.height - band * 2);
  return [
    { x: bounds.x, y: bounds.y, width: bounds.width, height: band },
    { x: bounds.x, y: bounds.y + bounds.height - band, width: bounds.width, height: band },
    { x: bounds.x, y: bounds.y + band, width: band, height: innerHeight },
    { x: bounds.x + bounds.width - band, y: bounds.y + band, width: band, height: innerHeight },
  ].filter((rect) => rect.width > 0 && rect.height > 0);
}

function getScopeHandlePosition(bounds: Bounds, handle: ScopeResizeHandle): { left: number; top: number } {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  switch (handle) {
    case 'n':
      return { left: centerX, top: bounds.y };
    case 's':
      return { left: centerX, top: bounds.y + bounds.height };
    case 'e':
      return { left: bounds.x + bounds.width, top: centerY };
    case 'w':
      return { left: bounds.x, top: centerY };
    case 'nw':
      return { left: bounds.x, top: bounds.y };
    case 'ne':
      return { left: bounds.x + bounds.width, top: bounds.y };
    case 'sw':
      return { left: bounds.x, top: bounds.y + bounds.height };
    case 'se':
      return { left: bounds.x + bounds.width, top: bounds.y + bounds.height };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// The one interaction pill is anchored bottom-center and must stay inside the
// display workArea (never under the macOS menu bar/notch or the Dock). The
// workArea rect arrives in overlay-window-local coordinates; when it is not
// known yet, fall back to the viewport.
function getBottomPillAnchor(
  pillSize: Size,
  viewportSize: Size,
  workArea: Bounds | null,
): Point {
  const area = workArea ?? { x: 0, y: 0, width: viewportSize.width, height: viewportSize.height };
  const minLeft = area.x + PILL_VIEWPORT_MARGIN;
  const maxLeft = Math.max(minLeft, area.x + area.width - pillSize.width - PILL_VIEWPORT_MARGIN);
  const minTop = area.y + PILL_VIEWPORT_MARGIN;
  const maxTop = Math.max(minTop, area.y + area.height - pillSize.height - PILL_VIEWPORT_MARGIN);

  return {
    left: clamp(area.x + (area.width - pillSize.width) / 2, minLeft, maxLeft),
    top: clamp(area.y + area.height - pillSize.height - PILL_BOTTOM_OFFSET, minTop, maxTop),
  };
}

// Progress for the executing pill state ("Typing · 3/15"). The reviewed plan
// length pins the total; the remaining ghosts give the current position.
function getExecutionPillProgress(params: {
  pillLabel: string | undefined;
  hasActiveAction: boolean;
  ghostCount: number;
  plannedActionCount: number;
}): { label: string; current: number; total: number } | null {
  if (!params.hasActiveAction) {
    return null;
  }

  const liveCount = 1 + params.ghostCount;
  const total = Math.max(params.plannedActionCount, liveCount, 1);
  const current = Math.min(total, Math.max(1, total - params.ghostCount));
  const label = (params.pillLabel ?? '').replace(/(\.\.\.|…)\s*$/, '').trim();

  return { label: label || 'Executing', current, total };
}

function setScopeDragPreview(element: HTMLDivElement | null, bounds: Bounds | null, color: string): void {
  if (!element) {
    return;
  }

  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    element.style.opacity = '0';
    element.style.transform = 'translate3d(0px, 0px, 0px)';
    element.style.width = '0px';
    element.style.height = '0px';
    return;
  }

  element.style.opacity = '1';
  element.style.borderColor = color;
  element.style.transform = `translate3d(${bounds.x}px, ${bounds.y}px, 0)`;
  element.style.width = `${bounds.width}px`;
  element.style.height = `${bounds.height}px`;
}

function isVisibleElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  if (
    rect.right <= 0
    || rect.bottom <= 0
    || rect.left >= window.innerWidth
    || rect.top >= window.innerHeight
  ) {
    return false;
  }

  let current: HTMLElement | null = element;
  while (current) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }

    const opacity = Number.parseFloat(style.opacity || '1');
    if (!Number.isNaN(opacity) && opacity <= 0.01) {
      return false;
    }

    current = current.parentElement;
  }

  return true;
}

function hasAnyVisibleElement(selector: string): boolean {
  return Array.from(document.querySelectorAll(selector)).some((element) => isVisibleElement(element));
}

export function Overlay() {
  "use no memo";

  const [state, setState] = useState<OverlayState>(DEFAULT_OVERLAY_STATE);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [displayedPlan, setDisplayedPlan] = useState<ReviewAction[]>([]);
  const [viewportSize, setViewportSize] = useState<Size>({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [pillSize, setPillSize] = useState<Size>({ width: 220, height: 44 });
  const [inputValue, setInputValue] = useState('');
  const [pillInputHeight, setPillInputHeight] = useState(28);
  const [fixedPillShellSize, setFixedPillShellSize] = useState<Size | null>(null);
  const [draftScopeBounds, setDraftScopeBounds] = useState<Bounds | null>(null);
  const liveScopeBounds = draftScopeBounds ?? state.scopeBounds;
  const [renderedScopeBounds, setRenderedScopeBounds] = useState<Bounds | null>(liveScopeBounds);
  const [scopeSurfaceVisible, setScopeSurfaceVisible] = useState(liveScopeBounds !== null);
  const [scopeInteractionMode, setScopeInteractionMode] = useState<'create' | 'move' | 'resize' | null>(null);
  const [hasScopeTooltipPointerMoved, setHasScopeTooltipPointerMoved] = useState(false);
  const [selectionTooltipSuppressed, setSelectionTooltipSuppressed] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<HoverTooltipState | null>(null);
  const [contextSourceHighlights, setContextSourceHighlights] = useState<ContextSourceHighlight[]>([]);
  const [scopeHoverActive, setScopeHoverActive] = useState(false);
  const [scopeTooltipPosition, setScopeTooltipPosition] = useState<Point>(() => ({
    left: Math.max(PILL_VIEWPORT_MARGIN, (window.innerWidth - SCOPE_TOOLTIP_SIZE.width) / 2),
    top: Math.max(PILL_VIEWPORT_MARGIN, window.innerHeight * 0.18),
  }));
  const pillContainerRef = useRef<HTMLDivElement | null>(null);
  const pillInputRef = useRef<HTMLTextAreaElement | null>(null);
  const scopeDragPreviewRef = useRef<HTMLDivElement | null>(null);
  const lastSubmitRef = useRef<{ text: string; at: number } | null>(null);
  const pendingLocalDraftRef = useRef(false);
  const pillShellLockTimeoutRef = useRef<number | null>(null);
  const previousPillVisualKeyRef = useRef<string | null>(null);
  const lastVisualHealthSignatureRef = useRef<string | null>(null);
  const lastVisualHealthRef = useRef<OverlayVisualHealth | null>(null);
  const previousContextSourceIdsRef = useRef<Set<string>>(new Set());
  const visualHealthFrameRef = useRef<number | null>(null);
  const scheduleVisualHealthReportRef = useRef<(() => void) | null>(null);
  const visualHealthStateRef = useRef<Pick<OverlayVisualHealth, 'renderedMode' | 'pillKind'> & {
    inputPromptVisible: boolean;
  }>({
    renderedMode: state.mode,
    pillKind: state.pill.kind,
    inputPromptVisible: state.mode === 'input',
  });
  const dragGestureRef = useRef<DragGestureState | null>(null);
  const scopeEditorGestureRef = useRef<ScopeEditorGesture | null>(null);
  const draftScopeBoundsRef = useRef<Bounds | null>(null);
  const prefersReducedMotion = false;
  const usesPillInputDesign = INTERPRETER_OVERLAY_INPUT_DESIGN === 'pill';
  const showInput = state.mode === 'input';
  const [, setOverlayBootstrap] = useState<OverlayBootstrapData | null>(null);
  const advancedVoicePeerRef = useRef<RTCPeerConnection | null>(null);
  const advancedVoiceStreamRef = useRef<MediaStream | null>(null);
  const advancedVoiceChannelRef = useRef<RTCDataChannel | null>(null);
  const advancedVoiceAudioContextRef = useRef<AudioContext | null>(null);
  const advancedVoiceAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const advancedVoiceOutputAudioRef = useRef<HTMLAudioElement | null>(null);
  const advancedVoiceInputCleanupRef = useRef<(() => void) | null>(null);
  const advancedVoiceResponseDoneWaitersRef = useRef<Array<() => void>>([]);
  const advancedVoiceActiveResponseRef = useRef(false);
  const advancedVoicePendingResponseCreateRef = useRef(false);
  const advancedVoiceHandledToolCallIdsRef = useRef<Set<string>>(new Set());
  const advancedVoiceHandledCompletionNoticeIdsRef = useRef<Set<string>>(new Set());
  const [advancedVoiceAmplitude, setAdvancedVoiceAmplitude] = useState(0);

  const cleanupAdvancedVoiceSession = useCallback((notifyService: boolean) => {
    advancedVoiceChannelRef.current?.close();
    advancedVoiceChannelRef.current = null;
    advancedVoicePeerRef.current?.close();
    advancedVoicePeerRef.current = null;
    advancedVoiceInputCleanupRef.current?.();
    advancedVoiceInputCleanupRef.current = null;
    advancedVoiceActiveResponseRef.current = false;
    advancedVoicePendingResponseCreateRef.current = false;
    advancedVoiceHandledToolCallIdsRef.current.clear();
    advancedVoiceHandledCompletionNoticeIdsRef.current.clear();
    for (const resolve of advancedVoiceResponseDoneWaitersRef.current.splice(0)) {
      resolve();
    }
    try {
      advancedVoiceAudioSourceRef.current?.stop();
    } catch {
      // The source can already be ended by the test audio buffer.
    }
    advancedVoiceAudioSourceRef.current = null;
    void advancedVoiceAudioContextRef.current?.close();
    advancedVoiceAudioContextRef.current = null;
    advancedVoiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    advancedVoiceStreamRef.current = null;
    advancedVoiceOutputAudioRef.current?.remove();
    advancedVoiceOutputAudioRef.current = null;
    setAdvancedVoiceAmplitude(0);
    if (notifyService) {
      window.overlay.send({ type: 'stop-advanced-voice' });
    }
  }, []);

  const stopAdvancedVoiceSession = useCallback(() => {
    cleanupAdvancedVoiceSession(true);
  }, [cleanupAdvancedVoiceSession]);

  const requestAdvancedVoiceResponse = useCallback((channel: RTCDataChannel) => {
    if (channel.readyState !== 'open') {
      return;
    }
    if (advancedVoiceActiveResponseRef.current) {
      advancedVoicePendingResponseCreateRef.current = true;
      console.log('[InterpreterOverlay][AdvancedVoice] response.create queued until active response is done');
      return;
    }
    advancedVoicePendingResponseCreateRef.current = false;
    channel.send(JSON.stringify({ type: 'response.create' }));
    advancedVoiceActiveResponseRef.current = true;
    console.log('[InterpreterOverlay][AdvancedVoice] response.create sent');
  }, []);

  useEffect(() => {
    const notice = state.advancedVoiceCompletionNotice;
    if (!notice || advancedVoiceHandledCompletionNoticeIdsRef.current.has(notice.id)) {
      return;
    }
    const channel = advancedVoiceChannelRef.current;
    if (!channel || channel.readyState !== 'open') {
      return;
    }
    advancedVoiceHandledCompletionNoticeIdsRef.current.add(notice.id);
    channel.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'The delegated work finished. Check the user-visible result now.' }],
      },
    }));
    requestAdvancedVoiceResponse(channel);
  }, [requestAdvancedVoiceResponse, state.advancedVoiceCompletionNotice]);

  const handleAdvancedVoiceEvent = useCallback(async (
    event: Record<string, unknown>,
    channel: RTCDataChannel,
  ) => {
    const eventType = typeof event.type === 'string' ? event.type : '';
    if (
      eventType === 'error'
      || eventType.startsWith('response.')
      || eventType.startsWith('input_audio_buffer.')
      || eventType.startsWith('conversation.item.')
      || eventType.startsWith('session.')
    ) {
      console.log('[InterpreterOverlay][AdvancedVoice] realtime event', JSON.stringify({
        type: eventType,
        name: typeof event.name === 'string' ? event.name : undefined,
        error: typeof event.error === 'object' && event.error !== null ? event.error : undefined,
        transcript: eventType === 'response.output_audio_transcript.done' && typeof event.transcript === 'string'
          ? event.transcript.slice(0, 600)
          : undefined,
      }));
    }
    if (
      eventType === 'input_audio_buffer.speech_started'
      || eventType === 'input_audio_buffer.speech_stopped'
      || eventType === 'input_audio_buffer.committed'
      || eventType === 'input_audio_buffer.cleared'
    ) {
      void window.overlay.recordAdvancedVoiceAudioEvent({ type: eventType });
    }
    const item = (
      typeof event.item === 'object' && event.item !== null
        ? event.item as Record<string, unknown>
        : null
    );
    const isFunctionCallDone = (
      event.type === 'response.function_call_arguments.done'
      || (event.type === 'response.output_item.done' && item?.type === 'function_call')
    );
    if (!isFunctionCallDone) {
      return;
    }

    const name = String(event.name ?? item?.name ?? '');
    const callId = String(event.call_id ?? item?.call_id ?? '');
    const argumentsJson = String(event.arguments ?? item?.arguments ?? '{}');
    if (!name || !callId) {
      return;
    }

    if (advancedVoiceHandledToolCallIdsRef.current.has(callId)) {
      console.log('[InterpreterOverlay][AdvancedVoice] ignored duplicate function call event', JSON.stringify({
        name,
        callId,
      }));
      return;
    }
    advancedVoiceHandledToolCallIdsRef.current.add(callId);

    const result = await window.overlay.handleAdvancedVoiceToolCall({
      name,
      argumentsJson,
    });
    // The user can stop advanced voice while an approved desktop batch is
    // executing. In that case the Realtime channel is intentionally closed;
    // do not attempt to publish a late tool result into the dead session.
    if (channel.readyState !== 'open') {
      return;
    }
    channel.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: result.output,
      },
    }));
    if (result.followUpUserMessage) {
      channel.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: result.followUpUserMessage }],
        },
      }));
    }
    if (result.requestResponse !== false || result.followUpUserMessage) {
      requestAdvancedVoiceResponse(channel);
    }
  }, [requestAdvancedVoiceResponse]);

  const startAdvancedVoiceAmplitudeMeter = useCallback((audioContext: AudioContext, sourceNode: MediaStreamAudioSourceNode) => {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    sourceNode.connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    let frameId = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / Math.max(1, samples.length));
      setAdvancedVoiceAmplitude(Math.min(1, rms * 4));
      frameId = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  const createAdvancedVoiceInputStream = useCallback(async () => {
    const testAudio = await window.overlay.getAdvancedVoiceTestAudio();
    if (!testAudio) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext();
      advancedVoiceAudioContextRef.current = audioContext;
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const stopMeter = startAdvancedVoiceAmplitudeMeter(audioContext, sourceNode);
      return { stream, cleanup: stopMeter, start: undefined };
    }

    const testAudioSegments = testAudio.segments?.length
      ? testAudio.segments
      : testAudio.dataUrl
        ? [{ dataUrl: testAudio.dataUrl, mimeType: testAudio.mimeType ?? 'audio/wav', delayAfterMs: 0 }]
        : [];
    if (testAudioSegments.length === 0) {
      throw new Error('Advanced voice test audio did not include any audio segments.');
    }
    const audioContext = new AudioContext();
    advancedVoiceAudioContextRef.current = audioContext;
    const buffers = await Promise.all(testAudioSegments.map(async (segment) => {
      const response = await fetch(segment.dataUrl);
      const audioData = await response.arrayBuffer();
      return audioContext.decodeAudioData(audioData.slice(0));
    }));
    const destination = audioContext.createMediaStreamDestination();
    const sources: AudioBufferSourceNode[] = [];
    const meterSource = audioContext.createMediaStreamSource(destination.stream);
    const stopMeter = startAdvancedVoiceAmplitudeMeter(audioContext, meterSource);
    let started = false;
    const waitMs = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const sendIfOpen = (channel: RTCDataChannel, payload: Record<string, unknown>) => {
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify(payload));
      }
    };
    const waitForResponseDone = () => new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => {
        const index = advancedVoiceResponseDoneWaitersRef.current.indexOf(done);
        if (index >= 0) {
          advancedVoiceResponseDoneWaitersRef.current.splice(index, 1);
        }
        resolve();
      }, 30000);
      const done = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      advancedVoiceResponseDoneWaitersRef.current.push(done);
    });
    const start = (channel: RTCDataChannel) => {
      if (started) {
        return;
      }
      started = true;
      void (async () => {
        for (let index = 0; index < buffers.length; index += 1) {
          if (channel.readyState !== 'open') {
            return;
          }
          sendIfOpen(channel, { type: 'input_audio_buffer.clear' });
          console.log(`[InterpreterOverlay][AdvancedVoice] input_audio_buffer.clear sent before test audio segment ${index + 1}`);
          void window.overlay.recordAdvancedVoiceAudioEvent({
            type: 'segment_clear',
            segmentIndex: index + 1,
          });
          const source = audioContext.createBufferSource();
          source.buffer = buffers[index];
          source.connect(destination);
          sources.push(source);
          advancedVoiceAudioSourceRef.current = source;
          console.log(`[InterpreterOverlay][AdvancedVoice] test audio segment ${index + 1} started`);
          void window.overlay.recordAdvancedVoiceAudioEvent({
            type: 'segment_started',
            segmentIndex: index + 1,
          });
          await new Promise<void>((resolve) => {
            source.onended = () => resolve();
            source.start();
          });
          console.log(`[InterpreterOverlay][AdvancedVoice] test audio segment ${index + 1} ended`);
          void window.overlay.recordAdvancedVoiceAudioEvent({
            type: 'segment_ended',
            segmentIndex: index + 1,
          });
          sendIfOpen(channel, { type: 'input_audio_buffer.commit' });
          console.log(`[InterpreterOverlay][AdvancedVoice] input_audio_buffer.commit sent after test audio segment ${index + 1}`);
          void window.overlay.recordAdvancedVoiceAudioEvent({
            type: 'input_committed',
            segmentIndex: index + 1,
          });
          requestAdvancedVoiceResponse(channel);
          console.log(`[InterpreterOverlay][AdvancedVoice] response.create requested after test audio segment ${index + 1}`);
          void window.overlay.recordAdvancedVoiceAudioEvent({
            type: 'response_requested',
            segmentIndex: index + 1,
          });
          await waitForResponseDone();
          const delayAfterMs = Math.max(0, Number(testAudioSegments[index]?.delayAfterMs ?? 0));
          if (delayAfterMs > 0) {
            await waitMs(delayAfterMs);
          }
        }
      })();
    };
    return {
      stream: destination.stream,
      start,
      cleanup: () => {
        stopMeter();
        for (const source of sources) {
          try {
            source.stop();
          } catch {
            // The source can already be ended by the test audio buffer.
          }
        }
      },
    };
  }, [requestAdvancedVoiceResponse, startAdvancedVoiceAmplitudeMeter]);

  useEffect(() => {
    return window.overlay.onState((nextState) => {
      if (nextState.scopeBounds) {
        setScopeDragPreview(scopeDragPreviewRef.current, null, nextState.tracePrimaryColor);
        dragGestureRef.current = null;
        scopeEditorGestureRef.current = null;
        setScopeInteractionMode(null);
        setDraftScopeBounds(null);
      }
      const currentState = stateRef.current;
      if (equalOverlayState(currentState, nextState)) {
        return;
      }
      if (currentState.mode !== nextState.mode) {
        flushSync(() => {
          stateRef.current = nextState;
          setState(nextState);
        });
        return;
      }
      stateRef.current = nextState;
      setState(nextState);
    });
  }, []);

  useEffect(() => {
    window.overlay.send({ type: 'renderer-ready' });
    return window.overlay.onRequestInputFocus(() => {
      window.overlay.send({ type: 'request-state-sync', reason: 'input-focus-request' });
    });
  }, []);

  useEffect(() => {
    if (!state.advancedVoiceActive) {
      cleanupAdvancedVoiceSession(false);
      return;
    }

    if (advancedVoicePeerRef.current) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const peer = new RTCPeerConnection();
        advancedVoicePeerRef.current = peer;
        const { stream, cleanup, start } = await createAdvancedVoiceInputStream();
        if (cancelled) {
          cleanup();
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        advancedVoiceStreamRef.current = stream;
        advancedVoiceInputCleanupRef.current = cleanup;
        for (const track of stream.getTracks()) {
          peer.addTrack(track, stream);
        }
        peer.ontrack = (event) => {
          const audio = document.createElement('audio');
          audio.autoplay = true;
          audio.srcObject = event.streams[0];
          audio.style.display = 'none';
          document.body.append(audio);
          advancedVoiceOutputAudioRef.current?.remove();
          advancedVoiceOutputAudioRef.current = audio;
        };
        const channel = peer.createDataChannel('oai-events');
        advancedVoiceChannelRef.current = channel;
        const startInputWhenReady = () => {
          if (channel.readyState !== 'open' || !peer.remoteDescription) {
            return;
          }
          start?.(channel);
        };
        channel.onopen = startInputWhenReady;
        channel.onmessage = (messageEvent) => {
          try {
            const parsed = JSON.parse(String(messageEvent.data)) as Record<string, unknown>;
            if (parsed.type === 'response.created') {
              advancedVoiceActiveResponseRef.current = true;
            }
            if (parsed.type === 'response.done') {
              advancedVoiceActiveResponseRef.current = false;
              // The planning window visual ends when a response finishes
              // without staging a batch; the main process needs the response
              // lifecycle boundary as an audio-event marker.
              void window.overlay.recordAdvancedVoiceAudioEvent({ type: 'response_done' });
              const waiters = advancedVoiceResponseDoneWaitersRef.current.splice(0);
              for (const resolve of waiters) {
                resolve();
              }
              if (advancedVoicePendingResponseCreateRef.current && channel.readyState === 'open') {
                requestAdvancedVoiceResponse(channel);
              }
            }
            void handleAdvancedVoiceEvent(parsed, channel).catch((error) => {
              console.error('[InterpreterOverlay][AdvancedVoice] event handling failed', error);
            });
          } catch (error) {
            console.error('[InterpreterOverlay][AdvancedVoice] event handling failed', error);
          }
        };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const { answerSdp } = await window.overlay.createAdvancedVoiceCall({
          offerSdp: offer.sdp ?? '',
          sessionKind: state.advancedVoiceSessionKind,
        });
        if (cancelled) {
          return;
        }
        await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        startInputWhenReady();
      } catch (error) {
        console.error('[InterpreterOverlay][AdvancedVoice] setup failed', error);
        stopAdvancedVoiceSession();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    cleanupAdvancedVoiceSession,
    createAdvancedVoiceInputStream,
    handleAdvancedVoiceEvent,
    state.advancedVoiceActive,
    state.advancedVoiceSessionKind,
    stopAdvancedVoiceSession,
  ]);

  useEffect(() => {
    return window.overlay.onDragPreview((bounds, color) => {
      setScopeDragPreview(scopeDragPreviewRef.current, bounds, color);
    });
  }, []);

  useEffect(() => {
    if (state.mode === 'idle') {
      previousContextSourceIdsRef.current = new Set();
      setContextSourceHighlights([]);
      return;
    }

    const addedSourceHighlights = getNewContextSourceHighlights(state.contextItems, previousContextSourceIdsRef.current);

    if (addedSourceHighlights.length === 0) {
      return;
    }

    previousContextSourceIdsRef.current = new Set([
      ...previousContextSourceIdsRef.current,
      ...addedSourceHighlights.map((highlight) => highlight.id),
    ]);
    setContextSourceHighlights((current) => [...current, ...addedSourceHighlights]);
    const timeoutId = window.setTimeout(() => {
      setContextSourceHighlights((current) => (
        current.filter((highlight) => !addedSourceHighlights.some((added) => added.id === highlight.id))
      ));
    }, 900);
    return () => window.clearTimeout(timeoutId);
  }, [state.contextItems, state.mode]);

  useEffect(() => {
    if (!showInput) {
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }

      void window.overlay.getBootstrap()
        .then((nextBootstrap) => {
          if (cancelled) {
            return;
          }

          setOverlayBootstrap(nextBootstrap);
        })
        .catch((error) => {
          console.error('[InterpreterOverlay] Failed to load overlay bootstrap:', error);
        });
    }, 1500);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [showInput]);

  useEffect(() => {
    const updateViewportSize = () => {
      setViewportSize({ width: window.innerWidth, height: window.innerHeight });
    };

    window.addEventListener('resize', updateViewportSize);
    return () => window.removeEventListener('resize', updateViewportSize);
  }, []);

  useEffect(() => {
    setScopeTooltipPosition((current) => clampTooltipPosition(current, SCOPE_TOOLTIP_SIZE, viewportSize));
  }, [viewportSize]);

  useEffect(() => {
    draftScopeBoundsRef.current = draftScopeBounds;
  }, [draftScopeBounds]);

  useLayoutEffect(() => {
    const element = pillContainerRef.current;
    if (!element) {
      return;
    }

    const updatePillSize = () => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      if (width > 0 && height > 0) {
        setPillSize({ width, height });
      }
    };

    updatePillSize();

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updatePillSize)
      : null;
    resizeObserver?.observe(element);

    return () => {
      resizeObserver?.disconnect();
    };
  }, [state.mode, state.pill.kind, state.action?.id, state.shiftPressed]);

  useLayoutEffect(() => {
    const incomingPlan = [
      ...(state.action ? [state.action] : []),
      ...state.ghosts,
    ];

    setDisplayedPlan((currentPlan) => {
      if (state.mode === 'idle' || state.mode === 'input') {
        return [];
      }

      if (state.pill.kind === 'review' && incomingPlan.length > 0) {
        return incomingPlan;
      }

      return currentPlan;
    });
  }, [state.action, state.ghosts, state.mode, state.pill.kind]);

  useEffect(() => {
    // Input mode owns the mouse outright: the open input surface is the
    // explicit capture opt-in, and hover-based release here is what leaked
    // region drags into the app underneath (macOS routes the whole drag
    // session to whichever app received the mousedown).
    const inputModeCaptured = state.mode === 'input';
    if (inputModeCaptured) {
      window.overlay.setIgnoreMouse(false);
    } else {
      window.overlay.setIgnoreMouse(true, { forward: true });
    }
    const isInteractiveTarget = (target: EventTarget | null): boolean => (
      target instanceof HTMLElement
      && target.closest([
        '[data-interactive]',
        '[data-overlay-editor-area="true"]',
      ].join(',')) !== null
    );
    // A drag that begins over an interactive overlay control (e.g. selecting
    // text inside the input panel) must keep window mouse capture for the
    // whole drag; releasing capture mid-drag leaks the rest of the drag into
    // the app underneath. The renderer only ever sees the mousedown when the
    // window is already capturing, so tracking it here is safe. Drags that
    // begin while the window is click-through never reach this renderer;
    // those are observed by the service global mouse hook, which owns
    // capture for region-selection drags — so while any button is down we
    // must not force the capture state one way or the other.
    let interactiveDragActive = false;
    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 0 && isInteractiveTarget(event.target)) {
        interactiveDragActive = true;
      }
    };
    const onMouseUp = () => {
      interactiveDragActive = false;
    };
    const onMove = (event: MouseEvent) => {
      if (inputModeCaptured) {
        window.overlay.setIgnoreMouse(false);
        return;
      }
      if (event.buttons !== 0) {
        if (interactiveDragActive) {
          window.overlay.setIgnoreMouse(false);
        }
        return;
      }
      interactiveDragActive = false;
      const interactive = isInteractiveTarget(event.target);
      window.overlay.setIgnoreMouse(!interactive, { forward: true });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMouseUp, true);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      window.overlay.setIgnoreMouse(true, { forward: true });
    };
  }, [state.advancedVoiceActive, state.dashboardApprovals.length, state.mode, state.pill.kind, state.runningAgents.length]);

  const send = useCallback((action: OverlayAction) => window.overlay.send(action), []);
  const reportInputFocusChange = useCallback(
    (focused: boolean) => send({ type: 'input-focus-change', focused }),
    [send],
  );

  useEffect(() => {
    if (state.mode !== 'input' && state.pill.kind !== 'review' && !state.advancedVoiceActive) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (state.advancedVoiceActive) {
        stopAdvancedVoiceSession();
        return;
      }

      if (state.pill.kind === 'review') {
        send({ type: 'reject' });
        return;
      }

      send({ type: 'dismiss' });
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [state.advancedVoiceActive, state.mode, state.pill.kind, stopAdvancedVoiceSession]);

  const [renderInputOverlay, setRenderInputOverlay] = useState(!state.advancedVoiceActive);
  const [inputOverlayVisible, setInputOverlayVisible] = useState(showInput);
  const showPillInput = showInput && usesPillInputDesign;
  const focusPillInputElement = useCallback((input: HTMLTextAreaElement | null) => {
    pillInputRef.current = input;
    if (!input || !showPillInput) {
      return;
    }

    const focusInput = () => {
      input.focus({ preventScroll: true });
      const cursorPosition = input.value.length;
      input.setSelectionRange(cursorPosition, cursorPosition);
      if (document.activeElement === input) {
        reportInputFocusChange(true);
      }
    };

    focusInput();
    requestAnimationFrame(focusInput);
  }, [reportInputFocusChange, showPillInput]);
  const scopeInteractionActive = scopeInteractionMode !== null;
  const hasSelectedScope = state.scopeBounds !== null;
  const selectionInterfaceOpacity = scopeInteractionActive ? 0 : 1;
  const inputComposerVisible = showInput && inputOverlayVisible && !scopeInteractionActive;
  const targetRegion = state.contextItems.find(
    (item): item is OverlayRegionContextItem => item.kind === 'region' && item.role === 'target',
  );
  const hasActiveAppTarget = targetRegion?.label.startsWith('Active app:') === true;
  const inputPlaceholder = targetRegion
    ? hasActiveAppTarget
      ? (state.isRecording ? 'Say what to do in the active app...' : 'Describe what to do in the active app...')
      : (state.isRecording ? 'Say what to do with this region...' : 'Describe what to do with this region...')
    : (state.isRecording ? 'Say what to do...' : 'Ask Interpreter anything...');
  const showSelectionHintTooltip = showInput
    && !hasSelectedScope
    && hasScopeTooltipPointerMoved
    && !scopeInteractionActive
    && !selectionTooltipSuppressed
    && hoverTooltip === null;
  useEffect(() => {
    if (!showInput) {
      setScopeHoverActive(false);
      return;
    }

    setHasScopeTooltipPointerMoved(false);
    setSelectionTooltipSuppressed(false);
    setHoverTooltip(null);
    setScopeHoverActive(false);
  }, [showInput]);

  useLayoutEffect(() => {
    if (state.advancedVoiceActive) {
      setInputOverlayVisible(false);
      setRenderInputOverlay(false);
      return;
    }

    if (showInput) {
      setRenderInputOverlay(true);
      setInputOverlayVisible(true);
      return;
    }

    setInputOverlayVisible(false);
    const timeoutId = window.setTimeout(() => setRenderInputOverlay(true), INPUT_OVERLAY_FADE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [showInput, state.advancedVoiceActive]);

  useEffect(() => {
    if (liveScopeBounds) {
      setRenderedScopeBounds(liveScopeBounds);
      setScopeSurfaceVisible(true);
      return;
    }

    setScopeSurfaceVisible(false);
    const timeoutId = window.setTimeout(() => setRenderedScopeBounds(null), SCOPE_SURFACE_FADE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [liveScopeBounds]);

  const displayBounds = useMemo<Bounds>(() => ({
    x: 0,
    y: 0,
    width: viewportSize.width,
    height: viewportSize.height,
  }), [viewportSize.height, viewportSize.width]);

  useEffect(() => {
    if (!showInput) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const pointerTarget = document.elementFromPoint(event.clientX, event.clientY);
      const suppressSelectionTooltip = pointerTarget instanceof Element
        && Boolean(pointerTarget.closest('[data-overlay-selection-tooltip-suppress="true"]'));
      const suppressForInputZone = event.clientY >= viewportSize.height - INPUT_TOOLTIP_SUPPRESS_HEIGHT;
      const tooltipTarget = pointerTarget instanceof Element
        ? pointerTarget.closest<HTMLElement>('[data-overlay-hover-tooltip]')
        : null;
      const hoveringScope = liveScopeBounds
        ? isPointInsideBounds({ x: event.clientX, y: event.clientY }, liveScopeBounds)
        : false;

      setHasScopeTooltipPointerMoved(true);
      setSelectionTooltipSuppressed(suppressSelectionTooltip || suppressForInputZone);
      setScopeHoverActive(hoveringScope && !scopeInteractionActive);
      if (tooltipTarget) {
        const label = tooltipTarget.dataset.overlayHoverTooltip?.trim();
        if (label) {
          const shortcut = tooltipTarget.dataset.overlayHoverTooltipShortcut?.trim() || null;
          const shortcutPrefix = tooltipTarget.dataset.overlayHoverTooltipShortcutPrefix?.trim() || null;
          const position = getHoverTooltipPosition(
            tooltipTarget.getBoundingClientRect(),
            viewportSize,
            label,
            shortcut,
            shortcutPrefix,
          );
          setHoverTooltip({
            id: `${label}-${shortcut ?? ''}-${Math.round(position.left)}-${Math.round(position.top)}`,
            label,
            shortcut,
            shortcutPrefix,
            position,
          });
        } else {
          setHoverTooltip(null);
        }
      } else {
        setHoverTooltip(null);
      }
      setScopeTooltipPosition(
        clampTooltipPosition(
          {
            left: event.clientX + SCOPE_TOOLTIP_OFFSET_X,
            top: event.clientY + SCOPE_TOOLTIP_OFFSET_Y,
          },
          SCOPE_TOOLTIP_SIZE,
          viewportSize,
        ),
      );
    };

    window.addEventListener('pointermove', handlePointerMove);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      setHoverTooltip(null);
      setSelectionTooltipSuppressed(false);
      setScopeHoverActive(false);
    };
  }, [liveScopeBounds, scopeInteractionActive, showInput, viewportSize]);

  const effectiveScopeBounds = draftScopeBounds ?? liveScopeBounds;
  const scopeVisualBounds = draftScopeBounds ?? renderedScopeBounds ?? effectiveScopeBounds;
  const scopeStatusTooltipPosition = useMemo<Point | null>(
    () => {
      if (!showInput || !effectiveScopeBounds || scopeInteractionActive || !scopeHoverActive) {
        return null;
      }

      return getScopeStatusTooltipPosition(effectiveScopeBounds, viewportSize);
    },
    [effectiveScopeBounds, scopeHoverActive, scopeInteractionActive, showInput, viewportSize],
  );
  const scopeMoveEdgeBands = useMemo<Bounds[]>(
    () => (effectiveScopeBounds ? getScopeMoveEdgeBands(effectiveScopeBounds) : []),
    [effectiveScopeBounds],
  );
  const scopedSelectionElements = useMemo<ScopedSelectionPreview[]>(
    () => {
      if (!effectiveScopeBounds) {
        return [];
      }

      return state.selectableElements.flatMap((element) => {
        if (!boundsIntersect(element.bounds, effectiveScopeBounds)) {
          return [];
        }

        const clippedBounds = clampBoundsToBounds(element.bounds, effectiveScopeBounds);
        if (clippedBounds.width <= 0 || clippedBounds.height <= 0) {
          return [];
        }

        return [{
          id: element.id,
          role: element.role,
          label: element.label,
          bounds: clippedBounds,
        }];
      });
    },
    [effectiveScopeBounds, state.selectableElements],
  );
  const livePlan = [
    ...(state.action ? [state.action] : []),
    ...state.ghosts,
  ];
  const effectivePlan = livePlan.length > 0
    ? livePlan
    : (state.pill.kind === 'review' || state.mode === 'working')
      ? displayedPlan
      : [];
  const reviewAction = effectivePlan[0] ?? null;
  const showReview = !showInput && state.pill.kind === 'review' && effectivePlan.length > 0;
  const showGhostTargets = !showInput && effectivePlan.length > 1 && (showReview || state.mode === 'working');
  const showTrace = !showInput && effectivePlan.length > 0 && (showReview || state.mode === 'working');
  const executionProgress = state.pill.kind === 'loading' && state.mode === 'working'
    ? getExecutionPillProgress({
        pillLabel: state.pill.label,
        hasActiveAction: state.action !== null,
        ghostCount: state.ghosts.length,
        plannedActionCount: displayedPlan.length,
      })
    : null;
  const shouldShowRunPill = !showInput && (
    (state.pill.kind === 'review' && effectivePlan.length > 0)
    || executionProgress !== null
    || state.pill.kind === 'message'
  );
  const showPill = showPillInput || shouldShowRunPill;
  const pillShouldBeImmediatelyVisible = showPillInput
    || (state.pill.kind === 'review' && effectivePlan.length > 0);
  const pillVisualKey = showPillInput
    ? `input:${state.isRecording ? 'recording' : 'idle'}`
    : `${state.pill.kind}:${reviewAction?.id ?? ''}:${state.mode}`;
  const activeAction = state.mode === 'working'
    ? state.action
    : showReview
      ? reviewAction
      : null;
  const tracePrimaryColor = state.tracePrimaryColor;
  const showScopeFrame = scopeVisualBounds !== null
    && (scopeInteractionMode !== 'create' || draftScopeBounds !== null);
  const showScopeFill = scopeVisualBounds !== null
    && scopeInteractionMode !== 'create';
  const showScopeDarkScrim = !showInput
    && effectiveScopeBounds !== null
    && (state.mode === 'working' || showReview);
  // Thinking sheen: runs continuously from submit until a proposed trace
  // renders (state.action set) or the run leaves working mode. This must not
  // depend on the pill kind — during a live attached tool session the run
  // engine publishes a hidden pill while the model is still thinking.
  const showProcessingEffects = !showInput
    && effectiveScopeBounds !== null
    && (
      state.pill.kind === 'recording'
      || (state.mode === 'working' && state.action === null)
    );
  const showActiveTarget = !showInput && hasRenderableTargetBounds(activeAction) && (showReview || state.mode === 'working');
  const scopeHolePressed = showReview && state.ctrlPressed;
  const globalApprovalControl = state.globalApproval ? (
    <div className="advanced-voice-approval" role="group" aria-label="Approval needed">
      <div className="advanced-voice-approval-copy">
        <span className="advanced-voice-approval-title">{state.globalApproval.title}</span>
        {state.globalApproval.detail ? (
          <span className="advanced-voice-approval-detail">{state.globalApproval.detail}</span>
        ) : null}
      </div>
      <button
        type="button"
        className="advanced-voice-approval-button advanced-voice-approval-deny"
        onClick={(event) => {
          event.stopPropagation();
          window.overlay.send({ type: 'deny-global-approval' });
        }}
      >
        Deny
      </button>
      <button
        type="button"
        className={`advanced-voice-approval-button advanced-voice-approval-accept${state.ctrlPressed ? ' is-pressed' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          window.overlay.send({ type: 'approve-global-approval' });
        }}
      >
        <span>Approve</span>
        <span className="advanced-voice-approval-key">Ctrl</span>
      </button>
    </div>
  ) : null;
  useEffect(() => {
    visualHealthStateRef.current = {
      renderedMode: state.mode,
      pillKind: state.pill.kind,
      // Keep input prompt visibility aligned with the actual fade lifecycle.
      // `showInput` drops immediately on dismiss, but the input surface remains
      // rendered while the overlay opacity transition completes.
      inputPromptVisible: inputOverlayVisible && !scopeInteractionActive,
    };
    scheduleVisualHealthReportRef.current?.();
  }, [
    inputComposerVisible,
    inputOverlayVisible,
    renderInputOverlay,
    showActiveTarget,
    showGhostTargets,
    showInput,
    showPill,
    showPillInput,
    showReview,
    state.mode,
    state.pill.kind,
  ]);
  const scopeHoleBounds = useMemo<Bounds | null>(
    () => {
      if (!showActiveTarget || !activeAction || !effectiveScopeBounds) {
        return null;
      }

      return clampBoundsToBounds(
        {
          x: activeAction.bounds.x - effectiveScopeBounds.x,
          y: activeAction.bounds.y - effectiveScopeBounds.y,
          width: activeAction.bounds.width,
          height: activeAction.bounds.height,
        },
        {
          x: 0,
          y: 0,
          width: effectiveScopeBounds.width,
          height: effectiveScopeBounds.height,
        },
      );
    },
    [activeAction, effectiveScopeBounds, showActiveTarget],
  );
  const loadingSheenElements = useMemo(
    () => {
      if (!scopeVisualBounds || !showProcessingEffects) {
        return [];
      }

      const scopeArea = scopeVisualBounds.width * scopeVisualBounds.height;
      return scopedSelectionElements
        .filter((element) => {
          const { width, height } = element.bounds;
          if (width < 8 || height < 8) {
            return false;
          }

          const area = width * height;
          const tier = getSheenTierForRole(element.role);
          const maxAreaRatio = tier === 'container' ? 0.72 : 0.4;
          if (area >= scopeArea * maxAreaRatio) {
            return false;
          }

          const maxWidthRatio = tier === 'container' ? 0.985 : 0.94;
          const maxHeightRatio = tier === 'container' ? 0.985 : 0.94;
          if (width >= scopeVisualBounds.width * maxWidthRatio || height >= scopeVisualBounds.height * maxHeightRatio) {
            return false;
          }

          return true;
        })
        .map((element) => ({
        id: element.id,
        tier: getSheenTierForRole(element.role),
        localLeft: element.bounds.x - scopeVisualBounds.x,
        localTop: element.bounds.y - scopeVisualBounds.y,
        width: element.bounds.width,
        height: element.bounds.height,
        }));
    },
    [scopeVisualBounds, scopedSelectionElements, showProcessingEffects],
  );

  useEffect(() => {
    if (!showInput) {
      dragGestureRef.current = null;
      scopeEditorGestureRef.current = null;
      setScopeDragPreview(scopeDragPreviewRef.current, null, tracePrimaryColor);
      setScopeInteractionMode(null);
      setDraftScopeBounds(null);
    }
  }, [showInput, tracePrimaryColor]);

  useEffect(() => {
    if (!showInput || !scopeEditorGestureRef.current) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = scopeEditorGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) {
        return;
      }

      const dx = event.clientX - gesture.startPointer.x;
      const dy = event.clientY - gesture.startPointer.y;
      const nextBounds = gesture.mode === 'move'
        ? translateScopeBounds(gesture.startBounds, dx, dy, displayBounds)
        : resizeScopeBounds(
            gesture.startBounds,
            gesture.handle ?? 'se',
            dx,
            dy,
            displayBounds,
            event.altKey,
          );
      setDraftScopeBounds(nextBounds);
      send({ type: 'scope-draft-changed', bounds: nextBounds });
    };

    const completeInteraction = (pointerId: number, restoreBlur: boolean) => {
      const gesture = scopeEditorGestureRef.current;
      if (!gesture || gesture.pointerId !== pointerId) {
        return;
      }

      const nextBounds = draftScopeBoundsRef.current ?? gesture.startBounds;
      if (gesture.target.hasPointerCapture(pointerId)) {
        gesture.target.releasePointerCapture(pointerId);
      }
      scopeEditorGestureRef.current = null;
      setScopeInteractionMode(null);
      setDraftScopeBounds(null);
      send({ type: 'region-selected', bounds: nextBounds, role: state.activeRegionRole });
      if (restoreBlur) {
        send({ type: 'scope-selection-ended' });
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      completeInteraction(event.pointerId, true);
    };

    const handlePointerCancel = (event: PointerEvent) => {
      completeInteraction(event.pointerId, true);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [displayBounds, send, showInput]);

  useEffect(() => {
    if (!showPillInput) {
      setInputValue('');
      lastSubmitRef.current = null;
      pendingLocalDraftRef.current = false;
      return;
    }

    const focusRetryTimers = new Set<number>();

    const focusInput = () => {
      const input = pillInputRef.current;
      if (!input) {
        return false;
      }

      input.focus({ preventScroll: true });
      const cursorPosition = input.value.length;
      input.setSelectionRange(cursorPosition, cursorPosition);
      const focused = document.activeElement === input;
      if (focused) {
        reportInputFocusChange(true);
      }
      return focused;
    };

    const scheduleFocusAttempt = (delayMs: number) => {
      const timerId = window.setTimeout(() => {
        focusRetryTimers.delete(timerId);
        requestFocus();
      }, delayMs);
      focusRetryTimers.add(timerId);
    };

    const requestFocus = () => {
      requestAnimationFrame(() => {
        if (focusInput()) {
          return;
        }

        for (const delayMs of [16, 48, 96, 180, 320]) {
          scheduleFocusAttempt(delayMs);
        }
      });
    };

    requestFocus();

    const handleWindowFocus = () => requestFocus();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestFocus();
      }
    };

    const unsubscribe = window.overlay.onRequestInputFocus(() => {
      requestFocus();
    });

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      unsubscribe();
      for (const timerId of focusRetryTimers) {
        window.clearTimeout(timerId);
      }
      focusRetryTimers.clear();
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [showPillInput]);

  useEffect(() => {
    if (pillShellLockTimeoutRef.current !== null) {
      window.clearTimeout(pillShellLockTimeoutRef.current);
      pillShellLockTimeoutRef.current = null;
    }

    if (!showPill) {
      previousPillVisualKeyRef.current = null;
      setFixedPillShellSize(null);
      return;
    }

    const previousKey = previousPillVisualKeyRef.current;
    previousPillVisualKeyRef.current = pillVisualKey;

    if (
      previousKey !== null
      && previousKey !== pillVisualKey
      && pillSize.width > 0
      && pillSize.height > 0
    ) {
      setFixedPillShellSize({ ...pillSize });
      pillShellLockTimeoutRef.current = window.setTimeout(() => {
        pillShellLockTimeoutRef.current = null;
        setFixedPillShellSize(null);
      }, OVERLAY_PRESENTATION_MS);
      return;
    }

    setFixedPillShellSize(null);
  }, [pillSize, pillVisualKey, showPill]);

  useEffect(() => () => {
    if (pillShellLockTimeoutRef.current !== null) {
      window.clearTimeout(pillShellLockTimeoutRef.current);
      pillShellLockTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!showPillInput) {
      return;
    }

    if (pendingLocalDraftRef.current && !state.isRecording) {
      if (state.transcript === inputValue) {
        pendingLocalDraftRef.current = false;
      } else {
        return;
      }
    }

    setInputValue(state.transcript);
  }, [inputValue, showPillInput, state.isRecording, state.transcript]);

  useLayoutEffect(() => {
    const input = pillInputRef.current;
    if (!input || !showPillInput) {
      if (!showPillInput) {
        setPillInputHeight(28);
      }
      return;
    }

    input.style.height = '0px';
    const nextHeight = Math.min(input.scrollHeight, 180);
    input.style.height = `${nextHeight}px`;
    setPillInputHeight(nextHeight);
  }, [inputValue, showPillInput]);

  const sendOverlaySubmit = async (
    text: string,
    attachments?: OverlayUserAttachment[],
  ) => {
    const submitBootstrap = await window.overlay.getBootstrap();
    setOverlayBootstrap(submitBootstrap);

    const submitWorkspaceTargets = buildWorkspaceTargets(submitBootstrap);
    const submitWorkspaceValue = selectDefaultWorkspaceValue(submitBootstrap, submitWorkspaceTargets);
    const submitWorkspaceTarget = submitWorkspaceTargets.find((target) => target.value === submitWorkspaceValue)
      ?? submitWorkspaceTargets[0]
      ?? {
        value: NO_WORKSPACE_VALUE,
        label: 'No workspace',
        workspacePath: null,
        targetWindowSessionKey: null,
      };
    const submitProfileId = resolvePreferredProfileId({
      profiles: submitBootstrap.profiles,
      preferredProfileId: submitBootstrap.preferredProfileId ?? null,
      defaultProfileId: submitBootstrap.defaultProfileId ?? null,
    });

    send({
      type: 'submit',
      text,
      attachments,
      contextItems: state.contextItems,
      workspacePath: submitWorkspaceTarget.workspacePath,
      targetWindowSessionKey: submitWorkspaceTarget.targetWindowSessionKey,
      profileId: submitProfileId,
    });
  };

  const handleInputSubmit = () => {
    const submittedValue = (state.transcript || inputValue).trim();
    if (!submittedValue) {
      return;
    }

    const now = Date.now();
    if (
      lastSubmitRef.current
      && lastSubmitRef.current.text === submittedValue
      && now - lastSubmitRef.current.at < 250
    ) {
      return;
    }

    lastSubmitRef.current = { text: submittedValue, at: now };
    pendingLocalDraftRef.current = false;
    void sendOverlaySubmit(submittedValue);
  };

  const handlePillInputChange = (nextValue: string) => {
    pendingLocalDraftRef.current = true;
    setInputValue(nextValue);
    send({ type: 'draft-changed', text: nextValue });
  };

  const handlePillPrimaryAction = () => {
    if (state.isRecording) {
      send({ type: 'dismiss' });
      return;
    }

    if (!inputValue.trim()) {
      send({ type: 'toggle-voice-recording' });
      return;
    }

    handleInputSubmit();
  };

  useEffect(() => {
    if (!showInput || state.mode !== 'input' || state.isRecording) {
      return;
    }

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      const isSubmitKey = event.key === 'Enter' || event.code === 'NumpadEnter';
      if (!isSubmitKey || event.shiftKey || event.isComposing) {
        return;
      }

      if (!inputValue.trim()) {
        return;
      }

      event.preventDefault();
      handleInputSubmit();
    };

    window.addEventListener('keydown', handleWindowKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown, true);
    };
  }, [handleInputSubmit, inputValue, showInput, state.isRecording, state.mode, state.transcript]);

  const handlePillInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleInputSubmit();
    }
  };

  const beginScopeInteraction = (mode: 'create' | 'move' | 'resize') => {
    setScopeInteractionMode(mode);
    send({ type: 'scope-selection-started' });
  };

  const endScopeInteraction = () => {
    setScopeInteractionMode(null);
    send({ type: 'scope-selection-ended' });
  };

  const isPointInsideInputControl = useCallback((clientX: number, clientY: number): boolean => {
    const selectors = [
      '[data-interactive]',
      '[data-overlay-context-chip-id]',
      '[data-overlay-context-chip-remove-id]',
      '[data-overlay-editor-area="true"]',
    ];

    return selectors.some((selector) => (
      Array.from(document.querySelectorAll<HTMLElement>(selector)).some((element) => {
        const rect = element.getBoundingClientRect();
        return (
          clientX >= rect.left
          && clientX <= rect.right
          && clientY >= rect.top
          && clientY <= rect.bottom
        );
      })
    ));
  }, []);

  const handleBackgroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!showInput || event.button !== 0) {
      return;
    }

    if (isPointInsideInputControl(event.clientX, event.clientY)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    setScopeTooltipPosition(
      clampTooltipPosition(
        {
          left: event.clientX + SCOPE_TOOLTIP_OFFSET_X,
          top: event.clientY + SCOPE_TOOLTIP_OFFSET_Y,
        },
        SCOPE_TOOLTIP_SIZE,
        viewportSize,
      ),
    );
    dragGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      maxDistancePx: 0,
    };
    setDraftScopeBounds(null);
    setScopeDragPreview(scopeDragPreviewRef.current, null, tracePrimaryColor);
    beginScopeInteraction('create');
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleBackgroundPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragGestureRef.current && isPointInsideInputControl(event.clientX, event.clientY)) {
      return;
    }

    setScopeTooltipPosition(
      clampTooltipPosition(
        {
          left: event.clientX + SCOPE_TOOLTIP_OFFSET_X,
          top: event.clientY + SCOPE_TOOLTIP_OFFSET_Y,
        },
        SCOPE_TOOLTIP_SIZE,
        viewportSize,
      ),
    );

    const gesture = dragGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    gesture.maxDistancePx = Math.max(
      gesture.maxDistancePx,
      getPointerTravelDistance(
        { x: gesture.startX, y: gesture.startY },
        { x: event.clientX, y: event.clientY },
      ),
    );

    const nextDraftBounds = buildCreateBounds(
      { x: gesture.startX, y: gesture.startY },
      { x: event.clientX, y: event.clientY },
      displayBounds,
    );
    setScopeDragPreview(
      scopeDragPreviewRef.current,
      hasMeaningfulScope(nextDraftBounds) ? nextDraftBounds : null,
      tracePrimaryColor,
    );
    if (hasMeaningfulScope(nextDraftBounds)) {
      setDraftScopeBounds(nextDraftBounds);
      send({ type: 'scope-draft-changed', bounds: nextDraftBounds });
    } else {
      setDraftScopeBounds(null);
      send({ type: 'scope-draft-changed', bounds: null });
    }
  };

  const clearBackgroundGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragGestureRef.current?.pointerId === event.pointerId) {
      dragGestureRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleBackgroundPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = dragGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    if (isPointInsideInputControl(gesture.startX, gesture.startY)) {
      clearBackgroundGesture(event);
      setScopeDragPreview(scopeDragPreviewRef.current, null, tracePrimaryColor);
      setDraftScopeBounds(null);
      send({ type: 'scope-draft-changed', bounds: null });
      endScopeInteraction();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const completedBounds = buildCreateBounds(
      { x: gesture.startX, y: gesture.startY },
      { x: event.clientX, y: event.clientY },
      displayBounds,
    );
    clearBackgroundGesture(event);
    setScopeDragPreview(scopeDragPreviewRef.current, null, tracePrimaryColor);
    setDraftScopeBounds(null);

    if (hasMeaningfulScope(completedBounds)) {
      send({ type: 'region-selected', bounds: completedBounds, role: state.activeRegionRole });
      endScopeInteraction();
      return;
    }

    send({ type: 'scope-draft-changed', bounds: null });

    if (
      gesture.maxDistancePx <= CLICK_DISMISS_MAX_DISTANCE_PX
      && (
      getPointerTravelDistance(
        { x: gesture.startX, y: gesture.startY },
        { x: event.clientX, y: event.clientY },
      ) <= CLICK_DISMISS_MAX_DISTANCE_PX
      )
    ) {
      send({ type: 'dismiss' });
      return;
    }

    endScopeInteraction();
  };

  const handleBackgroundPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    clearBackgroundGesture(event);
    setScopeDragPreview(scopeDragPreviewRef.current, null, tracePrimaryColor);
    setDraftScopeBounds(null);
    send({ type: 'scope-draft-changed', bounds: null });
    dragGestureRef.current = null;
    endScopeInteraction();
  };

  const handleScopeMovePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!showInput || !state.scopeBounds || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDraftScopeBounds(state.scopeBounds);
    scopeEditorGestureRef.current = {
      mode: 'move',
      pointerId: event.pointerId,
      startPointer: { x: event.clientX, y: event.clientY },
      startBounds: state.scopeBounds,
      target: event.currentTarget,
    };
    beginScopeInteraction('move');
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleScopeResizePointerDown = (handle: ScopeResizeHandle) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!showInput || !state.scopeBounds || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDraftScopeBounds(state.scopeBounds);
    scopeEditorGestureRef.current = {
      mode: 'resize',
      handle,
      pointerId: event.pointerId,
      startPointer: { x: event.clientX, y: event.clientY },
      startBounds: state.scopeBounds,
      target: event.currentTarget,
    };
    beginScopeInteraction('resize');
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const shouldRenderChromePill = showPill;
  // The executing pill is display-only: it must never add a mouse-capture
  // surface while automation is driving the screen.
  const isDisplayOnlyPill = !showPillInput && state.pill.kind !== 'review';

  const inlineMarkerVariant = useMemo<'dot' | 'send' | null>(() => {
    if (showPillInput) {
      return 'send';
    }

    return null;
  }, [showPillInput]);

  const pillAnchor = useMemo(
    () => getBottomPillAnchor(pillSize, viewportSize, state.displayWorkArea),
    [pillSize, state.displayWorkArea, viewportSize],
  );

  const pillEntryAnchor = pillAnchor;

  useEffect(() => {
    (window as Window & { __INTERPRETER_OVERLAY_DEBUG__?: unknown }).__INTERPRETER_OVERLAY_DEBUG__ = {
      mode: state.mode,
      pillKind: state.pill.kind,
      showInput,
      showPillInput,
      showReview,
      showGhostTargets,
      activeActionType: activeAction?.type ?? null,
      activeActionId: activeAction?.id ?? null,
      reviewActionType: reviewAction?.type ?? null,
      reviewActionId: reviewAction?.id ?? null,
      traceActionTypes: effectivePlan.map((action) => action.type),
      traceActionIds: effectivePlan.map((action) => action.id),
      ctrlPressed: state.ctrlPressed,
      shiftPressed: state.shiftPressed,
      scopeBounds: state.scopeBounds,
      draftScopeBounds: state.draftScopeBounds,
      localDraftScopeBounds: draftScopeBounds,
      selectableElementCount: state.selectableElements.length,
      scopedSelectionCount: scopedSelectionElements.length,
      contextItems: state.contextItems.map((item) => ({
        id: item.id,
        kind: item.kind,
        role: item.role,
        sourceKind: item.kind === 'file' ? item.sourceKind ?? null : null,
        sourceBounds: item.kind === 'file' ? item.sourceBounds ?? null : null,
      })),
      contextSourceHighlights: contextSourceHighlights.map((highlight) => ({
        id: highlight.id,
        bounds: highlight.bounds,
      })),
    };
  }, [
    activeAction?.id,
    activeAction?.type,
    draftScopeBounds,
    effectivePlan,
    reviewAction?.id,
    reviewAction?.type,
    scopedSelectionElements.length,
    showGhostTargets,
    showInput,
    showPillInput,
    showReview,
    state.ctrlPressed,
    state.shiftPressed,
    state.mode,
    state.pill.kind,
    state.draftScopeBounds,
    state.scopeBounds,
    state.contextItems,
    state.selectableElements.length,
    contextSourceHighlights,
  ]);

  useEffect(() => {
    let cancelled = false;

    const buildHealth = (): OverlayVisualHealth => {
      const toBounds = (element: Element | null): Bounds | null => {
        if (!(element instanceof HTMLElement)) {
          return null;
        }

        const rect = element.getBoundingClientRect();
        return {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
      };
      const root = document.getElementById('root');
      const editorArea = document.querySelector<HTMLElement>('[data-overlay-editor-area="true"]');
      const primaryAction = document.querySelector<HTMLElement>('[data-overlay-primary-action="true"]');
      const contextChipBounds = Array.from(document.querySelectorAll<HTMLElement>('[data-overlay-context-chip-id]'))
        .map((element) => {
          const id = element.dataset.overlayContextChipId;
          const bounds = toBounds(element);
          if (!id || !bounds) {
            return null;
          }
          const removeElement = document.querySelector<HTMLElement>(`[data-overlay-context-chip-remove-id="${CSS.escape(id)}"]`);
          return {
            id,
            bounds,
            removeBounds: removeElement ? toBounds(removeElement) : null,
            highlighted: element.dataset.overlayContextChipHighlighted === 'true',
          };
        })
        .filter((entry): entry is { id: string; bounds: Bounds; removeBounds: Bounds | null; highlighted: boolean } => entry !== null);
      const contextSourceHighlightBounds = Array.from(document.querySelectorAll('.overlay-context-source-highlight'))
        .map((element) => toBounds(element))
        .filter((bounds): bounds is Bounds => bounds !== null);
      const hasVisiblePill = hasAnyVisibleElement('.pill-shell');
      const visiblePillShell = Array.from(document.querySelectorAll<HTMLElement>('.pill-shell')).find(isVisibleElement) ?? null;
      const visualState = visualHealthStateRef.current;
      const hasVisibleEditor = isVisibleElement(editorArea);
      const hasVisibleInputControl = hasVisibleEditor || (visualState.inputPromptVisible && (
        hasAnyVisibleElement('.pill-input-field')
        || hasAnyVisibleElement('.input-panel-field')
      ));
      const reviewAcceptControl = document.querySelector<HTMLElement>('[data-overlay-review-accept="true"]');
      const hasVisibleReviewControl = hasAnyVisibleElement('.approval-review-button');
      const hasVisibleMarker = hasAnyVisibleElement('.overlay-agent-marker')
        || hasAnyVisibleElement('.overlay-agent-marker-inline');
      const hasVisibleThinkingSheen = hasAnyVisibleElement('.scope-selection-spark');
      const hasRenderedDom = Boolean(root && root.childElementCount > 0);
      const hasVisibleAffordance = hasVisiblePill
        || hasVisibleInputControl
        || hasVisibleReviewControl
        || hasVisibleMarker;

      return {
        source: 'chrome',
        renderedMode: visualState.renderedMode,
        pillKind: visualState.pillKind,
        activeActionId: activeAction?.id ?? null,
        reviewActionId: reviewAction?.id ?? null,
        activeActionBounds: activeAction?.bounds ?? null,
        reviewActionBounds: reviewAction?.bounds ?? null,
        scopeFrameBounds: state.scopeBounds,
        tracePrimaryColor: state.tracePrimaryColor,
        hasRenderedDom,
        hasVisiblePill,
        pillBounds: toBounds(visiblePillShell),
        hasVisibleInputControl,
        hasVisibleReviewControl,
        reviewControlBounds: isVisibleElement(reviewAcceptControl) ? toBounds(reviewAcceptControl) : null,
        hasVisibleMarker,
        hasVisibleThinkingSheen,
        hasVisibleAffordance,
        domNodeCount: root?.childElementCount ?? 0,
        selectedWorkspaceValue: null,
        selectedProfileId: null,
        workspaceTriggerBounds: null,
        profileTriggerBounds: null,
        editorBounds: toBounds(editorArea),
        primaryActionBounds: toBounds(primaryAction),
        contextSourceHighlightBounds,
        contextChipBounds,
        workspaceOptionBounds: [],
        profileOptionBounds: [],
        timestamp: Date.now(),
      };
    };

    const reportHealth = () => {
      if (cancelled) {
        return;
      }
      const health = buildHealth();
      const signature = JSON.stringify({
        renderedMode: health.renderedMode,
        pillKind: health.pillKind,
        hasRenderedDom: health.hasRenderedDom,
        hasVisiblePill: health.hasVisiblePill,
        hasVisibleInputControl: health.hasVisibleInputControl,
        hasVisibleReviewControl: health.hasVisibleReviewControl,
        hasVisibleMarker: health.hasVisibleMarker,
        hasVisibleAffordance: health.hasVisibleAffordance,
        domNodeCount: health.domNodeCount,
        contextSourceHighlightCount: health.contextSourceHighlightBounds?.length ?? 0,
        contextChipCount: health.contextChipBounds?.length ?? 0,
        highlightedContextChipCount: health.contextChipBounds?.filter((entry) => entry.highlighted).length ?? 0,
        selectedWorkspaceValue: health.selectedWorkspaceValue,
        selectedProfileId: health.selectedProfileId,
      });
      if (signature !== lastVisualHealthSignatureRef.current) {
        console.log('[InterpreterOverlay][RendererHealth]', signature);
        lastVisualHealthSignatureRef.current = signature;
      }
      lastVisualHealthRef.current = health;
      window.overlay.send({ type: 'visual-health', health });
    };

    const scheduleReport = () => {
      if (cancelled) {
        return;
      }

      if (visualHealthFrameRef.current !== null) {
        window.clearTimeout(visualHealthFrameRef.current);
        visualHealthFrameRef.current = null;
      }

      visualHealthFrameRef.current = window.setTimeout(() => {
        visualHealthFrameRef.current = null;
        reportHealth();
      }, 0);
    };

    scheduleVisualHealthReportRef.current = scheduleReport;

    const root = document.getElementById('root');
    const mutationObserver = root
      ? new MutationObserver((records) => {
          if (records.some((record) => record.type === 'childList')) {
            scheduleReport();
          }
        })
      : null;
    if (root && mutationObserver) {
      mutationObserver.observe(root, { childList: true, subtree: true });
    }

    const handleViewportChange = () => {
      scheduleReport();
    };

    const handleMotionSettled = (event: Event) => {
      if (!(event.target instanceof Element) || !root?.contains(event.target)) {
        return;
      }
      scheduleReport();
    };

    window.addEventListener('resize', handleViewportChange);
    document.addEventListener('visibilitychange', handleViewportChange);
    root?.addEventListener('transitionstart', handleMotionSettled, true);
    root?.addEventListener('transitionrun', handleMotionSettled, true);
    root?.addEventListener('transitionend', handleMotionSettled, true);
    root?.addEventListener('transitioncancel', handleMotionSettled, true);
    root?.addEventListener('animationstart', handleMotionSettled, true);
    root?.addEventListener('animationend', handleMotionSettled, true);
    root?.addEventListener('animationcancel', handleMotionSettled, true);

    scheduleReport();

    const heartbeatId = window.setInterval(() => {
      if (cancelled) {
        return;
      }

      const cachedHealth = lastVisualHealthRef.current;
      if (!cachedHealth) {
        scheduleReport();
        return;
      }

      const heartbeatHealth = {
        ...cachedHealth,
        timestamp: Date.now(),
      };
      lastVisualHealthRef.current = heartbeatHealth;
      window.overlay.send({ type: 'visual-health', health: heartbeatHealth });
    }, RENDERER_HEALTH_HEARTBEAT_MS);

    return () => {
      cancelled = true;
      scheduleVisualHealthReportRef.current = null;
      mutationObserver?.disconnect();
      window.removeEventListener('resize', handleViewportChange);
      document.removeEventListener('visibilitychange', handleViewportChange);
      root?.removeEventListener('transitionstart', handleMotionSettled, true);
      root?.removeEventListener('transitionrun', handleMotionSettled, true);
      root?.removeEventListener('transitionend', handleMotionSettled, true);
      root?.removeEventListener('transitioncancel', handleMotionSettled, true);
      root?.removeEventListener('animationstart', handleMotionSettled, true);
      root?.removeEventListener('animationend', handleMotionSettled, true);
      root?.removeEventListener('animationcancel', handleMotionSettled, true);
      if (visualHealthFrameRef.current !== null) {
        window.clearTimeout(visualHealthFrameRef.current);
        visualHealthFrameRef.current = null;
      }
      window.clearInterval(heartbeatId);
    };
  }, []);

  return (
    <LayoutGroup id="overlay-motion">
      <>
        <AnimatePresence initial={false}>
          {state.runningAgents.length > 0 ? (
            <motion.div
              initial={prefersReducedMotion ? false : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={prefersReducedMotion ? { duration: 0 } : SHARED_OBJECT_OPACITY}
            >
              <AgentDashboardTrack
                agents={state.runningAgents}
                approvals={state.dashboardApprovals}
                onReveal={(agentId) => send({ type: 'reveal-agent-window', agentId })}
                onStop={(agentId) => send({ type: 'stop-agent-window', agentId })}
                onSendMessage={(agentId, message) => send({ type: 'send-agent-window-message', agentId, message })}
                onApproveApproval={(approvalId, rememberForSession) => (
                  send({ type: 'approve-dashboard-approval', approvalId, rememberForSession })
                )}
                onDenyApproval={(approvalId) => send({ type: 'deny-dashboard-approval', approvalId })}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {renderInputOverlay && (
          <div
            className="overlay-root"
            style={{
              pointerEvents: showInput ? 'auto' : 'none',
              opacity: inputOverlayVisible ? 1 : 0,
              transition: `opacity ${INPUT_OVERLAY_FADE_MS}ms ease-out`,
              backgroundColor: showInput ? 'rgba(255, 255, 255, 0.01)' : 'transparent',
            }}
          >
            {showInput && !(showScopeFill && scopeVisualBounds) && (
              // With a selection box visible, the outside scrim owns the
              // dimming so the selected content stays completely untouched.
              // Keyed (like the capture layer below) so React never reassigns
              // DOM nodes between these siblings when this dim unmounts during
              // a pointer gesture — that would break pointer capture and eat
              // the click.
              <div key="overlay-input-screen-dim" className="overlay-input-screen-dim" aria-hidden="true" />
            )}
            <div
              key="overlay-selection-capture"
              className="overlay-selection-capture"
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: showInput ? 'auto' : 'none',
                backgroundColor: 'rgba(255, 255, 255, 0.01)',
              }}
              onPointerDown={handleBackgroundPointerDown}
              onPointerMove={handleBackgroundPointerMove}
              onPointerUp={handleBackgroundPointerUp}
              onPointerCancel={handleBackgroundPointerCancel}
            />

            <AnimatePresence initial={false}>
              {showSelectionHintTooltip && (
                <motion.div
                  key="scope-selection-hint"
                  className="scope-selection-tooltip"
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                  transition={prefersReducedMotion ? { duration: 0 } : SHARED_OBJECT_OPACITY}
                  style={{
                    left: scopeTooltipPosition.left,
                    top: scopeTooltipPosition.top,
                  }}
                  aria-hidden="true"
                >
                  Click and drag to grant a square on your screen.
                </motion.div>
              )}
            </AnimatePresence>

            <div
              ref={scopeDragPreviewRef}
              className="scope-drag-preview"
              aria-hidden="true"
            />

            {!usesPillInputDesign && (
              <InputPanel
                visible={showInput}
                shown={inputComposerVisible}
                screenshot={state.screenshot}
                transcript={state.transcript}
                isRecording={state.isRecording}
                amplitude={state.amplitude}
                contextItems={state.contextItems}
                selectionInteractionActive={scopeInteractionActive}
                onInputFocusChange={reportInputFocusChange}
                onDraftChange={(text) => send({ type: 'draft-changed', text })}
                onClearInputContext={() => send({ type: 'clear-input-context' })}
                onRemoveContextItem={(id) => send({ type: 'remove-context-item', id })}
                onFilesDropped={(files) => send({ type: 'files-dropped', files: files.filter((item) => item.kind === 'file') })}
                onSubmit={(submission) => sendOverlaySubmit(submission.text, submission.attachments)}
                onVoiceToggle={() => send({ type: 'toggle-voice-recording' })}
                onDismiss={() => send({ type: 'dismiss' })}
              />
            )}
          </div>
        )}

        {contextSourceHighlights.length > 0 && (
          <div className="overlay-root" style={{ pointerEvents: 'none', zIndex: 10060 }}>
            {contextSourceHighlights.map((highlight) => {
              const highlightStyle: OverlayContextSourceHighlightStyle = {
                left: highlight.bounds.x,
                top: highlight.bounds.y,
                width: highlight.bounds.width,
                height: highlight.bounds.height,
                borderColor: state.tracePrimaryColor,
                '--overlay-context-source-color': state.tracePrimaryColor,
              };
              return (
                <div
                  key={highlight.id}
                  className="overlay-context-source-highlight"
                  aria-hidden="true"
                  style={highlightStyle}
                />
              );
            })}
          </div>
        )}

        <AnimatePresence initial={false}>
          {!state.worldPinActive && showScopeFrame && scopeVisualBounds && (
            <motion.div
              className="overlay-root"
              style={{ pointerEvents: 'none', zIndex: 9999 }}
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: scopeSurfaceVisible ? 1 : 0 }}
              exit={{ opacity: 0 }}
              transition={
                prefersReducedMotion
                  ? { duration: 0 }
                  : {
                      duration: SCOPE_SURFACE_FADE_MS / 1000,
                      ease: SHARED_OBJECT_EASE,
                    }
              }
            >
              <div className="scope-selection-layer">
              <div
                className="scope-selection-surface"
                style={{
                  left: scopeVisualBounds.x,
                  top: scopeVisualBounds.y,
                  width: scopeVisualBounds.width,
                  height: scopeVisualBounds.height,
                }}
                aria-hidden="true"
              >
                {showScopeFill && showScopeDarkScrim && (
                  <div
                    className="scope-selection-dim"
                    style={{
                      left: 0,
                      top: 0,
                      width: '100%',
                      height: '100%',
                      backgroundColor: scopeHoleBounds
                        ? 'transparent'
                        : getInterpreterOverlayScopeFillColor(inputComposerVisible),
                      backdropFilter: 'none',
                      WebkitBackdropFilter: 'none',
                      '--scope-overlay-fill': getInterpreterOverlayScopeFillColor(inputComposerVisible),
                    }}
                  >
                    {scopeHoleBounds && (
                      <div
                        className={`scope-selection-hole${scopeHolePressed ? ' scope-selection-hole-pressed' : ''}`}
                        style={{
                          left: `${scopeHoleBounds.x}px`,
                          top: `${scopeHoleBounds.y}px`,
                          width: `${scopeHoleBounds.width}px`,
                          height: `${scopeHoleBounds.height}px`,
                          borderRadius: `${getScopeHoleRadius(scopeHoleBounds)}px`,
                        }}
                      />
                    )}
                  </div>
                )}
                {showScopeFill && !showScopeDarkScrim && (
                  // Input-mode selection look: everything outside the selected
                  // box is dimmed, the inside stays untouched, and the colored
                  // frame marks the edge.
                  <div className="scope-selection-outside-scrim" aria-hidden="true" />
                )}
                <div
                  className={`scope-selection-frame ${draftScopeBounds ? 'scope-selection-frame-draft' : 'scope-selection-frame-active'}`}
                  style={{
                    left: 0,
                    top: 0,
                    width: '100%',
                    height: '100%',
                    borderColor: tracePrimaryColor,
                  }}
                />
                {(() => {
                  const selectedScopeBounds = effectiveScopeBounds;
                  if (!showInput || !selectedScopeBounds || scopeMoveEdgeBands.length === 0) {
                    return null;
                  }

                  return (
                    <div className="scope-selection-editor" aria-hidden="true">
                      {scopeMoveEdgeBands.map((band, bandIndex) => (
                        <button
                          key={`move-band-${bandIndex}`}
                          type="button"
                          className="scope-selection-move-hit-target"
                          data-interactive
                          style={{
                            left: band.x - selectedScopeBounds.x,
                            top: band.y - selectedScopeBounds.y,
                            width: band.width,
                            height: band.height,
                          }}
                          onPointerDown={handleScopeMovePointerDown}
                        />
                      ))}
                      {SCOPE_RESIZE_HANDLES.map((handle) => {
                        const position = getScopeHandlePosition(selectedScopeBounds, handle);
                        return (
                          <button
                            key={handle}
                            type="button"
                            className={`scope-selection-handle scope-selection-handle-${handle}`}
                            data-interactive
                            style={{
                              left: position.left - selectedScopeBounds.x,
                              top: position.top - selectedScopeBounds.y,
                              width: SCOPE_HANDLE_SIZE,
                              height: SCOPE_HANDLE_SIZE,
                            }}
                            onPointerDown={handleScopeResizePointerDown(handle)}
                          />
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
              <AnimatePresence initial={false}>
                {scopeStatusTooltipPosition && (
                  <motion.div
                    key="scope-status-tooltip"
                    className="scope-selection-tooltip scope-selection-status-tooltip"
                    initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                    transition={prefersReducedMotion ? { duration: 0 } : SHARED_OBJECT_OPACITY}
                    style={{
                      left: scopeStatusTooltipPosition.left,
                      top: scopeStatusTooltipPosition.top,
                    }}
                    aria-hidden="true"
                  >
                    Interpreter only sees this region.
                  </motion.div>
                )}
              </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {shouldRenderChromePill && (
            <div className="overlay-root" style={{ pointerEvents: 'none', zIndex: 10003 }}>
              <motion.div
                className="pill-container"
                ref={pillContainerRef}
                data-interactive={isDisplayOnlyPill ? undefined : true}
                key="overlay-pill"
                initial={prefersReducedMotion ? false : {
                  x: pillShouldBeImmediatelyVisible ? pillAnchor.left : pillEntryAnchor.left,
                  y: pillShouldBeImmediatelyVisible ? pillAnchor.top : pillEntryAnchor.top,
                  opacity: pillShouldBeImmediatelyVisible ? (showInput ? selectionInterfaceOpacity : 1) : 0,
                  scale: pillShouldBeImmediatelyVisible ? 1 : 0.94,
                }}
                animate={{
                  x: pillAnchor.left,
                  y: pillAnchor.top,
                  opacity: showInput ? selectionInterfaceOpacity : 1,
                  scale: 1,
                }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={
                  prefersReducedMotion
                    ? { duration: 0 }
                    : {
                        x: SHARED_OBJECT_MOTION,
                        y: SHARED_OBJECT_MOTION,
                        scale: SHARED_OBJECT_OPACITY,
                        opacity: SHARED_OBJECT_OPACITY,
                      }
                }
                style={{
                  left: 0,
                  top: 0,
                  pointerEvents: isDisplayOnlyPill || (showInput && scopeInteractionActive) ? 'none' : 'auto',
                  cursor: 'default',
                }}
                onClick={(event) => event.stopPropagation()}
              >
                <Pill
                  mode={state.pill}
                  reviewAction={reviewAction}
                  reviewActionCount={effectivePlan.length}
                  executionProgress={executionProgress}
                  attachedToTarget={false}
                  onAccept={() => send({ type: 'accept' })}
                  onAcceptAllSession={() => send({ type: 'accept-all-session' })}
                  onReject={() => send({ type: 'reject' })}
                  ctrlPressed={state.pill.kind === 'review' ? state.ctrlPressed : false}
                  inlineMarkerVariant={inlineMarkerVariant}
                  disableInitialContentAnimation={state.pill.kind === 'loading' || state.pill.kind === 'recording'}
                  fixedShellSize={fixedPillShellSize}
                  primaryColor={tracePrimaryColor}
                  inputState={
                    showPillInput
                      ? {
                          value: inputValue,
                          isRecording: state.isRecording,
                          isExpanded: pillInputHeight > 34,
                          placeholder: inputPlaceholder,
                          buttonMode: state.isRecording ? 'dismiss' : (inputValue.trim() ? 'send' : 'voice'),
                          canSubmit: inputValue.trim().length > 0,
                          inputRef: focusPillInputElement,
                          onChange: handlePillInputChange,
                          onPrimaryAction: handlePillPrimaryAction,
                          onSubmit: handleInputSubmit,
                          onKeyDown: handlePillInputKeyDown,
                          onFocusChange: reportInputFocusChange,
                        }
                      : null
                  }
                />
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {showInput && hoverTooltip && (
            <motion.div
              key={hoverTooltip.id}
              className="scope-selection-tooltip scope-selection-control-tooltip"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 2 }}
              transition={prefersReducedMotion ? { duration: 0 } : SHARED_OBJECT_OPACITY}
              style={{
                left: hoverTooltip.position.left,
                top: hoverTooltip.position.top,
                zIndex: 10004,
              }}
            >
              <span className="scope-selection-tooltip-text">{hoverTooltip.label}</span>
              {hoverTooltip.shortcut && (
                <span className="scope-selection-tooltip-shortcut">
                  {hoverTooltip.shortcutPrefix && (
                    <span className="scope-selection-tooltip-shortcut-prefix">{hoverTooltip.shortcutPrefix}</span>
                  )}
                  {hoverTooltip.shortcut.split('+').map((part) => (
                    <span key={part} className="scope-selection-tooltip-keycap">{part}</span>
                  ))}
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {!state.worldPinActive && (showReview || state.mode === 'working') && effectivePlan.length > 0 && (
            <motion.div
              className="overlay-root"
              style={{ pointerEvents: 'none', zIndex: 10000 }}
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={prefersReducedMotion ? { duration: 0 } : SHARED_OBJECT_OPACITY}
            >
              {effectivePlan.map((action, index) => {
                const isActive = activeAction?.id === action.id;
                const isGhost = !isActive;
                const isExecutingActive = state.mode === 'working' && isActive;
                if (action.type === 'type') {
                  return (
                    <TypePreviewOverlay
                      key={`preview-type-${action.id}`}
                      action={action}
                      ghost={isGhost}
                      active={showReview && isActive}
                      pressed={showReview && isActive && state.ctrlPressed}
              executing={isExecutingActive}
              elevated={isActive || index === 0}
              traceIndex={index}
              primaryColor={tracePrimaryColor}
            />
                  );
                }
                if (action.type === 'click' || action.type === 'scroll') {
                  return (
                    <ReviewPanel
                      key={`preview-panel-${action.id}`}
                      action={action}
                      active={isActive}
                      pressed={showReview && isActive && state.ctrlPressed}
                      executing={isExecutingActive}
                      frameColor={isGhost ? 'rgba(148, 163, 184, 0.62)' : undefined}
                      frameOpacity={1}
                      outlineWidth={2}
                    />
                  );
                }
                return null;
              })}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {!state.worldPinActive && showTrace && (
            <motion.div
              className="overlay-root"
              style={{ pointerEvents: 'none', zIndex: 10002 }}
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={prefersReducedMotion ? { duration: 0 } : SHARED_OBJECT_OPACITY}
            >
              <TraceOverlay
                actions={effectivePlan}
                viewport={viewportSize}
                syntheticPlacementBounds={effectiveScopeBounds}
                primaryColor={tracePrimaryColor}
                pressed={showReview && state.ctrlPressed}
                executing={state.mode === 'working'}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {!state.worldPinActive && scopeVisualBounds && (
            <motion.div
              className="overlay-root"
              style={{ pointerEvents: 'none', zIndex: 10001 }}
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.24, ease: SHARED_OBJECT_EASE }}
            >
              <div
                className="scope-selection-surface"
                style={{
                  left: scopeVisualBounds.x,
                  top: scopeVisualBounds.y,
                  width: scopeVisualBounds.width,
                  height: scopeVisualBounds.height,
                }}
                aria-hidden="true"
              >
                <ScopeSelectionSheen
                  visible={showProcessingEffects}
                  scopeWidth={scopeVisualBounds.width}
                  scopeHeight={scopeVisualBounds.height}
                  elements={loadingSheenElements}
                  primaryColor={tracePrimaryColor}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {state.globalApproval && !state.advancedVoiceActive ? (
            <motion.div
              className="advanced-voice-controls global-approval-controls"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={prefersReducedMotion ? { duration: 0 } : SHARED_OBJECT_OPACITY}
            >
              {globalApprovalControl}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {state.advancedVoiceActive && (
            <motion.div
              className="advanced-voice-layer"
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={prefersReducedMotion ? { duration: 0 } : SHARED_OBJECT_OPACITY}
              aria-hidden="true"
            >
              <div
                className="advanced-voice-aurora"
                style={{
                  opacity: 0.26 + advancedVoiceAmplitude * 0.42,
                  transform: `translate3d(-50%, -50%, 0) scale(${1 + advancedVoiceAmplitude * 0.18})`,
                }}
              />
              <div className="advanced-voice-controls" data-interactive="true">
                {globalApprovalControl}
                <button
                  type="button"
                  className="advanced-voice-stop"
                  data-interactive="true"
                  onClick={(event) => {
                    event.stopPropagation();
                    stopAdvancedVoiceSession();
                  }}
                >
                  Stop
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </>
    </LayoutGroup>
  );
}

export const __test__ = {
  resolvePreferredProfileId,
  getBottomPillAnchor,
  getExecutionPillProgress,
};
