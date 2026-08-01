/**
 * CodeViewer - TipTap-based code editor with syntax highlighting
 *
 * Uses TipTap with CodeBlockLowlight for syntax highlighting.
 * Provides real-time selection tracking and proper code editing.
 */

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import { common, createLowlight } from 'lowlight';
import { useEffect, useState, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { readFile, writeFile } from '../api';
import { trackDocumentEdited } from '../utils/telemetry';
import { useFileRefresh } from '../hooks/useFileRefresh';
import { SaveStatus } from './ui/save-status';
import { openFeedbackPopover } from '../utils/feedback';
import { EditorShell, EditorToolbar, EditorContentSurface } from './EditorShell';

// Create lowlight instance with common languages
const lowlight = createLowlight(common);

interface CodeViewerProps {
  filePath: string;
}

type SaveStatus = 'saved' | 'unsaved' | 'saving';

export interface SearchMatch {
  from: number;
  to: number;
}

export interface CodeViewerRef {
  getContent: () => string;
  search: (query: string) => SearchMatch[];
  highlightMatch: (match: SearchMatch) => void;
  clearHighlights: () => void;
}

const LOADING_DELAY_MS = 150;
const SAVE_DEBOUNCE_MS = 1000;
const SAVE_INDICATOR_DELAY_MS = 1500;

// Map file extensions to language identifiers
const extensionToLanguage: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  json: 'json',
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  r: 'r',
  lua: 'lua',
  pl: 'perl',
};

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return extensionToLanguage[ext] || 'plaintext';
}

/**
 * Convert code text to TipTap document format with code block
 */
function codeToTiptap(code: string, language: string): Record<string, unknown> {
  return {
    type: 'doc',
    content: [
      {
        type: 'codeBlock',
        attrs: { language },
        content: code.length > 0 ? [{ type: 'text', text: code }] : [],
      },
    ],
  };
}

/**
 * Extract code from TipTap document
 */
function tiptapToCode(doc: Record<string, unknown>): string {
  const content = doc.content as Array<Record<string, unknown>> | undefined;
  if (!content) return '';

  for (const node of content) {
    if (node.type === 'codeBlock') {
      const nodeContent = node.content as Array<Record<string, unknown>> | undefined;
      if (!nodeContent) return '';
      return nodeContent
        .filter(child => child.type === 'text')
        .map(child => child.text as string)
        .join('');
    }
  }
  return '';
}

export const CodeViewer = forwardRef<CodeViewerRef, CodeViewerProps>(
  function CodeViewer({ filePath }, ref) {
    const [content, setContent] = useState<Record<string, unknown> | null>(null);
    const [loading, setLoading] = useState(true);
    const [showLoading, setShowLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
    const [language] = useState(() => getLanguageFromPath(filePath));
    const [reloadTrigger, setReloadTrigger] = useState(0);

    // Refs
    const saveTimeoutRef = useRef<number | null>(null);
    const loadingTimerRef = useRef<number | null>(null);
    const savedIndicatorTimeoutRef = useRef<number | null>(null);
    const lastSavedContentRef = useRef<string>('');
    const hasTrackedEditRef = useRef(false);
    const isUserSavingRef = useRef(false);
    const isSearchHighlightingRef = useRef(false);

    useEffect(() => {
      hasTrackedEditRef.current = false;
    }, [filePath]);

    // TipTap editor with code block highlighting
    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          // Disable everything except basics
          bold: false,
          italic: false,
          strike: false,
          code: false,
          codeBlock: false, // We use CodeBlockLowlight instead
          blockquote: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          heading: false,
          horizontalRule: false,
          paragraph: {},
          hardBreak: {},
        }),
        CodeBlockLowlight.configure({
          lowlight,
          defaultLanguage: language,
        }),
        Placeholder.configure({
          placeholder: 'Start typing code...',
        }),
        Highlight.configure({
          multicolor: true,
          HTMLAttributes: {
            class: 'search-highlight',
          },
        }),
      ],
      content: content ?? codeToTiptap('', language),
      editable: true,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: 'prose prose-sm max-w-none focus:outline-none font-mono text-ui-base',
          spellcheck: 'false',
        },
      },
      onUpdate: ({ editor }) => {
        if (isSearchHighlightingRef.current) return;

        setSaveStatus('unsaved');

        if (!hasTrackedEditRef.current) {
          hasTrackedEditRef.current = true;
          const ext = filePath.split('.').pop()?.toLowerCase() || '';
          trackDocumentEdited({ extension: ext, fileType: 'code', filePath });
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

        const codeContent = tiptapToCode(jsonContent);
        await writeFile(filePath, codeContent);

        lastSavedContentRef.current = codeContent;
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

        let code: string | null = null;
        try {
          const result = await readFile(filePath);
          code = result.content;
        } catch (err) {
          if (!mounted) return;
          setError(err instanceof Error ? err.message : 'Failed to load file');
        }

        if (!mounted) return;

        if (code !== null) {
          lastSavedContentRef.current = code;
          const tiptapContent = codeToTiptap(code, language);
          setContent(tiptapContent);
          setSaveStatus('saved');
        }

        if (loadingTimerRef.current !== null) {
          clearTimeout(loadingTimerRef.current);
          loadingTimerRef.current = null;
        }
        setLoading(false);
        setShowLoading(false);
      }

      void loadFile();

      return () => {
        mounted = false;
        if (loadingTimerRef.current !== null) {
          clearTimeout(loadingTimerRef.current);
        }
      };
    }, [filePath, language, reloadTrigger]);

    // Update editor content when loaded
    useEffect(() => {
      if (editor && content !== null) {
        const currentContent = editor.getJSON();
        if (JSON.stringify(currentContent) !== JSON.stringify(content)) {
          editor.commands.setContent(content);
        }
      }
    }, [editor, content]);

    // Cleanup
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
      let newCode: string | null = null;
      try {
        const result = await readFile(filePath);
        newCode = result.content;
      } catch (err) {
        console.error('[CodeViewer] Error reloading file:', err);
      }

      if (newCode !== null && newCode !== lastSavedContentRef.current) {
        lastSavedContentRef.current = newCode;
        const tiptapContent = codeToTiptap(newCode, language);
        setContent(tiptapContent);
        editor?.commands.setContent(tiptapContent);
        setSaveStatus('saved');
      }
    };

    useFileRefresh(filePath, reloadFromDisk);

    // Search
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

    const clearHighlights = useCallback(() => {
      if (!editor) return;
      isSearchHighlightingRef.current = true;
      editor.commands.unsetHighlight();
      setTimeout(() => {
        isSearchHighlightingRef.current = false;
      }, 50);
    }, [editor]);

    useImperativeHandle(ref, () => ({
      getContent: () => editor ? tiptapToCode(editor.getJSON()) : '',
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
          <div className="voice-focus-content-toolbar px-4 py-2" style={{ borderBottom: 'var(--border-width) solid var(--border)' }} />
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
        <EditorToolbar className="px-4">
          <SaveStatus status={saveStatus} />
        </EditorToolbar>
        <EditorContentSurface>
          <EditorContent
            editor={editor}
            className="h-full [&_.ProseMirror]:h-full [&_.ProseMirror]:p-4 [&_.ProseMirror]:text-ui-sm [&_.ProseMirror]:leading-relaxed [&_pre]:bg-transparent [&_pre]:p-0 [&_code]:bg-transparent"
          />
        </EditorContentSurface>
      </EditorShell>
    );
  }
);

export default CodeViewer;
