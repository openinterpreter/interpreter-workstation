import type { BuiltinToolDefinition } from '../../builtinTools';
import { publishSimplePresentation } from '../../../simplePresentation';

const ASSET = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.(png|jpe?g|webp|gif|avif)$/i;

export const displayInSimpleModeTool: BuiltinToolDefinition = {
  name: 'display_in_simple_mode',
  description: 'Present one intentional rich update in the Simple-mode drawer. Use this for a result, image, progress card, or text that deserves more space than the tiny activity summary; do not mirror every ordinary chat message here.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['text', 'image', 'progress', 'result'] },
      title: { type: 'string', description: 'Short drawer title.' },
      text: { type: 'string', description: 'Optional concise body text.' },
      asset: { type: 'string', description: 'Optional image filename already saved in the active interface public/assets folder.' },
    },
    required: ['kind', 'title'],
  },
  mode: 'write',
  annotations: { destructiveHint: false, idempotentHint: false },
  handler: async (args) => {
    const kind = args.kind;
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, 120) : '';
    const text = typeof args.text === 'string' && args.text.trim() ? args.text.trim().slice(0, 12_000) : null;
    const asset = typeof args.asset === 'string' && args.asset.trim() ? args.asset.trim() : null;
    if (!['text', 'image', 'progress', 'result'].includes(kind) || !title) {
      return { content: [{ type: 'text', text: 'kind and a short title are required.' }], isError: true };
    }
    if (asset && !ASSET.test(asset)) {
      return { content: [{ type: 'text', text: 'asset must be a supported image filename from the active interface project.' }], isError: true };
    }
    const presentation = publishSimplePresentation({ kind, title, text, asset });
    return { content: [{ type: 'text', text: `Displayed ${presentation.kind} in the Simple-mode drawer.` }], isError: false };
  },
};
