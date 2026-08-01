import { describe, expect, test } from 'bun:test';

import {
  buildOverlayBrowserSelectionElements,
  mergeBrowserSelectionIntoTargetContextItems,
} from './browser-selection-elements';
import type { BrowserControlPageElementInventory } from '../../../shared/types/browserControl';
import type { OverlayContextItem } from '../shared/ipc';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../shared/target-identity';

describe('browser selection elements', () => {
  test('maps browser viewport refs into display-local overlay selection refs', () => {
    const inventory: BrowserControlPageElementInventory = {
      tabRef: 'install:profile-1:chrome-tab:12',
      chromeTabId: 12,
      browserProfilePolicyId: 'install:profile-1',
      origin: 'https://example.test',
      frames: [{
        frameId: 0,
        chromeDocumentId: 'doc-1',
        url: 'https://example.test/form',
        documentRevision: 'rev-1',
        viewport: {
          width: 800,
          height: 600,
          scrollX: 0,
          scrollY: 20,
          devicePixelRatio: 2,
          screenBounds: { x: 120, y: 160, width: 800, height: 600 },
        },
        totalElementCount: 2,
        returnedElementCount: 2,
        truncatedElementCount: 0,
        elements: [
          {
            refId: 'browser-element:rev-1:0',
            index: 0,
            tagName: 'button',
            role: 'button',
            name: 'Submit',
            text: 'Submit',
            value: null,
            inputType: null,
            checked: null,
            disabled: false,
            editable: false,
            clickable: true,
            bounds: { x: 20, y: 30, width: 100, height: 40 },
          },
          {
            refId: 'browser-element:rev-1:1',
            index: 1,
            tagName: 'input',
            role: 'textbox',
            name: '',
            text: '',
            value: 'Ada',
            inputType: 'text',
            checked: null,
            disabled: false,
            editable: true,
            clickable: true,
            bounds: { x: 700, y: 500, width: 90, height: 28 },
          },
        ],
      }],
    };

    const elements = buildOverlayBrowserSelectionElements({
      display: {
        id: 1,
        boundsDIP: { x: 100, y: 100, width: 1000, height: 800 },
        scaleFactor: 2,
      },
      absoluteBounds: { x: 130, y: 170, width: 160, height: 120 },
      inventory,
      browserWindowId: 7,
    });

    expect(elements).toEqual([{
      id: 'browser-element:rev-1:0',
      role: 'button',
      label: 'Submit',
      bounds: { x: 40, y: 90, width: 100, height: 40 },
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
          ref_invalidation_rules: [
            'browser_profile_mismatch',
            'browser_tab_mismatch',
            'browser_frame_mismatch',
            'browser_document_revision_mismatch',
          ],
        },
      },
    }]);
  });

  test('skips browser refs without viewport screen bounds', () => {
    const inventory: BrowserControlPageElementInventory = {
      tabRef: 'install:profile-1:chrome-tab:12',
      chromeTabId: 12,
      browserProfilePolicyId: 'install:profile-1',
      origin: 'https://example.test',
      frames: [{
        frameId: 0,
        chromeDocumentId: null,
        url: 'https://example.test/form',
        documentRevision: 'rev-1',
        viewport: {
          width: 800,
          height: 600,
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 1,
          screenBounds: null,
        },
        totalElementCount: 1,
        returnedElementCount: 1,
        truncatedElementCount: 0,
        elements: [{
          refId: 'browser-element:rev-1:0',
          index: 0,
          tagName: 'button',
          role: 'button',
          name: 'Submit',
          text: 'Submit',
          value: null,
          inputType: null,
          checked: null,
          disabled: false,
          editable: false,
          clickable: true,
          bounds: { x: 20, y: 30, width: 100, height: 40 },
        }],
      }],
    };

    expect(buildOverlayBrowserSelectionElements({
      display: {
        id: 1,
        boundsDIP: { x: 0, y: 0, width: 1000, height: 800 },
        scaleFactor: 1,
      },
      absoluteBounds: { x: 0, y: 0, width: 1000, height: 800 },
      inventory,
    })).toEqual([]);
  });

  test('merges browser refs into the matching target context snapshot', () => {
    const bounds = { x: 130, y: 170, width: 160, height: 120 };
    const targetIdentity = buildOverlayTargetIdentity({
      kind: 'screen-region',
      bounds,
      display: {
        id: 'display-1',
        boundsDIP: { x: 100, y: 100, width: 1000, height: 800 },
        scaleFactor: 2,
      },
      targetWindowSessionKey: 'window-1',
      generation: 1,
      now: 1000,
    });
    const contextItems: OverlayContextItem[] = [{
      id: 'target-1',
      kind: 'region',
      role: 'target',
      label: 'Chrome target',
      scopeKind: 'screen-region',
      bounds,
      displayId: 'display-1',
      targetWindowSessionKey: 'window-1',
      targetIdentity,
      snapshot: buildCurrentSelectionContext({ targetIdentity }),
      previewText: null,
      previewImageDataUrl: null,
    }, {
      id: 'selected-text-1',
      kind: 'file',
      role: 'reference',
      name: 'Selected text.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
      filePath: null,
      dataUrl: `data:text/plain;base64,${Buffer.from('hello world').toString('base64')}`,
      sourceKind: 'selected-text',
      sourceLabel: 'Selected text',
      sourceBounds: { x: 150, y: 180, width: 100, height: 20 },
      sourceDisplayId: 'display-1',
    }];
    const browser = {
      profileId: 'profile-1',
      profilePolicyId: 'install:profile-1',
      windowId: 7,
      tabId: 12,
      frameId: null,
      tabRef: 'install:profile-1:chrome-tab:12',
      url: 'https://example.test/form',
      title: 'Example form',
      documentRevision: 'rev-1',
    };
    const selectableElements = [{
      id: 'browser-element:rev-1:0',
      role: 'button',
      label: 'Submit',
      bounds: { x: 40, y: 90, width: 100, height: 40 },
      browser: {
        tabRef: 'install:profile-1:chrome-tab:12',
        chromeTabId: 12,
        frameId: 0,
        refId: 'browser-element:rev-1:0',
        browserProfilePolicyId: 'install:profile-1',
        documentRevision: 'rev-1',
        origin: 'https://example.test',
        url: 'https://example.test/form',
      },
    }];

    const merged = mergeBrowserSelectionIntoTargetContextItems({
      contextItems,
      absoluteBounds: bounds,
      browser,
      selectableElements,
      previewText: 'Name\nSubmit',
    });

    expect(merged[1]).toBe(contextItems[1]);
    expect(merged[0]).toMatchObject({
      targetIdentity: {
        browser,
        document: {
          id: '12',
          title: 'Example form',
          url: 'https://example.test/form',
          appSpecificId: 12,
        },
      },
      previewText: 'Name\nSubmit',
      selectableElements,
      snapshot: {
        targetIdentityId: 'overlay-target-1',
        selectableRefs: [{
          id: 'browser-element:rev-1:0',
          browser: selectableElements[0].browser,
        }],
      },
    });
  });
});
