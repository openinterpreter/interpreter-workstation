import { describe, expect, test } from 'bun:test';
import { getTabBarClosedPadding, getTabBarRightPadding, getDragRegionStyle } from './titlebarLayout';

describe('titlebarLayout', () => {
  test('prefers measured windows left reserve when it is larger than base spacing', () => {
    expect(
      getTabBarClosedPadding({
        isMac: false,
        isWindows: true,
        trafficLightsWidth: 0,
        unitPadding: 8,
        unitElementHeight: 34,
        windowsLeftReserve: 196,
      }),
    ).toBe(196);
  });

  test('falls back to base spacing when measured windows reserve is small', () => {
    expect(
      getTabBarClosedPadding({
        isMac: false,
        isWindows: true,
        trafficLightsWidth: 0,
        unitPadding: 8,
        unitElementHeight: 34,
        windowsLeftReserve: 12,
      }),
    ).toBe(50);
  });

  test('includes traffic lights width on macOS', () => {
    expect(
      getTabBarClosedPadding({
        isMac: true,
        isWindows: false,
        trafficLightsWidth: 72,
        unitPadding: 8,
        unitElementHeight: 34,
        windowsLeftReserve: 0,
      }),
    ).toBe(122);
  });

  test('never returns negative right tab-bar padding', () => {
    expect(getTabBarRightPadding(220, 130)).toBe(0);
    expect(getTabBarRightPadding(40, 130)).toBe(90);
  });

  test('disables custom drag region on linux to avoid Wayland SIGSEGV (#976)', () => {
    expect(getDragRegionStyle('linux')).toBe('no-drag');
  });

  test('enables custom drag region on macOS and Windows', () => {
    expect(getDragRegionStyle('darwin')).toBe('drag');
    expect(getDragRegionStyle('win32')).toBe('drag');
  });
});
