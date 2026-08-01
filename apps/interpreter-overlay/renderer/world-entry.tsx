import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bounds, OverlayState, OverlayVisualHealth, ReviewAction } from '../shared/ipc.js';
import { DEFAULT_OVERLAY_STATE } from '../shared/ipc.js';
import { ScopeSelectionSheen } from './ScopeSelectionSheen.js';
import { TintedActionBox } from './TintedActionBox.js';
import { TraceOverlay } from './TraceOverlay.js';
import { TypePreviewOverlay } from './TypePreviewOverlay.js';

// `window.overlay` is declared by the chrome renderer's global.d.ts; we read it
// here too via the same preload bridge, so we don't redeclare its type.

function useOverlayState(): OverlayState {
  const [state, setState] = useState<OverlayState>(DEFAULT_OVERLAY_STATE);
  useEffect(() => {
    const off = window.overlay?.onState?.((next) => setState(next));
    return () => {
      off?.();
    };
  }, []);
  return state;
}

function VisualProbe({
  state,
  toWorldBounds,
}: {
  state: OverlayState;
  toWorldBounds: (bounds: Bounds) => Bounds;
}): React.ReactElement | null {
  const probe = state.debugVisualProbe;
  if (!probe) return null;
  const bounds = toWorldBounds(probe.bounds);
  return (
    <img
      src={probe.dataUrl}
      alt={probe.label}
      data-overlay-visual-probe={probe.id}
      style={{
        position: 'fixed',
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        display: 'block',
        objectFit: 'fill',
        pointerEvents: 'none',
        zIndex: 999,
      }}
    />
  );
}

function ScopeFrame({
  scope,
  primaryColor,
  elements,
  showExecutionSentinel = false,
}: {
  scope: { x: number; y: number; width: number; height: number };
  primaryColor: string;
  showExecutionSentinel?: boolean;
  elements: Array<{
    id: string;
    tier: 'container' | 'control';
    localLeft: number;
    localTop: number;
    width: number;
    height: number;
  }>;
}): React.ReactElement {
  const style: React.CSSProperties = {
    position: 'fixed',
    left: scope.x,
    top: scope.y,
    width: scope.width,
    height: scope.height,
    border: `1px solid ${primaryColor}`,
    borderRadius: 0,
    boxShadow: '0 0 0 1px rgba(0,0,0,0.22)',
    pointerEvents: 'none',
    overflow: 'hidden',
  };
  return (
    <div data-world-scope-frame="true" style={style}>
      <ScopeSelectionSheen
        visible
        scopeWidth={scope.width}
        scopeHeight={scope.height}
        elements={elements}
        primaryColor={primaryColor}
      />
      {showExecutionSentinel ? (
        <div
          data-world-execution-sentinel="true"
          style={{
            position: 'absolute',
            left: 10,
            top: 10,
            width: 34,
            height: 34,
            background: '#ff0000',
            border: '2px solid #ffffff',
            boxShadow: '0 0 0 2px #ff0000',
            pointerEvents: 'none',
            zIndex: 5000,
          }}
        />
      ) : null}
    </div>
  );
}

interface Size {
  width: number;
  height: number;
}

function getWorldViewportSize(state: OverlayState): Size {
  return {
    width: Math.max(1, Math.round(state.worldTargetBounds?.width ?? window.innerWidth ?? 1)),
    height: Math.max(1, Math.round(state.worldTargetBounds?.height ?? window.innerHeight ?? 1)),
  };
}

