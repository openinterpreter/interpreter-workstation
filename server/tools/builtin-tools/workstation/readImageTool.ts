import { readFile, stat } from 'node:fs/promises';

import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';
import { runVisionViaCodex } from '../../../utils/visionModelProvider';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function isSupportedImage(buffer: Buffer): boolean {
  return (
    (buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4e
      && buffer[3] === 0x47)
    || (buffer[0] === 0xff && buffer[1] === 0xd8)
    || (buffer[0] === 0x47
      && buffer[1] === 0x49
      && buffer[2] === 0x46
      && buffer[3] === 0x38)
    || (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP')
  );
}

export const readImageTool: BuiltinToolDefinition = {
  name: 'read_image',
  description:
    'Analyze a permission-scoped local PNG, JPEG, GIF, or WebP image with the profile’s configured vision model (or its main model when no vision override is configured).',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to an image.',
      },
      prompt: {
        type: 'string',
        description:
          'What to inspect or extract from the image. Defaults to a detailed visual description.',
      },
    },
    required: ['path'],
  },
  fileAccess: {
    mode: 'read',
    pathArg: 'path',
  },
  mode: 'read',
  fileTypes: ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (args: Record<string, unknown>, context?: BuiltinToolContext) => {
    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rawPath) {
      return {
        content: [{ type: 'text', text: 'Missing required parameter: path' }],
        isError: true,
      };
    }
    if (!context?.modelConfig) {
      return {
        content: [{
          type: 'text',
          text: 'read_image requires the calling agent model configuration.',
        }],
        isError: true,
      };
    }

    try {
      const workspace = context.workspace ?? getCurrentWorkspace();
      const resolvedPath = resolvePathWithWorkspace(rawPath, workspace);
      const metadata = await stat(resolvedPath);
      if (!metadata.isFile()) {
        throw new Error(`Not a file: ${resolvedPath}`);
      }
      if (metadata.size > MAX_IMAGE_BYTES) {
        throw new Error(
          `Image is too large (${metadata.size} bytes); maximum is ${MAX_IMAGE_BYTES} bytes.`,
        );
      }

      const image = await readFile(resolvedPath);
      if (!isSupportedImage(image)) {
        throw new Error('Unsupported image format. Use PNG, JPEG, GIF, or WebP.');
      }

      const modelConfig = context.modelConfig.visionModel ?? context.modelConfig;
      const prompt =
        typeof args.prompt === 'string' && args.prompt.trim()
          ? args.prompt.trim()
          : 'Describe this image in detail, including any visible text and UI state.';
      const analysis = await runVisionViaCodex(
        modelConfig,
        prompt,
        [image],
        context.abortSignal,
      );

      return {
        content: [{
          type: 'text',
          text: analysis || 'The vision model returned no analysis.',
        }],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to read image: ${message}` }],
        isError: true,
      };
    }
  },
};
