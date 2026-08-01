import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { WASocket } from '@whiskeysockets/baileys';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';

const DEFAULT_SEND_MAX_ATTEMPTS = 3;
const DEFAULT_SEND_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MARKDOWN_LINK_RE = /!?\[([^\]]*)\]\(([^)]+)\)/g;

type AttachmentKind = 'image' | 'video' | 'audio' | 'document';

type ResolvedAttachment = {
  kind: AttachmentKind;
  filePath: string;
  fileName: string;
  mimeType: string;
};

export type OutboundSendPart = {
  kind: 'text' | AttachmentKind;
  textForEcho?: string;
  messageId?: string;
};

export type OutboundSendResult = {
  parts: OutboundSendPart[];
};

type OutboundSendHooks = {
  onBeforeSend?: (part: OutboundSendPart) => void;
  onSent?: (part: OutboundSendPart) => void;
};

export type OutboundSendOptions = OutboundSendHooks & {
  maxAttempts?: number;
  timeoutMs?: number;
  maxAttachmentBytes?: number;
  workspacePath?: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

function isRetriableSendError(err: unknown): boolean {
  const text = describeError(err).toLowerCase();
  return (
    text.includes('closed') ||
    text.includes('reset') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('disconnect') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('socket hang up')
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await promise;
  }
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function sendWithRetry<T>(
  run: () => Promise<T>,
  label: string,
  maxAttempts: number,
  timeoutMs: number
): Promise<T> {
  let lastErr: unknown;
  const attempts = Math.max(1, maxAttempts);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(run(), timeoutMs, label);
    } catch (err) {
      lastErr = err;
      const isLast = attempt === attempts;
      if (isLast || !isRetriableSendError(err)) {
        throw err;
      }
      const backoffMs = DEFAULT_RETRY_BASE_DELAY_MS * attempt;
      console.warn(
        `[WhatsApp outbound] retrying ${label} in ${backoffMs}ms (${attempt}/${attempts - 1}): ${describeError(err)}`
      );
      await sleep(backoffMs);
    }
  }

  throw lastErr;
}

function normalizeLinkTarget(rawTarget: string): string {
  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }
  if (target.startsWith('file://')) {
    target = target.slice('file://'.length);
  }
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep original value when it's not URI-encoded.
  }
  return target;
}

function isRemoteTarget(target: string): boolean {
  const lower = target.toLowerCase();
  return (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('data:')
  );
}

function classifyAttachment(filePath: string): { kind: AttachmentKind; mimeType: string } {
  const extension = extname(filePath).toLowerCase();
  if (
    extension === '.jpg' ||
    extension === '.jpeg' ||
    extension === '.png' ||
    extension === '.gif' ||
    extension === '.webp' ||
    extension === '.bmp' ||
    extension === '.heic' ||
    extension === '.heif'
  ) {
    const mimeType =
      extension === '.jpg' || extension === '.jpeg'
        ? 'image/jpeg'
        : extension === '.png'
          ? 'image/png'
          : extension === '.gif'
            ? 'image/gif'
            : extension === '.webp'
              ? 'image/webp'
              : extension === '.bmp'
                ? 'image/bmp'
                : extension === '.heic'
                  ? 'image/heic'
                  : 'image/heif';
    return { kind: 'image', mimeType };
  }

  if (
    extension === '.mp4' ||
    extension === '.mov' ||
    extension === '.webm' ||
    extension === '.mkv' ||
    extension === '.avi'
  ) {
    const mimeType =
      extension === '.mov'
        ? 'video/quicktime'
        : extension === '.webm'
          ? 'video/webm'
          : extension === '.avi'
            ? 'video/x-msvideo'
            : extension === '.mkv'
              ? 'video/x-matroska'
              : 'video/mp4';
    return { kind: 'video', mimeType };
  }

  if (
    extension === '.ogg' ||
    extension === '.mp3' ||
    extension === '.m4a' ||
    extension === '.wav' ||
    extension === '.aac' ||
    extension === '.opus'
  ) {
    const mimeType =
      extension === '.mp3'
        ? 'audio/mpeg'
        : extension === '.m4a'
          ? 'audio/mp4'
          : extension === '.wav'
            ? 'audio/wav'
            : extension === '.aac'
              ? 'audio/aac'
              : extension === '.opus'
                ? 'audio/ogg; codecs=opus'
                : 'audio/ogg';
    return { kind: 'audio', mimeType };
  }

  if (extension === '.pdf') {
    return { kind: 'document', mimeType: 'application/pdf' };
  }

  return { kind: 'document', mimeType: 'application/octet-stream' };
}

