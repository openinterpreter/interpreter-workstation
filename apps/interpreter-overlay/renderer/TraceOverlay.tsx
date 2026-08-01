import type { Bounds, ReviewAction } from '../shared/ipc.js';
import { TintedActionBox } from './TintedActionBox.js';

interface TraceOverlayProps {
  actions: ReviewAction[];
  viewport: { width: number; height: number };
  syntheticPlacementBounds?: Bounds | null;
  primaryColor: string;
  pressed?: boolean;
  executing?: boolean;
}

interface TraceItem {
  action: ReviewAction;
  bounds: Bounds;
  synthetic: boolean;
}

const TRACE_BOX_WIDTH = 168;
const TRACE_BOX_HEIGHT = 36;
const TRACE_MARGIN = 18;
const TRACE_GAP = 12;
const TRACE_PRIMARY_COLORS = [
  '#ff2d55',
  '#00c853',
  '#ffb300',
  '#2979ff',
  '#7c4dff',
  '#00bcd4',
  '#ff6d00',
  '#d500f9',
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function centerOf(bounds: Bounds): { x: number; y: number } {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

export function chooseTracePrimaryColor(): string {
  return TRACE_PRIMARY_COLORS[Math.floor(Math.random() * TRACE_PRIMARY_COLORS.length)] ?? TRACE_PRIMARY_COLORS[0]!;
}

export function tracePrimaryColorForActions(actions: ReviewAction[]): string {
  const key = actions.map((action) => action.id).join(':');
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
  }
  return TRACE_PRIMARY_COLORS[Math.abs(hash) % TRACE_PRIMARY_COLORS.length] ?? TRACE_PRIMARY_COLORS[0]!;
}

function intersects(a: Bounds, b: Bounds): boolean {
  return !(
    a.x + a.width <= b.x
    || b.x + b.width <= a.x
    || a.y + a.height <= b.y
    || b.y + b.height <= a.y
  );
}

function formatSyntheticLabel(action: ReviewAction): string {
  if (action.type === 'hotkey') {
    return `Press ${action.keys || action.description.replace(/^Press\s+/i, '')}`;
  }
  if (action.type === 'type') {
    return `Type ${action.text ? `"${action.text}"` : 'text'}`;
  }
  return action.description || action.type;
}

function clampBoundsToViewport(bounds: Bounds, viewport: { width: number; height: number }): Bounds | null {
  const x = clamp(bounds.x, 0, viewport.width);
  const y = clamp(bounds.y, 0, viewport.height);
  const right = clamp(bounds.x + bounds.width, 0, viewport.width);
  const bottom = clamp(bounds.y + bounds.height, 0, viewport.height);
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function getRealBounds(action: ReviewAction, viewport: { width: number; height: number }): Bounds | null {
  if (!action.hasBounds || action.bounds.width <= 0 || action.bounds.height <= 0) {
    return null;
  }
  const rawBounds = {
    x: action.bounds.x,
    y: action.bounds.y,
    width: Math.max(action.bounds.width, 8),
    height: Math.max(action.bounds.height, 8),
  };
  const shouldSquareSmallClickTarget = action.type !== 'type'
    && rawBounds.height > rawBounds.width
    && rawBounds.width <= 44
    && rawBounds.height <= 96;
  const normalizedBounds = shouldSquareSmallClickTarget
    ? {
        x: rawBounds.x,
        y: rawBounds.y + (rawBounds.height - rawBounds.width) / 2,
        width: rawBounds.width,
        height: rawBounds.width,
      }
    : rawBounds;
  return clampBoundsToViewport(normalizedBounds, viewport);
}

function placeSyntheticBounds(
  actionIndex: number,
  actions: ReviewAction[],
  placed: TraceItem[],
  viewport: { width: number; height: number },
  syntheticPlacementBounds: Bounds | null,
): Bounds {
  const viewportBounds = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const placementArea = syntheticPlacementBounds
    ? (clampBoundsToViewport(syntheticPlacementBounds, viewport) ?? viewportBounds)
    : viewportBounds;
  const inset = Math.min(
    TRACE_MARGIN,
    Math.max(4, Math.floor(Math.min(placementArea.width, placementArea.height) / 6)),
  );
  const boxWidth = Math.max(1, Math.min(TRACE_BOX_WIDTH, placementArea.width - inset * 2));
  const boxHeight = Math.max(1, Math.min(TRACE_BOX_HEIGHT, placementArea.height - inset * 2));
  const minLeft = placementArea.x + inset;
  const maxLeft = Math.max(minLeft, placementArea.x + placementArea.width - boxWidth - inset);
  const minTop = placementArea.y + inset;
  const maxTop = Math.max(minTop, placementArea.y + placementArea.height - boxHeight - inset);
  const previous = placed[actionIndex - 1]?.bounds ?? null;
  const nextReal = actions
    .slice(actionIndex + 1)
    .map((action) => getRealBounds(action, viewport))
    .find((bounds): bounds is Bounds => bounds !== null) ?? null;
  const previousCenter = previous ? centerOf(previous) : null;
  const nextCenter = nextReal ? centerOf(nextReal) : null;
  const targetCenter = previousCenter && nextCenter
    ? {
        x: (previousCenter.x + nextCenter.x) / 2,
        y: (previousCenter.y + nextCenter.y) / 2,
      }
    : previousCenter
      ? { x: previousCenter.x + boxWidth * 0.72, y: previousCenter.y }
      : nextCenter
        ? { x: nextCenter.x - boxWidth * 0.72, y: nextCenter.y }
        : {
            x: placementArea.x + placementArea.width / 2,
            y: placementArea.y + placementArea.height - Math.min(64, placementArea.height / 3),
          };

  const baseLeft = clamp(
    targetCenter.x - boxWidth / 2,
    minLeft,
    maxLeft,
  );
  const baseTop = clamp(
    targetCenter.y - boxHeight / 2,
    minTop,
    maxTop,
  );
  const candidates: Bounds[] = [
    { x: baseLeft, y: baseTop, width: boxWidth, height: boxHeight },
    { x: baseLeft, y: baseTop - boxHeight - TRACE_GAP, width: boxWidth, height: boxHeight },
    { x: baseLeft, y: baseTop + boxHeight + TRACE_GAP, width: boxWidth, height: boxHeight },
    { x: baseLeft - boxWidth - TRACE_GAP, y: baseTop, width: boxWidth, height: boxHeight },
    { x: baseLeft + boxWidth + TRACE_GAP, y: baseTop, width: boxWidth, height: boxHeight },
  ].map((candidate) => ({
    ...candidate,
    x: clamp(candidate.x, minLeft, maxLeft),
    y: clamp(candidate.y, minTop, maxTop),
  }));

  const occupied = [
    ...placed.map((item) => item.bounds),
    ...actions.map((action) => getRealBounds(action, viewport)).filter((bounds): bounds is Bounds => bounds !== null),
  ];
  return candidates.find((candidate) => !occupied.some((bounds) => intersects(candidate, bounds))) ?? candidates[0];
}

function buildTraceItems(
  actions: ReviewAction[],
  viewport: { width: number; height: number },
  syntheticPlacementBounds: Bounds | null,
): TraceItem[] {
  const items: TraceItem[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const realBounds = getRealBounds(action, viewport);
    items.push({
      action,
      bounds: realBounds ?? placeSyntheticBounds(index, actions, items, viewport, syntheticPlacementBounds),
      synthetic: realBounds === null,
    });
  }
  return items;
}

export function TraceOverlay({
  actions,
  viewport,
  syntheticPlacementBounds = null,
  primaryColor,
  pressed = false,
  executing = false,
}: TraceOverlayProps) {
  if (actions.length === 0) {
    return null;
  }

  const items = buildTraceItems(actions, viewport, syntheticPlacementBounds);

  return (
    <div
      className={`trace-overlay${pressed ? ' trace-overlay-pressed' : ''}${executing ? ' trace-overlay-executing' : ''}`}
      style={{
        '--trace-color': primaryColor,
      }}
      aria-hidden="true"
    >
      {/* Connectors intentionally disabled for this demo pass. */}
      {items.map((item, index) => (
        <TintedActionBox
          key={item.action.id}
          className={[
            'trace-box',
            item.synthetic ? 'trace-box-synthetic' : '',
            index === 0 ? 'trace-box-active' : '',
          ].filter(Boolean).join(' ')}
          color={primaryColor}
          left={item.bounds.x}
          top={item.bounds.y}
          width={item.bounds.width}
          height={item.bounds.height}
          index={index}
        >
          {(item.synthetic || item.action.showLabel) && (
            <span className="trace-box-label">{formatSyntheticLabel(item.action)}</span>
          )}
        </TintedActionBox>
      ))}
    </div>
  );
}
