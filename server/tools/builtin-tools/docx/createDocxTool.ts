// Create DOCX Tool
// Creates a Word document from HTML content using x2t.
// The model writes HTML (inline styles, no external CSS) and gets a .docx file.

import type { BuiltinToolDefinition } from '../../builtinTools.js';
import { existsSync, mkdirSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { execFile } from 'child_process';
import { dirname, extname, join } from 'path';
import { tmpdir } from 'os';
import { resolvePathWithWorkspace } from '../../../utils/permissions.js';
import { getDestinationConflictError } from '../../../utils/outputFile.js';
import { getCurrentWorkspace } from '../../../utils/workspace.js';
import { emitEvent } from '../../../utils/ipcBridge.js';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry.js';
import { getX2tPaths, type X2tPaths } from '../x2tPaths.js';
import { rejectIfInternalContext } from '../../../utils/contentGuard.js';

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function execFileAsync(
  binary: string,
  args: string[],
  options: { timeout?: number; cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
    });
  });
}

export const createDocxTool: BuiltinToolDefinition = {
  name: 'create_docx',
  description:
    'Create a new Word document (.docx) from HTML content. ' +
    'Use overwrite=true to replace an existing file at the same path; otherwise the tool fails if the output already exists. ' +
    'Use inline styles on every element for formatting that survives conversion. ' +
    'Supported styles: font-family, font-size, font-weight, color, background-color, ' +
    'text-align, text-indent, line-height, margin-left, margin-right, margin-top, margin-bottom. ' +
    'Use <b>, <i>, <u> tags for bold/italic/underline. ' +
    'Use <table>, <tr>, <td> for tables. Use <img> with base64 src for images.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Output path for the Word file (should end with .docx)',
      },
      content: {
        type: 'string',
        description: 'HTML content to convert. Use inline styles for formatting.',
      },
      overwrite: {
        type: 'boolean',
        description:
          'Whether to replace an existing file at the target path. Defaults to false.',
      },
    },
    required: ['path', 'content'],
  },
  fileAccess: {
    mode: 'write',
    pathArg: 'path',
  },
  mode: 'write',
  fileTypes: ['.docx'],
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async (args: Record<string, any>, context) => {
    try {
      const filePath = args.path as string;
      const htmlContent = args.content as string;
      const overwrite = args.overwrite === true;
      const workspace = context?.workspace || getCurrentWorkspace();
      const resolvedPath = resolvePathWithWorkspace(filePath, workspace);

      if (!filePath) {
        return {
          content: [{ type: 'text', text: 'Error: path is required' }],
          isError: true,
        };
      }

      if (!htmlContent) {
        return {
          content: [{ type: 'text', text: 'Error: content is required' }],
          isError: true,
        };
      }

      const contextRejection = rejectIfInternalContext(htmlContent);
      if (contextRejection) return contextRejection;

      const ext = extname(resolvedPath).toLowerCase();
      if (ext !== '.docx') {
        return {
          content: [{ type: 'text', text: 'Error: Output file must have .docx extension' }],
          isError: true,
        };
      }

      const destinationConflict = overwrite ? null : await getDestinationConflictError(resolvedPath);
      if (destinationConflict) {
        return {
          content: [{ type: 'text', text: destinationConflict }],
          isError: true,
        };
      }

      // Check x2t binary
      let paths: X2tPaths;
      try {
        paths = getX2tPaths();
      } catch {
        return {
          content: [{ type: 'text', text: 'Error: This tool requires Electron.' }],
          isError: true,
        };
      }

      if (!existsSync(paths.x2tBinary)) {
        return {
          content: [{
            type: 'text',
            text: 'OfficeExtension editors are not installed. Install the OfficeExtension extension to enable document creation.',
          }],
          isError: true,
        };
      }

      // Ensure output directory exists
      const dir = dirname(resolvedPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Wrap content in a full HTML document if it isn't one already
      let fullHtml = htmlContent;
      if (!htmlContent.toLowerCase().includes('<html')) {
        fullHtml = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /></head><body>${htmlContent}</body></html>`;
      }

      // Write HTML to temp file
      const tempId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const htmlPath = join(tmpdir(), `x2t-html-${tempId}.html`);
      const paramsPath = join(tmpdir(), `x2t-params-${tempId}.xml`);

      try {
        await writeFile(htmlPath, fullHtml, 'utf-8');

        // Build x2t params XML — format code 65 = docx
        const paramsXml = `<?xml version="1.0" encoding="utf-8"?>
<TaskQueueDataConvert>
  <m_sFileFrom>${escapeXml(htmlPath)}</m_sFileFrom>
  <m_sFileTo>${escapeXml(resolvedPath)}</m_sFileTo>
  <m_nFormatTo>65</m_nFormatTo>
  <m_sThemeDir>${escapeXml(paths.themesDir)}</m_sThemeDir>
  <m_sAllFontsPath>${escapeXml(paths.allFontsPath)}</m_sAllFontsPath>
  <m_sFontDir>${escapeXml(paths.systemFontsDir)}</m_sFontDir>
  <m_bDontSaveAdditional>true</m_bDontSaveAdditional>
</TaskQueueDataConvert>`;

        await writeFile(paramsPath, paramsXml, 'utf-8');

        // Run x2t
        await execFileAsync(paths.x2tBinary, [paramsPath], { timeout: 60_000, cwd: tmpdir() });

        if (!existsSync(resolvedPath)) {
          return {
            content: [{ type: 'text', text: 'Error: x2t conversion completed but output file was not created. Check that the HTML content is valid.' }],
            isError: true,
          };
        }

        emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: resolvedPath });

        return {
          content: [{ type: 'text', text: `Created document at: ${resolvedPath}` }],
          isError: false,
        };
      } finally {
        try { await unlink(htmlPath); } catch {}
        try { await unlink(paramsPath); } catch {}
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create document';
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
};
