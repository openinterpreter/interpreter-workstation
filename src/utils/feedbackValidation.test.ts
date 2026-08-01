import { describe, expect, test } from 'bun:test';
import { isMeaningfulFeedbackMessage } from './feedbackValidation';

describe('isMeaningfulFeedbackMessage', () => {
  test('returns false for empty or whitespace-only messages', () => {
    expect(isMeaningfulFeedbackMessage('')).toBe(false);
    expect(isMeaningfulFeedbackMessage('   ')).toBe(false);
  });

  test('returns false for messages shorter than 10 characters', () => {
    expect(isMeaningfulFeedbackMessage('.')).toBe(false);
    expect(isMeaningfulFeedbackMessage('abcd')).toBe(false);
    expect(isMeaningfulFeedbackMessage('  ab  ')).toBe(false);
    expect(isMeaningfulFeedbackMessage('...!?')).toBe(false);
    expect(isMeaningfulFeedbackMessage('abcde')).toBe(false);
    expect(isMeaningfulFeedbackMessage('123456789')).toBe(false);
  });

  test('returns true for messages with 10 or more characters', () => {
    expect(isMeaningfulFeedbackMessage('1234567890')).toBe(true);
    expect(isMeaningfulFeedbackMessage('Bug in PDF export')).toBe(true);
    expect(isMeaningfulFeedbackMessage('Ошибка 500')).toBe(true);
    expect(isMeaningfulFeedbackMessage('版本2崩溃，请修复这个问题')).toBe(true);
  });
});
