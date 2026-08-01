// Add PDF Annotations Tool
// Adds FreeText annotations at specified positions
// Uses pdfAnnotationUtils for core functionality, adds IPC event emission

import type { BuiltinToolDefinition } from '../../builtinTools';
import { emitEvent } from '../../../utils/ipcBridge';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry';
import { addAnnotationsToPdf, type AnnotationInput } from './pdfAnnotationUtils';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';

export const addAnnotationsTool: BuiltinToolDefinition = {
  name: 'add_pdf_annotations',
  description: `Add FreeText annotations to a PDF at specified positions.

Before calling this tool, inspect the PDF visually with read_image/view_image on the relevant page(s). Raw x/y coordinates are allowed, but they must come from an actual visual inspection of the PDF in this chat.

Use read_pdf(include_bboxes=true) after visual inspection when you want structured bounding boxes to help derive candidate coordinates.

Each annotation needs:
- page: Page number (1-indexed)
- x, y: Position in points from top-left of page
- text: The text to display
- width/height: Optional, auto-calculated if not provided
- fontSize: Optional, defaults to 12

Example workflow:
1. read_image/view_image on the relevant PDF page
2. Optionally call read_pdf(include_bboxes=true) for candidate positions
3. add_pdf_annotations with the final x/y coordinates`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the PDF file'
      },
      annotations: {
        type: 'array',
        description: 'Array of annotations to add',
        items: {
          type: 'object',
          properties: {
            page: {
              type: 'number',
              description: 'Page number (1-indexed)'
            },
            x: {
              type: 'number',
              description: 'X position from left edge in points'
            },
            y: {
              type: 'number',
              description: 'Y position from top edge in points'
            },
            width: {
              type: 'number',
              description: 'Width of annotation box (auto-calculated if not provided)'
            },
            height: {
              type: 'number',
              description: 'Height of annotation box (auto-calculated if not provided)'
            },
            text: {
              type: 'string',
              description: 'Text content of the annotation'
            },
            fontSize: {
              type: 'number',
              description: 'Font size in points (default: 12)'
            }
          },
          required: ['page', 'x', 'y', 'text']
        }
      }
    },
    required: ['path', 'annotations']
  },
  fileAccess: {
    mode: 'write',
    pathArg: 'path'
  },
  mode: 'write',
  fileTypes: ['.pdf'],
  handler: async (args: Record<string, any>) => {
    try {
      const inputPath = args.path as string;
      const annotations = args.annotations as AnnotationInput[];

      if (!inputPath) {
        return {
          content: [{ type: 'text', text: 'Error: File path is required' }],
          isError: true
        };
      }

      if (!annotations || annotations.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: At least one annotation is required' }],
          isError: true
        };
      }

      // Resolve path relative to workspace
      const workspace = getCurrentWorkspace();
      const filePath = resolvePathWithWorkspace(inputPath, workspace);

      // Use the utility function for core functionality
      const result = await addAnnotationsToPdf(filePath, annotations);

      if (!result.success) {
        return {
          content: [{ type: 'text', text: `Error: ${result.error}` }],
          isError: true
        };
      }

      // Emit the unified agent-edit refresh event so open viewers reload from disk.
      emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: result.resolvedPath });
      console.log('[addAnnotationsTool] Emitted FILE_REFRESHED for:', result.resolvedPath);

      let response = `Successfully modified PDF: ${result.resolvedPath}\n\n`;
      if (result.createdIds.length > 0) {
        response += `Created annotation IDs: ${result.createdIds.join(', ')}\n\n`;
      }
      response += `Results:\n`;
      for (const r of result.results) {
        response += `- ${r}\n`;
      }

      return {
        content: [{ type: 'text', text: response }],
        isError: false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add annotations';
      return {
        content: [{ type: 'text', text: `Error adding annotations: ${message}` }],
        isError: true
      };
    }
  }
};
