import { describe, expect, test, vi } from 'vitest';

import { calculateContextDiff, formatContextDiffForMessage } from './ContextPreview';
import { createEmptyWorkstationContext } from '../../../shared/utils/formatWorkstationContext';
import type { WorkstationContext } from '../../../shared/types/workstation';

vi.mock('@/ipc', () => ({
  pathBasename: (targetPath: string) => targetPath.split('/').pop() ?? targetPath,
}));

function contextWithSelection(selection: WorkstationContext['selection']): WorkstationContext {
  return {
    ...createEmptyWorkstationContext(),
    selection,
  };
}

describe('ContextPreview office selection context', () => {
  test('treats office selections as sendable context changes', () => {
    const diff = calculateContextDiff(null, contextWithSelection({
      type: 'office',
      filePath: '/workspace/report.xlsx',
      filename: 'report.xlsx',
      doctype: 'spreadsheet',
      kind: 'cell',
      cell: 'B2',
      range: 'B2:C4',
      activeCell: 'B2',
      sheetIndex: 1,
      text: 'Revenue',
    }));

    expect(diff.hasChanges).toBe(true);
    expect(diff.selectionChanged).toBe(true);
    expect(diff.newSelection).toMatchObject({ type: 'office', kind: 'cell', range: 'B2:C4' });
  });

  test('formats office selections into hidden context diff text', () => {
    const diff = calculateContextDiff(null, contextWithSelection({
      type: 'office',
      filePath: '/workspace/slides.pptx',
      filename: 'slides.pptx',
      doctype: 'presentation',
      kind: 'image',
      objects: [{ type: 'image', id: 'img-1', imageName: 'Chart', hasImage: true }],
    }));

    const message = formatContextDiffForMessage(diff);

    expect(message).toContain('<workstation-context>');
    expect(message).toContain('[Selected Office Image from /workspace/slides.pptx]');
    expect(message).toContain('image img-1: Chart');
  });
});
