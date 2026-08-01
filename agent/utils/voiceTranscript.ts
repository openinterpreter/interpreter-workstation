export function normalizeVoiceText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Build a regex that matches a phrase case-insensitively, tolerating
 * punctuation and extra whitespace between words so that ASR output like
 * "make it, so" or "Make. It. So." still matches "make it so".
 */
export function buildTolerantPhrasePattern(phrase: string): RegExp {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return /(?!)/;
  const escaped = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('[\\s,\\.!?;:\'"\\-]*\\s*'), 'i');
}

export function buildTolerantPhraseSetPattern(phrases: readonly string[]): RegExp {
  const variants = phrases
    .map((phrase) => buildTolerantPhrasePattern(phrase))
    .filter((pattern) => pattern.source !== '(?!)')
    .sort((left, right) => right.source.length - left.source.length);

  if (variants.length === 0) {
    return /(?!)/;
  }

  return new RegExp(
    variants.map((pattern) => `(?:${pattern.source})`).join('|'),
    'i',
  );
}

/**
 * qwen_asr transcript updates revise the tail of the current utterance instead
 * of appending monotonically. Merge the new fragment into the existing rolling
 * transcript by preserving the longest token overlap.
 */
export function mergeStreamingVoiceTranscript(previousText: string, nextText: string): string {
  const previous = normalizeVoiceText(previousText);
  const next = normalizeVoiceText(nextText);

  if (!previous) return next;
  if (!next) return previous;
  if (previous === next) return previous;
  if (next.includes(previous)) return next;

  const previousTokens = previous.split(' ');
  const nextTokens = next.split(' ');
  let sharedPrefixLength = 0;
  while (
    sharedPrefixLength < previousTokens.length
    && sharedPrefixLength < nextTokens.length
    && previousTokens[sharedPrefixLength] === nextTokens[sharedPrefixLength]
  ) {
    sharedPrefixLength += 1;
  }

  // qwen revisions commonly keep the stable prefix and rewrite or retract the
  // tail. When both fragments still begin at the same point, trust the latest
  // hypothesis instead of preserving stale suffix tokens.
  if (sharedPrefixLength > 0) {
    return next;
  }

  const maxOverlap = Math.min(previousTokens.length, nextTokens.length);

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const previousSuffix = previousTokens.slice(-overlap).join(' ');
    const nextPrefix = nextTokens.slice(0, overlap).join(' ');
    if (previousSuffix === nextPrefix) {
      const suffix = nextTokens.slice(overlap).join(' ');
      return suffix ? `${previous} ${suffix}` : previous;
    }
  }

  return `${previous} ${next}`.trim();
}
