import { describe, expect, test } from 'bun:test';

import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../shared/target-identity';
import { mergeSelectedContextRefsIntoRunEngineElements } from './selected-context-run-engine-elements';

const targetIdentity = buildOverlayTargetIdentity({
  kind: 'screen-region',
  bounds: { x: 10, y: 20, width: 300, height: 200 },
  display: {
    id: 'display-1',
    boundsDIP: { x: 0, y: 0, width: 1000, height: 800 },
    scaleFactor: 2,
  },
  generation: 1,
  now: 1000,
});

describe('selected-context refs for RunEngine elements', () => {
  test('appends selected refs without inferring labels or replacing existing AX ids', () => {
    const snapshot = buildCurrentSelectionContext({
      targetIdentity,
      selectableRefs: [{
        id: 'ax-ref-1',
        role: 'AXButton',
        label: 'Existing AX label',
        bounds: { x: 40, y: 60, width: 90, height: 28 },
      }, {
        id: 'browser-element:rev-1:0',
        role: 'button',
        label: 'Submit',
        bounds: { x: 160, y: 260, width: 90, height: 36 },
        browser: {
          tabRef: 'install:profile-1:chrome-tab:12',
          chromeTabId: 12,
          browserWindowId: 7,
          frameId: 0,
          chromeDocumentId: 'doc-1',
          refId: 'browser-element:rev-1:0',
          browserProfilePolicyId: 'install:profile-1',
          documentRevision: 'rev-1',
          origin: 'https://example.test',
          url: 'https://example.test/form',
          targetIdentity: {
            kind: 'browser-page',
            browser_profile_policy_id: 'install:profile-1',
            tab_ref: 'install:profile-1:chrome-tab:12',
            chrome_tab_id: 12,
            browser_window_id: 7,
            frame_id: 0,
            chrome_document_id: 'doc-1',
            document_revision: 'rev-1',
            origin: 'https://example.test',
            url: 'https://example.test/form',
            coordinate_space: 'browser-viewport-css-px',
            ref_lifetime: 'current_document_revision',
            ref_invalidation_rules: ['browser_document_revision_mismatch'],
          },
        },
      }, {
        id: 'element_index:7',
        role: 'AXTextField',
        label: '- [7] AXTextField bounds={x=130, y=240, width=180, height=30, coordinate_space=screen_points}',
        bounds: { x: 130, y: 240, width: 180, height: 30 },
        nativeCua: {
          app: 'Notes',
          elementIndex: 7,
          targetIdentity: {
            kind: 'app-window',
            app: { name: 'Notes', pid: 123 },
            window: { native_window_id: 456, title: 'Draft' },
          },
        },
      }],
    });

    expect(mergeSelectedContextRefsIntoRunEngineElements([{
      id: 'ax-ref-1',
      role: 'AXButton',
      label: 'AX observed label',
      bbox: { x: 40, y: 60, width: 90, height: 28 },
    }], snapshot)).toEqual([{
      id: 'ax-ref-1',
      role: 'AXButton',
      label: 'AX observed label',
      bbox: { x: 40, y: 60, width: 90, height: 28 },
    }, {
      id: 'browser-element:rev-1:0',
      role: 'button',
      label: 'Submit',
      bbox: { x: 160, y: 260, width: 90, height: 36 },
      browserPage: {
        refId: 'browser-element:rev-1:0',
        targetIdentity: {
          kind: 'browser-page',
          browser_profile_policy_id: 'install:profile-1',
          tab_ref: 'install:profile-1:chrome-tab:12',
          chrome_tab_id: 12,
          browser_window_id: 7,
          frame_id: 0,
          chrome_document_id: 'doc-1',
          document_revision: 'rev-1',
          origin: 'https://example.test',
          url: 'https://example.test/form',
          coordinate_space: 'browser-viewport-css-px',
          ref_lifetime: 'current_document_revision',
          ref_invalidation_rules: ['browser_document_revision_mismatch'],
        },
      },
    }, {
      id: 'element_index:7',
      role: 'AXTextField',
      label: '- [7] AXTextField bounds={x=130, y=240, width=180, height=30, coordinate_space=screen_points}',
      bbox: { x: 130, y: 240, width: 180, height: 30 },
      nativeCua: {
        app: 'Notes',
        elementIndex: 7,
        targetIdentity: {
          kind: 'app-window',
          app: { name: 'Notes', pid: 123 },
          window: { native_window_id: 456, title: 'Draft' },
        },
      },
    }]);
  });
});