function toWorldLocalBounds(bounds: Bounds, state: OverlayState): Bounds {
  const origin = state.worldTargetBounds ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: bounds.x - origin.x,
    y: bounds.y - origin.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function toWorldLocalAction(action: ReviewAction, state: OverlayState): ReviewAction {
  return {
    ...action,
    bounds: toWorldLocalBounds(action.bounds, state),
  };
}

function boundsIntersect(left: Bounds, right: Bounds): boolean {
  return (
    left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
  );
}

function clampBoundsToBounds(bounds: Bounds, container: Bounds): Bounds {
  const x1 = Math.max(bounds.x, container.x);
  const y1 = Math.max(bounds.y, container.y);
  const x2 = Math.min(bounds.x + bounds.width, container.x + container.width);
  const y2 = Math.min(bounds.y + bounds.height, container.y + container.height);
  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1),
  };
}

function getSheenTierForRole(role: string): 'container' | 'control' {
  if (role === 'AXGroup' || role === 'AXScrollArea' || role === 'AXWebArea' || role === 'AXForm') {
    return 'container';
  }
  return 'control';
}

function WorldPill({ state }: { state: OverlayState }): React.ReactElement | null {
  void state;
  return null;
}

function WorldDimming({ state }: { state: OverlayState }): React.ReactElement | null {
  void state;
  return null;
}

function WorldActionLayers({ state }: { state: OverlayState }): React.ReactElement {
  const activeAction = state.action;
  const showReview = state.mode === 'review' && state.pill.kind === 'review' && activeAction !== null;
  const showWorking = state.mode === 'working' && activeAction !== null;
  const sourceActions = activeAction ? [activeAction, ...state.ghosts] : state.ghosts;
  const actions = sourceActions.map((action) => toWorldLocalAction(action, state));
  const primaryColor = state.tracePrimaryColor;

  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 60 }}>
      <TraceOverlay
        actions={actions}
        viewport={getWorldViewportSize(state)}
        syntheticPlacementBounds={state.scopeBounds ? toWorldLocalBounds(state.scopeBounds, state) : null}
        primaryColor={primaryColor}
        pressed={showReview && state.ctrlPressed}
        executing={showWorking}
      />
      {actions.map((action, index) => {
        const isActive = activeAction?.id === sourceActions[index]?.id;
        const isGhost = !isActive;
        const isExecutingActive = showWorking && isActive;
        if (action.type === 'type') {
          return (
            <TypePreviewOverlay
              key={`world-preview-type-${action.id}`}
              action={action}
              ghost={isGhost}
              active={showReview && isActive}
              pressed={showReview && isActive && state.ctrlPressed}
              executing={isExecutingActive}
              elevated={isActive || index === 0}
              traceIndex={index}
              primaryColor={primaryColor}
            />
          );
        }
        return null;
      })}
      {showWorking && actions[0] ? (
        <TintedActionBox
          key={`world-active-execution-${actions[0].id}`}
          className="trace-box trace-box-active trace-execution-active-box"
          color={primaryColor}
          left={actions[0].bounds.x}
          top={actions[0].bounds.y}
          width={actions[0].bounds.width}
          height={actions[0].bounds.height}
          index={0}
        />
      ) : null}
    </div>
  );
}

function isVisibleElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.01;
}