async function resolveAttachmentFromLink(params: {
  rawTarget: string;
  workspacePath: string | null;
  maxAttachmentBytes: number;
}): Promise<ResolvedAttachment | null> {
  const target = normalizeLinkTarget(params.rawTarget);
  if (!target || isRemoteTarget(target)) return null;

  let filePath: string;
  try {
    filePath = resolvePathWithWorkspace(target, params.workspacePath);
  } catch {
    return null;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return null;
    if (fileStat.size <= 0 || fileStat.size > params.maxAttachmentBytes) {
      console.warn(
        `[WhatsApp outbound] skipping attachment outside size limits: ${filePath} (${fileStat.size} bytes)`
      );
      return null;
    }
  } catch {
    return null;
  }

  const { kind, mimeType } = classifyAttachment(filePath);
  return {
    kind,
    filePath,
    fileName: basename(filePath),
    mimeType,
  };
}

function cleanTextAfterLinkRemoval(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function parseMessageForAttachments(params: {
  text: string;
  workspacePath: string | null;
  maxAttachmentBytes: number;
}): Promise<{ cleanedText: string; attachments: ResolvedAttachment[] }> {
  const matches: Array<{
    start: number;
    end: number;
    raw: string;
    rawTarget: string;
  }> = [];
  for (const match of params.text.matchAll(MARKDOWN_LINK_RE)) {
    if (match.index == null) continue;
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      rawTarget: match[2] ?? '',
    });
  }

  if (matches.length === 0) {
    return { cleanedText: params.text.trim(), attachments: [] };
  }

  const attachments: ResolvedAttachment[] = [];
  const chunks: string[] = [];
  let cursor = 0;

  for (const match of matches) {
    chunks.push(params.text.slice(cursor, match.start));
    const attachment = await resolveAttachmentFromLink({
      rawTarget: match.rawTarget,
      workspacePath: params.workspacePath,
      maxAttachmentBytes: params.maxAttachmentBytes,
    });
    if (attachment) {
      attachments.push(attachment);
    } else {
      chunks.push(match.raw);
    }
    cursor = match.end;
  }

  chunks.push(params.text.slice(cursor));
  const cleanedText = cleanTextAfterLinkRemoval(chunks.join(''));
  return { cleanedText, attachments };
}

function placeholderForAttachment(params: {
  kind: AttachmentKind;
  fileName: string;
  caption?: string;
}): string {
  const mediaPlaceholder =
    params.kind === 'image'
      ? '[Image]'
      : params.kind === 'video'
        ? '[Video]'
        : params.kind === 'audio'
          ? '[Voice message]'
          : `[File: ${params.fileName}]`;

  if (!params.caption) {
    return mediaPlaceholder;
  }
  return `${params.caption}\n${mediaPlaceholder}`;
}

function supportsCaption(kind: AttachmentKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'document';
}

