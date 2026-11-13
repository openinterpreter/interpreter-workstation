import { loadConfig, saveConfig, type AppConfig } from '../configStore';
import { getCodexService } from '../../src/lib/codex/service';
import { getPhoneNumber } from '../tools/builtin-tools/whatsapp/connection';

export type WhatsAppThreadBinding = { threadId: string; accountId: string };
type Persistence = {
  load: () => Promise<AppConfig>;
  save: (config: AppConfig) => Promise<void>;
  account: () => string | null;
  threadExists: (threadId: string) => Promise<boolean>;
};
const runtime: Persistence = {
  load: loadConfig,
  save: saveConfig,
  account: () => getPhoneNumber() ?? null,
  threadExists: async (threadId) => (await getCodexService().readThread(threadId)).id === threadId,
};
let pending: Promise<void> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = pending.then(operation);
  pending = next.then(() => undefined, () => undefined);
  return next;
}

function accountId(value: string | null): string {
  const normalized = value?.replace(/\D/g, '') ?? '';
  if (!/^[0-9]{6,18}$/.test(normalized)) throw new Error('Connect WhatsApp before binding a conversation.');
  return normalized;
}

/** Account identity is checked on every inbound message, including after reconnect. */
export async function getWhatsAppThreadBinding(deps: Persistence = runtime): Promise<WhatsAppThreadBinding | null> {
  const stored = (await deps.load()).whatsappThreadBinding;
  if (!stored || !/^[\w-]{8,128}$/.test(stored.threadId) || !/^[0-9]{6,18}$/.test(stored.accountId)) return null;
  return stored;
}

export async function bindWhatsAppThread(threadId: string, deps: Persistence = runtime): Promise<WhatsAppThreadBinding> {
  if (!/^[\w-]{8,128}$/.test(threadId)) throw new Error('Invalid conversation ID.');
  const account = accountId(deps.account());
  if (!await deps.threadExists(threadId)) throw new Error('Start the conversation before connecting WhatsApp.');
  return serialize(async () => {
    const config = await deps.load();
    // A single paired WhatsApp account deliberately owns at most one thread.
    const binding = { threadId, accountId: account };
    config.whatsappThreadBinding = binding;
    await deps.save(config);
    return binding;
  });
}

export async function unbindWhatsAppThread(expectedThreadId: string, deps: Persistence = runtime): Promise<void> {
  return serialize(async () => {
    const config = await deps.load();
    if (config.whatsappThreadBinding?.threadId !== expectedThreadId) throw new Error('Conversation binding changed; refresh and retry.');
    delete config.whatsappThreadBinding;
    await deps.save(config);
  });
}

/** Fence ambiguous sends before they reach the network; never silently replay. */
export async function offerWhatsAppReply(threadId: string, turnId: string, deps: Persistence = runtime): Promise<boolean> {
  if (!/^[\w-]{8,128}$/.test(threadId) || !/^[\w-]{8,160}$/.test(turnId)) return false;
  return serialize(async () => {
    const config = await deps.load();
    if (config.whatsappThreadBinding?.threadId !== threadId ||
        config.whatsappThreadBinding.accountId !== accountId(deps.account())) return false;
    const key = `${threadId}:${turnId}`;
    if (config.whatsappReplyReceipts?.[key]) return false;
    config.whatsappReplyReceipts = { ...config.whatsappReplyReceipts, [key]: 'offered' };
    await deps.save(config);
    return true;
  });
}

export async function confirmWhatsAppReply(threadId: string, turnId: string, deps: Persistence = runtime): Promise<void> {
  return serialize(async () => {
    const config = await deps.load();
    const key = `${threadId}:${turnId}`;
    if (config.whatsappReplyReceipts?.[key] !== 'offered') throw new Error('WhatsApp reply receipt changed.');
    config.whatsappReplyReceipts = { ...config.whatsappReplyReceipts, [key]: 'sent' };
    await deps.save(config);
  });
}

/** Sending can fail ambiguously. Hold rather than retry and duplicate a possible delivery. */
export async function holdWhatsAppReply(threadId: string, turnId: string, deps: Persistence = runtime): Promise<void> {
  return serialize(async () => {
    const config = await deps.load();
    const key = `${threadId}:${turnId}`;
    if (config.whatsappReplyReceipts?.[key] !== 'offered') return;
    config.whatsappReplyReceipts = { ...config.whatsappReplyReceipts, [key]: 'held' };
    await deps.save(config);
  });
}

export async function getHeldWhatsAppReplyCount(threadId: string, deps: Persistence = runtime): Promise<number> {
  const receipts = (await deps.load()).whatsappReplyReceipts ?? {};
  // An `offered` receipt left by a process crash is equally ambiguous: the
  // network may have delivered it. Surface it; never replay automatically.
  return Object.entries(receipts).filter(([key, status]) =>
    key.startsWith(`${threadId}:`) && (status === 'held' || status === 'offered')).length;
}

/** Store only transport IDs; no message text or credentials enter receipts. */
export async function rememberWhatsAppOutboundIds(ids: string[], deps: Persistence = runtime): Promise<void> {
  const valid = ids.filter((id) => /^[\w-]{6,160}$/.test(id));
  if (!valid.length) return;
  return serialize(async () => {
    const config = await deps.load();
    config.whatsappOutboundMessageIds = Array.from(new Set([...(config.whatsappOutboundMessageIds ?? []), ...valid])).slice(-512);
    await deps.save(config);
  });
}

export async function isKnownWhatsAppOutboundId(id: string, deps: Persistence = runtime): Promise<boolean> {
  if (!id || id.length > 160) return false;
  return ((await deps.load()).whatsappOutboundMessageIds ?? []).includes(id);
}
