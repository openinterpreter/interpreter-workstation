import { describe, test, expect } from 'bun:test';
import { shouldShowDiff } from '../../src/utils/diffDetection';

describe('diffDetection', () => {
  describe('shouldShowDiff', () => {
    test('returns self-save when disk matches lastSavedContent', () => {
      const result = shouldShowDiff(
        '# Hello\nContent here',  // diskContent
        '# Hello\nContent here',  // lastSavedContent (matches disk)
        '# Hello\nContent here'   // editorContent
      );

      expect(result.shouldShowDiff).toBe(false);
      expect(result.reason).toBe('self-save');
    });

    test('returns self-save even when editor has diverged (autosave race)', () => {
      // User typed more after autosave started but before file watcher fired
      const result = shouldShowDiff(
        '# Hello\nSaved content',      // diskContent (what was saved)
        '# Hello\nSaved content',      // lastSavedContent (matches disk)
        '# Hello\nSaved content + new' // editorContent (user kept typing)
      );

      expect(result.shouldShowDiff).toBe(false);
      expect(result.reason).toBe('self-save');
    });

    test('returns content-match when disk matches editor but not lastSaved', () => {
      // Edge case: external change happens to match what user typed
      const result = shouldShowDiff(
        '# Same content',    // diskContent
        '# Old content',     // lastSavedContent (different)
        '# Same content'     // editorContent (matches disk)
      );

      expect(result.shouldShowDiff).toBe(false);
      expect(result.reason).toBe('content-match');
    });

    test('returns external-change when disk differs from both lastSaved and editor', () => {
      const result = shouldShowDiff(
        '# Agent modified this',  // diskContent (external change)
        '# Original content',     // lastSavedContent
        '# User is editing'       // editorContent
      );

      expect(result.shouldShowDiff).toBe(true);
      expect(result.reason).toBe('external-change');
    });

    test('detects external change with empty editor', () => {
      const result = shouldShowDiff(
        '# New content from agent',  // diskContent
        '',                          // lastSavedContent (empty file)
        ''                           // editorContent (empty)
      );

      expect(result.shouldShowDiff).toBe(true);
      expect(result.reason).toBe('external-change');
    });

    test('handles whitespace-only differences', () => {
      const result = shouldShowDiff(
        '# Hello\n\n',   // diskContent (trailing newlines)
        '# Hello',       // lastSavedContent (no trailing)
        '# Hello'        // editorContent
      );

      expect(result.shouldShowDiff).toBe(true);
      expect(result.reason).toBe('external-change');
    });

    test('self-save takes priority over content-match', () => {
      // When all three match, self-save is the reason (checked first)
      const result = shouldShowDiff(
        'identical',
        'identical',
        'identical'
      );

      expect(result.shouldShowDiff).toBe(false);
      expect(result.reason).toBe('self-save');
    });

    test('rapid typing scenario: multiple autosaves', () => {
      // Simulates: user types fast, autosave fires multiple times
      // Each time disk content matches lastSaved, no diff should show

      // First autosave
      let result = shouldShowDiff('v1', 'v1', 'v1 + more');
      expect(result.shouldShowDiff).toBe(false);
      expect(result.reason).toBe('self-save');

      // Second autosave
      result = shouldShowDiff('v1 + more', 'v1 + more', 'v1 + more + even more');
      expect(result.shouldShowDiff).toBe(false);
      expect(result.reason).toBe('self-save');

      // Third autosave
      result = shouldShowDiff('v1 + more + even more', 'v1 + more + even more', 'v1 + more + even more');
      expect(result.shouldShowDiff).toBe(false);
      expect(result.reason).toBe('self-save');
    });

    test('external agent writes while user is editing', () => {
      // User is editing, agent writes to disk
      const result = shouldShowDiff(
        '# Agent added this line\n\nOriginal content',  // diskContent
        'Original content',                              // lastSavedContent
        'Original content with user edits'               // editorContent
      );

      expect(result.shouldShowDiff).toBe(true);
      expect(result.reason).toBe('external-change');
    });
  });
});
