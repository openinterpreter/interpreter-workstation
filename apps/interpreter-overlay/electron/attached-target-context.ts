import type { OverlayRegionContextItem, OverlaySelectionElement } from '../shared/ipc.js';
import type { Bounds, DisplayInfo } from '../shared/types.js';
import {
  buildCurrentSelectionContext,
  type OverlayTargetIdentity,
  type CurrentSelectionElementRefInput,
} from '../shared/target-identity.js';
import { windowBoundsByCgId } from '../runtime/infra/window-tracker.js';

export interface NativeCuaSelectionRefreshRequest {
  appName: string;
  targetIdentity: Record<string, unknown>;
}

function cloneElementRefInput(ref: CurrentSelectionElementRefInput): CurrentSelectionElementRefInput {
  return {
    id: ref.id,
    role: ref.role,
    label: ref.label,
    bounds: { ...ref.bounds },
    nativeCua: ref.nativeCua
      ? {
          app: ref.nativeCua.app,
          elementIndex: ref.nativeCua.elementIndex,
          targetIdentity: ref.nativeCua.targetIdentity
            ? { ...ref.nativeCua.targetIdentity }
            : undefined,
        }
      : undefined,
    browser: ref.browser
      ? {
          ...ref.browser,
          targetIdentity: ref.browser.targetIdentity
            ? { ...ref.browser.targetIdentity }
            : undefined,
        }
      : undefined,
  };
}

function selectionElementToRefInput(element: OverlaySelectionElement): CurrentSelectionElementRefInput {
  return {
    id: element.id,
    role: element.role,
    label: element.label,
    bounds: { ...element.bounds },
    nativeCua: element.nativeCua
      ? {
          app: element.nativeCua.app,
          elementIndex: element.nativeCua.elementIndex,
          targetIdentity: element.nativeCua.targetIdentity
            ? { ...element.nativeCua.targetIdentity }
            : undefined,
        }
      : undefined,
    browser: element.browser
      ? {
          ...element.browser,
          targetIdentity: element.browser.targetIdentity
            ? { ...element.browser.targetIdentity }
            : undefined,
        }
      : undefined,
  };
}

/**
 * Resolves the concrete native window a committed target context is bound to.
 * Active-app targets carry it on the region target identity; dragged screen
 * regions carry it on the hydrated executable refs' native CUA target
 * identity. Returns null when the committed target names no native window
 * (e.g. an unhydrated region), in which case no dead-window claim can be made.
 */
export function resolveCommittedTargetWindow(
  targetContext: OverlayRegionContextItem,
): { nativeWindowId: number; appName: string | null } | null {
  const identity = targetContext.targetIdentity;
  if (typeof identity?.window?.nativeWindowId === 'number') {
    return {
      nativeWindowId: identity.window.nativeWindowId,
      appName: identity.app?.name?.trim() || null,
    };
  }
  const refs = targetContext.snapshot.selectableRefs.length > 0
    ? targetContext.snapshot.selectableRefs
    : (targetContext.selectableElements ?? []);
  for (const ref of refs) {
    const cuaIdentity = ref.nativeCua?.targetIdentity as {
      app?: { name?: unknown };
      window?: { native_window_id?: unknown };
    } | undefined;
    const nativeWindowId = cuaIdentity?.window?.native_window_id;
    if (typeof nativeWindowId === 'number') {
      const identityAppName = typeof cuaIdentity?.app?.name === 'string' ? cuaIdentity.app.name.trim() : '';
      return {
        nativeWindowId,
        appName: identityAppName || ref.nativeCua?.app?.trim() || null,
      };
    }
  }
  return null;
}

/**
 * Dead-target detection for a committed selected-target run. When the
 * committed target names a concrete native window and that window no longer
 * exists on screen, returns a human-readable observation naming the dead
 * target; otherwise null. The observation is data for the controller model
 * (at submit, and as the computer_batch/call_hidden_agent tool result instead
 * of executing) — the model decides the outcome.
 */
export async function committedTargetWindowClosedMessage(
  targetContext: OverlayRegionContextItem,
): Promise<string | null> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return null;
  }
  const committed = resolveCommittedTargetWindow(targetContext);
  if (!committed) {
    return null;
  }
  const window = await windowBoundsByCgId(committed.nativeWindowId);
  if (window) {
    return null;
  }
  const targetLabel = targetContext.label?.trim() || 'selected target';
  return `Target window closed: ${committed.appName ? `${committed.appName} — ` : ''}"${targetLabel}" is no longer on screen. Its element refs cannot be executed.`;
}

