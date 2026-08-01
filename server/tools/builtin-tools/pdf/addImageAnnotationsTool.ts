// Add PDF Image Annotations Tool
// Adds image annotations (stamps) at specified positions
// Uses pdfAnnotationUtils for core functionality, adds IPC event emission

import type { BuiltinToolDefinition } from '../../builtinTools';
import { emitEvent } from '../../../utils/ipcBridge';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry';
import { addImageAnnotationsToPdf, type ImageAnnotationInput } from './pdfAnnotationUtils';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';

export const addImageAnnotationsTool: BuiltinToolDefinition = {
  name: 'add_pdf_image_annotations',
  description: `Add image annotations to a PDF at specified positions.

Places images as stamp annotations that can be moved, resized, and removed.

Before calling this tool, inspect the PDF visually with read_image/view_image on the relevant page(s). Raw x/y coordinates are allowed, but they must come from an actual visual inspection of the PDF in this chat.

Each image annotation needs:
- page: Page number (1-indexed)
- x, y: Position in points from top-left of page
- width, height: Size of the image on the page
- imagePath: Path to the image file (PNG, JPG, or SVG)

Supported formats: PNG, JPG/JPEG, SVG (SVG files are automatically converted to PNG)

Example:
{
  "path": "document.pdf",
  "annotations": [
    {
      "page": 1,
      "x": 50,
      "y": 100,
      "width": 200,
      "height": 150,
      "imagePath": "logo.png"
    }
  ]
}`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the PDF file'
      },
      annotations: {
        type: 'array',
        description: 'Array of image annotations to add',
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
              description: 'Width of the image on the page in points'
            },
            height: {
              type: 'number',
              description: 'Height of the image on the page in points'
            },
            imagePath: {
              type: 'string',
              description: 'Path to the image file (PNG, JPG, or SVG)'
            }
          },
          required: ['page', 'x', 'y', 'width', 'height', 'imagePath']
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
      const annotations = args.annotations as ImageAnnotationInput[];

      if (!inputPath) {
        return {
          content: [{ type: 'text', text: 'Error: File path is required' }],
          isError: true
        };
      }

      if (!annotations || annotations.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: At least one image annotation is required' }],
          isError: true
        };
      }

      // Resolve paths relative to workspace
      const workspace = getCurrentWorkspace();
      const filePath = resolvePathWithWorkspace(inputPath, workspace);

      // Resolve image paths as well
      const resolvedAnnotations = annotations.map(annot => ({
        ...annot,
        imagePath: resolvePathWithWorkspace(annot.imagePath, workspace)
      }));

      // Use the utility function for core functionality
      const result = await addImageAnnotationsToPdf(filePath, resolvedAnnotations, workspace || undefined);

      if (!result.success) {
        return {
          content: [{ type: 'text', text: `Error: ${result.error}` }],
          isError: true
        };
      }

      // Emit the unified agent-edit refresh event so open viewers reload from disk.
      emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: result.resolvedPath });
      console.log('[addImageAnnotationsTool] Emitted FILE_REFRESHED for:', result.resolvedPath);

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
      const message = error instanceof Error ? error.message : 'Failed to add image annotations';
      return {
        content: [{ type: 'text', text: `Error adding image annotations: ${message}` }],
        isError: true
      };
    }
  }
};
