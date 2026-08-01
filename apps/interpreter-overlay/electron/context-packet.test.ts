import { describe, expect, test } from 'bun:test';

import { buildOverlayContextPacketText, getOverlayRegionScopeKind } from '../shared/context-packet';
import type { OverlayContextItem } from '../shared/ipc';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../shared/target-identity';

function regionContextItem(input: {
  id: string;
  role: 'target' | 'reference';
  scopeKind: 'active-app' | 'whole-screen' | 'screen-region';
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  targetWindowSessionKey: string | null;
  generation: number;
}): OverlayContextItem {
  const targetIdentity = buildOverlayTargetIdentity({
    kind: input.scopeKind,
    bounds: input.bounds,
    display: {
      id: 1,
      boundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
      scaleFactor: 2,
    },
    targetWindowSessionKey: input.targetWindowSessionKey,
    generation: input.generation,
    now: 1000,
  });
  return {
    id: input.id,
    kind: 'region',
    role: input.role,
    scopeKind: input.scopeKind,
    label: input.label,
    bounds: input.bounds,
    displayId: 1,
    targetWindowSessionKey: input.targetWindowSessionKey,
    targetIdentity,
    snapshot: buildCurrentSelectionContext({ targetIdentity }),
    previewText: null,
    previewImageDataUrl: null,
  };
}

describe('overlay context packet', () => {
  test('preserves active-app and whole-screen region scope kinds explicitly', () => {
    const contextItems: OverlayContextItem[] = [
      {
        ...regionContextItem({
          id: 'active-app-target',
          role: 'target',
          scopeKind: 'active-app',
          label: 'Active app: Chromium',
          bounds: { x: 40, y: 40, width: 1200, height: 800 },
          targetWindowSessionKey: 'window-1',
          generation: 1,
        }),
        previewText: 'Insurance form',
        selectableElements: [
          {
            id: 'field-1',
            role: 'textbox',
            label: 'Insured name',
            bounds: { x: 60, y: 90, width: 240, height: 28 },
            nativeCua: {
              app: 'Google Chrome',
              elementIndex: 12,
              targetIdentity: {
                kind: 'app-window',
                app: { name: 'Google Chrome', pid: 4321 },
                window: { native_window_id: 99, title: 'Form' },
              },
            },
            browser: {
              tabRef: 'install:profile-1:chrome-tab:9',
              chromeTabId: 9,
              frameId: 0,
              refId: 'browser-element:rev-browser:0',
              browserProfilePolicyId: 'install:profile-1',
              documentRevision: 'rev-browser',
              origin: 'https://example.test',
              url: 'https://example.test/form',
            },
          },
        ],
      },
      regionContextItem({
        id: 'whole-screen-reference',
        role: 'reference',
        scopeKind: 'whole-screen',
        label: 'Whole screen',
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        targetWindowSessionKey: null,
        generation: 2,
      }),
      {
        id: 'file-1',
        kind: 'file',
        role: 'reference',
        name: 'claim.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        filePath: '/tmp/claim.pdf',
        sourceKind: 'selected-file',
        sourceLabel: 'Selected file',
        sourceBounds: { x: 10, y: 12, width: 40, height: 44 },
        sourceDisplayId: 1,
      },
      {
        id: 'selected-text-1',
        kind: 'file',
        role: 'reference',
        name: 'selection.txt',
        mimeType: 'text/plain',
        sizeBytes: 16,
        filePath: null,
        dataUrl: `data:text/plain;base64,${Buffer.from('Policy number 123').toString('base64')}`,
        sourceKind: 'selected-text',
        sourceLabel: 'Selected text',
        sourceBounds: { x: 20, y: 30, width: 120, height: 20 },
        sourceDisplayId: 1,
      },
    ];

    const packet = buildOverlayContextPacketText(contextItems);

    expect(packet).toContain('label="Active app: Chromium"');
    expect(packet).toContain('scope_kind: active-app');
    expect(packet).toContain('target_browser_profile_id: none');
    expect(packet).toContain('target_document_id: none');
    expect(packet).toContain('ref_stale_after_ms: none');
    expect(packet).toContain('<selected_context>');
    expect(packet).toContain('valid_element_id_source: only ref id values in this selectable_refs block are valid current tool element_id handles; reread context after UI changes');
    expect(packet).toContain('permission_scope_target_window_session_key: window-1');
    expect(packet).toContain('context_item_ids: active-app-target, whole-screen-reference, file-1, selected-text-1');
    expect(packet).toContain('ref_coordinate_space: screen-dip');
    expect(packet).toContain('ref_observed_at: 1000');
    expect(packet).toContain('refs_native_cua_app: "Google Chrome"');
    expect(packet).toContain('ref id="field-1" role="textbox" label="Insured name" bounds="x=60 y=90 width=240 height=28"');
    expect(packet).not.toContain('selected_context_snapshot_id');
    expect(packet).toContain('native_cua_element_index=12');
    expect(packet).toContain('native_cua_element_index=12');
    expect(packet).toContain('refs_native_cua_target_identity: {"kind":"app-window","app":{"name":"Google Chrome","pid":4321},"window":{"native_window_id":99,"title":"Form"}}');
    expect(packet).toContain('browser_tab_ref="install:profile-1:chrome-tab:9"');
    expect(packet).toContain('browser_frame_id=0');
    expect(packet).toContain('browser_ref_id="browser-element:rev-browser:0"');
    expect(packet).toContain('file id="file-1" name="claim.pdf" mime_type="application/pdf" size_bytes=1234 source_kind=selected-file source_label="Selected file" display_id=1 source_bounds="x=10 y=12 width=40 height=44" file_path=/tmp/claim.pdf');
    expect(packet).toContain('text id="selected-text-1" label="Selected text" display_id=1 bounds="x=20 y=30 width=120 height=20" preview="Policy number 123"');
    expect(packet).toContain('label="Whole screen"');
    expect(packet).toContain('scope_kind: whole-screen');
  });

  test('detects whole-screen scope from display bounds without changing normal regions', () => {
    const display = {
      id: 'display-1',
      boundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
      scaleFactor: 2,
    };

    expect(getOverlayRegionScopeKind(
      { x: 0, y: 0, width: 1440, height: 900 },
      display,
    )).toBe('whole-screen');
    expect(getOverlayRegionScopeKind(
      { x: 40, y: 40, width: 1200, height: 800 },
      display,
    )).toBe('screen-region');
    expect(getOverlayRegionScopeKind(
      { x: 0, y: 0, width: 1440, height: 900 },
      display,
      'active-app',
    )).toBe('active-app');
  });
});
