import { describe, expect, it } from 'bun:test';
import {
  isChineseLanguageCode,
  normalizeTranscriptText,
  resolveEffectiveTranscriptLanguage,
  sanitizeTranscriptForLanguage,
} from './sttTranscriptSanitizer';

describe('sttTranscriptSanitizer', () => {
  it('detects Chinese language codes', () => {
    expect(isChineseLanguageCode('zh-CN')).toBe(true);
    expect(isChineseLanguageCode('zh-Hans-CN')).toBe(true);
    expect(isChineseLanguageCode('en-US')).toBe(false);
  });

  it('normalizes transcript spacing around punctuation', () => {
    expect(normalizeTranscriptText("  Yep  --  I'm here .  ")).toBe("Yep -- I'm here.");
    expect(normalizeTranscriptText('" 什么 ？"')).toBe('"什么？"');
  });

  it('strips Han characters for non-Chinese locales when enabled', () => {
    expect(
      sanitizeTranscriptForLanguage("嘶 。 Yep -- I'm here. 什么 ？", 'en', true),
    ).toBe("Yep -- I'm here.");
    expect(
      sanitizeTranscriptForLanguage('什么？', 'en-US', true),
    ).toBe('');
  });

  it('keeps Han characters for Chinese locales', () => {
    expect(
      sanitizeTranscriptForLanguage('什么 是。', 'zh-CN', true),
    ).toBe('什么 是。');
  });

  it('keeps Han characters when stripping is disabled', () => {
    expect(
      sanitizeTranscriptForLanguage('什么？', 'en-US', false),
    ).toBe('什么？');
  });

  it('resolves effective language from locale-like environment values', () => {
    expect(resolveEffectiveTranscriptLanguage('zh_CN.UTF-8')).toBe('zh-CN');
    expect(resolveEffectiveTranscriptLanguage('en_US@formal')).toBe('en-US');
  });
});
