import type { Bounds, DisplayInfo } from './types.js';
import type { OverlayContextItem, OverlayRegionContextItem, OverlayRegionScopeKind } from './ipc.js';
import type {
  OverlayTargetIdentity,
  CurrentSelectionFileRef,
  CurrentSelectionContext,
  CurrentSelectionTextRef,
} from './target-identity.js';
import { buildCurrentSelectionContext } from './target-identity.js';

function boundsApproximatelyEqual(left: Bounds | null | undefined, right: Bounds | null | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return Math.abs(left.x - right.x) < 1
    && Math.abs(left.y - right.y) < 1
    && Math.abs(left.width - right.width) < 1
    && Math.abs(left.height - right.height) < 1;
}

// Real forms routinely expose more than 80 interactive elements; hiding
// visible refs from the model makes it silently skip requested fields. Keep a
// bound for pathological captures, but a generous one.
const MAX_SHOWN_SELECTABLE_REFS = 200;

function parseSelectedTextDataUrl(dataUrl: string): string | null {
  const match = /^data:([^;,]+)?;base64,(.*)$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  return Buffer.from(match[2], 'base64').toString('utf8').trim() || null;
}

export function getOverlayRegionScopeKind(
  bounds: Bounds,
  display: DisplayInfo | null,
  requestedScopeKind?: OverlayRegionScopeKind | null,
): OverlayRegionScopeKind {
  if (requestedScopeKind) {
    return requestedScopeKind;
  }

  if (display && boundsApproximatelyEqual(bounds, display.boundsDIP)) {
    return 'whole-screen';
  }

  return 'screen-region';
}

export function formatContextBounds(bounds: Bounds): string {
  return `x=${Math.round(bounds.x)} y=${Math.round(bounds.y)} width=${Math.round(bounds.width)} height=${Math.round(bounds.height)}`;
}

export function formatTargetIdentity(identity: OverlayTargetIdentity): string[] {
  const lines = [
    `target_kind: ${identity.kind}`,
    `target_captured_at: ${identity.capturedAt}`,
    `coordinate_space: ${identity.coordinateSpace}`,
    `target_bounds: ${formatContextBounds(identity.bounds)}`,
    `target_display_id: ${identity.displayId === null ? 'unknown' : String(identity.displayId)}`,
    `target_scale_factor: ${identity.scaleFactor === null ? 'unknown' : String(identity.scaleFactor)}`,
    `target_window_session_key: ${identity.window.sessionKey ?? 'none'}`,
    `target_native_window_id: ${identity.window.nativeWindowId ?? 'none'}`,
    `target_browser_profile_id: ${identity.browser?.profileId ?? 'none'}`,
    `target_browser_window_id: ${identity.browser?.windowId ?? 'none'}`,
    `target_browser_tab_id: ${identity.browser?.tabId ?? 'none'}`,
    `target_browser_frame_id: ${identity.browser?.frameId ?? 'none'}`,
    `target_browser_url: ${identity.browser?.url ?? 'none'}`,
    `target_browser_title: ${identity.browser?.title ?? 'none'}`,
    `target_browser_document_revision: ${identity.browser?.documentRevision ?? 'none'}`,
    `target_document_id: ${identity.document?.id ?? 'none'}`,
    `target_document_title: ${identity.document?.title ?? 'none'}`,
    `target_document_url: ${identity.document?.url ?? 'none'}`,
    `target_document_file_path: ${identity.document?.filePath ?? 'none'}`,
    `target_document_app_specific_id: ${identity.document?.appSpecificId ?? 'none'}`,
    `ref_stale_after_ms: ${identity.refInvalidation.staleAfterMs === null ? 'none' : String(identity.refInvalidation.staleAfterMs)}`,
    `permission_scope_target_window_session_key: ${identity.permissionScope.targetWindowSessionKey ?? 'none'}`,
  ];
  if (identity.app) {
    lines.push(
      `target_app_name: ${identity.app.name}`,
      `target_app_pid: ${identity.app.pid === null ? 'unknown' : String(identity.app.pid)}`,
      `target_app_bundle_path: ${identity.app.bundlePath ?? 'none'}`,
    );
  }
  return lines;
}

