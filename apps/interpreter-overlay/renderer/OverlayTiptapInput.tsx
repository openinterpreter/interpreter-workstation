/**
 * OverlayTiptapInput
 *
 * Minimal TipTap editor for the Interpreter Overlay's input panel. Replaces
 * the old plain <textarea> so the overlay can accept pasted text snippets
 * and pasted/dropped images as attachment chips, while preserving the
 * overlay's existing layout (bottom strip, font auto-scaling, voice transcript
 * merge, Enter-to-submit). This is the current UI surface that emits image
 * payload attachments; the desktop agent composer keeps image paste/drop on
 * the file-reference path instead.
 */

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import HardBreak from '@tiptap/extension-hard-break';
import Placeholder from '@tiptap/extension-placeholder';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  AttachmentChip,
  createAttachmentStore,
  handleComposerPaste,
  handleComposerDrop,
  serializeEditorWithAttachments,
  type AttachmentStore,
  type ComposerImageAttachment,
  type SerializedComposerSubmission,
} from '../../../agent/components/composer/attachment';
import {
  OverlaySkillMention,
  createOverlaySkillMentionSuggestion,
  type OverlaySkillMentionDropdownData,
} from './overlaySkillMentions';

export interface OverlayTiptapInputHandle {
  focus(): void;
  blur(): void;
  clear(): void;
  /**
   * Replace the editor's plain-text content with `value`. Used for voice
   * transcript streaming. Preserves no previous content (matches the
   * textarea's `setInputValue(transcript)` semantics).
   */
  setPlainText(value: string): void;
  /** Current serialized submission: `{ text, attachments }`. */
  getSubmission(): SerializedComposerSubmission;
  /** Whether the editor currently has any non-whitespace content or chips. */
  hasContent(): boolean;
}

export interface OverlayTiptapInputProps {
  readOnly?: boolean;
  autoFocus?: boolean;
  fontSize: number;
  lineHeight: number;
  maxHeight: number;
  skillDropdownData?: OverlaySkillMentionDropdownData | null;
  /**
   * Optional external attachment store. If provided, the caller owns the
   * store's lifetime (so a host popover can read from it). If omitted, the
   * editor creates and manages its own per-instance store.
   */
  store?: AttachmentStore;
  onChange?(text: string, hasContent: boolean): void;
  onSubmit?(submission: SerializedComposerSubmission): void;
  onFilesDropped?(files: File[]): void | Promise<void>;
  onFocus?(): void;
  onBlur?(): void;
  onReady?(): void;
  onEmptyBackspace?(): void;
  onHeightChange?(height: number): void;
  onWarn?(message: string): void;
  onError?(message: string): void;
}

