import { describe, expect, test } from 'bun:test';
import { resolveTypingTarget } from './interpreter-overlay-typing';

describe('resolveTypingTarget', () => {
  test('retargets label-like nodes to the editable field on the same row', () => {
    const elements = [
      {
        id: 'company-label',
        role: 'AXTextArea',
        label: 'Company Name:',
        bbox: { x: 120, y: 240, width: 180, height: 30 },
      },
      {
        id: 'company-input',
        role: 'AXTextArea',
        label: '',
        bbox: { x: 430, y: 238, width: 260, height: 34 },
      },
      {
        id: 'other-input',
        role: 'AXTextArea',
        label: '',
        bbox: { x: 430, y: 320, width: 260, height: 34 },
      },
    ];

    const target = resolveTypingTarget(elements, elements[0]);

    expect(target.id).toBe('company-input');
  });

  test('leaves already-editable targets unchanged', () => {
    const elements = [
      {
        id: 'company-input',
        role: 'AXTextArea',
        label: '',
        bbox: { x: 430, y: 238, width: 260, height: 34 },
      },
    ];

    const target = resolveTypingTarget(elements, elements[0]);

    expect(target.id).toBe('company-input');
  });
});
