import type { MessageSendSource } from '../../shared/types/messageSendSource';
import type { VoiceMode } from '../../shared/types/stt';
import type { SerializedComposerSubmission } from './composer/attachment/types';

export interface AssistantTtsManualPlayRequestDetail {
  agentId: string;
  messageId: string;
  sentences: string[];
  modelId: string;
}

export function shouldHandleManualTtsPlayRequest(params: {
  composerAgentId?: string;
  request?: AssistantTtsManualPlayRequestDetail | null;
}): boolean {
  const { composerAgentId, request } = params;
  if (!composerAgentId) return false;
  if (request?.agentId !== composerAgentId) return false;
  if (!request.messageId) return false;
  return Array.isArray(request.sentences) && request.sentences.length > 0;
}

export function shouldAdoptWindowWorkspaceForIdleComposer(params: {
  isTerminal: boolean;
  onWorkspacePathChange?: (workspacePath: string) => void;
  messageCount: number;
  windowWorkspacePath: string | null;
  workspacePath?: string;
}): boolean {
  if (params.isTerminal || !params.onWorkspacePathChange) return false;
  if (params.messageCount !== 0 || !params.windowWorkspacePath) return false;
  return params.workspacePath === undefined;
}

export function getEffectiveComposerWorkspacePath(params: {
  workspacePath?: string;
  windowWorkspacePath: string | null;
}): string | undefined {
  return params.workspacePath ?? params.windowWorkspacePath ?? undefined;
}

export type VoiceSendBehavior = 'default-send' | 'steer' | 'interrupt';

export function getVoiceSendBehavior(params: {
  isStreaming: boolean;
  voiceMode?: VoiceMode | null;
}): VoiceSendBehavior {
  if (!params.isStreaming) {
    return 'default-send';
  }

  return (params.voiceMode ?? 'conversational') === 'conversational'
    ? 'interrupt'
    : 'steer';
}

export function shouldCancelCurrentTurnForVoiceBargeIn(
  voiceMode?: VoiceMode | null,
): boolean {
  return (voiceMode ?? 'conversational') === 'conversational';
}

export function normalizeWindowVoiceSelectedText(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Pending agent-tab sends only persist text plus runtime context. They do not
 * carry image payloads. The desktop composer also does not create image
 * payloads from paste/drop; it saves those images as file references instead.
 * Any image attachments reaching this validator are expected to come from an
 * overlay-originated direct-send path.
 */
export function getPendingInputValidationError(
  submission: SerializedComposerSubmission,
): string | null {
  if (submission.attachments.length > 0) {
    return 'This send path does not support raw image inputs. In the desktop composer, pasted or dropped images become file references. Overlay image inputs can only be sent through the attached overlay agent path.';
  }

  return null;
}

export function buildSuggestionChipMessageSource(params: {
  id: string;
  label: string;
  prompt: string;
}): MessageSendSource {
  return {
    type: 'suggestion_chip',
    chipId: params.id,
    chipTitle: params.label,
    chipContent: params.prompt,
  };
}

export function resolveComposerMessageSource(params: {
  submission: SerializedComposerSubmission;
  explicitSource?: MessageSendSource | null;
  pendingSource?: MessageSendSource | null;
}): MessageSendSource | null {
  if (params.explicitSource) {
    return params.explicitSource;
  }

  const pendingSource = params.pendingSource;
  if (!pendingSource) {
    return null;
  }

  const chipContent = pendingSource.chipContent?.trim();
  if (!chipContent) {
    return pendingSource;
  }

  return params.submission.text.includes(chipContent)
    ? pendingSource
    : null;
}

export function describeVoiceError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}' && serialized !== 'null') return serialized;
  } catch {}
  return fallback;
}

export function isLikelyMicrophonePermissionError(error: unknown): boolean {
  const message = describeVoiceError(error, '').toLowerCase();
  if (!message) return false;
  return (
    message.includes('permission to the requested resource was denied')
    || message.includes('permission denied')
    || message.includes('notallowederror')
    || message.includes('microphone permission')
  );
}

export async function primeMicrophonePermission(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  constraints: MediaStreamConstraints,
): Promise<void> {
  const stream = await getUserMedia(constraints);
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