export function formatCurrentSelectionContext(snapshot: CurrentSelectionContext): string[] {
  const lines = [
    '<selected_context>',
    `captured_at: ${snapshot.capturedAt}`,
    `bounds: ${formatContextBounds(snapshot.bounds)}`,
    `context_item_ids: ${snapshot.contextItemIds.length > 0 ? snapshot.contextItemIds.join(', ') : 'none'}`,
    `selectable_ref_count: ${snapshot.selectableRefCount}`,
    `selected_file_ref_count: ${snapshot.selectedFileRefs.length}`,
    `selected_text_ref_count: ${snapshot.selectedTextRefs.length}`,
  ];
  if (snapshot.selectableRefs.length > 0) {
    const shownRefs = snapshot.selectableRefs.slice(0, MAX_SHOWN_SELECTABLE_REFS);
    // Ref coordinate metadata and the native CUA app/target identity are
    // uniform across one snapshot; print them once instead of repeating the
    // same observed values on every ref line. Non-uniform native identities
    // fall back to per-ref fields.
    const uniformNativeIdentityJson = (() => {
      const values = shownRefs
        .filter((ref) => ref.nativeCua)
        .map((ref) => JSON.stringify({
          app: ref.nativeCua?.app,
          targetIdentity: ref.nativeCua?.targetIdentity ?? null,
        }));
      if (values.length === 0) {
        return null;
      }
      return values.every((value) => value === values[0]) ? values[0] : null;
    })();
    lines.push('<selectable_refs>');
    lines.push('valid_element_id_source: only ref id values in this selectable_refs block are valid current tool element_id handles; reread context after UI changes');
    lines.push(`ref_coordinate_space: ${snapshot.targetIdentity.coordinateSpace}`);
    lines.push(`ref_observed_at: ${snapshot.capturedAt}`);
    if (uniformNativeIdentityJson) {
      const uniform = JSON.parse(uniformNativeIdentityJson) as {
        app: string;
        targetIdentity: Record<string, unknown> | null;
      };
      lines.push(`refs_native_cua_app: ${JSON.stringify(uniform.app)}`);
      if (uniform.targetIdentity) {
        lines.push(`refs_native_cua_target_identity: ${JSON.stringify(uniform.targetIdentity)}`);
      }
    }
    for (const ref of shownRefs) {
      const nativeCuaRef = ref.nativeCua
        ? uniformNativeIdentityJson
          ? ` native_cua_element_index=${ref.nativeCua.elementIndex}`
          : ` native_cua_app=${JSON.stringify(ref.nativeCua.app)} native_cua_element_index=${ref.nativeCua.elementIndex}${ref.nativeCua.targetIdentity ? ` native_cua_target_identity=${JSON.stringify(ref.nativeCua.targetIdentity)}` : ''}`
        : '';
      const browserRef = ref.browser
        ? ` browser_tab_ref=${JSON.stringify(ref.browser.tabRef)} browser_chrome_tab_id=${ref.browser.chromeTabId} browser_frame_id=${JSON.stringify(ref.browser.frameId)} browser_ref_id=${JSON.stringify(ref.browser.refId)} browser_profile_policy_id=${JSON.stringify(ref.browser.browserProfilePolicyId)} browser_document_revision=${JSON.stringify(ref.browser.documentRevision)} browser_origin=${JSON.stringify(ref.browser.origin)} browser_url=${JSON.stringify(ref.browser.url)}`
        : '';
      lines.push(
        `ref id=${JSON.stringify(ref.id)} role=${JSON.stringify(ref.role)} label=${JSON.stringify(ref.label)} bounds="${formatContextBounds(ref.bounds)}"${nativeCuaRef}${browserRef}`,
      );
    }
    if (snapshot.selectableRefs.length > MAX_SHOWN_SELECTABLE_REFS) {
      lines.push(`truncated_ref_count: ${snapshot.selectableRefs.length - MAX_SHOWN_SELECTABLE_REFS}`);
    }
    lines.push('</selectable_refs>');
  }
  if (snapshot.selectedFileRefs.length > 0) {
    lines.push('<selected_file_refs>');
    for (const ref of snapshot.selectedFileRefs) {
      const sourceBounds = ref.sourceBounds ? ` source_bounds="${formatContextBounds(ref.sourceBounds)}"` : ' source_bounds="unknown"';
      lines.push(
        `file id=${JSON.stringify(ref.id)} name=${JSON.stringify(ref.name)} mime_type=${JSON.stringify(ref.mimeType)} size_bytes=${ref.sizeBytes} source_kind=${ref.sourceKind ?? 'unknown'} source_label=${JSON.stringify(ref.sourceLabel ?? 'selected file')} display_id=${ref.sourceDisplayId === null ? 'unknown' : String(ref.sourceDisplayId)}${sourceBounds} file_path=${ref.filePath ?? 'none'}`,
      );
    }
    lines.push('</selected_file_refs>');
  }
  if (snapshot.selectedTextRefs.length > 0) {
    lines.push('<selected_text_refs>');
    for (const ref of snapshot.selectedTextRefs) {
      lines.push(
        `text id=${JSON.stringify(ref.id)} label=${JSON.stringify(ref.sourceLabel ?? 'selected text')} display_id=${ref.sourceDisplayId === null ? 'unknown' : String(ref.sourceDisplayId)} bounds="${ref.sourceBounds ? formatContextBounds(ref.sourceBounds) : 'unknown'}" preview=${JSON.stringify(ref.textPreview)}`,
      );
    }
    lines.push('</selected_text_refs>');
  }
  lines.push('</selected_context>');
  return lines;
}

function buildSelectedFileRefs(contextItems: OverlayContextItem[]): CurrentSelectionFileRef[] {
  const refs: CurrentSelectionFileRef[] = [];
  for (const item of contextItems) {
    if (item.kind !== 'file' || item.sourceKind === 'selected-text') {
      continue;
    }
    refs.push({
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      filePath: item.filePath,
      sourceKind: item.sourceKind ?? null,
      sourceLabel: item.sourceLabel ?? null,
      sourceBounds: item.sourceBounds ? { ...item.sourceBounds } : null,
      sourceDisplayId: item.sourceDisplayId ?? null,
    });
  }
  return refs;
}

