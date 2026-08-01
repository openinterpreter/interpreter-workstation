import { describe, expect, test } from 'bun:test';
import { shouldUseMarkdownDiffReview } from './diffDetection';

describe('shouldUseMarkdownDiffReview', () => {
  test('uses review UI when review setting is enabled', () => {
    expect(shouldUseMarkdownDiffReview({
      hasDiffs: true,
      reviewMarkdownEdits: true,
      lastSavedContent: 'v1',
      editorContent: 'v1',
    })).toBe(true);
  });

  test('uses animation when review setting is disabled and no unsaved edits exist', () => {
    expect(shouldUseMarkdownDiffReview({
      hasDiffs: true,
      reviewMarkdownEdits: false,
      lastSavedContent: 'v1',
      editorContent: 'v1',
    })).toBe(false);
  });

  test('forces review UI when unsaved editor edits exist', () => {
    expect(shouldUseMarkdownDiffReview({
      hasDiffs: true,
      reviewMarkdownEdits: false,
      lastSavedContent: 'v1',
      editorContent: 'v1 with local edit',
    })).toBe(true);
  });

  test('returns false when no diffs exist', () => {
    expect(shouldUseMarkdownDiffReview({
      hasDiffs: false,
      reviewMarkdownEdits: true,
      lastSavedContent: 'v1',
      editorContent: 'v2',
    })).toBe(false);
  });
});
