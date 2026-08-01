import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  getInterpreterOverlayPermissionStatus,
  openInterpreterOverlayAccessibilitySettings,
  openInterpreterOverlayScreenRecordingSettings,
  requestInterpreterOverlayAccessibilityPermission,
  requestInterpreterOverlayScreenRecordingPermission,
} from './settings';

function isNonDarwinOrNonElectron(): boolean {
  return !process.versions.electron || process.platform !== 'darwin';
}

describe('interpreter overlay permission handlers', () => {
  test('getInterpreterOverlayPermissionStatus returns expected defaults off macOS/electron', async () => {
    const { status } = await getInterpreterOverlayPermissionStatus();

    assert.equal(typeof status.accessibilityGranted, 'boolean');
    assert.equal(typeof status.screenRecordingGranted, 'boolean');
    assert.equal(typeof status.screenRecordingStatus, 'string');

    if (isNonDarwinOrNonElectron()) {
      assert.equal(status.accessibilityGranted, true);
      assert.equal(status.screenRecordingGranted, true);
      assert.equal(status.screenRecordingStatus, 'granted');
    }
  });

  test('requestInterpreterOverlayAccessibilityPermission returns success off macOS/electron', async () => {
    const response = await requestInterpreterOverlayAccessibilityPermission();

    assert.equal(typeof response.success, 'boolean');
    assert.equal(typeof response.status.accessibilityGranted, 'boolean');
    assert.equal(typeof response.status.screenRecordingGranted, 'boolean');

    if (isNonDarwinOrNonElectron()) {
      assert.equal(response.success, true);
      assert.equal(response.status.accessibilityGranted, true);
      assert.equal(response.status.screenRecordingGranted, true);
      assert.equal(response.error, undefined);
    }
  });

  test('requestInterpreterOverlayScreenRecordingPermission returns success off macOS/electron', async () => {
    const response = await requestInterpreterOverlayScreenRecordingPermission();

    assert.equal(typeof response.success, 'boolean');
    assert.equal(typeof response.status.accessibilityGranted, 'boolean');
    assert.equal(typeof response.status.screenRecordingGranted, 'boolean');

    if (isNonDarwinOrNonElectron()) {
      assert.equal(response.success, true);
      assert.equal(response.status.accessibilityGranted, true);
      assert.equal(response.status.screenRecordingGranted, true);
      assert.equal(response.error, undefined);
    }
  });

  test('openInterpreterOverlayAccessibilitySettings is a no-op off macOS/electron', async () => {
    const response = await openInterpreterOverlayAccessibilitySettings();

    assert.equal(typeof response.success, 'boolean');
    if (isNonDarwinOrNonElectron()) {
      assert.equal(response.success, true);
      assert.equal(response.error, undefined);
    }
  });

  test('openInterpreterOverlayScreenRecordingSettings is a no-op off macOS/electron', async () => {
    const response = await openInterpreterOverlayScreenRecordingSettings();

    assert.equal(typeof response.success, 'boolean');
    if (isNonDarwinOrNonElectron()) {
      assert.equal(response.success, true);
      assert.equal(response.error, undefined);
    }
  });
});
