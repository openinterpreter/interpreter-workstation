import { describe, expect, it } from 'bun:test';
import type { ScreenElement } from '../infra/ocr-segmentation/index.js';
import {
  filterOverlayScopeSheenElements,
  normalizeStructuredContext,
} from './structured-context.js';

describe('normalizeStructuredContext', () => {
  it('keeps the interactive model context and rewrites duplicate ids', () => {
    const elements: ScreenElement[] = [
      {
        id: 'title',
        role: 'AXStaticText',
        label: 'Account Settings',
        bbox: { x: 24, y: 24, width: 180, height: 24 },
      },
      {
        id: 'field',
        role: 'AXTextField',
        label: 'First Name',
        bbox: { x: 24, y: 72, width: 220, height: 36 },
      },
      {
        id: 'field',
        role: 'AXButton',
        label: 'Save',
        bbox: { x: 24, y: 124, width: 96, height: 36 },
      },
    ];

    const normalized = normalizeStructuredContext(
      '<text id="title">Account Settings</text>\n<input id="field">First Name</input>\n<button id="field">Save</button>',
      elements,
    );

    expect(normalized.elements).toHaveLength(2);
    expect(normalized.elements.map((element) => element.role)).toEqual(['AXTextField', 'AXButton']);
    expect(normalized.elements[0]?.id).toBe('field');
    expect(normalized.elements[1]?.id).toContain('field__save');
    expect(normalized.formattedText).toContain('id="title"');
    expect(normalized.formattedText).toContain('id="field"');
    expect(normalized.formattedText).toContain(`id="${normalized.elements[1]?.id}"`);
  });

  it('keeps raw control labels instead of inferring nearby label ownership', () => {
    const elements: ScreenElement[] = [
      {
        id: 'label-first',
        role: 'AXStaticText',
        label: 'First Name',
        bbox: { x: 399, y: 288, width: 72, height: 16 },
      },
      {
        id: 'input-first',
        role: 'AXTextField',
        label: 'Averie',
        value: 'Averie',
        bbox: { x: 399, y: 332, width: 322, height: 48 },
      },
    ];

    const normalized = normalizeStructuredContext(
      '<text id="label-first">First Name</text>\n<input id="input-first">Averie</input>',
      elements,
    );

    expect(normalized.elements).toHaveLength(1);
    expect(normalized.elements[0]?.id).toBe('input-first');
    expect(normalized.elements[0]?.label).toBe('Averie');
    expect(normalized.formattedText).toContain('<text id="label-first">First Name</text>');
    expect(normalized.formattedText).toContain('<input id="input-first">Averie</input>');
  });
});

describe('filterOverlayScopeSheenElements', () => {
  it('keeps non-static-text overlay shapes including containers', () => {
    const elements: ScreenElement[] = [
      {
        id: 'title',
        role: 'AXStaticText',
        label: 'Checkout',
        bbox: { x: 0, y: 0, width: 120, height: 28 },
      },
      {
        id: 'button',
        role: 'AXButton',
        label: 'Continue',
        bbox: { x: 0, y: 36, width: 100, height: 32 },
      },
      {
        id: 'text',
        role: 'AXTextField',
        label: 'Email',
        bbox: { x: 0, y: 76, width: 200, height: 36 },
      },
      {
        id: 'checkbox',
        role: 'AXCheckBox',
        label: 'Subscribe',
        bbox: { x: 0, y: 120, width: 16, height: 16 },
      },
      {
        id: 'menuitem',
        role: 'AXMenuItem',
        label: 'File',
        bbox: { x: 0, y: 146, width: 120, height: 24 },
      },
      {
        id: 'group',
        role: 'AXGroup',
        label: 'Payment section',
        bbox: { x: 0, y: 178, width: 240, height: 120 },
      },
    ];

    const sheenElements = filterOverlayScopeSheenElements(elements);

    expect(sheenElements.map((element) => element.id)).toEqual(['button', 'text', 'checkbox', 'menuitem']);
  });
});
