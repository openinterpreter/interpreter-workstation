import { describe, expect, it } from 'bun:test';
import {
  normalizeSwiftElements,
  windowsUiaElementIntersectsScope,
  windowsUiaWindowId,
} from './accessibility-parser/index.js';

describe('accessibility parser dropdown normalization', () => {
  it('removes duplicate selected menuitem echoes from closed dropdowns', () => {
    const normalized = normalizeSwiftElements([
      {
        id: 'language',
        role: 'AXPopUpButton',
        role_description: 'pop up button',
        value: 'English',
        visible: true,
        children: [
          {
            id: 'language-option',
            role: 'AXMenuItem',
            role_description: 'menu item',
            value: 'English',
            visible: true,
          },
        ],
      },
    ]);

    expect(normalized).toEqual([
      {
        id: 'language',
        role: 'AXPopUpButton',
        role_description: 'pop up button',
        value: 'English',
        visible: true,
        children: undefined,
      },
    ]);
  });

  it('drops duplicate nested dropdown menus when the same option list is already exposed elsewhere', () => {
    const normalized = normalizeSwiftElements([
      {
        id: 'global-menu',
        role: 'AXMenu',
        visible: true,
        children: [
          {
            id: 'annual',
            role: 'AXMenuItem',
            value: 'Annual',
            visible: true,
          },
          {
            id: 'quarterly',
            role: 'AXMenuItem',
            value: 'Quarterly',
            visible: true,
          },
        ],
      },
      {
        id: 'billing-cycle',
        role: 'AXPopUpButton',
        role_description: 'pop up button',
        value: 'Quarterly',
        visible: true,
        children: [
          {
            id: 'nested-menu',
            role: 'AXMenu',
            visible: true,
            children: [
              {
                id: 'nested-annual',
                role: 'AXMenuItem',
                value: 'Annual',
                visible: true,
              },
              {
                id: 'nested-quarterly',
                role: 'AXMenuItem',
                value: 'Quarterly',
                visible: true,
              },
            ],
          },
        ],
      },
    ]);

    expect(normalized[0]?.children).toHaveLength(2);
    expect(normalized[1]?.children).toBeUndefined();
  });

  it('preserves nested dropdown menus when they are the only option list representation', () => {
    const normalized = normalizeSwiftElements([
      {
        id: 'country',
        role: 'AXPopUpButton',
        role_description: 'pop up button',
        value: 'Select an option',
        visible: true,
        children: [
          {
            id: 'country-menu',
            role: 'AXMenu',
            visible: true,
            children: [
              {
                id: 'country-australia',
                role: 'AXMenuItem',
                value: 'Australia',
                visible: true,
              },
              {
                id: 'country-united-states',
                role: 'AXMenuItem',
                value: 'United States',
                visible: true,
              },
            ],
          },
        ],
      },
    ]);

    expect(normalized[0]?.children).toHaveLength(1);
    expect(normalized[0]?.children?.[0]?.role).toBe('AXMenu');
  });
});

describe('Windows UIA scope filtering', () => {
  it('formats native window handles as UIA window ids', () => {
    expect(windowsUiaWindowId(9568)).toBe('hwnd-2560');
    expect(windowsUiaWindowId('hwnd-2560')).toBe('hwnd-2560');
    expect(windowsUiaWindowId(0)).toBeNull();
    expect(windowsUiaWindowId(null)).toBeNull();
  });

  it('keeps only elements intersecting the selected region', () => {
    const scope = { x: 100, y: 100, width: 200, height: 160 };
    const displayScale = 1;

    expect(windowsUiaElementIntersectsScope({
      element_index: 1,
      role: 'Edit',
      name: 'Inside',
      bounds: { x: 120, y: 130, width: 80, height: 32 },
    }, scope, displayScale)).toBe(true);

    expect(windowsUiaElementIntersectsScope({
      element_index: 2,
      role: 'Edit',
      name: 'Below',
      bounds: { x: 120, y: 400, width: 80, height: 32 },
    }, scope, displayScale)).toBe(false);
  });
});
