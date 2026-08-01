// Create PDF Tool
// Creates PDF documents from HTML content using Chromium's print engine.
// The model writes HTML (inline styles, no external CSS) and gets a .pdf file.

import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools.js';
import { rejectIfInternalContext } from '../../../utils/contentGuard.js';
import { existsSync, mkdirSync } from 'fs';
import { writeFile, unlink, readFile } from 'fs/promises';
import { dirname, extname, join } from 'path';
import { tmpdir } from 'os';
import {
  resolvePathWithWorkspace,
} from '../../../utils/permissions.js';
import { getDestinationConflictError } from '../../../utils/outputFile.js';
import { getCurrentWorkspace } from '../../../utils/workspace.js';
import { emitEvent } from '../../../utils/ipcBridge.js';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry.js';
import {
  renderHtmlFileToPdf,
  isChromiumPdfRuntimeAvailable,
  type ChromiumPdfMargins,
  type ChromiumPdfPageSize,
} from '../../../utils/chromiumPdf.js';

const NAMED_PAGE_SIZES = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Legal', 'Letter', 'Tabloid', 'Ledger'] as const;
type NamedPageSize = (typeof NAMED_PAGE_SIZES)[number];

interface CreatePdfMarginsInput {
  top_in?: number;
  bottom_in?: number;
  left_in?: number;
  right_in?: number;
}

interface CreatePdfCustomPageSizeInput {
  width_in: number;
  height_in: number;
}

function normalizeNamedPageSize(value: string): NamedPageSize | null {
  const trimmed = value.trim();
  const found = NAMED_PAGE_SIZES.find((size) => size.toLowerCase() === trimmed.toLowerCase());
  return found ?? null;
}

function parsePageSizeInput(value: unknown): { value?: NamedPageSize | ChromiumPdfPageSize; error?: string } {
  if (value == null) return {};

  if (typeof value === 'string') {
    const normalized = normalizeNamedPageSize(value);
    if (!normalized) {
      return {
        error: `Invalid page_size "${value}". Allowed names: ${NAMED_PAGE_SIZES.join(', ')}.`,
      };
    }
    return { value: normalized };
  }

  if (typeof value === 'object') {
    const custom = value as CreatePdfCustomPageSizeInput;
    const width = custom.width_in;
    const height = custom.height_in;
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      return {
        error: 'Invalid page_size object. width_in and height_in must be positive numbers in inches.',
      };
    }
    return {
      value: { width, height },
    };
  }

  return {
    error: 'Invalid page_size. Use a named size string (e.g., "Letter", "A4") or { width_in, height_in }.',
  };
}

function parseMarginsInput(value: unknown): { value?: ChromiumPdfMargins; error?: string } {
  if (value == null) return {};
  if (typeof value !== 'object') {
    return {
      error: 'Invalid margins. Use an object with top_in/bottom_in/left_in/right_in numbers (in inches).',
    };
  }

  const raw = value as CreatePdfMarginsInput;
  const entries: Array<[keyof CreatePdfMarginsInput, keyof ChromiumPdfMargins]> = [
    ['top_in', 'top'],
    ['bottom_in', 'bottom'],
    ['left_in', 'left'],
    ['right_in', 'right'],
  ];
  const parsed: ChromiumPdfMargins = {};

  for (const [inputKey, outputKey] of entries) {
    const v = raw[inputKey];
    if (v == null) continue;
    if (!Number.isFinite(v) || v < 0) {
      return { error: `Invalid margins.${inputKey}. Must be a non-negative number in inches.` };
    }
    parsed[outputKey] = v;
  }

  return { value: Object.keys(parsed).length > 0 ? parsed : undefined };
}

function parseOrientation(value: unknown): { value?: boolean; error?: string } {
  if (value == null) return {};
  if (typeof value !== 'string') {
    return { error: 'Invalid orientation. Use "portrait" or "landscape".' };
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'portrait') return { value: false };
  if (normalized === 'landscape' || normalized === 'horizontal') return { value: true };

  return { error: 'Invalid orientation. Use "portrait" or "landscape".' };
}

function parseBooleanFlag(value: unknown, fieldName: string): { value?: boolean; error?: string } {
  if (value == null) return {};
  if (typeof value !== 'boolean') {
    return { error: `Invalid ${fieldName}. Must be true or false.` };
  }
  return { value };
}

