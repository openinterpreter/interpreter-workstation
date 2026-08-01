import { describe, expect, test } from 'bun:test';
import { getOverlayRegionSelectionRole } from './region-selection-role.js';

describe('getOverlayRegionSelectionRole', () => {
  test('keeps target selections as target replacements for any profile', () => {
    expect(getOverlayRegionSelectionRole('agent-profile', 'target')).toBe('target');
  });

  test('keeps active-app replacement drags as target selections for any profile', () => {
    expect(getOverlayRegionSelectionRole(
      'agent-profile',
      'reference',
      { currentTargetIsActiveApp: true },
    )).toBe('target');
  });

  test('preserves explicit reference drags after a real target exists', () => {
    expect(getOverlayRegionSelectionRole(
      'agent-profile',
      'reference',
      { currentTargetIsActiveApp: false },
    )).toBe('reference');
  });
});
