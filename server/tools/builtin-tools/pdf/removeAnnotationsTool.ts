// Remove PDF Annotations Tool
// Removes annotations by ID (from read_pdf output)
// Uses pdfAnnotationUtils for core functionality, adds IPC event emission

import type { BuiltinToolDefinition } from '../../builtinTools';
import { emitEvent } from '../../../utils/ipcBridge';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry';
import { removeAnnotationsFromPdf } from './pdfAnnotationUtils';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';

export const removeAnnotationsTool: BuiltinToolDefinition = {
  name: 'remove_pdf_annotations',
  description: `Remove annotations from a PDF by their IDs.

Use read_pdf first to see all annotations with their IDs (e.g., "a0", "a1", "a2").
Then use this tool to remove specific annotations by ID.

Note: Form field widgets are not removed by this tool (use edit_pdf to clear form values instead).`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the PDF file'
      },
      annotationIds: {
        type: 'array',
        description: 'Array of annotation IDs to remove (e.g., ["a0", "a2"])',
        items: {
          type: 'string'
        }
      }
    },
    required: ['path', 'annotationIds']
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
      const annotationIds = args.annotationIds as string[];

      if (!inputPath) {
        return {
          content: [{ type: 'text', text: 'Error: File path is required' }],
          isError: true
        };
      }

      if (!annotationIds || annotationIds.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: At least one annotation ID is required' }],
          isError: true
        };
      }

      // Resolve path relative to workspace
      const workspace = getCurrentWorkspace();
      const filePath = resolvePathWithWorkspace(inputPath, workspace);

      // Use the utility function for core functionality
      const result = await removeAnnotationsFromPdf(filePath, annotationIds);

      if (!result.success) {
        return {
          content: [{ type: 'text', text: `Error: ${result.error}` }],
          isError: true
        };
      }

      // Emit the unified agent-edit refresh event so open viewers reload from disk.
      emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: result.resolvedPath });
      console.log('[removeAnnotationsTool] Emitted FILE_REFRESHED for:', result.resolvedPath);

      let response = `Successfully modified PDF: ${result.resolvedPath}\n\n`;
      response += `Removed ${result.removedCount} annotation(s):\n`;
      for (const r of result.results) {
        response += `- ${r}\n`;
      }

      return {
        content: [{ type: 'text', text: response }],
        isError: false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove annotations';
      return {
        content: [{ type: 'text', text: `Error removing annotations: ${message}` }],
        isError: true
      };
    }
  }
};
