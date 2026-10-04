/** A single durable OIX conversation per Simple workspace. No shadow transcript. */
import { loadConfig, saveConfig, type AppConfig } from '../configStore';
import { getSimpleWorkspacePath } from '../simpleWorkspace';

export type SimplePrimaryThreadBinding = { threadId: string | null };

type Persistence = {
  workspace: () => Promise<string>;
  load: () => Promise<AppConfig>;
  save: (config: AppConfig) => Promise<void>;
};

const persistence: Persistence = {
  workspace: getSimpleWorkspacePath,
  load: loadConfig,
  save: saveConfig,
};

let pending: Promise<void> = Promise.resolve();

/** Serialize read-modify-write across windows in this process. */
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

function validateThreadId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{8,128}$/.test(value)) {
    throw new Error('Invalid primary conversation ID');
  }
  return value;
}

export async function getSimplePrimaryThread(
  deps: Persistence = persistence,
): Promise<SimplePrimaryThreadBinding> {
  const workspace = await deps.workspace();
  const config = await deps.load();
  return { threadId: config.simplePrimaryThreads?.[workspace] ?? null };
}

/** First claimant wins. A stale binding can be repaired only with an exact CAS. */
export async function bindSimplePrimaryThread(
  request: { threadId: string; expectedThreadId?: string | null },
  deps: Persistence = persistence,
): Promise<SimplePrimaryThreadBinding> {
  const threadId = validateThreadId(request?.threadId);
  if (request.expectedThreadId !== undefined && request.expectedThreadId !== null) {
    validateThreadId(request.expectedThreadId);
  }
  return serialize(async () => {
    const workspace = await deps.workspace();
    const config = await deps.load();
    const current = config.simplePrimaryThreads?.[workspace] ?? null;
    if (current === threadId) return { threadId };
    // An empty slot is always safe to claim. This also makes a provider-change
    // remount resilient when the old binding was cleared just before the new
    // AgentThread reports its identity.
    if (current !== null && current !== (request.expectedThreadId ?? null)) {
      throw new Error('Primary conversation changed in another window; reload and retry.');
    }
    config.simplePrimaryThreads = { ...config.simplePrimaryThreads, [workspace]: threadId };
    await deps.save(config);
    return { threadId };
  });
}

/** Clear the durable binding before intentionally changing model providers. */
export async function clearSimplePrimaryThread(
  request: { expectedThreadId: string },
  deps: Persistence = persistence,
): Promise<SimplePrimaryThreadBinding> {
  const expectedThreadId = validateThreadId(request?.expectedThreadId);
  return serialize(async () => {
    const workspace = await deps.workspace();
    const config = await deps.load();
    const current = config.simplePrimaryThreads?.[workspace] ?? null;
    if (current === null) return { threadId: null };
    if (current !== expectedThreadId) throw new Error('Primary conversation changed in another window; reload and retry.');
    const next = { ...(config.simplePrimaryThreads ?? {}) };
    delete next[workspace];
    config.simplePrimaryThreads = next;
    await deps.save(config);
    return { threadId: null };
  });
}

/** Bind the Simple durable thread as the reply target for an active WhatsApp self-chat. */
export async function bindSimplePrimaryChannel(request: { threadId: string }): Promise<{ success: boolean }> {
  const threadId = validateThreadId(request?.threadId);
  const { bindWhatsAppBridgeConversation } = await import('../services/whatsappBridge');
  bindWhatsAppBridgeConversation('simple-primary-agent', threadId);
  return { success: true };
}

/** Forward one completed durable-thread response only when WhatsApp is awaiting it. */
export async function forwardSimplePrimaryChannelReply(request: {
  threadId: string;
  text: string;
}): Promise<{ sent: boolean }> {
  const threadId = validateThreadId(request?.threadId);
  const text = typeof request?.text === 'string' ? request.text.trim() : '';
  if (!text) return { sent: false };
  const { forwardWhatsAppAssistantMessage } = await import('../services/whatsappBridge');
  return { sent: await forwardWhatsAppAssistantMessage(threadId, text) };
}
