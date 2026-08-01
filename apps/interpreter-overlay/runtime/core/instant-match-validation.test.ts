import { describe, expect, it } from 'bun:test';
import { getInstantMatchRejectionReason } from './instant-match-validation.js';

describe('getInstantMatchRejectionReason', () => {
  it('allows id-only clicks when there is no semantic contradiction to check', () => {
    const rejection = getInstantMatchRejectionReason({
      actionTool: 'click',
      sourceElement: {
        role: 'AXButton',
        label: 'New Tab',
        bbox: { x: 1306, y: 33, width: 28, height: 41 },
      },
      matchedElement: {
        role: 'AXButton',
        label: 'New Tab',
        bbox: { x: 1306, y: 33, width: 28, height: 41 },
      },
    });

    expect(rejection).toBeNull();
  });

  it('rejects mismatched ids when the visible label contradicts the description', () => {
    const rejection = getInstantMatchRejectionReason({
      actionTool: 'click',
      sourceElement: {
        role: 'AXButton',
        label: 'New Tab',
        bbox: { x: 1306, y: 33, width: 28, height: 41 },
      },
      matchedElement: {
        role: 'AXButton',
        label: 'New Tab',
        bbox: { x: 1306, y: 33, width: 28, height: 41 },
      },
      elementDescription: 'employee id field',
    });

    expect(rejection).toContain('does not match target');
  });

  it('allows ids when the description matches the visible label', () => {
    const rejection = getInstantMatchRejectionReason({
      actionTool: 'click',
      sourceElement: {
        role: 'AXButton',
        label: 'New Tab',
        bbox: { x: 1306, y: 33, width: 28, height: 41 },
      },
      matchedElement: {
        role: 'AXButton',
        label: 'New Tab',
        bbox: { x: 1306, y: 33, width: 28, height: 41 },
      },
      elementDescription: 'new tab',
    });

    expect(rejection).toBeNull();
  });

  it('rejects type actions that resolve to non-editable controls', () => {
    const rejection = getInstantMatchRejectionReason({
      actionTool: 'type',
      sourceElement: {
        role: 'AXButton',
        label: 'Submit',
        bbox: { x: 500, y: 300, width: 120, height: 40 },
      },
      matchedElement: {
        role: 'AXButton',
        label: 'Submit',
        bbox: { x: 500, y: 300, width: 120, height: 40 },
      },
      elementDescription: 'employee id field',
    });

    expect(rejection).toContain('not an editable field');
  });

  it('allows in-content form fields even when their labels are blank', () => {
    const rejection = getInstantMatchRejectionReason({
      actionTool: 'type',
      sourceElement: {
        role: 'AXTextField',
        label: '',
        bbox: { x: 300, y: 320, width: 200, height: 40 },
      },
      matchedElement: {
        role: 'AXTextField',
        label: '',
        bbox: { x: 300, y: 320, width: 200, height: 40 },
      },
    });

    expect(rejection).toBeNull();
  });

  it('allows typing through combo-box shell fields', () => {
    const rejection = getInstantMatchRejectionReason({
      actionTool: 'type',
      sourceElement: {
        role: 'AXComboBox',
        label: 'City',
        bbox: { x: 300, y: 320, width: 200, height: 40 },
      },
      matchedElement: {
        role: 'AXComboBox',
        label: 'City',
        bbox: { x: 300, y: 320, width: 200, height: 40 },
      },
      elementDescription: 'city',
    });

    expect(rejection).toBeNull();
  });

  it('allows field descriptions to match validation-heavy labels when the core field tokens agree', () => {
    const rejection = getInstantMatchRejectionReason({
      actionTool: 'type',
      sourceElement: {
        role: 'AXComboBox',
        label: 'First Name should be 2-34 letters or spaces',
        bbox: { x: 300, y: 320, width: 200, height: 40 },
      },
      matchedElement: {
        role: 'AXComboBox',
        label: 'First Name should be 2-34 letters or spaces',
        bbox: { x: 300, y: 320, width: 200, height: 40 },
      },
      elementDescription: 'First Name field',
    });

    expect(rejection).toBeNull();
  });
});
