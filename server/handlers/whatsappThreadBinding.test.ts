import { describe, expect, test } from 'bun:test';
import { bindWhatsAppThread, getWhatsAppThreadBinding, unbindWhatsAppThread, offerWhatsAppReply, confirmWhatsAppReply, holdWhatsAppReply, getHeldWhatsAppReplyCount, rememberWhatsAppOutboundIds, isKnownWhatsAppOutboundId } from './whatsappThreadBinding';
import type { AppConfig } from '../configStore';

function fixture() {
  let config = { agents: {} } as AppConfig;
  let account: string | null = '+15551234567';
  const deps = {
    load: async () => structuredClone(config),
    save: async (next: AppConfig) => { config = structuredClone(next); },
    account: () => account,
    threadExists: async (threadId: string) => threadId === 'thread-12345678',
  };
  return { deps, setAccount: (next: string | null) => { account = next; } };
}

describe('WhatsApp durable conversation binding', () => {
  test('binds only an existing conversation to the paired account, persists and unbinds with CAS', async () => {
    const { deps } = fixture();
    expect(await getWhatsAppThreadBinding(deps)).toBeNull();
    expect(await bindWhatsAppThread('thread-12345678', deps)).toEqual({ threadId: 'thread-12345678', accountId: '15551234567' });
    expect(await getWhatsAppThreadBinding(deps)).toEqual({ threadId: 'thread-12345678', accountId: '15551234567' });
    await expect(unbindWhatsAppThread('thread-wrong000', deps)).rejects.toThrow('changed');
    await unbindWhatsAppThread('thread-12345678', deps);
    expect(await getWhatsAppThreadBinding(deps)).toBeNull();
  });

  test('rejects missing pairing, unknown threads and malicious paths', async () => {
    const { deps, setAccount } = fixture();
    await expect(bindWhatsAppThread('../../etc/passwd', deps)).rejects.toThrow('Invalid');
    await expect(bindWhatsAppThread('thread-unknown123', deps)).rejects.toThrow('Start the conversation');
    setAccount(null);
    await expect(bindWhatsAppThread('thread-12345678', deps)).rejects.toThrow('Connect WhatsApp');
  });

  test('persists no-replay receipt before outbound reply and fails closed after account switch', async () => {
    const { deps, setAccount } = fixture();
    await bindWhatsAppThread('thread-12345678', deps);
    expect(await offerWhatsAppReply('thread-12345678', 'turn-12345678', deps)).toBe(true);
    expect(await offerWhatsAppReply('thread-12345678', 'turn-12345678', deps)).toBe(false);
    await confirmWhatsAppReply('thread-12345678', 'turn-12345678', deps);
    expect(await offerWhatsAppReply('thread-12345678', 'turn-12345678', deps)).toBe(false);
    setAccount('+15559999999');
    expect(await offerWhatsAppReply('thread-12345678', 'turn-new00001', deps)).toBe(false);
  });

  test('holds an ambiguous reply for visible recovery and remembers outbound IDs without message text', async () => {
    const { deps } = fixture();
    await bindWhatsAppThread('thread-12345678', deps);
    expect(await offerWhatsAppReply('thread-12345678', 'turn-ambiguous001', deps)).toBe(true);
    await holdWhatsAppReply('thread-12345678', 'turn-ambiguous001', deps);
    expect(await getHeldWhatsAppReplyCount('thread-12345678', deps)).toBe(1);
    expect(await offerWhatsAppReply('thread-12345678', 'turn-ambiguous001', deps)).toBe(false);
    await rememberWhatsAppOutboundIds(['transport-outbound-123'], deps);
    expect(await isKnownWhatsAppOutboundId('transport-outbound-123', deps)).toBe(true);
    expect(await isKnownWhatsAppOutboundId('different', deps)).toBe(false);
  });
});
