import type { Bounds, DisplayInfo } from './types.js';

export type OverlayTargetKind =
  | 'active-app'
  | 'screen-region'
  | 'whole-screen';

export interface OverlayTargetAppIdentity {
  name: string;
  pid: number | null;
  bundlePath: string | null;
}

export interface OverlayTargetWindowIdentity {
  nativeWindowId: number | string | null;
  sessionKey: string | null;
}

export interface OverlayTargetBrowserIdentity {
  profileId: string | null;
  windowId: string | number | null;
  tabId: string | number | null;
  frameId: string | number | null;
  url: string | null;
  title: string | null;
  documentRevision: string | number | null;
}

export interface OverlayTargetDocumentIdentity {
  id: string | null;
  title: string | null;
  url: string | null;
  filePath: string | null;
  appSpecificId: string | number | null;
}

export interface OverlayTargetRefInvalidation {
  staleAfterMs: number | null;
  rules: string[];
}

export interface OverlayTargetIdentity {
  id: string;
  kind: OverlayTargetKind;
  displayId: string | number | null;
  coordinateSpace: 'screen-dip';
  scaleFactor: number | null;
  bounds: Bounds;
  capturedAt: number;
  generation: number;
  app: OverlayTargetAppIdentity | null;
  window: OverlayTargetWindowIdentity;
  browser: OverlayTargetBrowserIdentity | null;
  document: OverlayTargetDocumentIdentity | null;
  refInvalidation: OverlayTargetRefInvalidation;
  permissionScope: {
    targetWindowSessionKey: string | null;
  };
}

export interface CurrentSelectionElementRefInput {
  id: string;
  role: string;
  label: string;
  bounds: Bounds;
  nativeCua?: {
    app: string;
    elementIndex: number;
    targetIdentity?: Record<string, unknown>;
  };
  browser?: {
    tabRef: string;
    chromeTabId: number;
    browserWindowId?: number | null;
    frameId: number | string;
    chromeDocumentId?: string | null;
    refId: string;
    browserProfilePolicyId: string;
    documentRevision: string;
    origin: string | null;
    url: string;
    targetIdentity?: Record<string, unknown>;
  };
}

export interface CurrentSelectionElementRef extends CurrentSelectionElementRefInput {
  observedAt: number;
  coordinateSpace: OverlayTargetIdentity['coordinateSpace'];
  displayId: string | number | null;
  scaleFactor: number | null;
}

export interface CurrentSelectionFileRef {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  filePath: string | null;
  sourceKind: string | null;
  sourceLabel: string | null;
  sourceBounds: Bounds | null;
  sourceDisplayId: string | number | null;
}

export interface CurrentSelectionTextRef {
  id: string;
  sourceLabel: string | null;
  sourceBounds: Bounds | null;
  sourceDisplayId: string | number | null;
  textPreview: string;
}

export interface CurrentSelectionContext {
  id: string;
  targetIdentityId: string;
  targetIdentity: OverlayTargetIdentity;
  generation: number;
  capturedAt: number;
  bounds: Bounds;
  contextItemIds: string[];
  selectableRefs: CurrentSelectionElementRef[];
  selectableRefCount: number;
  selectedFileRefs: CurrentSelectionFileRef[];
  selectedTextRefs: CurrentSelectionTextRef[];
}

export interface BuildOverlayTargetIdentityInput {
  kind: OverlayTargetKind;
  bounds: Bounds;
  display: DisplayInfo | null;
  targetWindowSessionKey?: string | null;
  nativeWindowId?: number | string | null;
  appName?: string | null;
  appPid?: number | null;
  appBundlePath?: string | null;
  browser?: OverlayTargetBrowserIdentity | null;
  document?: OverlayTargetDocumentIdentity | null;
  refInvalidation?: Partial<OverlayTargetRefInvalidation> | null;
  now?: number;
  generation?: number;
}

let overlayTargetIdentityGeneration = 0;

function nextGeneration(): number {
  overlayTargetIdentityGeneration += 1;
  return overlayTargetIdentityGeneration;
}

function normalizeAppIdentity(input: BuildOverlayTargetIdentityInput): OverlayTargetAppIdentity | null {
  const name = input.appName?.trim();
  if (!name && (input.appPid === null || input.appPid === undefined) && !input.appBundlePath) {
    return null;
  }
  return {
    name: name || 'unknown app',
    pid: input.appPid ?? null,
    bundlePath: input.appBundlePath ?? null,
  };
}

