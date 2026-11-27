import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { BrowserPiTranscript } from './piTranscript';

export type PresentationFailure = 'capability' | 'busy' | 'rejected' | 'timeout' |
  'buffer' | 'storage-unavailable' | 'incomplete';
export class BrowserPresentationError extends Error {
  constructor(readonly code: PresentationFailure) {
    super(`Browser presentation ${code}`);
    this.name = 'BrowserPresentationError';
  }
}

export type PresentationTool = Readonly<{ id: string; name: string;
  arguments: Readonly<Record<string, unknown>>; result: readonly unknown[]; success: boolean }>;
export type PresentationCandidate = Readonly<{
  projectId: string; threadId: string; turnId: string; runId: string;
  tools: readonly PresentationTool[]; answerParts: readonly string[];
  /** Convenience only for a final answer with exactly one text part. */
  answer: string;
  priorTranscript: Readonly<BrowserPiTranscript>;
}>;
export type PresentationValidator = (candidate: PresentationCandidate) =>
  Promise<{ accept: true } | { accept: false; reason: string }> |
  { accept: true } | { accept: false; reason: string };

export function transcriptDigest(value: BrowserPiTranscript): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A completed turn, with strictly paired model-authored calls and results. */
export function presentationCandidate(transcript: BrowserPiTranscript, start: number,
  end: number, runId: string, priorRevision = transcript.revision): PresentationCandidate {
  const messages = transcript.messages.slice(start, end);
  if (messages[0]?.role !== 'user') throw new BrowserPresentationError('incomplete');
  const turnId = `pi-turn-${start}`;
  if (transcript.failedTurns?.[turnId] || transcript.interruptedTurnIds?.includes(turnId))
    throw new BrowserPresentationError('incomplete');
  const tools: PresentationTool[] = [];
  const pending = new Map<string, { id: string; name: string; arguments: Record<string, unknown> }>();
  const answerParts: string[] = [];
  let answer = '';
  let final = false;
  for (const message of messages.slice(1)) {
    if (final) throw new BrowserPresentationError('incomplete');
    if (message.role === 'assistant') {
      const texts = message.content.filter(part => part.type === 'text').map(part => part.text)
        .filter(text => text.length > 0);
      answerParts.push(...texts);
      for (const part of message.content) {
        if (part.type === 'toolCall') {
          if (pending.has(part.id)) throw new BrowserPresentationError('incomplete');
          pending.set(part.id, { id: part.id, name: part.name, arguments: part.arguments });
        }
      }
      if (message.stopReason === 'stop') {
        if (pending.size) throw new BrowserPresentationError('incomplete');
        final = texts.some(text => !!text.trim());
        answer = texts.length === 1 ? texts[0] : '';
      } else if (message.stopReason !== 'toolUse') throw new BrowserPresentationError('incomplete');
    } else if (message.role === 'toolResult') {
      const call = pending.get(message.toolCallId);
      if (!call || call.name !== message.toolName) throw new BrowserPresentationError('incomplete');
      pending.delete(call.id);
      tools.push({ ...call, result: message.content, success: !message.isError });
    } else throw new BrowserPresentationError('incomplete');
  }
  if (!final || pending.size) throw new BrowserPresentationError('incomplete');
  const earlier = (id: string) => {
    const index = Number(id.slice('pi-turn-'.length));
    return /^pi-turn-\d+$/.test(id) && index < start;
  };
  const priorTranscript: BrowserPiTranscript = { ...transcript,
    revision: priorRevision, messages: transcript.messages.slice(0, start),
    interruptedTurnIds: transcript.interruptedTurnIds?.filter(earlier),
    presentationRuns: Object.fromEntries(Object.entries(transcript.presentationRuns ?? {})
      .filter(([id]) => earlier(id))),
    presentationPriorRevisions: Object.fromEntries(
      Object.entries(transcript.presentationPriorRevisions ?? {}).filter(([id]) => earlier(id))),
    failedTurns: Object.fromEntries(Object.entries(transcript.failedTurns ?? {})
      .filter(([id]) => earlier(id))) };
  return deepFreeze(structuredClone({ projectId: transcript.projectId, threadId: transcript.threadId,
    turnId, runId, tools, answerParts, answer, priorTranscript }));
}

export async function validatePresentation(validator: PresentationValidator,
  candidate: PresentationCandidate, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new BrowserPresentationError('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrowserPresentationError('timeout')), 10_000);
      abort = () => reject(new BrowserPresentationError('timeout'));
      signal?.addEventListener('abort', abort, { once: true });
    });
    const result = await Promise.race([Promise.resolve().then(() => validator(candidate)), expiry]);
    if (signal?.aborted) throw new BrowserPresentationError('timeout');
    if (result?.accept !== true) throw new BrowserPresentationError('rejected');
  } catch (error) {
    if (error instanceof BrowserPresentationError) throw error;
    throw new BrowserPresentationError('rejected');
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
