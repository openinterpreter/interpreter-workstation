// Read PDF Tool
// Returns structured representation of PDF with text, annotations, and form fields
// Elements are interleaved by spatial position (top-to-bottom, left-to-right)

import type { BuiltinToolDefinition } from '../../builtinTools';
import { existsSync } from 'fs';
import { extname, basename } from 'path';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';
import { readPdfStructure } from '../../../utils/pdfStructure';

export const readPdfTool: BuiltinToolDefinition = {
  name: 'read_pdf',
  description: `Read a PDF file. This is the tool to use for reading any .pdf file — do NOT use the Read tool for PDFs.

Returns text and interactive elements in reading order (top-to-bottom, left-to-right).

By default returns a slim, token-efficient format:
- Text content (no IDs, just the text)
- Form fields: [f0] "fieldName" (type): value
- Annotations: [a0] type: "contents"

Field IDs (f0, f1...) follow the PDF's internal order, NOT visual order. Always match by field name.

Set include_bboxes=true for JSON with bounding boxes — use when you need position data for add_pdf_annotations.

Workflow for filling PDF forms:
1. read_pdf → get text and [fN] form field IDs in reading order
2. If few fields and the mapping is clear, go ahead and fill with fill_pdf_form
3. If many fields or the layout is complex, call read_pdf(include_bboxes=true) and cross-check field names against nearby text before filling.
4. If the mapping is still ambiguous after inspecting the structure, ask for clarification before filling.

Workflow for adding annotations:
1. read_pdf(include_bboxes=true) → JSON with bounding box positions
2. add_pdf_annotations using the coordinates from the JSON`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the PDF file'
      },
      page: {
        type: 'number',
        description: 'Specific page to inspect (1-indexed). If omitted, inspects all pages.'
      },
      include_bboxes: {
        type: 'boolean',
        description: 'If true, returns JSON with bounding boxes for all elements. Use this when you need position data for adding annotations.'
      }
    },
    required: ['path']
  },
  fileAccess: {
    mode: 'read',
    pathArg: 'path'
  },
  mode: 'read',
  fileTypes: ['.pdf'],
  handler: async (args: Record<string, any>) => {
    try {
      const filePath = args.path as string;
      const specificPage = args.page as number | undefined;
      const includeBboxes = args.include_bboxes as boolean | undefined;

      if (!filePath) {
        return {
          content: [{ type: 'text', text: 'Error: File path is required' }],
          isError: true
        };
      }

      // Resolve path relative to workspace
      const workspace = getCurrentWorkspace();
      const resolvedPath = resolvePathWithWorkspace(filePath, workspace);

      if (!existsSync(resolvedPath)) {
        return {
          content: [{ type: 'text', text: `Error: File not found: ${resolvedPath}` }],
          isError: true
        };
      }

      const ext = extname(resolvedPath).toLowerCase();
      if (ext !== '.pdf') {
        return {
          content: [{ type: 'text', text: 'Error: Only .pdf files are supported' }],
          isError: true
        };
      }

      const structure = await readPdfStructure(resolvedPath, specificPage);

      // When a specific page is requested, also get the total form field count
      // across ALL pages so the caller knows fields exist even if this page has none.
      let totalFormFieldCount = 0;
      if (specificPage) {
        const fullStructure = await readPdfStructure(resolvedPath);
        totalFormFieldCount = fullStructure.elements.filter(e => e.type === 'formField').length;
      }

      // Group by page
      const byPage = new Map<number, typeof structure.elements>();
      for (const el of structure.elements) {
        if (!byPage.has(el.page)) byPage.set(el.page, []);
        byPage.get(el.page)!.push(el);
      }

      const pageFormFieldCount = structure.elements.filter(e => e.type === 'formField').length;

      let response: string;

      if (includeBboxes) {
        // JSON mode with bounding boxes — for annotation positioning
        // When a specific page is requested, only include that page's info
        // to avoid sending 50+ page entries the caller doesn't need.
        const output = specificPage
          ? { ...structure, pages: structure.pages.filter(p => p.number === specificPage) }
          : structure;
        response = JSON.stringify(output, null, 2);
      } else {
        // Slim default: text + form fields + annotations in reading order, no coordinates
        response = `# ${basename(resolvedPath)} (${structure.pages.length} page${structure.pages.length > 1 ? 's' : ''})\n`;

        for (const [pageNum, elements] of byPage) {
          if (structure.pages.length > 1) {
            response += `\n## Page ${pageNum}\n\n`;
          } else {
            response += '\n';
          }

          for (const el of elements) {
            if (el.type === 'text') {
              response += `${el.text}\n`;
            } else if (el.type === 'annotation') {
              response += `[${el.id}] ${el.annotationType}: "${el.contents}"\n`;
            } else if (el.type === 'formField') {
              const val = typeof el.fieldValue === 'boolean' ? el.fieldValue : (el.fieldValue || '(empty)');
              response += `[${el.id}] "${el.fieldName}" (${el.fieldType}): ${val}\n`;
            }
          }
        }

        // When viewing a specific page, tell the caller about form fields on other pages
        if (specificPage && pageFormFieldCount === 0 && totalFormFieldCount > 0) {
          response += `\n⚠️ This page has 0 form fields, but the PDF has ${totalFormFieldCount} form fields on other pages. Call read_pdf without the page parameter to see all form fields.\n`;
        } else if (specificPage && totalFormFieldCount > pageFormFieldCount) {
          response += `\n📋 This page has ${pageFormFieldCount} form fields. The PDF has ${totalFormFieldCount} total form fields across all pages.\n`;
        }
      }

      return {
        content: [{ type: 'text', text: response }],
        isError: false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to inspect PDF';
      return {
        content: [{ type: 'text', text: `Error inspecting PDF: ${message}` }],
        isError: true
      };
    }
  }
};
