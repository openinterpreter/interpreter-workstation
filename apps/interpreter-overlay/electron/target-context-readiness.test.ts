import { describe, expect, test } from 'bun:test';

import {
  hasExecutableTargetRefs,
  isStructuredContextReadyForTarget,
} from './target-context-readiness';
import type { OverlayRegionContextItem } from '../shared/ipc';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../shared/target-identity';

const bounds = { x: 100, y: 200, width: 500, height: 300 };
const targetIdentity = buildOverlayTargetIdentity({
  kind: 'screen-region',
  bounds,
  display: {
    id: 'display-1',
    boundsDIP: { x: 0, y: 0, width: 1200, height: 900 },
    scaleFactor: 2,
  },
  generation: 1,
  now: 1000,
});

const targetContext: OverlayRegionContextItem = {
  id: 'target',
  kind: 'region',
  role: 'target',
  scopeKind: 'screen-region',
  label: 'Selected region',
  bounds,
  displayId: 'display-1',
  targetWindowSessionKey: null,
  targetIdentity,
  snapshot: buildCurrentSelectionContext({ targetIdentity }),
  previewText: null,
  previewImageDataUrl: null,
};

describe('target context readiness', () => {
  test('requires matching display, matching target bounds, and real elements', () => {
    expect(isStructuredContextReadyForTarget(
      {
        displayId: 'display-1',
        scopeBounds: { x: 100.4, y: 199.6, width: 500, height: 300 },
        elements: [{ id: 'field' }],
      },
      { id: 'display-1' },
      targetContext,
    )).toBe(true);

    expect(isStructuredContextReadyForTarget(
      {
        displayId: 'display-2',
        scopeBounds: targetContext.bounds,
        elements: [{ id: 'field' }],
      },
      { id: 'display-1' },
      targetContext,
    )).toBe(false);

    expect(isStructuredContextReadyForTarget(
      {
        displayId: 'display-1',
        scopeBounds: { x: 140, y: 200, width: 500, height: 300 },
        elements: [{ id: 'field' }],
      },
      { id: 'display-1' },
      targetContext,
    )).toBe(false);

    expect(isStructuredContextReadyForTarget(
      {
        displayId: 'display-1',
        scopeBounds: targetContext.bounds,
        elements: [],
      },
      { id: 'display-1' },
      targetContext,
    )).toBe(false);
  });

  test('requires browser or native CUA metadata for executable target refs', () => {
    expect(hasExecutableTargetRefs(targetContext)).toBe(false);

    expect(hasExecutableTargetRefs({
      ...targetContext,
      snapshot: buildCurrentSelectionContext({
        targetIdentity,
        selectableRefs: [{
          id: 'browser-field',
          role: 'textbox',
          label: 'Name',
          bounds: { x: 10, y: 10, width: 100, height: 20 },
          browser: {
            tabRef: 'profile:tab:1',
            chromeTabId: 1,
            frameId: 0,
            refId: 'browser-field',
            browserProfilePolicyId: 'profile',
            documentRevision: 'rev-1',
            origin: 'https://example.test',
            url: 'https://example.test/form',
          },
        }],
      }),
    })).toBe(true);

    expect(hasExecutableTargetRefs({
      ...targetContext,
      snapshot: buildCurrentSelectionContext({
        targetIdentity,
        selectableRefs: [{
          id: 'native-field',
          role: 'textbox',
          label: 'Name',
          bounds: { x: 10, y: 10, width: 100, height: 20 },
          nativeCua: {
            app: 'Example',
            elementIndex: 3,
            targetIdentity: { kind: 'app-window' },
          },
        }],
      }),
    })).toBe(true);
  });
});
