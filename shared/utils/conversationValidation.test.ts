import { describe, test, expect } from 'bun:test';
import { validateConversationId } from './conversationValidation';

describe('validateConversationId', () => {
  test('accepts valid format: conv-{timestamp}-{id}', () => {
    expect(validateConversationId('conv-1704067200000-abc123')).toBe(true);
  });

  test('accepts uppercase letters in id portion', () => {
    expect(validateConversationId('conv-123-ABC')).toBe(true);
  });

  test('accepts underscores and hyphens in id', () => {
    expect(validateConversationId('conv-123-a_b-c')).toBe(true);
  });

  test('accepts minimal valid id', () => {
    expect(validateConversationId('conv-0-a')).toBe(true);
  });

  test('rejects path traversal: ../etc/passwd', () => {
    expect(validateConversationId('../etc/passwd')).toBe(false);
  });

  test('rejects path traversal with valid prefix: conv-123-../../etc', () => {
    expect(validateConversationId('conv-123-../../etc')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(validateConversationId('')).toBe(false);
  });

  test('rejects path separators', () => {
    expect(validateConversationId('conv-123-abc/def')).toBe(false);
    expect(validateConversationId('conv-123-abc\\def')).toBe(false);
  });

  test('rejects non-numeric timestamp', () => {
    expect(validateConversationId('conv-abc-123')).toBe(false);
  });

  test('rejects missing id portion', () => {
    expect(validateConversationId('conv-123-')).toBe(false);
  });

  test('rejects special characters', () => {
    expect(validateConversationId('conv-123-abc!@#')).toBe(false);
  });

  test('rejects missing prefix', () => {
    expect(validateConversationId('1704067200000-abc123')).toBe(false);
  });
});
