// Convert File Tool
// Converts documents between formats using the configured document engine.

import type { BuiltinToolDefinition } from '../../builtinTools.js';
import { existsSync } from 'fs';
import { writeFile, unlink, access } from 'fs/promises';
import { execFile } from 'child_process';
import { extname, dirname, basename, join } from 'path';
import { tmpdir } from 'os';
import { resolvePathWithWorkspace } from '../../../utils/permissions.js';
import { getCurrentWorkspace } from '../../../utils/workspace';
import { emitEvent } from '../../../utils/ipcBridge';
import { renderHtmlFileToPdf } from '../../../utils/chromiumPdf.js';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry';
import {
  X2T_CONVERTIBLE_FORMATS,
  getPathExtension,
} from '../../../../shared/utils/converterFormats.js';
import { getX2tPaths, type X2tPaths } from '../x2tPaths.js';
import { isOoEditorsInstalled } from '../../../../electron/services/office-extension';

// x2t output format codes — verified by testing against the binary
const FORMAT_CODES: Record<string, number> = {
  // Documents
  docx: 65,
  odt: 67,
  rtf: 68,
  txt: 69,
  html: 70,
  epub: 72,
  fb2: 73,
  // Spreadsheets
  xlsx: 257,
  ods: 259,
  csv: 260,
  // Presentations
  pptx: 129,
  odp: 131,
  // Universal
  pdf: 513,
};

const SUPPORTED_TARGET_FORMATS = Object.keys(FORMAT_CODES);

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildParamsXml(
  inputPath: string,
  outputPath: string,
  formatCode: number,
  paths: X2tPaths
): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <m_sFileFrom>${escapeXml(inputPath)}</m_sFileFrom>
  <m_sFileTo>${escapeXml(outputPath)}</m_sFileTo>
  <m_nFormatTo>${formatCode}</m_nFormatTo>
  <m_sThemeDir>${escapeXml(paths.themesDir)}</m_sThemeDir>
  <m_sAllFontsPath>${escapeXml(paths.allFontsPath)}</m_sAllFontsPath>
  <m_sFontDir>${escapeXml(paths.systemFontsDir)}</m_sFontDir>
  <m_bDontSaveAdditional>true</m_bDontSaveAdditional>
