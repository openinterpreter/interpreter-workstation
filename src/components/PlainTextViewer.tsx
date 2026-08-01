/**
 * PlainTextViewer - TipTap-based plain text editor
 *
 * Uses TipTap for editing but with NO rich formatting extensions.
 * This gives us real-time selection tracking (via selectionchange event)
 * while keeping the content as plain text.
 */

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import { useEffect, useState, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { readFile, writeFile } from '../api';
import { useFileRefresh } from '../hooks/useFileRefresh';
import { trackDocumentEdited } from '../utils/telemetry';
import { SaveStatus } from './ui/save-status';
import { openFeedbackPopover } from '../utils/feedback';
import { EditorShell, EditorToolbar, EditorContentSurface } from './EditorShell';

interface PlainTextViewerProps {
  filePath: string;
}

type SaveStatus = 'saved' | 'unsaved' | 'saving';

export interface SearchMatch {
  from: number;
  to: number;
}

export interface PlainTextViewerRef {
  getContent: () => string;
  search: (query: string) => SearchMatch[];
  highlightMatch: (match: SearchMatch) => void;
  clearHighlights: () => void;
}

const LOADING_DELAY_MS = 150;
const SAVE_DEBOUNCE_MS = 1000;
const SAVE_INDICATOR_DELAY_MS = 1500;

/**
 * Convert plain text to TipTap document format
 * Each line becomes a paragraph
 */
function plainTextToTiptap(text: string): Record<string, unknown> {
  const lines = text.split('\n');

  return {
    type: 'doc',
    content: lines.map(line => ({
      type: 'paragraph',
      content: line.length > 0 ? [{ type: 'text', text: line }] : [],
    })),
  };
}

/**
 * Convert TipTap document to plain text
 * Extract text from paragraphs, join with newlines
 */
function tiptapToPlainText(doc: Record<string, unknown>): string {
  const content = doc.content as Array<Record<string, unknown>> | undefined;
  if (!content) return '';

  return content.map(node => {
    if (node.type !== 'paragraph') return '';
    const nodeContent = node.content as Array<Record<string, unknown>> | undefined;
    if (!nodeContent) return '';
    return nodeContent
      .filter(child => child.type === 'text')
      .map(child => child.text as string)
      .join('');
  }).join('\n');
}

export const PlainTextViewer = forwardRef<PlainTextViewerRef, PlainTextViewerProps>(
  function PlainTextViewer({ filePath }, ref) {
    const [content, setContent] = useState<Record<string, unknown> | null>(null);
    const [loading, setLoading] = useState(true);
    const [showLoading, setShowLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
    const [reloadTrigger, setReloadTrigger] = useState(0);

    // Refs
    const saveTimeoutRef = useRef<number | null>(null);
    const loadingTimerRef = useRef<number | null>(null);
    const savedIndicatorTimeoutRef = useRef<number | null>(null);
    const lastSavedContentRef = useRef<string>('');
    const isUserSavingRef = useRef(false);
    const isSearchHighlightingRef = useRef(false);
    const hasTrackedEditRef = useRef(false);

    useEffect(() => {
      hasTrackedEditRef.current = false;
    }, [filePath]);

    // TipTap editor with minimal extensions - NO rich formatting
    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          // Disable all rich formatting features
          bold: false,
          italic: false,
          strike: false,
          code: false,
          codeBlock: false,
          blockquote: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          heading: false,
          horizontalRule: false,
          // Keep essential text editing features
          paragraph: {},
          hardBreak: {},
        }),
        Placeholder.configure({
          placeholder: 'Start typing...',
        }),
        Highlight.configure({
          multicolor: true,
          HTMLAttributes: {
            class: 'search-highlight',
          },
        }),
      ],
      content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
      editable: true,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: 'prose prose-sm max-w-none focus:outline-none font-mono text-ui-base',
          spellcheck: 'false',
        },
      },
      onUpdate: ({ editor }) => {
        // Skip save status update if we're just highlighting search results
        if (isSearchHighlightingRef.current) return;

        setSaveStatus('unsaved');

        if (!hasTrackedEditRef.current) {
          hasTrackedEditRef.current = true;
          const ext = filePath.split('.').pop()?.toLowerCase() || 'txt';
          trackDocumentEdited({ extension: ext, fileType: 'plaintext', filePath });
        }

        if (saveTimeoutRef.current !== null) {
          clearTimeout(saveTimeoutRef.current);
        }

        saveTimeoutRef.current = window.setTimeout(() => {
          saveContent(editor);
        }, SAVE_DEBOUNCE_MS);
      },
    });

    // Save content to disk
    const saveContent = useCallback(async (editorInstance: typeof editor) => {
      if (!editorInstance) return;

      try {
        setSaveStatus('saving');
        isUserSavingRef.current = true;

        const jsonContent = editorInstance.getJSON();
        if (!jsonContent) {
          setSaveStatus('saved');
          return;
        }

        const textContent = tiptapToPlainText(jsonContent);
        await writeFile(filePath, textContent);

        lastSavedContentRef.current = textContent;
        setSaveStatus('saved');

        if (savedIndicatorTimeoutRef.current !== null) {
          clearTimeout(savedIndicatorTimeoutRef.current);
        }
        savedIndicatorTimeoutRef.current = window.setTimeout(() => {
          isUserSavingRef.current = false;
        }, SAVE_INDICATOR_DELAY_MS);

      } catch (err: unknown) {
        console.error('Failed to save file:', err);
        setError(err instanceof Error ? err.message : 'Failed to save');
        setSaveStatus('unsaved');
      }
    }, [filePath]);

    // Load file from disk
    useEffect(() => {
      let mounted = true;

      async function loadFile() {
        setLoading(true);
        setShowLoading(false);
        setError(null);

        if (loadingTimerRef.current !== null) {
          clearTimeout(loadingTimerRef.current);
        }
        loadingTimerRef.current = window.setTimeout(() => {
          if (mounted) setShowLoading(true);
        }, LOADING_DELAY_MS);

        let text: string | null = null;
        try {
          const result = await readFile(filePath);
          text = result.content;
        } catch (err) {
          if (!mounted) return;
          setError(err instanceof Error ? err.message : 'Failed to load file');
        }

        if (!mounted) return;

        if (text !== null) {
          lastSavedContentRef.current = text;
          const tiptapContent = plainTextToTiptap(text);
          setContent(tiptapContent);
          setSaveStatus('saved');
        }

        if (mounted) {
          if (loadingTimerRef.current !== null) {
            clearTimeout(loadingTimerRef.current);
            loadingTimerRef.current = null;
          }
          setLoading(false);
          setShowLoading(false);
        }
      }

      void loadFile();

      return () => {
        mounted = false;
        if (loadingTimerRef.current !== null) {
          clearTimeout(loadingTimerRef.current);
        }
      };
    }, [filePath, reloadTrigger]);

    // Update editor content when loaded content changes
    useEffect(() => {
      if (editor && content !== null) {
        const currentContent = editor.getJSON();
        if (JSON.stringify(currentContent) !== JSON.stringify(content)) {
          editor.commands.setContent(content);
        }
      }
    }, [editor, content]);

    // Cleanup timeouts on unmount
    useEffect(() => {
      return () => {
        if (saveTimeoutRef.current !== null) {
          clearTimeout(saveTimeoutRef.current);
        }
        if (savedIndicatorTimeoutRef.current !== null) {
          clearTimeout(savedIndicatorTimeoutRef.current);
        }
        editor?.destroy();
      };
    }, [editor]);

    const reloadFromDisk = async () => {
      if (isUserSavingRef.current) return;
      let newText: string | null = null;
      try {
        const result = await readFile(filePath);
        newText = result.content;
      } catch (err) {
        console.error('[PlainTextViewer] Error reloading file:', err);
      }

      if (newText !== null && newText !== lastSavedContentRef.current) {
        lastSavedContentRef.current = newText;
        const tiptapContent = plainTextToTiptap(newText);
        setContent(tiptapContent);
        editor?.commands.setContent(tiptapContent);
        setSaveStatus('saved');
      }
    };

    useFileRefresh(filePath, reloadFromDisk);

    // Search function
    const searchText = useCallback((query: string): SearchMatch[] => {
      if (!editor || !query) return [];

      const matches: SearchMatch[] = [];
      const doc = editor.state.doc;
      const searchRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

      doc.descendants((node, pos) => {
        if (node.isText && node.text) {
          let match;
          while ((match = searchRegex.exec(node.text)) !== null) {
            matches.push({
              from: pos + match.index,
              to: pos + match.index + match[0].length,
            });
          }
        }
        return true;
      });

      return matches;
    }, [editor]);

    // Highlight a match
    const highlightMatch = useCallback((match: SearchMatch) => {
      if (!editor) return;

      isSearchHighlightingRef.current = true;
      editor.commands.unsetHighlight();
      editor.chain()
        .setTextSelection({ from: match.from, to: match.to })
        .setHighlight({ color: '#ffeb3b' })
        .run();

      const element = editor.view.dom.querySelector('.search-highlight');
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      setTimeout(() => {
        isSearchHighlightingRef.current = false;
      }, 50);
    }, [editor]);

    // Clear highlights
    const clearHighlights = useCallback(() => {
      if (!editor) return;
      isSearchHighlightingRef.current = true;
      editor.commands.unsetHighlight();
      setTimeout(() => {
        isSearchHighlightingRef.current = false;
      }, 50);
    }, [editor]);

    // Expose methods through ref
    useImperativeHandle(ref, () => ({
      getContent: () => editor ? tiptapToPlainText(editor.getJSON()) : '',
      search: searchText,
      highlightMatch,
      clearHighlights,
    }), [editor, searchText, highlightMatch, clearHighlights]);

    if (loading && showLoading) {
      return (
        <div className="flex items-center justify-center h-full text-muted-foreground">
          Loading...
        </div>
      );
    }

    if (loading && !showLoading) {
      return (
        <div className="flex flex-col h-full">
          <div className="voice-focus-content-toolbar px-2" style={{ height: 'var(--unit-height)', borderBottom: 'var(--border-width) solid var(--border)' }} />
          <div className="voice-focus-content-surface flex-1 overflow-auto bg-background p-4" />
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center space-y-3">
            <div className="text-muted-foreground">Unable to load this file</div>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setReloadTrigger(t => t + 1)}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                Try again
              </button>
              <button
                onClick={() => openFeedbackPopover()}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                Report bug
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <EditorShell>
        <EditorToolbar>
          <SaveStatus status={saveStatus} />
        </EditorToolbar>
        <EditorContentSurface className="p-4">
          <EditorContent
            editor={editor}
            className="h-full w-full [&_.ProseMirror]:h-full [&_.ProseMirror]:text-ui-base [&_.ProseMirror]:font-mono [&_.ProseMirror]:leading-relaxed"
          />
        </EditorContentSurface>
      </EditorShell>
    );
  }
);

export default PlainTextViewer;
