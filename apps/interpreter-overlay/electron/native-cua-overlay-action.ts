import type {
  OverlayClickRequest,
  OverlayScrollRequest,
  OverlaySessionRecord,
  OverlayTypeRequest,
} from '../../../server/overlaySessionManager';
import type { NativeCuaAppWindowTarget, NativeCuaElementTarget, NativeCuaPointTarget } from '../shared/ports.js';
import type { ScrollParams } from '../shared/types.js';

export interface NativeCuaOverlayToolCall {
  serverId: 'builtin-cua-driver';
  toolName: 'click' | 'press_key' | 'scroll' | 'select_option' | 'set_value' | 'type_text';
  args: Record<string, unknown>;
}

function nativeCuaRefForElementId(
  session: OverlaySessionRecord,
  elementId: string | undefined,
) {
  if (!elementId) {
    return null;
  }
  return session.latestContext.currentSelectionContext?.selectableRefs.find((ref) => (
    ref.id === elementId
    && ref.nativeCua
    && ref.nativeCua.targetIdentity
  )) ?? null;
}

function baseNativeCuaTargetArgs(target: NativeCuaElementTarget): Record<string, unknown> {
  return {
    app: target.app,
    element_index: String(target.elementIndex),
    target_identity: { ...target.targetIdentity },
  };
}

function isDropdownRole(role: string): boolean {
  return role === 'AXComboBox' || role === 'AXPopUpButton' || role === 'AXMenuButton';
}

export function buildNativeCuaClickToolCallForTarget(
  target: NativeCuaElementTarget,
): NativeCuaOverlayToolCall {
  return {
    serverId: 'builtin-cua-driver',
    toolName: 'click',
    args: {
      ...baseNativeCuaTargetArgs(target),
      // Overlay execution rereads affected-target state after the batch,
      // so the per-action window side-effect detector is redundant latency
      // here. All builders in this file set the same flag.
      skip_change_detection: true,
    },
  };
}

export function buildNativeCuaPointClickToolCallForTarget(
  target: NativeCuaPointTarget,
): NativeCuaOverlayToolCall {
  return {
    serverId: 'builtin-cua-driver',
    toolName: 'click',
    args: {
      app: target.app,
      x: target.x,
      y: target.y,
      target_identity: { ...target.targetIdentity },
      skip_change_detection: true,
    },
  };
}

export function buildNativeCuaPressKeyToolCallForTarget(
  target: NativeCuaAppWindowTarget,
  key: string,
): NativeCuaOverlayToolCall {
  return {
    serverId: 'builtin-cua-driver',
    toolName: 'press_key',
    args: {
      app: target.app,
      key,
      target_identity: { ...target.targetIdentity },
      skip_change_detection: true,
    },
  };
}

export function buildNativeCuaAppWindowTypeTextToolCallForTarget(
  target: NativeCuaAppWindowTarget,
  text: string,
): NativeCuaOverlayToolCall {
  return {
    serverId: 'builtin-cua-driver',
    toolName: 'type_text',
    args: {
      app: target.app,
      text,
      target_identity: { ...target.targetIdentity },
      skip_change_detection: true,
    },
  };
}

export function buildNativeCuaAppWindowScrollToolCallForTarget(
  target: NativeCuaAppWindowTarget,
  direction: ScrollParams['direction'],
  pages: number,
): NativeCuaOverlayToolCall {
  return {
    serverId: 'builtin-cua-driver',
    toolName: 'scroll',
    args: {
      app: target.app,
      direction,
      pages,
      target_identity: { ...target.targetIdentity },
      skip_change_detection: true,
    },
  };
}

export function buildNativeCuaSetValueToolCallForTarget(
  target: NativeCuaElementTarget,
  value: string,
): NativeCuaOverlayToolCall {
  return {
    serverId: 'builtin-cua-driver',
    toolName: 'set_value',
    args: {
      ...baseNativeCuaTargetArgs(target),
      value,
      skip_change_detection: true,
    },
  };
}

export function buildNativeCuaTypeTextToolCallForTarget(
  target: NativeCuaElementTarget,
  text: string,
): NativeCuaOverlayToolCall {
  return {
    serverId: 'builtin-cua-driver',
    toolName: 'type_text',
    args: {
      ...baseNativeCuaTargetArgs(target),
      text,
      skip_change_detection: true,
    },
  };
}

export function buildNativeCuaSelectOptionToolCallForTarget(
  target: NativeCuaElementTarget,
  option: string,
): NativeCuaOverlayToolCall {
  return {
    serverId: 'builtin-cua-driver',
    toolName: 'select_option',
    args: {
      ...baseNativeCuaTargetArgs(target),
      option,
      skip_change_detection: true,
    },
  };
}

export function buildNativeCuaScrollToolCallForTarget(
  target: NativeCuaElementTarget,
  direction: ScrollParams['direction'],
  pages: number,
): NativeCuaOverlayToolCall {
  return {
    serverId: 'builtin-cua-driver',
    toolName: 'scroll',
    args: {
      ...baseNativeCuaTargetArgs(target),
      direction,
      pages,
      skip_change_detection: true,
    },
  };
}

export function buildNativeCuaOverlayClickToolCall(
  session: OverlaySessionRecord,
  request: OverlayClickRequest,
): NativeCuaOverlayToolCall | null {
  const ref = nativeCuaRefForElementId(session, request.element_id);
  return ref?.nativeCua?.targetIdentity
    ? buildNativeCuaClickToolCallForTarget({
        app: ref.nativeCua.app,
        elementIndex: ref.nativeCua.elementIndex,
        targetIdentity: ref.nativeCua.targetIdentity,
      })
    : null;
}

export function buildNativeCuaOverlayTypeToolCall(
  session: OverlaySessionRecord,
  request: OverlayTypeRequest,
): NativeCuaOverlayToolCall | null {
  const ref = nativeCuaRefForElementId(session, request.element_id);
  if (!ref?.nativeCua?.targetIdentity) {
    return null;
  }
  const target = {
    app: ref.nativeCua.app,
    elementIndex: ref.nativeCua.elementIndex,
    targetIdentity: ref.nativeCua.targetIdentity,
  };
  if (isDropdownRole(ref.role)) {
    return buildNativeCuaSelectOptionToolCallForTarget(target, request.text);
  }
  return request.clear_first === true
    ? buildNativeCuaSetValueToolCallForTarget(target, request.text)
    : buildNativeCuaTypeTextToolCallForTarget(target, request.text);
}

export function buildNativeCuaOverlayScrollToolCall(
  session: OverlaySessionRecord,
  request: OverlayScrollRequest,
): NativeCuaOverlayToolCall | null {
  const ref = nativeCuaRefForElementId(session, request.element_id);
  if (!ref?.nativeCua?.targetIdentity) {
    return null;
  }
  return buildNativeCuaScrollToolCallForTarget({
    app: ref.nativeCua.app,
    elementIndex: ref.nativeCua.elementIndex,
    targetIdentity: ref.nativeCua.targetIdentity,
  }, request.direction, request.amount ?? 1);
}