function getElementBounds(element: Element | null): Bounds | null {
  if (!(element instanceof HTMLElement)) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function useWorldVisualHealth(state: OverlayState): void {
  useEffect(() => {
    let cancelled = false;
    let frame: number | null = null;

    const sendHealth = () => {
      frame = null;
      if (cancelled) return;
      const root = document.getElementById('root');
      const reviewControl = document.querySelector('[data-world-review-ui="true"]');
      const scopeFrame = document.querySelector('[data-world-scope-frame="true"]');
      const executionSentinel = document.querySelector('[data-world-execution-sentinel="true"]');
      const activeActionBounds = state.action ? toWorldLocalBounds(state.action.bounds, state) : null;
      const hasVisiblePill = Array.from(document.querySelectorAll('.pill-shell')).some(isVisibleElement);
      const hasVisibleReviewControl = Array.from(document.querySelectorAll('[data-world-review-ui="true"], .pill-button')).some(isVisibleElement);
      const hasVisibleMarker = Array.from(document.querySelectorAll('.overlay-agent-marker, [data-world-review-action-id], [data-world-scope-frame="true"], .scope-selection-spark')).some(isVisibleElement);
      const hasVisibleThinkingSheen = Array.from(document.querySelectorAll('.scope-selection-spark')).some(isVisibleElement);
      const hasExecutionSentinel = isVisibleElement(executionSentinel);
      const hasRenderedDom = Boolean(root?.querySelector('[data-world-overlay-root="true"]'));
      const health: OverlayVisualHealth = {
        source: 'world',
        renderedMode: state.mode,
        pillKind: state.pill.kind,
        hasDebugVisualProbe: Boolean(state.debugVisualProbe),
        debugVisualProbeBounds: state.debugVisualProbe?.bounds ?? null,
        hasExecutionSentinel,
        executionSentinelBounds: hasExecutionSentinel ? getElementBounds(executionSentinel) : null,
        activeActionId: state.action?.id ?? null,
        reviewActionId: state.mode === 'review' ? state.action?.id ?? null : null,
        activeActionBounds,
        reviewActionBounds: state.mode === 'review' ? activeActionBounds : null,
        scopeFrameBounds: getElementBounds(scopeFrame),
        tracePrimaryColor: state.tracePrimaryColor,
        hasRenderedDom,
        hasVisiblePill,
        pillBounds: getElementBounds(Array.from(document.querySelectorAll('.pill-shell')).find(isVisibleElement) ?? null),
        hasVisibleInputControl: false,
        hasVisibleReviewControl,
        hasVisibleMarker,
        hasVisibleThinkingSheen,
        hasVisibleAffordance: hasVisiblePill || hasVisibleReviewControl || hasVisibleMarker,
        domNodeCount: root?.querySelectorAll('*').length ?? 0,
        reviewControlBounds: hasVisibleReviewControl ? getElementBounds(reviewControl) : null,
        timestamp: Date.now(),
      };
      window.overlay?.send?.({ type: 'visual-health', health });
    };

    const schedule = () => {
      if (cancelled || frame !== null) return;
      frame = window.requestAnimationFrame(sendHealth);
    };

    schedule();
    const interval = window.setInterval(schedule, 250);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [state]);
}

function WorldRoot(): React.ReactElement | null {
  const state = useOverlayState();
  useWorldVisualHealth(state);
  const [pinnedFrameState, setPinnedFrameState] = useState<{
    scopeBounds: Bounds;
    worldTargetBounds: Bounds;
    action: OverlayState['action'];
    ghosts: OverlayState['ghosts'];
    selectableElements: OverlayState['selectableElements'];
    debugVisualProbe: OverlayState['debugVisualProbe'];
  } | null>(null);
  const [executionSentinelLatched, setExecutionSentinelLatched] = useState(false);
  useEffect(() => {
    const nextScopeBounds = state.scopeBounds;
    const nextWorldTargetBounds = state.worldTargetBounds;
    if (state.worldPinActive && nextWorldTargetBounds && nextScopeBounds) {
      setPinnedFrameState((previousPinnedFrame) => ({
        scopeBounds: previousPinnedFrame?.scopeBounds ?? nextScopeBounds,
        worldTargetBounds: previousPinnedFrame?.worldTargetBounds ?? nextWorldTargetBounds,
        action: state.action,
        ghosts: state.ghosts,
        selectableElements: state.selectableElements,
        debugVisualProbe: state.debugVisualProbe,
      }));
    } else if (state.mode === 'idle' && !state.advancedVoiceActive) {
      setPinnedFrameState(null);
      setExecutionSentinelLatched(false);
    }

    if (state.debugExecutionSentinel && state.worldPinActive && state.scopeBounds) {
      setExecutionSentinelLatched(true);
    }
  }, [state]);
  const pinnedFrame = (
    state.worldPinActive
      ? pinnedFrameState
      : (state.mode === 'review' || state.mode === 'working' ? pinnedFrameState : null)
  );
  const frameState = pinnedFrame
    ? {
        ...state,
        worldPinActive: true,
        scopeBounds: pinnedFrame.scopeBounds,
        worldTargetBounds: pinnedFrame.worldTargetBounds,
        action: pinnedFrame.action,
        ghosts: pinnedFrame.ghosts,
        selectableElements: pinnedFrame.selectableElements,
        debugVisualProbe: pinnedFrame.debugVisualProbe,
      }
    : state;
  const scope = frameState.worldPinActive && frameState.worldTargetBounds && frameState.scopeBounds
    ? toWorldLocalBounds(frameState.scopeBounds, frameState)
    : null;
  const hasSpatialState = useMemo(() => (
    frameState.worldPinActive
    && frameState.worldTargetBounds !== null
    && (
      frameState.mode === 'review'
      || frameState.mode === 'working'
      || frameState.pill.kind === 'recording'
      || frameState.pill.kind === 'loading'
    )
  ), [frameState.mode, frameState.pill.kind, frameState.worldPinActive, frameState.worldTargetBounds]);

  if (!frameState.worldPinActive || !frameState.worldTargetBounds) return null;

  const primaryColor = frameState.tracePrimaryColor;
  const worldOpacity = frameState.worldPinClosing ? 0 : 1;
  const fadeShellStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    pointerEvents: 'none',
  };
  const showScope = Boolean(scope && hasSpatialState);
  const showPinnedScope = Boolean(scope && frameState.worldPinActive);
  const showPill = frameState.mode === 'review' && frameState.pill.kind === 'review';
  const showProcessingEffects = frameState.pill.kind === 'recording'
    || (frameState.mode === 'working' && frameState.action === null);
  const scopeElements = scope && showProcessingEffects
    ? frameState.selectableElements.flatMap((element) => {
        if (!frameState.scopeBounds || !boundsIntersect(element.bounds, frameState.scopeBounds)) {
          return [];
        }
        const clippedBounds = clampBoundsToBounds(element.bounds, frameState.scopeBounds);
        if (clippedBounds.width < 8 || clippedBounds.height < 8) {
          return [];
        }
        const tier = getSheenTierForRole(element.role);
        const scopeArea = frameState.scopeBounds.width * frameState.scopeBounds.height;
        const area = clippedBounds.width * clippedBounds.height;
        const maxAreaRatio = tier === 'container' ? 0.72 : 0.4;
        if (area >= scopeArea * maxAreaRatio) {
          return [];
        }
        const local = toWorldLocalBounds(clippedBounds, frameState);
        return [{
          id: element.id,
          tier,
          localLeft: local.x - scope.x,
          localTop: local.y - scope.y,
          width: local.width,
          height: local.height,
        }];
      })
    : [];
  return (
    <div
      data-world-overlay-root="true"
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        opacity: worldOpacity,
        transition: 'opacity 700ms ease-out',
      }}
    >
      <WorldDimming state={state} />
      {showPinnedScope && scope ? (
        <div style={fadeShellStyle}>
          <ScopeFrame
            scope={scope}
            primaryColor={primaryColor}
            showExecutionSentinel={executionSentinelLatched && frameState.mode !== 'idle'}
            elements={showScope ? scopeElements : []}
          />
        </div>
      ) : null}
      {hasSpatialState ? (
        <div style={fadeShellStyle}>
          <WorldActionLayers state={frameState} />
        </div>
      ) : null}
      <VisualProbe state={frameState} toWorldBounds={(bounds) => toWorldLocalBounds(bounds, frameState)} />
      {showPill ? (
        <div style={fadeShellStyle}>
          <WorldPill state={frameState} />
        </div>
      ) : null}
    </div>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}
createRoot(rootElement).render(
  <React.StrictMode>
    <WorldRoot />
  </React.StrictMode>,
);
