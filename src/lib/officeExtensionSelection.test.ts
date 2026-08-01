import { describe, expect, test } from 'bun:test';

import { mapOfficeExtensionSelectionMessage } from './officeExtensionSelection';

const filePath = '/workspace/report.xlsx';

describe('mapOfficeExtensionSelectionMessage', () => {
  test('maps a cell selection payload', () => {
    const selection = mapOfficeExtensionSelectionMessage({
      type: 'ONLYOFFICE_SELECTION_CHANGED',
      filePath,
      filename: 'report.xlsx',
      doctype: 'spreadsheet',
      timestamp: 1710000000000,
      selection: {
        kind: 'cell',
        cell: 'B2',
        range: 'B2:C4',
        activeCell: 'B2',
        sheetIndex: 1,
        text: 'Revenue',
      },
    }, filePath);

    expect(selection).toEqual({
      type: 'office',
      filePath,
      filename: 'report.xlsx',
      doctype: 'spreadsheet',
      kind: 'cell',
      cell: 'B2',
      range: 'B2:C4',
      activeCell: 'B2',
      sheetIndex: 1,
      text: 'Revenue',
    });
  });

  test('maps a text selection payload', () => {
    const selection = mapOfficeExtensionSelectionMessage({
      type: 'ONLYOFFICE_SELECTION_CHANGED',
      filePath: '/workspace/proposal.docx',
      filename: 'proposal.docx',
      doctype: 'word',
      timestamp: 1710000000001,
      selection: {
        kind: 'text',
        text: 'Selected paragraph',
      },
    }, '/workspace/proposal.docx');

    expect(selection).toEqual({
      type: 'office',
      filePath: '/workspace/proposal.docx',
      filename: 'proposal.docx',
      doctype: 'word',
      kind: 'text',
      text: 'Selected paragraph',
    });
  });

  test('maps selected image and object payloads', () => {
    const imageSelection = mapOfficeExtensionSelectionMessage({
      type: 'ONLYOFFICE_SELECTION_CHANGED',
      filePath: '/workspace/slides.pptx',
      filename: 'slides.pptx',
      doctype: 'presentation',
      timestamp: 1710000000002,
      selection: {
        kind: 'image',
        objects: [{ type: 'image', id: 'img-1', imageName: 'Chart', hasImage: true }],
      },
    }, '/workspace/slides.pptx');

    const objectSelection = mapOfficeExtensionSelectionMessage({
      type: 'ONLYOFFICE_SELECTION_CHANGED',
      filePath: '/workspace/slides.pptx',
      filename: 'slides.pptx',
      doctype: 'presentation',
      timestamp: 1710000000003,
      selection: {
        kind: 'object',
        objects: [{ type: 'shape', value: 'Rectangle', id: 'shape-7' }],
      },
    }, '/workspace/slides.pptx');

    expect(imageSelection).toMatchObject({
      type: 'office',
      filePath: '/workspace/slides.pptx',
      filename: 'slides.pptx',
      doctype: 'presentation',
      kind: 'image',
      objects: [{ type: 'image', id: 'img-1', imageName: 'Chart', hasImage: true }],
    });
    expect(objectSelection).toMatchObject({
      type: 'office',
      kind: 'object',
      objects: [{ type: 'shape', value: 'Rectangle', id: 'shape-7' }],
    });
  });

  test('returns null for empty selection', () => {
    const selection = mapOfficeExtensionSelectionMessage({
      type: 'ONLYOFFICE_SELECTION_CHANGED',
      filePath,
      filename: 'report.xlsx',
      doctype: 'spreadsheet',
      timestamp: 1710000000004,
      selection: { kind: 'empty' },
    }, filePath);

    expect(selection).toBeNull();
  });

  test('ignores messages for another file path', () => {
    const selection = mapOfficeExtensionSelectionMessage({
      type: 'ONLYOFFICE_SELECTION_CHANGED',
      filePath: '/workspace/other.xlsx',
      filename: 'other.xlsx',
      doctype: 'spreadsheet',
      timestamp: 1710000000005,
      selection: { kind: 'cell', cell: 'A1' },
    }, filePath);

    expect(selection).toBeUndefined();
  });

  test('ignores text selections with non-string text', () => {
    const selection = mapOfficeExtensionSelectionMessage({
      type: 'ONLYOFFICE_SELECTION_CHANGED',
      filePath,
      filename: 'report.xlsx',
      doctype: 'spreadsheet',
      timestamp: 1710000000006,
      selection: { kind: 'text', text: 42 },
    }, filePath);

    expect(selection).toBeUndefined();
  });

  test('drops malformed selected object arrays', () => {
    const selection = mapOfficeExtensionSelectionMessage({
      type: 'ONLYOFFICE_SELECTION_CHANGED',
      filePath: '/workspace/slides.pptx',
      filename: 'slides.pptx',
      doctype: 'presentation',
      timestamp: 1710000000007,
      selection: { kind: 'image', objects: { type: 'image', imageName: 'Chart' } },
    }, '/workspace/slides.pptx');

    expect(selection).toEqual({
      type: 'office',
      filePath: '/workspace/slides.pptx',
      filename: 'slides.pptx',
      doctype: 'presentation',
      kind: 'image',
      objects: [],
    });
  });
});
