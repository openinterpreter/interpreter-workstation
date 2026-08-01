import { describe, expect, test } from 'bun:test';

import {
  buildAttachedTargetContextSnapshot,
  cloneAttachedTargetIdentity,
  getNativeCuaSelectionRefreshRequest,
  resolveCommittedTargetWindow,
} from './attached-target-context';
import type { OverlayRegionContextItem, OverlaySelectionElement } from '../shared/ipc';
import type { DisplayInfo } from '../shared/types';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../shared/target-identity';

const display: DisplayInfo = {
  id: 'display-1',
  boundsDIP: { x: 0, y: 0, width: 1200, height: 900 },
  scaleFactor: 2,
};

function nativeTargetContext(): OverlayRegionContextItem {
  const bounds = { x: 100, y: 200, width: 500, height: 300 };
  const nativeTargetIdentity = {
    kind: 'app-window',
    platform: 'darwin',
    coordinate_space: 'screen-dip',
    observed_at: 1000,
    app: { name: 'Client Intake', pid: 123 },
    window: { native_window_id: 456, title: 'Client Intake' },
    bounds: { x: 90, y: 180, width: 540, height: 340 },
  };
  const targetIdentity = buildOverlayTargetIdentity({
    kind: 'screen-region',
    bounds,
    display,
    targetWindowSessionKey: 'window-session-1',
    nativeWindowId: 456,
    appName: 'Client Intake',
    appPid: 123,
    generation: 7,
    now: 1000,
  });
  return {
    id: 'target-1',
    kind: 'region',
    role: 'target',
    scopeKind: 'screen-region',
    label: 'Client Intake form',
    bounds,
    displayId: display.id,
    targetWindowSessionKey: 'window-session-1',
    targetIdentity,
    snapshot: buildCurrentSelectionContext({
      targetIdentity,
      contextItemIds: ['target-1'],
      selectableRefs: [{
        id: 'element_index:6',
        role: 'combobox',
        label: 'Standard',
        bounds: { x: 120, y: 240, width: 180, height: 28 },
        nativeCua: {
          app: 'Client Intake',
          elementIndex: 6,
          targetIdentity: nativeTargetIdentity,
        },
      }],
    }),
    previewText: null,
    previewImageDataUrl: null,
  };
}

function appWindowTargetWithoutNativeRefs(): OverlayRegionContextItem {
  const targetContext = nativeTargetContext();
  return {
    ...targetContext,
    snapshot: buildCurrentSelectionContext({
      targetIdentity: targetContext.targetIdentity,
      contextItemIds: ['target-1'],
      selectableRefs: [{
        id: 'ax-field-1',
        role: 'textbox',
        label: 'First Name',
        bounds: { x: 120, y: 240, width: 180, height: 28 },
      }],
    }),
  };
}

describe('attached target context', () => {
  test('keeps the attached target identity generation stable across refreshes', () => {
    const targetContext = nativeTargetContext();
    const cloned = cloneAttachedTargetIdentity({
      sourceIdentity: targetContext.targetIdentity,
      display,
      targetBounds: { x: 101, y: 201, width: 498, height: 299 },
      targetWindowSessionKey: 'window-session-2',
      now: 2000,
    });

    expect(cloned.id).toBe('overlay-target-7');
    expect(cloned.generation).toBe(7);
    expect(cloned.capturedAt).toBe(2000);
    expect(cloned.bounds).toEqual({ x: 101, y: 201, width: 498, height: 299 });
    expect(cloned.window.sessionKey).toBe('window-session-2');
    expect(cloned.permissionScope.targetWindowSessionKey).toBe('window-session-2');
  });

  test('uses refreshed native CUA refs without changing selected-context metadata', () => {
    const targetContext = nativeTargetContext();
    const refreshedElements: OverlaySelectionElement[] = [{
      id: 'element_index:6',
      role: 'combobox',
      label: 'Priority',
      bounds: { x: 120, y: 240, width: 180, height: 28 },
      nativeCua: {
        app: 'Client Intake',
        elementIndex: 6,
        targetIdentity: { source: 'live-native-cua' },
      },
    }];

    const context = buildAttachedTargetContextSnapshot({
      targetContext,
      display,
      targetBounds: targetContext.bounds,
      targetWindowSessionKey: targetContext.targetWindowSessionKey,
      refreshedSelectableElements: refreshedElements,
      now: 3000,
    });

    expect(context.targetIdentity.id).toBe('overlay-target-7');
    expect(context.currentSelectionContext.id).toBe('selected-context-7');
    expect(context.currentSelectionContext.generation).toBe(7);
    expect(context.currentSelectionContext.selectableRefs).toHaveLength(1);
    expect(context.currentSelectionContext.selectableRefs[0]).toMatchObject({
      id: 'element_index:6',
      label: 'Priority',
    });
    expect(context.currentSelectionContext.selectableRefs[0].nativeCua?.targetIdentity).toEqual({
      source: 'live-native-cua',
    });
  });

  test('returns the native CUA refresh target from selected refs', () => {
    expect(getNativeCuaSelectionRefreshRequest(nativeTargetContext())).toEqual({
      appName: 'Client Intake',
      targetIdentity: {
        kind: 'app-window',
        platform: 'darwin',
        coordinate_space: 'screen-dip',
        observed_at: 1000,
        app: { name: 'Client Intake', pid: 123 },
        window: { native_window_id: 456, title: 'Client Intake' },
        bounds: { x: 90, y: 180, width: 540, height: 340 },
      },
    });
  });

  test('returns a native CUA refresh target from observed target app identity before native refs exist', () => {
    expect(getNativeCuaSelectionRefreshRequest(appWindowTargetWithoutNativeRefs())).toEqual({
      appName: 'Client Intake',
      targetIdentity: {
        kind: 'app-window',
        platform: process.platform,
        coordinate_space: 'screen-dip',
        observed_at: 1000,
        app: { name: 'Client Intake', pid: 123 },
        window: { native_window_id: 456, title: null },
        bounds: { x: 100, y: 200, width: 500, height: 300 },
        ref_invalidation: {
          rules: [
            'target_identity_mismatch',
            'pid_mismatch',
            'native_window_id_mismatch',
            'window_closed',
          ],
        },
      },
    });
  });

  test('resolves the committed target window from the region identity when present', () => {
    expect(resolveCommittedTargetWindow(nativeTargetContext())).toEqual({
      nativeWindowId: 456,
      appName: 'Client Intake',
    });
  });

  test('resolves the committed target window from hydrated native CUA refs when the region identity has none', () => {
    const targetContext = nativeTargetContext();
    const dragRegion: OverlayRegionContextItem = {
      ...targetContext,
      targetIdentity: {
        ...targetContext.targetIdentity,
        app: null,
        window: { nativeWindowId: null, sessionKey: null },
      },
    };
    expect(resolveCommittedTargetWindow(dragRegion)).toEqual({
      nativeWindowId: 456,
      appName: 'Client Intake',
    });
  });

  test('returns null when neither the region identity nor the refs name a native window', () => {
    const targetContext = appWindowTargetWithoutNativeRefs();
    const unhydrated: OverlayRegionContextItem = {
      ...targetContext,
      targetIdentity: {
        ...targetContext.targetIdentity,
        app: null,
        window: { nativeWindowId: null, sessionKey: null },
      },
    };
    expect(resolveCommittedTargetWindow(unhydrated)).toBeNull();
  });
});