export const OverlayTiptapInput = forwardRef<OverlayTiptapInputHandle, OverlayTiptapInputProps>(
  function OverlayTiptapInput(
    {
      readOnly = false,
      autoFocus = true,
      fontSize,
      lineHeight,
      maxHeight,
      skillDropdownData = null,
      onChange,
      onSubmit,
      onFilesDropped,
      onFocus,
      onBlur,
      onReady,
      onEmptyBackspace,
      onHeightChange,
      onWarn,
      onError,
      store,
    },
    ref,
  ) {
    "use no memo";

    const internalStoreRef = useRef<AttachmentStore>(createAttachmentStore());
    const attachmentStore = store ?? internalStoreRef.current;
    const editorWrapperRef = useRef<HTMLDivElement | null>(null);
    const skillDropdownDataRef = useRef<OverlaySkillMentionDropdownData | null>(skillDropdownData);
    const [documentVersion, setDocumentVersion] = useState(0);
    const bumpDocumentVersion = useCallback(() => {
      setDocumentVersion((version) => version + 1);
    }, []);

    useEffect(() => {
      skillDropdownDataRef.current = skillDropdownData;
    }, [skillDropdownData]);

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: false,
          horizontalRule: false,
          blockquote: false,
          codeBlock: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          hardBreak: false,
        }),
        HardBreak.configure({ keepMarks: false }),
        Placeholder.configure({
          placeholder: '',
          showOnlyWhenEditable: true,
          showOnlyCurrent: true,
        }),
        OverlaySkillMention.configure({
          suggestion: createOverlaySkillMentionSuggestion({
            getContainer: () => editorWrapperRef.current,
            getDropdownData: () => skillDropdownDataRef.current,
          }),
        }),
        AttachmentChip,
      ],
      content: '',
      editable: !readOnly,
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: 'overlay-tiptap-input__content',
          spellcheck: 'false',
        },
        handleKeyDown: (_view, event) => {
          if (event.key === 'Backspace' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
            const submission = serializeEditorWithAttachments(
              editor?.getJSON() as never,
              attachmentStore,
            );
            if (!submission.text.trim() && submission.attachments.length === 0) {
              onEmptyBackspace?.();
              return true;
            }
          }

          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            const submission = serializeEditorWithAttachments(
              editor?.getJSON() as never,
              attachmentStore,
            );
            if (submission.text.trim() || submission.attachments.length > 0) {
              onSubmit?.(submission);
            }
            return true;
          }
          return false;
        },
        handlePaste: (_view, event) => {
          if (!editor) return false;
          const items = Array.from(event.clipboardData?.items ?? []);
          const hasImage = items.some(
            (item) => item.kind === 'file' && item.type.startsWith('image/'),
          );
          if (!hasImage) return false;
          event.preventDefault();
          void handleComposerPaste(event, editor, attachmentStore, {
            onWarn,
            onError,
          });
          return true;
        },
        handleDrop: (_view, event, _slice, _moved) => {
          if (!editor) return false;
          const dragEvent = event as DragEvent;
          const files = Array.from(dragEvent.dataTransfer?.files ?? []);
          if (files.length > 0 && onFilesDropped) {
            dragEvent.preventDefault();
            void onFilesDropped(files);
            return true;
          }
          const hasImage = files.some((f) => f.type.startsWith('image/'));
          if (!hasImage) return false;
          dragEvent.preventDefault();
          void handleComposerDrop(dragEvent, editor, attachmentStore, {
            onWarn,
            onError,
          });
          return true;
        },
      },
      onUpdate: ({ editor: ed }) => {
        reconcileAttachmentStore(ed.getJSON() as never, attachmentStore);
        const submission = serializeEditorWithAttachments(
          ed.getJSON() as never,
          attachmentStore,
        );
        const has =
          submission.text.trim().length > 0 || submission.attachments.length > 0;
      onChange?.(submission.text, has);
      bumpDocumentVersion();
    },
      onFocus: () => onFocus?.(),
      onBlur: () => onBlur?.(),
    });

    useEffect(() => {
      if (!editor) return;
      editor.setEditable(!readOnly);
    }, [editor, readOnly]);

    useEffect(() => {
      if (!editor) return;
      onReady?.();
    }, [editor, onReady]);

    // Measure content height and report up. The editor wrapper's scrollHeight
    // reflects all wrapped text + chips; we clamp to maxHeight.
    useLayoutEffect(() => {
      const el = editorWrapperRef.current;
      if (!el) return;
      const measured = Math.max(el.scrollHeight, lineHeight);
      const clamped = Math.min(measured, maxHeight);
      onHeightChange?.(clamped);
    }, [documentVersion, editor, fontSize, lineHeight, maxHeight, onHeightChange]);

    const setPlainText = useCallback(
      (value: string) => {
        if (!editor) return;
        editor.commands.setContent(
          value
            ? {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: value ? [{ type: 'text', text: value }] : [],
                  },
                ],
              }
            : { type: 'doc', content: [{ type: 'paragraph' }] },
          { emitUpdate: false },
        );
        bumpDocumentVersion();
      },
      [bumpDocumentVersion, editor],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus() {
          editor?.commands.focus('end');
        },
        blur() {
          editor?.commands.blur();
        },
        clear() {
          editor?.commands.clearContent(false);
          attachmentStore.clear();
          bumpDocumentVersion();
        },
        setPlainText,
        getSubmission() {
          if (!editor) return { text: '', attachments: [] };
          return serializeEditorWithAttachments(
            editor.getJSON() as never,
            attachmentStore,
          );
        },
        hasContent() {
          if (!editor) return false;
          const json = editor.getJSON() as never;
          const sub = serializeEditorWithAttachments(json, attachmentStore);
          return sub.text.trim().length > 0 || sub.attachments.length > 0;
        },
      }),
      [attachmentStore, bumpDocumentVersion, editor, setPlainText],
    );

    return (
      <div
        ref={editorWrapperRef}
        className="overlay-tiptap-input overlay-skill-mention-anchor"
        style={{
          fontSize: `${fontSize}px`,
          lineHeight: `${lineHeight}px`,
          maxHeight: `${maxHeight}px`,
          overflowY: 'auto',
          outline: 'none',
        }}
      >
        <EditorContent editor={editor} />
      </div>
    );
  },
);

/**
 * Remove attachment records whose chip nodes are no longer in the editor doc.
 * Called on every doc update so the store doesn't leak past the chip lifetime.
 */
function reconcileAttachmentStore(
  doc: { type: string; content?: unknown[] },
  store: AttachmentStore,
): void {
  const liveIds = new Set<string>();
  collectChipIds(doc, liveIds);
  for (const record of store.snapshot()) {
    if (!liveIds.has(record.id)) store.remove(record.id);
  }
}

function collectChipIds(
  node: unknown,
  out: Set<string>,
): void {
  if (!node || typeof node !== 'object') return;
  const n = node as {
    type?: string;
    attrs?: { id?: string };
    content?: unknown[];
  };
  if (n.type === 'attachmentChip' && typeof n.attrs?.id === 'string') {
    out.add(n.attrs.id);
  }
  if (Array.isArray(n.content)) {
    for (const child of n.content) collectChipIds(child, out);
  }
}

// Exported for unit tests.
export const __test__ = { reconcileAttachmentStore, collectChipIds };
export type { ComposerImageAttachment };
