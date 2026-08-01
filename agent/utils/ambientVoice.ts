import { normalizeVoiceText } from './voiceTranscript';

export type AmbientEndPhraseAction =
  | { type: 'none' }
  | { type: 'reset-empty'; matchedPhrase: string }
  | { type: 'send'; matchedPhrase: string; finalText: string }
  | { type: 'defer'; matchedPhrase: string; finalText: string };

export interface AmbientCommandFinalText {
  finalText: string;
  source: 'qwen' | 'native-detector';
}

export interface AmbientDetectorFinishRequest {
  matchedPhrase: string;
  previewText: string;
}

export interface AmbientTranscriptGateResult {
  triggerDetected: boolean;
  commandText: string;
  endAction: AmbientEndPhraseAction;
}

export function resolveAmbientEndPhrase(
  displayText: string,
  endPattern: RegExp,
  isSendInFlight: boolean,
): AmbientEndPhraseAction {
  const endMatch = displayText.match(endPattern);
  if (!endMatch) {
    return { type: 'none' };
  }

  const finalText = displayText.slice(0, endMatch.index ?? 0).trim();
  if (!finalText) {
    return { type: 'reset-empty', matchedPhrase: endMatch[0] };
  }

  return {
    type: isSendInFlight ? 'defer' : 'send',
    matchedPhrase: endMatch[0],
    finalText,
  };
}

export function resolveAmbientTranscriptGate(
  transcript: string,
  phase: 'waiting' | 'accumulating',
  triggerPattern: RegExp,
  endPattern: RegExp,
  isSendInFlight: boolean,
): AmbientTranscriptGateResult {
  const normalized = normalizeVoiceText(transcript);
  if (!normalized) {
    return {
      triggerDetected: false,
      commandText: '',
      endAction: { type: 'none' },
    };
  }

  if (phase === 'waiting') {
    const triggerMatch = normalized.match(triggerPattern);
    if (!triggerMatch) {
      return {
        triggerDetected: false,
        commandText: '',
        endAction: { type: 'none' },
      };
    }

    const commandText = normalized
      .slice((triggerMatch.index ?? 0) + triggerMatch[0].length)
      .replace(/^[\s,.:;!?\-'"]+/, '')
      .trim();

    return {
      triggerDetected: true,
      commandText,
      endAction: resolveAmbientEndPhrase(commandText, endPattern, isSendInFlight),
    };
  }

  const triggerMatch = normalized.match(triggerPattern);
  const commandText = triggerMatch
    ? normalized
      .slice((triggerMatch.index ?? 0) + triggerMatch[0].length)
      .replace(/^[\s,.:;!?\-'"]+/, '')
      .trim()
    : normalized.trim();

  return {
    triggerDetected: false,
    commandText,
    endAction: resolveAmbientEndPhrase(commandText, endPattern, isSendInFlight),
  };
}

export function extractAmbientCommandText(transcript: string, triggerPattern: RegExp): string {
  const normalized = normalizeVoiceText(transcript);
  if (!normalized) return '';
  const triggerMatch = normalized.match(triggerPattern);
  if (!triggerMatch) {
    return normalized.trim();
  }

  return normalized
    .slice((triggerMatch.index ?? 0) + triggerMatch[0].length)
    .replace(/^[\s,.:;!?\-'"]+/, '')
    .trim();
}

export function resolveAmbientDetectorFinishRequest(
  detectorTranscript: string,
  triggerPattern: RegExp,
  endPattern: RegExp,
  qwenPreviewText: string,
): AmbientDetectorFinishRequest | null {
  const detectorCommandText = extractAmbientCommandText(detectorTranscript, triggerPattern);
  const endAction = resolveAmbientEndPhrase(detectorCommandText, endPattern, false);
  if (endAction.type === 'none') {
    return null;
  }

  return {
    matchedPhrase: endAction.matchedPhrase,
    // Native streaming hypotheses can retract the full utterance down to the
    // trailing end phrase. Preserve the last qwen preview so finalization still
    // has command text to reconcile against.
    previewText: endAction.type === 'reset-empty'
      ? normalizeVoiceText(qwenPreviewText)
      : endAction.finalText,
  };
}

export function resolveAmbientCommandFinalText(
  qwenTranscript: string,
  nativePreviewText: string,
  triggerPattern: RegExp,
  endPattern: RegExp,
): AmbientCommandFinalText {
  const qwenCommandText = extractAmbientCommandText(qwenTranscript, triggerPattern);
  const finalCommandText = qwenCommandText || normalizeVoiceText(nativePreviewText);
  const resolved = resolveAmbientEndPhrase(finalCommandText, endPattern, false);

  return {
    finalText: resolved.type === 'send'
      ? resolved.finalText
      : resolved.type === 'reset-empty'
        ? ''
        : finalCommandText.trim(),
    source: qwenCommandText ? 'qwen' : 'native-detector',
  };
}