function parseScale(value: unknown): { value?: number; error?: string } {
  if (value == null) return {};
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return { error: 'Invalid scale. Must be a positive number.' };
  }
  return { value };
}

// Convert local image path or URL to base64 data URL for embedding
async function embedImage(src: string, workspace: string | null): Promise<string | null> {
  try {
    // Already a data URL
    if (src.startsWith('data:')) {
      return src;
    }

    let buffer: Buffer;
    let mimeType: string;

    // Handle URL
    if (src.startsWith('http://') || src.startsWith('https://')) {
      console.log(`[createPdfTool] Downloading image: ${src}`);
      const response = await fetch(src, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'image/*,*/*',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        console.error(`[createPdfTool] Failed to download image: ${response.status}`);
        return null;
      }
      buffer = Buffer.from(await response.arrayBuffer());

      // Determine MIME type from Content-Type or URL
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('png')) mimeType = 'image/png';
      else if (contentType.includes('jpeg') || contentType.includes('jpg')) mimeType = 'image/jpeg';
      else if (contentType.includes('gif')) mimeType = 'image/gif';
      else if (contentType.includes('webp')) mimeType = 'image/webp';
      else if (contentType.includes('svg')) mimeType = 'image/svg+xml';
      else mimeType = getMimeTypeFromExtension(src) || 'image/png';
    }
    // Handle local file path
    else {
      const resolvedPath = resolvePathWithWorkspace(src, workspace);
      if (!existsSync(resolvedPath)) {
        console.error(`[createPdfTool] Image file not found: ${resolvedPath}`);
        return null;
      }
      buffer = await readFile(resolvedPath);
      mimeType = getMimeTypeFromExtension(src) || 'image/png';
    }

    // Convert to base64 data URL
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error(`[createPdfTool] Error embedding image:`, error);
    return null;
  }
}

function getMimeTypeFromExtension(path: string): string | null {
  const ext = path.toLowerCase().split('?')[0].split('#')[0];
  if (ext.endsWith('.png')) return 'image/png';
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'image/jpeg';
  if (ext.endsWith('.gif')) return 'image/gif';
  if (ext.endsWith('.webp')) return 'image/webp';
  if (ext.endsWith('.svg')) return 'image/svg+xml';
  if (ext.endsWith('.bmp')) return 'image/bmp';
  return null;
}

// Process HTML to embed all images as base64 data URLs
async function processHtmlImages(html: string, workspace: string | null): Promise<string> {
  // Match <img> tags with src attribute
  const imgRegex = /<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi;
  const matches: Array<{ full: string; src: string }> = [];

  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    matches.push({ full: match[0], src: match[2] });
  }

  let processedHtml = html;
  for (const { full, src } of matches) {
    // Skip if already a data URL
    if (src.startsWith('data:')) continue;

    const dataUrl = await embedImage(src, workspace);
    if (dataUrl) {
      const newTag = full.replace(src, dataUrl);
      processedHtml = processedHtml.replace(full, newTag);
      console.log(`[createPdfTool] Embedded image: ${src.substring(0, 50)}...`);
    } else {
      console.warn(`[createPdfTool] Could not embed image: ${src}`);
    }
  }

  return processedHtml;
}