function buildSelectedTextRefs(contextItems: OverlayContextItem[]): CurrentSelectionTextRef[] {
  const refs: CurrentSelectionTextRef[] = [];
  for (const item of contextItems) {
    if (item.kind !== 'file' || item.sourceKind !== 'selected-text') {
      continue;
    }
    refs.push({
      id: item.id,
      sourceLabel: item.sourceLabel ?? null,
      sourceBounds: item.sourceBounds ? { ...item.sourceBounds } : null,
      sourceDisplayId: item.sourceDisplayId ?? null,
      textPreview: item.dataUrl ? (parseSelectedTextDataUrl(item.dataUrl) ?? '').slice(0, 12_000) : '',
    });
  }
  return refs;
}

export function buildOverlayCurrentSelectionContext(
  regionItem: OverlayRegionContextItem,
  contextItems: OverlayContextItem[],
): CurrentSelectionContext {
  const selectableRefs = regionItem.snapshot.selectableRefs.length > 0
    ? regionItem.snapshot.selectableRefs
    : (regionItem.selectableElements ?? []).map((element) => ({
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
        browser: element.browser ? { ...element.browser } : undefined,
      }));
  return buildCurrentSelectionContext({
    targetIdentity: regionItem.targetIdentity,
    contextItemIds: contextItems.map((item) => item.id),
    selectableRefs,
    selectableRefCount: regionItem.snapshot.selectableRefs.length > 0
      ? regionItem.snapshot.selectableRefCount
      : (regionItem.selectableElements?.length ?? regionItem.snapshot.selectableRefCount),
    selectedFileRefs: buildSelectedFileRefs(contextItems),
    selectedTextRefs: buildSelectedTextRefs(contextItems),
  });
}

export function describeOverlayContextItem(
  item: OverlayContextItem,
  index: number,
  contextItems: OverlayContextItem[] = [item],
): string {
  if (item.kind === 'region') {
    const roleDescription = item.role === 'target'
      ? 'controllable overlay target/grant'
      : 'reference screen region';
    const regionItem: OverlayRegionContextItem = item;
    const lines = [
      `<screen_context_item index="${index + 1}" id=${JSON.stringify(regionItem.id)} kind="region" role=${JSON.stringify(regionItem.role)} label=${JSON.stringify(regionItem.label)}>`,
      `purpose: ${roleDescription}`,
      `scope_kind: ${regionItem.scopeKind}`,
      `bounds: ${formatContextBounds(regionItem.bounds)}`,
      `display_id: ${regionItem.displayId === null ? 'unknown' : String(regionItem.displayId)}`,
      `target_window_session_key: ${regionItem.targetWindowSessionKey ?? 'none'}`,
      ...formatTargetIdentity(regionItem.targetIdentity),
      ...formatCurrentSelectionContext(buildOverlayCurrentSelectionContext(regionItem, contextItems)),
      `element_count: ${regionItem.selectableElements?.length ?? 0}`,
    ];
    const preview = regionItem.previewText?.trim();
    if (preview) {
      lines.push('<preview_text>', preview.slice(0, 12_000), '</preview_text>');
    } else if (regionItem.previewImageDataUrl) {
      lines.push('preview_image: attached');
    } else {
      lines.push('preview: none');
    }
    lines.push('</screen_context_item>');
    return lines.join('\n');
  }

  const lines = [
    `<screen_context_item index="${index + 1}" id=${JSON.stringify(item.id)} kind="file" role="reference" label=${JSON.stringify(item.sourceLabel ?? item.name)}>`,
    `source_kind: ${item.sourceKind ?? 'unknown'}`,
    `name: ${item.name}`,
    `mime_type: ${item.mimeType}`,
    `size_bytes: ${item.sizeBytes}`,
    `file_path: ${item.filePath ?? 'none'}`,
  ];
  if (item.sourceBounds) {
    lines.push(`source_bounds: ${formatContextBounds(item.sourceBounds)}`);
  }
  if (item.sourceDisplayId !== null && item.sourceDisplayId !== undefined) {
    lines.push(`source_display_id: ${String(item.sourceDisplayId)}`);
  }
  if (item.sourceKind === 'selected-text' && item.dataUrl) {
    const text = parseSelectedTextDataUrl(item.dataUrl);
    if (text) {
      lines.push('<selected_text>', text.slice(0, 12_000), '</selected_text>');
    } else {
      lines.push('selected_text: unreadable');
    }
  }
  lines.push('</screen_context_item>');
  return lines.join('\n');
}

export function buildOverlayContextPacketText(contextItems: OverlayContextItem[]): string {
  if (contextItems.length === 0) {
    return '';
  }
  return [
    '<overlay_context_packet>',
    'This packet is the single screen/context bundle represented by the chips in Interpreter Overlay.',
    'A target region is a controllable overlay grant. Reference regions, selected text, and selected files are context only.',
    ...contextItems.map((item, index) => describeOverlayContextItem(item, index, contextItems)),
    '</overlay_context_packet>',
  ].join('\n');
}
