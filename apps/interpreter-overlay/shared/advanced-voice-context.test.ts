import { describe, expect, test } from 'bun:test';
import { buildAdvancedVoiceOverlayContextInstructions } from './advanced-voice-context';
import { buildOverlayContextPacketText } from './context-packet';
import type { OverlayContextItem, OverlayRegionContextItem } from './ipc';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from './target-identity';
import {
  buildOverlayTextControllerContextPrompt,
  buildOverlayTextControllerRequest,
} from './text-controller';

function targetRegion(): OverlayRegionContextItem {
  const bounds = { x: 10, y: 20, width: 300, height: 200 };
  const targetIdentity = buildOverlayTargetIdentity({
    kind: 'active-app',
    bounds,
    display: {
      id: 'display-1',
      boundsDIP: { x: 0, y: 0, width: 1200, height: 800 },
      scaleFactor: 2,
    },
    targetWindowSessionKey: 'window-1',
    nativeWindowId: 99,
    appName: 'Chromium',
    appPid: 1234,
    generation: 1,
    now: 1000,
  });
  return {
    id: 'target-1',
    kind: 'region',
    role: 'target',
    label: 'Active app: Chromium',
    scopeKind: 'active-app',
    bounds,
    displayId: 'display-1',
    targetWindowSessionKey: 'window-1',
    targetIdentity,
    snapshot: buildCurrentSelectionContext({
      targetIdentity,
      selectableRefs: [{
        id: 'field-1',
        role: 'textbox',
        label: 'Insured name',
        bounds: { x: 12, y: 24, width: 120, height: 24 },
      }],
    }),
    selectableElements: [{
      id: 'field-1',
      role: 'textbox',
      label: 'Insured name',
      bounds: { x: 12, y: 24, width: 120, height: 24 },
    }],
    previewText: null,
    previewImageDataUrl: null,
  };
}

describe('advanced voice overlay context instructions', () => {
  test('injects the selected context packet used by the typed controller', () => {
    const contextItems: OverlayContextItem[] = [
      targetRegion(),
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
        sourceDisplayId: 'display-1',
      },
    ];

    const instructions = buildAdvancedVoiceOverlayContextInstructions(contextItems).join('\n');

    expect(instructions).toContain('Current overlay target: Active app: Chromium, bounds x=10, y=20, width=300, height=200.');
    expect(instructions).toContain('Current overlay context packet follows.');
    expect(instructions).toContain('<overlay_context_packet>');
    expect(instructions).toContain('<selected_context>');
    expect(instructions).toContain('permission_scope_target_window_session_key: window-1');
    expect(instructions).toContain('ref id="field-1" role="textbox" label="Insured name"');
    expect(instructions).toContain('text id="selected-text-1" label="Selected text"');
  });

  test('uses the exact selected-context packet that typed overlay input uses', () => {
    const contextItems: OverlayContextItem[] = [
      targetRegion(),
      {
        id: 'selected-file-1',
        kind: 'file',
        role: 'reference',
        name: 'quote.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        filePath: '/workspace/quote.pdf',
        sourceKind: 'selected-file',
        sourceLabel: 'Selected file',
        sourceBounds: { x: 30, y: 40, width: 90, height: 24 },
        sourceDisplayId: 'display-1',
      },
    ];
    const packet = buildOverlayContextPacketText(contextItems).trim();
    const advancedVoiceInstructions = buildAdvancedVoiceOverlayContextInstructions(contextItems).join('\n');
    const typedPrompt = buildOverlayTextControllerContextPrompt(buildOverlayTextControllerRequest({
      text: 'Use the selected field',
      serviceContextItems: contextItems,
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-1',
      profileId: 'profile-fast',
      renderedProfileId: null,
      inputMethod: 'text',
      now: 1000,
    }));

    expect(packet).toContain('<selected_context>');
    expect(packet).toContain('ref id="field-1" role="textbox" label="Insured name"');
    expect(packet).toContain('file id="selected-file-1" name="quote.pdf" mime_type="application/pdf" size_bytes=2048 source_kind=selected-file source_label="Selected file" display_id=display-1 source_bounds="x=30 y=40 width=90 height=24" file_path=/workspace/quote.pdf');
    expect(advancedVoiceInstructions).toContain(packet);
    expect(typedPrompt).toContain(packet);
  });

  test('reports no selected context when nothing is attached', () => {
    expect(buildAdvancedVoiceOverlayContextInstructions([])).toEqual([
      'Current overlay context: no active app or selected region is attached.',
    ]);
  });
});
