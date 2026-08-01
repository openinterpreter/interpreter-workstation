import fs from 'node:fs';
import path from 'node:path';
import type { BuiltinToolDefinition } from '../../builtinTools';
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  executeInJsReplKernel,
  jsReplKernelKey,
} from './kernelManager';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export const jsReplTool: BuiltinToolDefinition = {
  name: 'js_repl',
  description: [
    'Run JavaScript in a persistent Node kernel with top-level await. Top-level bindings persist across calls in the same thread, so write idempotent snippets and keep long-lived state on globalThis (for example `globalThis.page ??= ...`) instead of redeclaring `let`/`const` names.',
    'Use dynamic imports (`await import("pkg")`); top-level static `import` declarations are not supported. The bundled module search path includes `playwright-core` and `interpreter-browser-control` (browser control over CDP).',
    'Helpers: `interpreter.cwd`, `interpreter.homeDir`, `interpreter.tmpDir`, and `await interpreter.emitImage(imageLike)` which saves an emitted image (data URL or `{ bytes, mimeType }`) to disk and reports its path in the result.',
    'Console output is returned as text. A failed call keeps previously completed bindings. Call js_repl_reset to clear all kernel state.',
    'Pass timeout_ms above the default for long-running operations such as browser navigation, slow network calls, or large downloads. A timed-out call keeps the kernel and bindings alive, and the timed-out code may still finish in the background.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Raw JavaScript source to evaluate in the persistent kernel. Top-level await is supported.',
      },
      timeout_ms: {
        type: 'number',
        description: `Execution timeout in milliseconds (default ${DEFAULT_EXEC_TIMEOUT_MS}, max ${MAX_EXEC_TIMEOUT_MS}). On timeout the call fails but the kernel and its bindings are preserved; only an unresponsive kernel is reset.`,
      },
    },
    required: ['code'],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
  },
  handler: async (args, context) => {
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) {
      return {
        content: [{ type: 'text', text: 'js_repl expects non-empty JavaScript source in the `code` argument.' }],
        isError: true,
      };
    }
    const timeoutMs = typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)
      ? args.timeout_ms
      : undefined;

    const workspace = context?.workspace;
    if (!workspace) {
      return {
        content: [{ type: 'text', text: 'js_repl requires an active workspace; no workspace is set for this agent.' }],
        isError: true,
      };
    }

    try {
      const result = await executeInJsReplKernel({
        key: jsReplKernelKey(context),
        cwd: workspace,
        code,
        timeoutMs,
      });
      // Emitted images ride along as image content items plus imagePaths, like
      // the cua-driver screenshots: direct transports get image data, the CLI
      // text transport swaps each image item for its saved-path notice.
      const imageItems = result.imagePaths.map((imagePath) => ({
        type: 'image',
        data: fs.readFileSync(imagePath).toString('base64'),
        mimeType: IMAGE_MIME_BY_EXTENSION[path.extname(imagePath).toLowerCase()] ?? 'image/png',
      }));
      return {
        content: [
          {
            type: 'text',
            text: result.output.length > 0 ? result.output : '(js_repl finished with no console output)',
          },
          ...imageItems,
        ],
        isError: false,
        ...(result.imagePaths.length > 0 ? { imagePaths: result.imagePaths } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
      };
    }
  },
};
