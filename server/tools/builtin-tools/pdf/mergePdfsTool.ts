import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools.js';
import { existsSync, mkdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { dirname, extname } from 'path';
import { PDFDocument } from 'pdf-lib';
import {
  resolvePathWithWorkspace,
} from '../../../utils/permissions.js';
import { getCurrentWorkspace } from '../../../utils/workspace.js';

export const mergePdfsTool: BuiltinToolDefinition = {
  name: 'merge_pdfs',
  description: 'Merge multiple PDF files into a single PDF file.',
  inputSchema: {
    type: 'object',
    properties: {
      input_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of PDF file paths to merge, in order.',
      },
      output_path: {
        type: 'string',
        description: 'Output path for the merged PDF file (must end with .pdf).',
      },
    },
    required: ['input_paths', 'output_path'],
  },
  fileAccess: {
    mode: 'write',
    pathArg: ['input_paths', 'output_path'],
    pathArgModes: {
      input_paths: 'read',
      output_path: 'write',
    },
  },
  mode: 'write',
  fileTypes: ['.pdf'],
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    try {
      const inputPaths = args.input_paths as unknown;
      const outputPath = args.output_path as unknown;

      if (!Array.isArray(inputPaths) || inputPaths.length < 2) {
        return {
          content: [{ type: 'text', text: 'Error: input_paths must be an array with at least 2 PDF paths' }],
          isError: true,
        };
      }

      if (!outputPath || typeof outputPath !== 'string') {
        return {
          content: [{ type: 'text', text: 'Error: output_path is required' }],
          isError: true,
        };
      }

      const workspace = context?.workspace || getCurrentWorkspace();
      const resolvedOutputPath = resolvePathWithWorkspace(outputPath, workspace);
      const resolvedInputPaths = inputPaths.map((inputPath) => resolvePathWithWorkspace(String(inputPath), workspace));

      if (extname(resolvedOutputPath).toLowerCase() !== '.pdf') {
        return {
          content: [{ type: 'text', text: 'Error: output_path must have .pdf extension' }],
          isError: true,
        };
      }

      for (const resolvedInputPath of resolvedInputPaths) {
        if (!existsSync(resolvedInputPath)) {
          return {
            content: [{ type: 'text', text: `Error: Input file not found: ${resolvedInputPath}` }],
            isError: true,
          };
        }
        if (extname(resolvedInputPath).toLowerCase() !== '.pdf') {
          return {
            content: [{ type: 'text', text: `Error: Input file must be a PDF: ${resolvedInputPath}` }],
            isError: true,
          };
        }
      }

      if (existsSync(resolvedOutputPath)) {
        return {
          content: [{ type: 'text', text: `Error: Output file already exists: ${resolvedOutputPath}` }],
          isError: true,
        };
      }

      const outputDir = dirname(resolvedOutputPath);
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      const mergedPdf = await PDFDocument.create();

      for (const resolvedInputPath of resolvedInputPaths) {
        const sourceBytes = await readFile(resolvedInputPath);
        const sourcePdf = await PDFDocument.load(sourceBytes);
        const sourcePages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        for (const page of sourcePages) {
          mergedPdf.addPage(page);
        }
      }

      const mergedBytes = await mergedPdf.save();
      await writeFile(resolvedOutputPath, mergedBytes);

      return {
        content: [{ type: 'text', text: `Merged ${resolvedInputPaths.length} PDFs into: ${resolvedOutputPath}` }],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to merge PDFs';
      return {
        content: [{ type: 'text', text: `Error merging PDFs: ${message}` }],
        isError: true,
      };
    }
  },
};
