const CHINESE_TRANSCRIPT_NOISE_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF、，。！？；：]/gu;
const SPACING_BEFORE_PUNCTUATION_PATTERN = /\s+([,.;:!?)\]}，。！？；：])/gu;
const SPACING_AFTER_OPENING_PUNCTUATION_PATTERN = /([([{'"`“‘])\s+/gu;
const VISIBLE_TEXT_PATTERN = /[\p{Letter}\p{Number}]/u;
const PROCESS_LANGUAGE_ENV_KEYS = ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const;

export function isChineseLanguageCode(language: string | null | undefined): boolean {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized.startsWith('zh');
}

export function normalizeTranscriptText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(SPACING_BEFORE_PUNCTUATION_PATTERN, '$1')
    .replace(SPACING_AFTER_OPENING_PUNCTUATION_PATTERN, '$1')
    .trim();
}

function normalizeLanguageCandidate(language: string | null | undefined): string | null {
  const normalized = language?.trim();
  if (!normalized) {
    return null;
  }

  return normalized
    .replace(/\..*$/, '')
    .replace(/@.*$/, '')
    .replace(/_/g, '-');
}

export function resolveEffectiveTranscriptLanguage(language: string | null | undefined): string | null {
  const explicitLanguage = normalizeLanguageCandidate(language);
  if (explicitLanguage) {
    return explicitLanguage;
  }

  if (typeof process !== 'undefined' && process.env) {
    for (const envKey of PROCESS_LANGUAGE_ENV_KEYS) {
      const candidate = normalizeLanguageCandidate(process.env[envKey]);
      if (candidate) {
        return candidate;
      }
    }
  }

  const runtimeLocale = normalizeLanguageCandidate(
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : null,
  );
  return runtimeLocale;
}

export function sanitizeTranscriptForLanguage(
  text: string,
  language: string | null | undefined,
  stripChineseCharacters: boolean,
): string {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) {
    return '';
  }

  const effectiveLanguage = resolveEffectiveTranscriptLanguage(language);
  if (!stripChineseCharacters || isChineseLanguageCode(effectiveLanguage)) {
    return normalized;
  }

  const stripped = normalizeTranscriptText(
    normalized.replace(CHINESE_TRANSCRIPT_NOISE_PATTERN, ''),
  );
  if (!stripped) {
    return '';
  }

  return VISIBLE_TEXT_PATTERN.test(stripped) ? stripped : '';
}