export const createPdfTool: BuiltinToolDefinition = {
  name: 'create_pdf',
  description:
    'Create a new high-quality PDF document from HTML content using Chromium rendering. ' +
    'Fails if the output path already exists. ' +
    'Default paper standard is US Letter. ' +
    'Default output is Letter portrait (8.5in x 11in). ' +
    'If orientation is landscape and page_size is omitted, default is Letter landscape (11in x 8.5in). ' +
    'Use page_size explicitly for A4 or custom dimensions. ' +
    'This tool is for print-document layout, not responsive web UI. ' +
    'Use semantic HTML and print CSS: @page for paper size/margins, break-before/break-after/break-inside for pagination, and img/table/figure styles to avoid clipping. ' +
    'Avoid awkward trailing pages by controlling content flow: use break-inside: avoid on figure/table/card blocks and tune section lengths so headings are not left with only a few lines on the last page. ' +
    'Use <img src="..."> for images (absolute local paths or URLs; they are embedded automatically). Relative image paths are not supported. ' +
    'When using CSS page size in @page, set prefer_css_page_size=true. ' +
    'Note: if prefer_css_page_size=true and @page defines size, the orientation arg may be ignored by Chromium. ' +
    'For consistent color output, keep print_background=true and use print-color-adjust: exact in CSS. ' +
    'You can also use display_header_footer with header_template/footer_template for running page numbers and metadata.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Output path for the PDF file (should end with .pdf)',
      },
      content: {
        type: 'string',
        description: 'HTML content to convert. Use print CSS (e.g., @page { size: Letter; margin: 0.5in; }, break-before: page with page-break-before fallback, break-inside: avoid for tables/figures). Images are automatically embedded, but local image paths must be absolute (not relative).',
      },
      orientation: {
        type: 'string',
        enum: ['portrait', 'landscape'],
        description: 'Page orientation. Default: portrait (US Letter portrait unless page_size is set).',
      },
      page_size: {
        description: 'Paper size as a named size (A4, Letter, Legal, etc.) or custom inches { width_in, height_in }. Default: Letter.',
        oneOf: [
          {
            type: 'string',
            enum: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Legal', 'Letter', 'Tabloid', 'Ledger'],
          },
          {
            type: 'object',
            properties: {
              width_in: { type: 'number', description: 'Page width in inches.' },
              height_in: { type: 'number', description: 'Page height in inches.' },
            },
            required: ['width_in', 'height_in'],
          },
        ],
      },
      prefer_css_page_size: {
        type: 'boolean',
        description: 'Prefer @page CSS size over page_size argument. Default: false.',
      },
      print_background: {
        type: 'boolean',
        description: 'Print CSS backgrounds and images. Default: true.',
      },
      scale: {
        type: 'number',
        description: 'Print scale multiplier. Default: 1.',
      },
      margins: {
        type: 'object',
        description: 'Optional margins in inches. Usually leave unset and control margins in CSS @page.',
        properties: {
          top_in: { type: 'number', description: 'Top margin in inches.' },
          bottom_in: { type: 'number', description: 'Bottom margin in inches.' },
          left_in: { type: 'number', description: 'Left margin in inches.' },
          right_in: { type: 'number', description: 'Right margin in inches.' },
        },
      },
      display_header_footer: {
        type: 'boolean',
        description: 'Whether to enable Chromium print header/footer templates. Default: false (unless template is provided).',
      },
      header_template: {
        type: 'string',
        description: 'HTML template for print header. Supports classes: date, title, url, pageNumber, totalPages.',
      },
      footer_template: {
        type: 'string',
        description: 'HTML template for print footer. Supports classes: date, title, url, pageNumber, totalPages.',
      },
      page_ranges: {
        type: 'string',
        description: 'Optional page ranges like "1-3,5,8-10". Defaults to all pages.',
      },
    },
    required: ['path', 'content'],
  },
  fileAccess: {
    mode: 'write',
    pathArg: 'path',
  },
  mode: 'write',
  fileTypes: ['.pdf'],
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    try {
      const filePath = args.path as string;
      const htmlContent = args.content as string;

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

      const orientationResult = parseOrientation(args.orientation);
      if (orientationResult.error) {
        return {
          content: [{ type: 'text', text: `Error: ${orientationResult.error}` }],
          isError: true,
        };
      }

      const pageSizeResult = parsePageSizeInput(args.page_size);
      if (pageSizeResult.error) {
        return {
          content: [{ type: 'text', text: `Error: ${pageSizeResult.error}` }],
          isError: true,
        };
      }

      const marginsResult = parseMarginsInput(args.margins);
      if (marginsResult.error) {
        return {
          content: [{ type: 'text', text: `Error: ${marginsResult.error}` }],
          isError: true,
        };
      }

      const preferCssPageSizeResult = parseBooleanFlag(args.prefer_css_page_size, 'prefer_css_page_size');
      if (preferCssPageSizeResult.error) {
        return {
          content: [{ type: 'text', text: `Error: ${preferCssPageSizeResult.error}` }],
          isError: true,
        };
      }

      const printBackgroundResult = parseBooleanFlag(args.print_background, 'print_background');
      if (printBackgroundResult.error) {
        return {
          content: [{ type: 'text', text: `Error: ${printBackgroundResult.error}` }],
          isError: true,
        };
      }

      const displayHeaderFooterResult = parseBooleanFlag(args.display_header_footer, 'display_header_footer');
      if (displayHeaderFooterResult.error) {
        return {
          content: [{ type: 'text', text: `Error: ${displayHeaderFooterResult.error}` }],
          isError: true,
        };
      }

      const scaleResult = parseScale(args.scale);
      if (scaleResult.error) {
        return {
          content: [{ type: 'text', text: `Error: ${scaleResult.error}` }],
          isError: true,
        };
      }

      if (args.header_template != null && typeof args.header_template !== 'string') {
        return {
          content: [{ type: 'text', text: 'Error: header_template must be a string.' }],
          isError: true,
        };
      }

      if (args.footer_template != null && typeof args.footer_template !== 'string') {
        return {
          content: [{ type: 'text', text: 'Error: footer_template must be a string.' }],
          isError: true,
        };
      }

      if (args.page_ranges != null && typeof args.page_ranges !== 'string') {
        return {
          content: [{ type: 'text', text: 'Error: page_ranges must be a string like "1-3,5".' }],
          isError: true,
        };
      }

      const headerTemplate = args.header_template as string | undefined;
      const footerTemplate = args.footer_template as string | undefined;
      if (
        displayHeaderFooterResult.value === false &&
        (headerTemplate?.trim() || footerTemplate?.trim())
      ) {
        return {
          content: [{ type: 'text', text: 'Error: header_template/footer_template provided but display_header_footer is false.' }],
          isError: true,
        };
      }

      const landscape = orientationResult.value ?? false;
      const pageSize = pageSizeResult.value ?? 'Letter';
      const displayHeaderFooter =
        displayHeaderFooterResult.value ??
        !!(headerTemplate?.trim() || footerTemplate?.trim());
      const workspace = context?.workspace || getCurrentWorkspace();
      const resolvedPath = resolvePathWithWorkspace(filePath, workspace);

      const ext = extname(resolvedPath).toLowerCase();
      if (ext !== '.pdf') {
        return {
          content: [{ type: 'text', text: 'Error: Output file must have .pdf extension' }],
          isError: true,
        };
      }

      const destinationConflict = await getDestinationConflictError(resolvedPath);
      if (destinationConflict) {
        return {
          content: [{ type: 'text', text: destinationConflict }],
          isError: true,
        };
      }

      if (!isChromiumPdfRuntimeAvailable()) {
        return {
          content: [{
            type: 'text',
            text: 'Error: This tool requires Electron.',
          }],
          isError: true,
        };
      }

      // Ensure output directory exists
      const dir = dirname(resolvedPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Process HTML to embed images
      console.log('[createPdfTool] Processing HTML and embedding images...');
      const processedHtml = await processHtmlImages(htmlContent, workspace);

      // Wrap content in a full HTML document if it isn't one already
      let fullHtml = processedHtml;
      if (!processedHtml.toLowerCase().includes('<html')) {
        fullHtml = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /></head><body>${processedHtml}</body></html>`;
      }

      // Write HTML to temp file
      const tempId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const htmlRenderPath = join(tmpdir(), `chromium-html-${tempId}.html`);

      try {
        await writeFile(htmlRenderPath, fullHtml, 'utf-8');

        console.log('[createPdfTool] Rendering PDF with Chromium...');
        await renderHtmlFileToPdf(htmlRenderPath, resolvedPath, {
          timeoutMs: 120_000,
          landscape,
          pageSize,
          preferCSSPageSize: preferCssPageSizeResult.value ?? false,
          printBackground: printBackgroundResult.value ?? true,
          scale: scaleResult.value,
          margins: marginsResult.value,
          displayHeaderFooter,
          headerTemplate,
          footerTemplate,
          pageRanges: args.page_ranges as string | undefined,
        });

        if (!existsSync(resolvedPath)) {
          return {
            content: [{ type: 'text', text: 'Error: PDF generation completed but output file was not created. Check that the HTML content is valid.' }],
            isError: true,
          };
        }

        emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: resolvedPath });

        return {
          content: [{ type: 'text', text: `Created PDF at: ${resolvedPath}` }],
          isError: false,
        };
      } finally {
        try { await unlink(htmlRenderPath); } catch {}
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create PDF';
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
};