async function buildMediaPayload(params: {
  attachment: ResolvedAttachment;
  caption?: string;
}): Promise<Record<string, unknown>> {
  const buffer = await readFile(params.attachment.filePath);
  if (buffer.length <= 0) {
    throw new Error(`Attachment is empty: ${params.attachment.filePath}`);
  }

  switch (params.attachment.kind) {
    case 'image':
      return {
        image: buffer,
        caption: params.caption,
        mimetype: params.attachment.mimeType,
      };
    case 'video':
      return {
        video: buffer,
        caption: params.caption,
        mimetype: params.attachment.mimeType,
      };
    case 'audio':
      return {
        audio: buffer,
        ptt: false,
        mimetype: params.attachment.mimeType,
      };
    case 'document':
      return {
        document: buffer,
        caption: params.caption,
        mimetype: params.attachment.mimeType,
        fileName: params.attachment.fileName,
      };
    default:
      return {
        document: buffer,
        mimetype: params.attachment.mimeType,
        fileName: params.attachment.fileName,
      };
  }
}

export async function sendWhatsAppMessageWithRetry(params: {
  sock: WASocket;
  chatId: string;
  text: string;
  options?: OutboundSendOptions;
}): Promise<OutboundSendResult> {
  const text = params.text.trim();
  if (!text) {
    return { parts: [] };
  }

  const maxAttempts = params.options?.maxAttempts ?? DEFAULT_SEND_MAX_ATTEMPTS;
  const timeoutMs = params.options?.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const workspacePath = params.options?.workspacePath ?? getCurrentWorkspace();
  const maxAttachmentBytes = params.options?.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  const parsed = await parseMessageForAttachments({
    text,
    workspacePath,
    maxAttachmentBytes,
  });

  const parts: OutboundSendPart[] = [];
  let remainingText = parsed.cleanedText;
  const attachments = parsed.attachments;
  const firstCaptionIndex = attachments.findIndex((item) => supportsCaption(item.kind));

  if (remainingText && attachments.length > 0 && firstCaptionIndex < 0) {
    const textPart: OutboundSendPart = { kind: 'text', textForEcho: remainingText };
    params.options?.onBeforeSend?.(textPart);
    const result = await sendWithRetry(
      () => params.sock.sendMessage(params.chatId, { text: remainingText }),
      'text',
      maxAttempts,
      timeoutMs
    );
    const sentPart: OutboundSendPart = {
      ...textPart,
      messageId: result?.key?.id ?? undefined,
    };
    params.options?.onSent?.(sentPart);
    parts.push(sentPart);
    remainingText = '';
  }

  for (const [index, attachment] of attachments.entries()) {
    const caption =
      remainingText && supportsCaption(attachment.kind) && index === firstCaptionIndex
        ? remainingText
        : undefined;
    if (caption) {
      remainingText = '';
    }

    const textForEcho = placeholderForAttachment({
      kind: attachment.kind,
      fileName: attachment.fileName,
      caption,
    });
    const partBase: OutboundSendPart = {
      kind: attachment.kind,
      textForEcho,
    };
    params.options?.onBeforeSend?.(partBase);

    const payload = await buildMediaPayload({
      attachment,
      caption,
    });

    const result = await sendWithRetry(
      () => params.sock.sendMessage(params.chatId, payload as any),
      `${attachment.kind}:${attachment.fileName}`,
      maxAttempts,
      timeoutMs
    );
    const sentPart: OutboundSendPart = {
      ...partBase,
      messageId: result?.key?.id ?? undefined,
    };
    params.options?.onSent?.(sentPart);
    parts.push(sentPart);
  }

  if (remainingText) {
    const textPart: OutboundSendPart = { kind: 'text', textForEcho: remainingText };
    params.options?.onBeforeSend?.(textPart);
    const result = await sendWithRetry(
      () => params.sock.sendMessage(params.chatId, { text: remainingText }),
      'text',
      maxAttempts,
      timeoutMs
    );
    const sentPart: OutboundSendPart = {
      ...textPart,
      messageId: result?.key?.id ?? undefined,
    };
    params.options?.onSent?.(sentPart);
    parts.push(sentPart);
  }

  return { parts };
}
