/**
 * Diff Detection Utility
 *
 * Pure functions for determining when to show diff UI in editors.
 * The diff UI should only appear when an external process modifies
 * the file on disk, NOT when the user's own edits are autosaved.
 */

export interface DiffDecision {
  shouldShowDiff: boolean;
  reason: 'self-save' | 'content-match' | 'external-change';
}

export interface MarkdownDiffDisplayDecision {
  hasDiffs: boolean;
  reviewMarkdownEdits: boolean;
  lastSavedContent: string;
  editorContent: string;
}

/**
 * Determines whether to show the diff UI when a file change is detected.
 *
 * @param diskContent - The new content read from disk
 * @param lastSavedContent - The content we last wrote to disk (tracks self-saves)
 * @param editorContent - The current content in the editor
 * @returns Decision object with shouldShowDiff flag and reason
 */
export function shouldShowDiff(
  diskContent: string,
  lastSavedContent: string,
  editorContent: string
): DiffDecision {
  // If disk matches what we last saved, this was our own save - skip diff
  if (diskContent === lastSavedContent) {
    return { shouldShowDiff: false, reason: 'self-save' };
  }

  // If disk matches current editor content, no diff needed
  if (diskContent === editorContent) {
    return { shouldShowDiff: false, reason: 'content-match' };
  }

  // External change detected - show diff
  return { shouldShowDiff: true, reason: 'external-change' };
}

/**
 * Determines whether markdown external changes should use the review UI instead
 * of animation mode.
 *
 * Always prefer review mode when user edits are still only in editor memory
 * (editor content diverges from last known saved content), even if the global
 * "review markdown edits" setting is disabled.
 */
export function shouldUseMarkdownDiffReview({
  hasDiffs,
  reviewMarkdownEdits,
  lastSavedContent,
  editorContent,
}: MarkdownDiffDisplayDecision): boolean {
  if (!hasDiffs) {
    return false;
  }

  return reviewMarkdownEdits || editorContent !== lastSavedContent;
}
