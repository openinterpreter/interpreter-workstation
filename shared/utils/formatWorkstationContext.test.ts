import { describe, test, expect } from 'bun:test';
import { formatWorkstationContext, createEmptyWorkstationContext, stripWorkstationContext } from './formatWorkstationContext';
import type { WorkstationContext } from '../types/workstation';

function baseContext(overrides: Partial<WorkstationContext> = {}): WorkstationContext {
  return {
    ...createEmptyWorkstationContext(),
    ...overrides,
  };
}

describe('formatWorkstationContext', () => {
  test('empty context with no tabs and no selection', () => {
    const result = formatWorkstationContext(createEmptyWorkstationContext());
    expect(result).toBe('');
    expect(result).not.toContain('Selected Text');
    expect(result).not.toContain('Sidebars');
  });

  test('does not include workspace when context has a workspace string', () => {
    const ctx = baseContext({ workspace: '/home/user/project' });
    const result = formatWorkstationContext(ctx);
    expect(result).not.toContain('Workspace:');
  });

  test('does not include workspace when context has a workspace object', () => {
    const ctx = baseContext({ workspace: { path: '/home/user/project' } as any });
    const result = formatWorkstationContext(ctx);
    expect(result).not.toContain('Workspace:');
  });

  test('file tabs with active marker', () => {
    const ctx = baseContext({
      tabs: {
        files: [
          { path: '/src/index.ts', isActive: true },
          { path: '/src/app.ts', isActive: false },
        ],
        browsers: [],
        emails: [],
      },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toContain('Open Files:');
    expect(result).toContain('- /src/index.ts [active]');
    expect(result).toContain('- /src/app.ts');
    expect(result).not.toContain('app.ts [active]');
  });

  test('browser-control tabs are included in hidden workstation context', () => {
    const ctx = baseContext({
      tabs: {
        files: [],
        browsers: [
          { browserId: 'b1', title: 'Google', url: 'https://google.com', isActive: true },
          { browserId: 'b2', title: 'GitHub', url: 'https://github.com', isActive: false },
        ],
        emails: [],
      },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toContain('Browser-Control Tabs:');
    expect(result).not.toContain('Shared Browser Tabs:');
    expect(result).toContain('- Google (https://google.com) [tab_id: b1] [active]');
    expect(result).toContain('- GitHub (https://github.com) [tab_id: b2]');
  });

  test('email tabs are excluded from hidden workstation context', () => {
    const ctx = baseContext({
      tabs: {
        files: [],
        browsers: [],
        emails: [
          { emailId: 'e1', subject: 'Hello', isActive: false },
          { emailId: 'e2', subject: 'Meeting', isActive: true },
        ],
      },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toBe('');
    expect(result).not.toContain('- Email:');
  });

  test('selection truncation at 500 chars', () => {
    const longText = 'x'.repeat(600);
    const ctx = baseContext({
      selection: { type: 'text', text: longText, source: { type: 'unknown' } },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toContain('x'.repeat(500) + '...');
    expect(result).not.toContain('x'.repeat(501));
  });

  test('selection under 500 chars is not truncated', () => {
    const shortText = 'y'.repeat(499);
    const ctx = baseContext({
      selection: { type: 'text', text: shortText, source: { type: 'unknown' } },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toContain(shortText);
    expect(result).not.toContain('...');
  });

  test('selection source file with lines', () => {
    const ctx = baseContext({
      selection: {
        type: 'text',
        text: 'code',
        source: { type: 'file', path: '/src/main.ts', startLine: 10, endLine: 20 },
      },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toContain('from /src/main.ts:10-20');
  });

  test('selection source pdf with page', () => {
    const ctx = baseContext({
      selection: {
        type: 'text',
        text: 'text',
        source: { type: 'pdf', path: '/docs/manual.pdf', page: 3 },
      },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toContain('from /docs/manual.pdf (page 3)');
  });

  test('selection source browser', () => {
    const ctx = baseContext({
      selection: {
        type: 'text',
        text: 'content',
        source: { type: 'browser', browserId: 'tab-42' },
      },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toContain('from browser tab tab-42');
  });

  test('selection source email', () => {
    const ctx = baseContext({
      selection: {
        type: 'text',
        text: 'body',
        source: { type: 'email', emailId: 'msg-99' },
      },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toContain('from email msg-99');
  });

  test('office cell selection includes workbook location', () => {
    const ctx = baseContext({
      selection: {
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
      },
    });

    const result = formatWorkstationContext(ctx);

    expect(result).toContain('Selected Office Cell (from /workspace/report.xlsx, sheet 1, range B2:C4, active B2)');
    expect(result).toContain('Revenue');
  });

  test('office object selection includes object details', () => {
    const ctx = baseContext({
      selection: {
        type: 'office',
        filePath: '/workspace/slides.pptx',
        filename: 'slides.pptx',
        doctype: 'presentation',
        kind: 'image',
        objects: [
          { type: 'image', id: 'img-1', imageName: 'Chart', hasImage: true },
          { type: 'shape', id: 'shape-2', value: 'Rectangle' },
        ],
      },
    });

    const result = formatWorkstationContext(ctx);

    expect(result).toContain('Selected Office Image (from /workspace/slides.pptx):');
    expect(result).toContain('- image img-1: Chart');
    expect(result).toContain('- shape shape-2: Rectangle');
  });

  test('pdf form field selection includes fill_pdf_form target id', () => {
    const ctx = baseContext({
      selection: {
        type: 'pdf',
        kind: 'formField',
        filePath: '/workspace/form.pdf',
        fieldId: 'f7',
        fieldName: 'email',
        fieldType: 'text',
        fieldIndex: 7,
        page: 1,
        value: '',
      },
    });

    const formatted = formatWorkstationContext(ctx);

    expect(formatted).toContain('Selected PDF Form Field (from /workspace/form.pdf, page 1):');
    expect(formatted).toContain('[f7] "email" (text)');
    expect(formatted).toContain('fields: [{ "id": "f7", "value": ... }]');
  });

  test('sidebars none open', () => {
    const ctx = baseContext();
    const result = formatWorkstationContext(ctx);
    expect(result).not.toContain('Sidebars');
  });

  test('sidebars left open only', () => {
    const ctx = baseContext({
      sidebars: {
        left: { isOpen: true, activeTab: 'explorer' },
        right: { isOpen: false },
      },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toContain('Sidebars:');
    expect(result).toContain('Left sidebar: explorer');
    expect(result).not.toContain('Right sidebar');
  });

  test('sidebars right open only', () => {
    const ctx = baseContext({
      sidebars: {
        left: { isOpen: false, activeTab: 'explorer' },
        right: { isOpen: true },
      },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toContain('Sidebars:');
    expect(result).toContain('Right sidebar: pinned agents');
    expect(result).not.toContain('Left sidebar');
  });

  test('sidebars both open', () => {
    const ctx = baseContext({
      sidebars: {
        left: { isOpen: true, activeTab: 'inbox' },
        right: { isOpen: true },
      },
    });
    const result = formatWorkstationContext(ctx);
    expect(result).toContain('Left sidebar: inbox');
    expect(result).toContain('Right sidebar: pinned agents');
  });
});

describe('stripWorkstationContext', () => {
  test('should_strip_single_workstation_context_block', () => {
    const input = '<workstation-context>\nWorkspace: /Users/vic8or/Documents/My Workspace\n\nOpen Tabs: (none)\n\nSidebars:\n  - Right sidebar: pinned agents\n</workstation-context>\nhello';
    expect(stripWorkstationContext(input)).toBe('hello');
  });

  test('should_strip_multiple_workstation_context_blocks', () => {
    const input = '<workstation-context>\nWorkspace: /Users/vic8or/Documents/My Workspace\n\nOpen Tabs: (none)\n\nSidebars:\n  - Left sidebar: explorer\n  - Right sidebar: pinned agents\n</workstation-context>\n<workstation-context>\n[Workspace: /Users/vic8or/Documents/My Workspace]\n</workstation-context>\n\nread an image in this workspace';
    expect(stripWorkstationContext(input)).toBe('read an image in this workspace');
  });

  test('should_return_text_unchanged_when_no_context', () => {
    expect(stripWorkstationContext('just a message')).toBe('just a message');
  });

  test('should_handle_empty_string', () => {
    expect(stripWorkstationContext('')).toBe('');
  });

  test('should_handle_null_ish_input', () => {
    expect(stripWorkstationContext(undefined as any)).toBe(undefined);
  });
});

describe('createEmptyWorkstationContext', () => {
  test('returns expected defaults', () => {
    const ctx = createEmptyWorkstationContext();
    expect(ctx.workspace).toBeNull();
    expect(ctx.tabs).toEqual({ files: [], browsers: [], emails: [] });
    expect(ctx.selection).toBeNull();
    expect(ctx.sidebars.left.isOpen).toBe(false);
    expect(ctx.sidebars.right.isOpen).toBe(false);
  });
});
