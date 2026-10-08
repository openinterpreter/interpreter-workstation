import { getAllProviders, getDefaultProfile } from '../configStore';
import { getCodexService } from '../../src/lib/codex/service';
import type { v2 } from './codex-generated-types';
import { getSimplePrimaryThread } from './simplePrimaryThread';
import { threadToPublicMessages } from '../utils/publicThreadSnapshot';

const LIVE_SESSION_URL = 'https://api.openai.com/v1/live/sessions';
const MAX_SDP_LENGTH = 200_000;

export type SimpleLiveStatus = {
  configured: boolean;
  source: 'profile' | 'environment' | 'secure' | 'none';
};

export type SimpleLiveInputMessage = {
  type: 'message';
  role: 'user' | 'assistant';
  content: [{ type: 'input_text' | 'output_text'; text: string }];
};

const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CHARACTERS = 24_000;

type LiveCredential = { apiKey: string; source: 'profile' | 'environment' };

async function resolveLiveCredential(): Promise<LiveCredential | null> {
  const profile = await getDefaultProfile();
  const providers = await getAllProviders();
  const provider = profile?.providerId
    ? providers.find((candidate) => candidate.id === profile.providerId)
    : undefined;
  const baseURL = provider?.baseURL ?? profile?.baseURL;
  const preset = provider?.api?.preset;
  const isOpenAI = profile?.provider === 'api'
    && (preset === 'openai' || !baseURL || /^https:\/\/api\.openai\.com(?:\/|$)/i.test(baseURL));

  if (isOpenAI) {
    const environmentKey = profile?.environmentKey?.trim();
    if (environmentKey && process.env[environmentKey]?.trim()) {
      return { apiKey: process.env[environmentKey]!.trim(), source: 'environment' };
    }
    const stored = provider?.apiKey?.trim() || profile?.apiKey?.trim();
    if (stored) return { apiKey: stored, source: 'profile' };
  }

  const environmentKey = process.env.OPENAI_API_KEY?.trim();
  return environmentKey ? { apiKey: environmentKey, source: 'environment' } : null;
}

export async function getSimpleLiveStatus(options?: { secureApiKey?: string | null }): Promise<SimpleLiveStatus> {
  const secureApiKey = options?.secureApiKey?.trim();
  if (secureApiKey) return { configured: true, source: 'secure' };
  const credential = await resolveLiveCredential();
  return credential
    ? { configured: true, source: credential.source }
    : { configured: false, source: 'none' };
}

export function buildBoundedLiveHistory(thread: v2.Thread | null): SimpleLiveInputMessage[] {
  if (!thread) return [];
  const messages = threadToPublicMessages(thread)
    .flatMap<SimpleLiveInputMessage>((message) => {
      const text = message.parts
        .filter((part): part is Extract<(typeof message.parts)[number], { kind: 'text' }> => part.kind === 'text')
        .map((part) => part.content)
        .join('\n')
        .trim();
      if (!text || (message.role !== 'user' && message.role !== 'assistant')) return [];
      const liveMessage: SimpleLiveInputMessage = {
        type: 'message' as const,
        role: message.role,
        content: [{
          type: message.role === 'assistant' ? 'output_text' as const : 'input_text' as const,
          text,
        }],
      };
      return [liveMessage];
    })
    .slice(-MAX_HISTORY_MESSAGES);

  let characterCount = 0;
  const bounded: SimpleLiveInputMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const text = message.content[0].text;
    const remaining = MAX_HISTORY_CHARACTERS - characterCount;
    if (remaining <= 0) break;
    const next = text.length <= remaining
      ? message
      : { ...message, content: [{ ...message.content[0], text: text.slice(-remaining) }] as SimpleLiveInputMessage['content'] };
    bounded.unshift(next);
    characterCount += next.content[0].text.length;
  }
  return bounded;
}

async function loadBoundedPrimaryThreadHistory(): Promise<SimpleLiveInputMessage[]> {
  try {
    const { threadId } = await getSimplePrimaryThread();
    if (!threadId) return [];
    const thread = await getCodexService().readThread(threadId);
    return buildBoundedLiveHistory(thread);
  } catch (error) {
    console.warn('[SimpleLive] Could not seed bounded durable-thread history:', error instanceof Error ? error.message : error);
    return [];
  }
}

function validateOfferSdp(value: unknown): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > MAX_SDP_LENGTH) {
    throw new Error('Invalid GPT Live connection offer.');
  }
  return value;
}

export async function createSimpleLiveSession(
  request: { offerSdp: string },
  options?: { secureApiKey?: string | null; history?: SimpleLiveInputMessage[] },
): Promise<{ answerSdp: string; sessionId: string }> {
  const offerSdp = validateOfferSdp(request?.offerSdp);
  const secureApiKey = options?.secureApiKey?.trim();
  const credential = secureApiKey
    ? { apiKey: secureApiKey, source: 'profile' as const }
    : await resolveLiveCredential();
  if (!credential) {
    throw new Error('GPT Live needs an OpenAI API key. Add an OpenAI model in Settings or set OPENAI_API_KEY.');
  }

  const input = options?.history ?? await loadBoundedPrimaryThreadHistory();
  const response = await fetch(LIVE_SESSION_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        model: 'gpt-live-1',
        input,
        delegation: { type: 'client' },
        instructions: [
          'You are the GPT Live voice interface for Interpreter Simple mode.',
          'Be concise and conversational. Delegate substantive requests to the durable Interpreter conversation.',
          'The user may keep talking and steer while delegated work continues.',
          'Do not claim delegated work is complete until the application returns its result.',
        ].join(' '),
      },
      transport: { type: 'webrtc', sdp: offerSdp },
    }),
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('GPT Live could not start: the configured OpenAI API key has no available quota (429). Add API credits or choose another OpenAI API key.');
    }
    throw new Error(`GPT Live could not start (${response.status}). Check the OpenAI key and try again.`);
  }
  const data = await response.json() as {
    session?: { id?: unknown };
    transport?: { sdp?: unknown };
  };
  if (typeof data.transport?.sdp !== 'string' || typeof data.session?.id !== 'string') {
    throw new Error('GPT Live returned an invalid connection response.');
  }
  return { answerSdp: data.transport.sdp, sessionId: data.session.id };
}
