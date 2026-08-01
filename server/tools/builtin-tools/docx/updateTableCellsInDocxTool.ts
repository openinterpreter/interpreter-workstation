import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools.js';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolvePathWithWorkspace } from '../../../utils/permissions.js';
import { getCurrentWorkspace } from '../../../utils/workspace.js';
import { emitEvent } from '../../../utils/ipcBridge.js';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry.js';
import { extractDocxToFolder, getExtractedFolderPath, repackageDocxFromFolder } from './ooxmlPackage.js';
import {
  buildTableCellXml,
  extractCellParagraphTemplate,
  replaceTableCellInDocument,
  selectTable,
} from './documentStructure.js';

interface RawCellUpdate {
  row_index?: unknown;
  column_index?: unknown;
  text?: unknown;
}

interface CellUpdate {
  rowIndex: number;
  columnIndex: number;
  text: string;
}

function normalizeTableIndex(input: unknown): number {
  if (!Number.isInteger(input) || (input as number) < 1) {
    throw new Error('table_index must be an integer >= 1');
  }
  return input as number;
}

function normalizeCellUpdates(input: unknown): CellUpdate[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('cells must be a non-empty array');
  }

  const seen = new Set<string>();
  return input.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Cell update ${index + 1} must be an object`);
    }

    const raw = item as RawCellUpdate;
    if (!Number.isInteger(raw.row_index) || (raw.row_index as number) < 1) {
      throw new Error(`cells[${index}].row_index must be an integer >= 1`);
    }
    if (!Number.isInteger(raw.column_index) || (raw.column_index as number) < 1) {
      throw new Error(`cells[${index}].column_index must be an integer >= 1`);
    }
    if (typeof raw.text !== 'string') {
      throw new Error(`cells[${index}].text must be a string`);
    }

    const key = `${raw.row_index}:${raw.column_index}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate cell update for row ${raw.row_index}, column ${raw.column_index}`);
    }
    seen.add(key);

    return {
      rowIndex: raw.row_index as number,
      columnIndex: raw.column_index as number,
      text: raw.text,
    };
  });
}

export const updateTableCellsInDocxTool: BuiltinToolDefinition = {
  name: 'update_table_cells_in_docx',
  description:
    'Update one or more existing table cells inside a Word document (.docx). ' +
    'Targets a specific table by document order and preserves the surrounding table/cell formatting while replacing the targeted cell text.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the source Word document (.docx).',
      },
      output_path: {
        type: 'string',
        description: 'Optional output .docx path. If omitted, edits the source file in place.',
      },
      table_index: {
        type: 'number',
        description: '1-based table number in document order.',
      },
      cells: {
        type: 'array',
        description: 'Cell updates to apply. Use row_index/column_index values within the selected table.',
        items: {
          type: 'object',
          properties: {
            row_index: {
              type: 'number',
              description: '1-based row index inside the selected table.',
            },
            column_index: {
              type: 'number',
              description: '1-based column index inside the selected table.',
            },
            text: {
              type: 'string',
              description: 'Replacement visible cell text. Use \\n for line breaks inside the cell.',
            },
          },
          required: ['row_index', 'column_index', 'text'],
          additionalProperties: false,
        },
      },
      inherit_formatting: {
        type: 'boolean',
        description: 'Whether to inherit paragraph/run formatting from each replaced cell. Defaults to true.',
      },
    },
    required: ['path', 'table_index', 'cells'],
  },
  fileAccess: {
    mode: 'write',
    pathArg: ['path', 'output_path'],
    pathArgModes: {
      path: 'read',
      output_path: 'write',
    },
  },
  mode: 'write',
  fileTypes: ['.docx'],
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args: Record<string, unknown>, context?: BuiltinToolContext) => {
    let extractionRoot: string | null = null;

    try {
      const inputPath = typeof args.path === 'string' ? args.path : '';
      if (!inputPath) {
        return {
          content: [{ type: 'text', text: 'Error: path is required' }],
          isError: true,
        };
      }

      const tableIndex = normalizeTableIndex(args.table_index);
      const cellUpdates = normalizeCellUpdates(args.cells);
      const inheritFormatting = typeof args.inherit_formatting === 'boolean'
        ? args.inherit_formatting
        : true;
      const workspace = context?.workspace || getCurrentWorkspace();
      const resolvedInputPath = resolvePathWithWorkspace(inputPath, workspace);
      const rawOutputPath = typeof args.output_path === 'string' && args.output_path.trim().length > 0
        ? args.output_path
        : inputPath;
      const resolvedOutputPath = resolvePathWithWorkspace(rawOutputPath, workspace);

      if (path.extname(resolvedInputPath).toLowerCase() !== '.docx') {
        return {
          content: [{ type: 'text', text: 'Error: path must reference a .docx file' }],
          isError: true,
        };
      }

      if (path.extname(resolvedOutputPath).toLowerCase() !== '.docx') {
        return {
          content: [{ type: 'text', text: 'Error: output_path must end with .docx when provided' }],
          isError: true,
        };
      }

      if (!existsSync(resolvedInputPath)) {
        return {
          content: [{ type: 'text', text: `Error: File not found: ${resolvedInputPath}` }],
          isError: true,
        };
      }

      extractionRoot = await mkdtemp(path.join(tmpdir(), 'docx-update-table-cells-'));
      const extractedFolder = getExtractedFolderPath(resolvedInputPath, extractionRoot);
      await extractDocxToFolder(resolvedInputPath, extractedFolder, false);

      const documentXmlPath = path.join(extractedFolder, 'word', 'document.xml');
      if (!existsSync(documentXmlPath)) {
        throw new Error('Invalid DOCX package: missing word/document.xml');
      }

      let documentXml = await readFile(documentXmlPath, 'utf-8');
      const table = selectTable(documentXml, tableIndex);
      const replacements = cellUpdates.map((update) => {
        const row = table.rows[update.rowIndex - 1];
        if (!row) {
          throw new Error(`Table ${tableIndex} does not have row ${update.rowIndex}.`);
        }
        const cell = row.cells[update.columnIndex - 1];
        if (!cell) {
          throw new Error(`Table ${tableIndex} row ${update.rowIndex} does not have column ${update.columnIndex}.`);
        }
        const template = inheritFormatting ? extractCellParagraphTemplate(cell) : undefined;
        return {
          cell,
          replacementXml: buildTableCellXml(cell, update.text, template),
        };
      }).sort((a, b) => b.cell.start - a.cell.start);

      for (const replacement of replacements) {
        documentXml = replaceTableCellInDocument(documentXml, replacement.cell, replacement.replacementXml);
      }

      await writeFile(documentXmlPath, documentXml, 'utf-8');
      await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
      await repackageDocxFromFolder(extractedFolder, resolvedOutputPath);

      if (!existsSync(resolvedOutputPath)) {
        throw new Error(`Output DOCX was not created at ${resolvedOutputPath}`);
      }

      await emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: resolvedOutputPath });

      return {
        content: [{
          type: 'text',
          text: [
            `Updated DOCX table cells: ${resolvedOutputPath}`,
            '',
            `Table index: ${tableIndex}`,
            `Cells updated: ${cellUpdates.length}`,
            `Formatting inherited: ${inheritFormatting ? 'yes' : 'no'}`,
          ].join('\n'),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error updating DOCX table cells: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    } finally {
      if (extractionRoot) {
        await rm(extractionRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  },
};