const DEFAULT_REF_INVALIDATION_RULES = [
  'target_identity_mismatch',
  'current_context_changed',
  'target_window_session_mismatch',
  'display_or_coordinate_space_mismatch',
];

function normalizeBrowserIdentity(
  browser: OverlayTargetBrowserIdentity | null | undefined,
): OverlayTargetBrowserIdentity | null {
  if (!browser) {
    return null;
  }
  return { ...browser };
}

function normalizeDocumentIdentity(
  document: OverlayTargetDocumentIdentity | null | undefined,
): OverlayTargetDocumentIdentity | null {
  if (!document) {
    return null;
  }
  return { ...document };
}

function normalizeRefInvalidation(
  refInvalidation: Partial<OverlayTargetRefInvalidation> | null | undefined,
): OverlayTargetRefInvalidation {
  return {
    staleAfterMs: refInvalidation?.staleAfterMs ?? null,
    rules: refInvalidation?.rules ? [...refInvalidation.rules] : [...DEFAULT_REF_INVALIDATION_RULES],
  };
}

export function buildOverlayTargetIdentity(input: BuildOverlayTargetIdentityInput): OverlayTargetIdentity {
  const generation = input.generation ?? nextGeneration();
  const capturedAt = input.now ?? Date.now();
  return {
    id: `overlay-target-${generation}`,
    kind: input.kind,
    displayId: input.display?.id ?? null,
    coordinateSpace: 'screen-dip',
    scaleFactor: input.display?.scaleFactor ?? null,
    bounds: { ...input.bounds },
    capturedAt,
    generation,
    app: normalizeAppIdentity(input),
    window: {
      nativeWindowId: input.nativeWindowId ?? null,
      sessionKey: input.targetWindowSessionKey ?? null,
    },
    browser: normalizeBrowserIdentity(input.browser),
    document: normalizeDocumentIdentity(input.document),
    refInvalidation: normalizeRefInvalidation(input.refInvalidation),
    permissionScope: {
      targetWindowSessionKey: input.targetWindowSessionKey ?? null,
    },
  };
}

export function buildCurrentSelectionContext(input: {
  targetIdentity: OverlayTargetIdentity;
  contextItemIds?: string[];
  selectableRefs?: CurrentSelectionElementRefInput[];
  selectableRefCount?: number;
  selectedFileRefs?: CurrentSelectionFileRef[];
  selectedTextRefs?: CurrentSelectionTextRef[];
}): CurrentSelectionContext {
  const selectableRefs = input.selectableRefs ?? [];
  const snapshotId = `selected-context-${input.targetIdentity.generation}`;
  return {
    id: snapshotId,
    targetIdentityId: input.targetIdentity.id,
    targetIdentity: {
      ...input.targetIdentity,
      bounds: { ...input.targetIdentity.bounds },
      app: input.targetIdentity.app ? { ...input.targetIdentity.app } : null,
      window: { ...input.targetIdentity.window },
      browser: input.targetIdentity.browser ? { ...input.targetIdentity.browser } : null,
      document: input.targetIdentity.document ? { ...input.targetIdentity.document } : null,
      refInvalidation: {
        ...input.targetIdentity.refInvalidation,
        rules: [...input.targetIdentity.refInvalidation.rules],
      },
      permissionScope: { ...input.targetIdentity.permissionScope },
    },
    generation: input.targetIdentity.generation,
    capturedAt: input.targetIdentity.capturedAt,
    bounds: { ...input.targetIdentity.bounds },
    contextItemIds: [...(input.contextItemIds ?? [])],
    selectableRefs: selectableRefs.map((ref) => ({
      ...ref,
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
      observedAt: input.targetIdentity.capturedAt,
      coordinateSpace: input.targetIdentity.coordinateSpace,
      displayId: input.targetIdentity.displayId,
      scaleFactor: input.targetIdentity.scaleFactor,
    })),
    selectableRefCount: input.selectableRefCount ?? selectableRefs.length,
    selectedFileRefs: (input.selectedFileRefs ?? []).map((ref) => ({
      ...ref,
      sourceBounds: ref.sourceBounds ? { ...ref.sourceBounds } : null,
    })),
    selectedTextRefs: (input.selectedTextRefs ?? []).map((ref) => ({
      ...ref,
      sourceBounds: ref.sourceBounds ? { ...ref.sourceBounds } : null,
    })),
  };
}
