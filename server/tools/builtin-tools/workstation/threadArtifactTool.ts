import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { ArtifactReceiptError, threadArtifactReceipts } from '../../../utils/threadArtifactReceipts';

const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const response = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}),
});

export async function createThreadArtifactForCaller(
  args: Record<string, unknown>, context?: BuiltinToolContext,
  store: typeof threadArtifactReceipts = threadArtifactReceipts,
) {
  const threadId = context?.verifiedCallerThreadId;
  if (!threadId || !THREAD.test(threadId) || context?.threadId !== threadId ||
      context?.isSubagent || (context?.toolCallPath?.length ?? 0) !== 0) {
    return response({ available: false, category: 'caller_unavailable' }, true);
  }
  if (typeof args.receiptId !== 'string' || typeof args.sha256 !== 'string' ||
      typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > 1024 * 1024) {
    return response({ available: false, category: 'invalid_artifact_request' }, true);
  }
  try {
    const receipt = await store.create(threadId, args.receiptId, Buffer.from(args.content, 'utf8'), args.sha256);
    return response({ available: true, ...receipt });
  } catch (error) {
    return response({ available: false, category: error instanceof ArtifactReceiptError
      ? `artifact_${error.code}` : 'artifact_unavailable' }, true);
  }
}

export const threadArtifactCreateTool: BuiltinToolDefinition = {
  name: 'interpreter_thread_artifact_create',
  description: 'Create a private, exact-thread UTF-8 artifact with an idempotent digest-bound receipt.',
  inputSchema: { type: 'object', properties: {
    receiptId: { type: 'string' }, sha256: { type: 'string' }, content: { type: 'string' },
  }, required: ['receiptId', 'sha256', 'content'] },
  mode: 'write', mainAgentOnly: true, annotations: { idempotentHint: true },
  handler: (args, context) => createThreadArtifactForCaller(args, context),
};