</TaskQueueDataConvert>`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getUniqueOutputPath(dir: string, baseName: string, ext: string): Promise<string> {
  let outputPath = join(dir, `${baseName}.${ext}`);
  let counter = 1;
  while (await fileExists(outputPath)) {
    outputPath = join(dir, `${baseName} (${counter}).${ext}`);
    counter++;
  }
  return outputPath;
}

function execFileAsync(
  binary: string,
  args: string[],
  options: { timeout?: number; signal?: AbortSignal; cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
    });
  });
}

export const convertFileTool: BuiltinToolDefinition = {
  name: 'convert_file',
  description:
    'Convert a file between formats. ' +
    'HTML/HTM to PDF uses Chromium rendering. ' +
    'Documents: doc, docx, odt, rtf, txt, html, htm, epub, fb2. ' +
    'Spreadsheets: xls, xlsx, xlsm, xlsb, xltx, xltm, ods, csv, tsv, fods. ' +
    'Presentations: ppt, pptx, odp, fodp. ' +
    'All can convert to PDF. Documents can convert between document formats. ' +
    'Spreadsheets can convert between spreadsheet formats. Same for presentations.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the input file (absolute or workspace-relative)',
      },
      format: {
        type: 'string',
        description: 'Target format to convert to',
        enum: [
          'docx', 'xlsx', 'pptx', 'pdf', 'odt', 'ods', 'csv', 'rtf', 'txt', 'html', 'epub', 'fb2', 'odp',
          'xls'
        ],
      },
      output_path: {
        type: 'string',
        description:
          'Optional output file path. Defaults to the same directory and name with the new extension.',
      },
    },
    required: ['path', 'format'],
  },
  fileAccess: {
    mode: 'write',
    pathArg: ['path', 'output_path'],
  },
  mode: 'write',
  fileTypes: [
    '.doc', '.docx', '.odt', '.rtf', '.txt', '.html', '.htm', '.epub', '.fb2',
    '.xls', '.xlsx', '.xlsm', '.xlsb', '.xltx', '.xltm', '.ods', '.csv', '.tsv', '.fods',
    '.ppt', '.pptx', '.odp', '.fodp',
  ],
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async (args: Record<string, any>) => {
    try {
      const inputPath = args.path as string;
      const formatRaw = args.format as string;
      const outputPathArg = args.output_path as string | undefined;

      if (!inputPath) {
        return {
          content: [{ type: 'text', text: 'Error: File path is required' }],
          isError: true,
        };
      }

      const format = (formatRaw || '').toLowerCase();
      if (!format || !SUPPORTED_TARGET_FORMATS.includes(format)) {
        return {
          content: [{ type: 'text', text: `Error: Unsupported target format "${formatRaw}". Supported: ${SUPPORTED_TARGET_FORMATS.join(', ')}` }],
          isError: true,
        };
      }

      // Resolve input path
      const workspace = getCurrentWorkspace();
      const resolvedInput = resolvePathWithWorkspace(inputPath, workspace);

      if (!existsSync(resolvedInput)) {
        return {
          content: [{ type: 'text', text: `Error: File not found: ${resolvedInput}` }],
          isError: true,
        };
      }

      // Validate conversion is allowed
      const inputExt = getPathExtension(resolvedInput) || extname(resolvedInput).toLowerCase();

      // Determine output path
      let resolvedOutput: string;
      if (outputPathArg) {
        resolvedOutput = resolvePathWithWorkspace(outputPathArg, workspace);
      } else {
        const dir = dirname(resolvedInput);
        const base = basename(resolvedInput, inputExt);
        resolvedOutput = await getUniqueOutputPath(dir, base, format);
      }

      // Document-engine path.
      const allowed = X2T_CONVERTIBLE_FORMATS[inputExt];
      if (!allowed) {
        return {
          content: [{ type: 'text', text: `Error: Input format "${inputExt}" is not supported for conversion.` }],
          isError: true,
        };
      }

      if (!allowed.includes(format)) {
        return {
          content: [{
            type: 'text',
            text: `Error: Cannot convert ${inputExt} to ${format}. Allowed targets for ${inputExt}: ${allowed.join(', ')}`,
          }],
          isError: true,
        };
      }

      // Route HTML -> PDF through Chromium so visual output matches browser rendering.
      if ((inputExt === '.html' || inputExt === '.htm') && format === 'pdf') {
        try {
          await renderHtmlFileToPdf(resolvedInput, resolvedOutput);
          emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: resolvedOutput });

          return {
            content: [{
              type: 'text',
              text: `Successfully converted ${inputExt} to ${format}.\nOutput: ${resolvedOutput}`,
            }],
            isError: false,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text', text: `Error converting file: ${message}` }],
            isError: true,
          };
        }
      }

      // Check x2t binary exists
      let paths: X2tPaths;
      try {
        paths = getX2tPaths();
      } catch {
        return {
          content: [{ type: 'text', text: 'Error: This tool must be running in the app environment.' }],
          isError: true,
        };
      }

      if (!existsSync(paths.x2tBinary)) {
        const installed = isOoEditorsInstalled();
        let text = installed
          ? 'Error: OfficeExtension is installed but the converter binary (x2t) is missing. The installation may be incomplete or corrupt — reinstall the OfficeExtension to fix this.'
          : 'Error: OfficeExtension is not installed. The document converter requires OfficeExtension. It installs automatically on first launch — if it was recently triggered, wait for installation to complete.';
        if (inputExt === '.docx') {
          text += `\nTo read this document without conversion, use read_word(path="${inputPath}") or read_docx(path="${inputPath}"). These tools do not require OfficeExtension.`;
        } else if (inputExt === '.pdf') {
          text += `\nTo read this PDF without conversion, use read_pdf(path="${inputPath}"). This tool does not require OfficeExtension.`;
        }
        text += '\nDo not retry this conversion until the OfficeExtension is fully installed.';
        return {
          content: [{ type: 'text', text }],
          isError: true,
        };
      }

      const formatCode = FORMAT_CODES[format];
      if (!formatCode) {
        return {
          content: [{ type: 'text', text: `Error: OfficeExtension does not support target format "${format}".` }],
          isError: true,
        };
      }

      const paramsXml = buildParamsXml(resolvedInput, resolvedOutput, formatCode, paths);
      const paramsPath = join(tmpdir(), `x2t-params-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);

      try {
        await writeFile(paramsPath, paramsXml, 'utf-8');

        // Spawn x2t
        await execFileAsync(paths.x2tBinary, [paramsPath], {
          timeout: 60_000,
          cwd: tmpdir(),
        });

        // Verify output was created
        if (!existsSync(resolvedOutput)) {
          return {
            content: [{ type: 'text', text: 'Error: Conversion completed but output file was not created. The x2t converter may not support this specific conversion.' }],
            isError: true,
          };
        }

        emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: resolvedOutput });

        return {
          content: [{
            type: 'text',
            text: `Successfully converted ${inputExt} to ${format}.\nOutput: ${resolvedOutput}`,
          }],
          isError: false,
        };
      } finally {
        // Clean up temp params file
        try {
          await unlink(paramsPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (error) {
      // NOTE(victor): Node child_process ExecFileException carries exit code,
      // stderr, and kill state. Parse these for actionable agent guidance
      // instead of the opaque "Command failed: ..." default.
      const exitCode = error instanceof Error && typeof (error as any).code === 'number'
        ? (error as any).code as number
        : null;
      const killed = error instanceof Error && (error as any).killed === true;

      if (exitCode !== null || killed) {
        const stderr = ((error as any).stderr ?? '').toString().trim();
        const installed = isOoEditorsInstalled();
        let text = killed
          ? 'Error: Document conversion timed out (converter killed after 60s).'
          : `Error: Document conversion failed (converter exit code ${exitCode}).`;
        if (stderr) {
          text += `\nConverter stderr: ${stderr}`;
        }
        if (!installed) {
          text += '\nOfficeExtension is not installed. The converter binary existed at check time but the installation is incomplete. Wait for OfficeExtension to finish installing.';
        } else {
          text += '\nOfficeExtension is installed but the converter crashed. The binary may be corrupt, or the input file format may be unsupported by the converter.';
        }
        const filePath = args.path as string;
        const ext = extname(filePath || '').toLowerCase();
        if (ext === '.docx') {
          text += `\nTo read this document without conversion, use read_word(path="${filePath}") or read_docx(path="${filePath}"). These tools do not require OfficeExtension.`;
        } else if (ext === '.pdf') {
          text += `\nTo read this PDF without conversion, use read_pdf(path="${filePath}"). This tool does not require OfficeExtension.`;
        }
        text += '\nDo not retry the same conversion.';
        return {
          content: [{ type: 'text', text }],
          isError: true,
        };
      }

      const message = error instanceof Error ? error.message : 'Unknown conversion error';
      return {
        content: [{ type: 'text', text: `Error converting file: ${message}` }],
        isError: true,
      };
    }
  },
};
