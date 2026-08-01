import type {
  OverlayClickRequest,
  OverlayScrollRequest,
  OverlaySessionRecord,
} from '../../../server/overlaySessionManager';
import type { BrowserPageElementTarget } from '../shared/ports.js';
import type { ScrollParams } from '../shared/types.js';

const BROWSER_PAGE_SCROLL_PIXELS_PER_AMOUNT = 120;

export interface BrowserPageOverlayToolCall {
  serverId: 'builtin-interpreter';
  toolName:
    | 'interpreter_browser_page_click'
    | 'interpreter_browser_page_scroll'
    | 'interpreter_browser_page_select'
    | 'interpreter_browser_page_type';
  args: Record<string, unknown>;
}

function browserPageRefForElementId(
  session: OverlaySessionRecord,
  elementId: string | undefined,
) {
  if (!elementId) {
    return null;
  }
  return session.latestContext.currentSelectionContext?.selectableRefs.find((ref) => (
    ref.id === elementId
    && ref.browser
    && ref.browser.targetIdentity
  )) ?? null;
}

export function buildBrowserPageClickToolCallForTarget(
  target: BrowserPageElementTarget,
): BrowserPageOverlayToolCall {
  return {
    serverId: 'builtin-interpreter',
    toolName: 'interpreter_browser_page_click',
    args: {
      target_identity: { ...target.targetIdentity },
      ref_id: target.refId,
    },
  };
}

export function buildBrowserPageOverlayClickToolCall(
  session: OverlaySessionRecord,
  request: OverlayClickRequest,
): BrowserPageOverlayToolCall | null {
  const ref = browserPageRefForElementId(session, request.element_id);
  return ref?.browser?.targetIdentity
    ? buildBrowserPageClickToolCallForTarget({
        refId: ref.browser.refId,
        targetIdentity: ref.browser.targetIdentity,
      })
    : null;
}

export function buildBrowserPageOverlayScrollToolCall(
  session: OverlaySessionRecord,
  request: OverlayScrollRequest,
): BrowserPageOverlayToolCall | null {
  const ref = browserPageRefForElementId(session, request.element_id);
  return ref?.browser?.targetIdentity
    ? buildBrowserPageScrollToolCallForTarget({
        refId: ref.browser.refId,
        targetIdentity: ref.browser.targetIdentity,
      }, request.direction, request.amount ?? 1)
    : null;
}

export function buildBrowserPageTypeToolCallForTarget(
  target: BrowserPageElementTarget,
  text: string,
): BrowserPageOverlayToolCall {
  return {
    serverId: 'builtin-interpreter',
    toolName: 'interpreter_browser_page_type',
    args: {
      target_identity: { ...target.targetIdentity },
      ref_id: target.refId,
      text,
    },
  };
}

export function buildBrowserPageSelectToolCallForTarget(
  target: BrowserPageElementTarget,
  value: string,
): BrowserPageOverlayToolCall {
  return {
    serverId: 'builtin-interpreter',
    toolName: 'interpreter_browser_page_select',
    args: {
      target_identity: { ...target.targetIdentity },
      ref_id: target.refId,
      value,
    },
  };
}

export function buildBrowserPageScrollToolCallForTarget(
  target: BrowserPageElementTarget,
  direction: ScrollParams['direction'],
  amount: number,
): BrowserPageOverlayToolCall {
  const pixels = Math.max(1, Math.round(Math.abs(amount))) * BROWSER_PAGE_SCROLL_PIXELS_PER_AMOUNT;
  const deltaX = direction === 'left' ? -pixels : direction === 'right' ? pixels : 0;
  const deltaY = direction === 'up' ? -pixels : direction === 'down' ? pixels : 0;
  return {
    serverId: 'builtin-interpreter',
    toolName: 'interpreter_browser_page_scroll',
    args: {
      target_identity: { ...target.targetIdentity },
      ref_id: target.refId,
      delta_x: deltaX,
      delta_y: deltaY,
    },
  };
}