export function getNativeCuaSelectionRefreshRequest(
  targetContext: OverlayRegionContextItem,
): NativeCuaSelectionRefreshRequest | null {
  const nativeRef = targetContext.snapshot.selectableRefs.find((ref) => ref.nativeCua);
  if (!nativeRef?.nativeCua) {
    const appName = targetContext.targetIdentity.app?.name.trim() ?? '';
    if (!appName) {
      return null;
    }
    return {
      appName,
      targetIdentity: {
        kind: 'app-window',
        platform: process.platform,
        coordinate_space: targetContext.targetIdentity.coordinateSpace,
        observed_at: targetContext.targetIdentity.capturedAt,
        app: {
          name: appName,
          pid: targetContext.targetIdentity.app?.pid ?? null,
        },
        window: {
          native_window_id: targetContext.targetIdentity.window.nativeWindowId,
          title: null,
        },
        bounds: { ...targetContext.targetIdentity.bounds },
        ref_invalidation: {
          rules: [
            'target_identity_mismatch',
            'pid_mismatch',
            'native_window_id_mismatch',
            'window_closed',
          ],
        },
      },
    };
  }
  const appName = nativeRef.nativeCua.app.trim();
  if (!appName) {
    throw new Error('Selected native CUA target is missing an app name');
  }
  if (!nativeRef.nativeCua.targetIdentity) {
    throw new Error('Selected native CUA target is missing target identity metadata');
  }
  return {
    appName,
    targetIdentity: { ...nativeRef.nativeCua.targetIdentity },
  };
}

export function cloneAttachedTargetIdentity(input: {
  sourceIdentity: OverlayTargetIdentity;
  display: DisplayInfo;
  targetBounds: Bounds;
  targetWindowSessionKey: string | null;
  now?: number;
}): OverlayTargetIdentity {
  const sessionKey = input.targetWindowSessionKey ?? input.sourceIdentity.window.sessionKey;
  return {
    ...input.sourceIdentity,
    displayId: input.display.id,
    scaleFactor: input.display.scaleFactor,
    bounds: { ...input.targetBounds },
    capturedAt: input.now ?? Date.now(),
    app: input.sourceIdentity.app ? { ...input.sourceIdentity.app } : null,
    window: {
      ...input.sourceIdentity.window,
      sessionKey,
    },
    browser: input.sourceIdentity.browser ? { ...input.sourceIdentity.browser } : null,
    document: input.sourceIdentity.document ? { ...input.sourceIdentity.document } : null,
    refInvalidation: {
      ...input.sourceIdentity.refInvalidation,
      rules: [...input.sourceIdentity.refInvalidation.rules],
    },
    permissionScope: {
      ...input.sourceIdentity.permissionScope,
      targetWindowSessionKey: sessionKey,
    },
  };
}

export function buildAttachedTargetContextSnapshot(input: {
  targetContext: OverlayRegionContextItem;
  display: DisplayInfo;
  targetBounds: Bounds;
  targetWindowSessionKey: string | null;
  refreshedSelectableElements?: OverlaySelectionElement[] | null;
  now?: number;
}): {
  targetIdentity: OverlayTargetIdentity;
  currentSelectionContext: ReturnType<typeof buildCurrentSelectionContext>;
} {
  const targetIdentity = cloneAttachedTargetIdentity({
    sourceIdentity: input.targetContext.targetIdentity,
    display: input.display,
    targetBounds: input.targetBounds,
    targetWindowSessionKey: input.targetWindowSessionKey,
    now: input.now,
  });
  const selectableRefs = input.refreshedSelectableElements
    ? input.refreshedSelectableElements.map(selectionElementToRefInput)
    : input.targetContext.snapshot.selectableRefs.map(cloneElementRefInput);
  return {
    targetIdentity,
    currentSelectionContext: buildCurrentSelectionContext({
      targetIdentity,
      contextItemIds: input.targetContext.snapshot.contextItemIds.length > 0
        ? input.targetContext.snapshot.contextItemIds
        : [input.targetContext.id],
      selectableRefs,
      selectableRefCount: input.refreshedSelectableElements
        ? selectableRefs.length
        : input.targetContext.snapshot.selectableRefCount,
      selectedFileRefs: input.targetContext.snapshot.selectedFileRefs,
      selectedTextRefs: input.targetContext.snapshot.selectedTextRefs,
    }),
  };
}
