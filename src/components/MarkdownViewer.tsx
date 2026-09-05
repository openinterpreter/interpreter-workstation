import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, useReducedMotion } from 'motion/react';
import { MarkdownFrontmatterCard } from './MarkdownFrontmatterCard';
import { MarkdownNoteContextCard } from './MarkdownNoteContextCard';
import { TipTapViewer, TipTapViewerRef, SearchMatch } from './TipTapViewer';
import { markdownToTiptap, tiptapToMarkdown } from '../utils/markdown-parser';
import {
  extractMarkdownFrontmatter,
  mapMarkdownSourceLineRangeToBody,
  serializeFrontmatterData,
  serializeMarkdownWithFrontmatter,
  type MarkdownFrontmatter,
} from '../utils/markdownFrontmatter';
import { shouldShowDiff, shouldUseMarkdownDiffReview } from '../utils/diffDetection';
import { scrollToHeading, scrollToLine, highlightLineRange, highlightHeadingRange, getLineElementsRect, getHeadingElementRect } from '../utils/editorScrolling';
import { readFile, writeFile } from '../api';
import { trackDocumentEdited } from '../utils/telemetry';
import { showContextMenu, getFileUrl, pathBasename, pathDirname, pathJoin, isAbsolutePath, uiSettings, vault, type ContextMenuItem } from '@/ipc';
import type { BooleanSettingChangedEvent } from '../../shared/booleanSettings';
import type { VaultNoteContext } from '../../shared/types/vault';
import { useFileRefresh } from '../hooks/useFileRefresh';
import * as Diff from 'diff';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { EditorToolbarSeparator } from './ui/editor-toolbar';
import { openFeedbackPopover } from '../utils/feedback';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Quote,
} from 'lucide-react';
import { isWorkstationReadOnly } from '../remote/workstationConnection';
import { SaveStatus } from './ui/save-status';
import { runEditorAnimation } from '../utils/editorAnimation';
import { formatPrimaryShortcut } from '../utils/platformShortcuts';

interface MarkdownViewerProps {
  filePath: string;
}

type SaveStatus = 'saved' | 'unsaved' | 'saving';
type ViewMode = 'rich' | 'raw';

// A segment is either unchanged content or a diff hunk
interface DiffSegment {
  type: 'unchanged' | 'diff';
  id: number;
  // For unchanged segments
  content?: string;
  // For diff segments
  oldContent?: string;
  newContent?: string;
}

const LOADING_DELAY_MS = 150;
const SAVE_DEBOUNCE_MS = 1000;
const LARGE_MARKDOWN_RAW_MODE_THRESHOLD = 500_000;
const TOOLBAR_HEIGHT = 'calc(var(--unit-height-small) + 2 * var(--unit-padding))';
const EXTERNAL_REFRESH_QUIET_MS = 180;
const EXTERNAL_REFRESH_SETTLE_CHECK_MS = 120;
const EXTERNAL_REFRESH_MAX_ATTEMPTS = 6;

export function MarkdownViewer({ filePath }: MarkdownViewerProps) {
  "use no memo";

  const { t } = useTranslation();
  const reduceMotion = useReducedMotion() ?? false;
  const [content, setContent] = useState<Record<string, unknown> | null>(null);
  const [frontmatter, setFrontmatter] = useState<MarkdownFrontmatter | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [viewMode, setViewMode] = useState<ViewMode>('rich');
  const [rawContent, setRawContent] = useState<string>('');
  const [isMetadataOpen, setIsMetadataOpen] = useState(true);
  const [hasLinkMetadata, setHasLinkMetadata] = useState(false);
  const [initialNoteContext, setInitialNoteContext] = useState<VaultNoteContext | null>(null);
  const [initialNoteContextError, setInitialNoteContextError] = useState<string | null>(null);
  const [noteContextReady, setNoteContextReady] = useState(false);
  const [showToolbar, setShowToolbar] = useState(true);
  const [toolbarTransitionsEnabled, setToolbarTransitionsEnabled] = useState(false);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  // Diff state
  const [diffSegments, setDiffSegments] = useState<DiffSegment[]>([]);
  const [showingDiff, setShowingDiff] = useState(false);
  const [diskContent, setDiskContent] = useState<string>('');
  const [currentMarkdownRef, setCurrentMarkdownRef] = useState<string>('');

  // In-editor animation state
  const [animating, setAnimating] = useState(false);
  const animatingRef = useRef(false);
  const [reviewMarkdownEdits, setReviewMarkdownEdits] = useState(true);
  const animationCancelRef = useRef(false);

  // Search state
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rawTextareaRef = useRef<HTMLTextAreaElement>(null);
  const isSearchHighlightingRef = useRef(false);

  // Track the "resolved" document state during diff review
  // This gets updated as user accepts/rejects hunks
  const resolvedDocumentRef = useRef<string>('');

  // Refs
  const saveTimeoutRef = useRef<number | null>(null);
  const loadingTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshRequestRef = useRef(0);
  const editorRef = useRef<TipTapViewerRef>(null);
  const lastSavedContentRef = useRef<string>('');
  const saveInFlightRef = useRef(false);
  const hasTrackedEditRef = useRef(false);
  const persistMarkdownRef = useRef<
    ((markdownContent: string, options?: { trackEdit?: boolean }) => Promise<void>) | null
  >(null);
  const mentionContainerRef = useRef<HTMLDivElement>(null);
  const frontmatterCardRef = useRef<HTMLDivElement>(null);
  const getMentionContainer = useCallback(() => mentionContainerRef.current, []);

  useEffect(() => {
    hasTrackedEditRef.current = false;
  }, [filePath]);

  useEffect(() => {
    setIsMetadataOpen(true);
    setInitialNoteContext(null);
    setInitialNoteContextError(null);
    setNoteContextReady(false);
  }, [filePath]);

  useEffect(() => {
    setToolbarTransitionsEnabled(false);
    const animationFrame = window.requestAnimationFrame(() => {
      setToolbarTransitionsEnabled(true);
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [filePath]);

  // Base directory for resolving relative paths in local file links
  const baseDir = useMemo(() => pathDirname(filePath), [filePath]);
  const hasMetadata = useMemo(
    () => Boolean(frontmatter && Object.keys(frontmatter.data).length > 0),
    [frontmatter],
  );
  const shouldShowMetadataPanel = hasMetadata || hasLinkMetadata;

  const parseMarkdownDocument = useCallback((markdown: string) => {
    const parsed = extractMarkdownFrontmatter(markdown);
    return {
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      tiptapContent: markdownToTiptap(parsed.body, baseDir),
    };
  }, [baseDir]);

  const applyMarkdownDocument = useCallback((
    markdown: string,
    options?: { updateRawContent?: boolean },
  ) => {
    const parsed = parseMarkdownDocument(markdown);
    setFrontmatter(parsed.frontmatter);
    setContent(parsed.tiptapContent);
    if (options?.updateRawContent ?? true) {
      setRawContent(markdown);
    }
    return parsed;
  }, [parseMarkdownDocument]);

  const serializeEditorMarkdown = useCallback((jsonContent: Record<string, unknown> | null | undefined) => {
    const bodyMarkdown = jsonContent ? tiptapToMarkdown(jsonContent) : '';
    return serializeMarkdownWithFrontmatter(bodyMarkdown, frontmatter);
  }, [frontmatter]);

  const persistMarkdown = useCallback(async (
    markdownContent: string,
    options?: { trackEdit?: boolean },
  ) => {
    if (saveInFlightRef.current) {
      if (saveTimeoutRef.current !== null) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = window.setTimeout(() => {
        const nextPersistMarkdown = persistMarkdownRef.current;
        if (nextPersistMarkdown) {
          void nextPersistMarkdown(markdownContent, options);
        }
      }, SAVE_DEBOUNCE_MS);
      return;
    }

    const shouldTrackEdit = options?.trackEdit === true && !hasTrackedEditRef.current;
    try {
      setSaveStatus('saving');
      saveInFlightRef.current = true;

      if (shouldTrackEdit) {
        hasTrackedEditRef.current = true;
        trackDocumentEdited({ extension: 'md', fileType: 'markdown', filePath });
      }

      lastSavedContentRef.current = markdownContent;
      setRawContent(markdownContent);
      await writeFile(filePath, markdownContent);
      setSaveStatus('saved');
    } catch (err: unknown) {
      console.error('Failed to save file:', err);
      setError(err instanceof Error ? err.message : 'Failed to save');
      setSaveStatus('unsaved');
    }

    saveInFlightRef.current = false;
  }, [filePath]);

  useEffect(() => {
    persistMarkdownRef.current = persistMarkdown;
  }, [persistMarkdown]);

  const resolveSourceLineTarget = useCallback((lineStart: number, lineEnd?: number) => {
    return mapMarkdownSourceLineRangeToBody(frontmatter, lineStart, lineEnd);
  }, [frontmatter]);

  const scrollFrontmatterCardIntoView = useCallback(() => {
    const frontmatterElement = frontmatterCardRef.current;
    if (frontmatterElement) {
      frontmatterElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }

    return false;
  }, []);

  const highlightFrontmatterCard = useCallback(() => {
    const frontmatterElement = frontmatterCardRef.current;
    if (!frontmatterElement) {
      return null;
    }

    frontmatterElement.classList.add('mention-hover-highlight');
    return () => {
      frontmatterElement.classList.remove('mention-hover-highlight');
    };
  }, []);

  const getFrontmatterCardRect = useCallback((): DOMRect | null => {
    return frontmatterCardRef.current?.getBoundingClientRect() ?? null;
  }, []);

  // Resolve image src paths to displayable API URLs.
  // Handles absolute paths, relative paths (resolved from this file's directory),
  // and passes through external URLs unchanged.
  const resolveImageSrc = useCallback(async (src: string): Promise<string> => {
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    let absolutePath = src;
    if (!isAbsolutePath(src)) {
      const dir = pathDirname(filePath);
      absolutePath = pathJoin(dir, src.replace(/^\.\//, ''));
    }
    return getFileUrl(absolutePath);
  }, [filePath]);

  // Load review markdown edits setting
  useEffect(() => {
    async function loadSetting() {
      try {
        const response = await uiSettings.getReviewMarkdownEdits();
        setReviewMarkdownEdits(response.enabled);
      } catch (error) {
        console.error('[MarkdownViewer] Failed to load review markdown edits setting:', error);
      }
    }
    loadSetting();

    const unsubscribe = uiSettings.onReviewMarkdownEditsChanged?.((event: BooleanSettingChangedEvent) => {
      setReviewMarkdownEdits(event.enabled);
    });

    return unsubscribe;
  }, []);

  // Load markdown from disk
  useEffect(() => {
    let mounted = true;

    function loadNoteContext() {
      // Keep note indexing metadata off the critical first-read path so markdown can render as soon as file I/O finishes.
      void vault.getNoteContext({ filePath })
        .then((context) => {
          if (!mounted) return;

          setInitialNoteContext(context);
          setInitialNoteContextError(null);
          const note = context.note;
          setHasLinkMetadata(Boolean(
            note
            && (
              note.outgoingLinks.length > 0
              || note.backlinks.length > 0
            ),
          ));
        })
        .catch((noteContextError) => {
          if (!mounted) return;

          setInitialNoteContext(null);
          setInitialNoteContextError(
            noteContextError instanceof Error
              ? noteContextError.message
              : 'Failed to load note context',
          );
          setHasLinkMetadata(false);
        })
        .finally(() => {
          if (mounted) {
            setNoteContextReady(true);
          }
        });
    }

    async function loadMarkdown() {
      setLoading(true);
      setShowLoading(false);
      setError(null);
      setShowingDiff(false);
      setDiffSegments([]);
      setContent(null);
      setFrontmatter(null);
      setRawContent('');
      lastSavedContentRef.current = '';
      setNoteContextReady(false);
      setInitialNoteContext(null);
      setInitialNoteContextError(null);
      setHasLinkMetadata(false);

      if (loadingTimerRef.current !== null) {
        clearTimeout(loadingTimerRef.current);
      }
      loadingTimerRef.current = window.setTimeout(() => {
        if (mounted) setShowLoading(true);
      }, LOADING_DELAY_MS);

      let markdown: string | null = null;
      try {
        const result = await readFile(filePath);
        markdown = result.content;
      } catch (err) {
        console.error('[MarkdownViewer] Failed to load markdown file:', {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'Failed to load markdown file');
        setNoteContextReady(true);
      }

      if (!mounted) return;

      if (markdown !== null) {
        lastSavedContentRef.current = markdown;

        if (markdown.length > LARGE_MARKDOWN_RAW_MODE_THRESHOLD) {
          // Avoid the expensive Tiptap parse during initial load; users can opt into rich mode after the raw view appears.
          setRawContent(markdown);
          setViewMode('raw');
        } else {
          applyMarkdownDocument(markdown);
        }

        loadNoteContext();
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

    void loadMarkdown();

    return () => {
      mounted = false;
      if (loadingTimerRef.current !== null) {
        clearTimeout(loadingTimerRef.current);
      }
    };
  }, [applyMarkdownDocument, filePath, reloadTrigger]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current !== null) {
        clearTimeout(saveTimeoutRef.current);
      }
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  // Save content to disk
  const saveContent = useCallback(async () => {
    if (!editorRef.current) return;
    const jsonContent = editorRef.current.getJSON();
    if (!jsonContent) {
      setSaveStatus('saved');
      return;
    }
    await persistMarkdown(serializeEditorMarkdown(jsonContent), { trackEdit: true });
  }, [persistMarkdown, serializeEditorMarkdown]);

  // Handle switching between rich and raw modes
  const handleModeSwitch = useCallback((newMode: ViewMode) => {
    if (newMode === viewMode) return;

    if (newMode === 'raw') {
      // Switching to raw - get current Tiptap content as markdown
      const markdown = serializeEditorMarkdown(editorRef.current?.getJSON());
      setRawContent(markdown);
    } else {
      // Switching to rich - convert raw markdown to Tiptap
      applyMarkdownDocument(rawContent, { updateRawContent: false });
    }

    setViewMode(newMode);
  }, [applyMarkdownDocument, rawContent, serializeEditorMarkdown, viewMode]);

  // Handle raw content changes
  const handleRawChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setRawContent(newContent);
    setSaveStatus('unsaved');

    if (saveTimeoutRef.current !== null) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(async () => {
      await persistMarkdown(newContent, { trackEdit: true });
    }, SAVE_DEBOUNCE_MS);
  }, [persistMarkdown]);

  const handleFrontmatterChange = useCallback((key: string, value: unknown) => {
    setFrontmatter((current) => {
      const baseData = current?.data ?? {};
      const nextData = {
        ...baseData,
        [key]: value,
      };
      const normalizedData = Object.fromEntries(
        Object.entries(nextData).filter(([, entryValue]) => {
          if (typeof entryValue === 'string') {
            return entryValue.trim() !== '';
          }

          if (Array.isArray(entryValue)) {
            return entryValue.length > 0;
          }

          return entryValue != null;
        }),
      );
      const nextFrontmatter = Object.keys(normalizedData).length > 0
        ? {
          data: normalizedData,
          rawBlock: serializeFrontmatterData(normalizedData),
          bodyPrefix: current?.bodyPrefix ?? '\n\n',
        }
        : null;

      const currentJson = editorRef.current?.getJSON() ?? content;
      const bodyMarkdown = currentJson ? tiptapToMarkdown(currentJson as Record<string, unknown>) : '';
      const markdownContent = serializeMarkdownWithFrontmatter(bodyMarkdown, nextFrontmatter);

      setRawContent(markdownContent);
      setSaveStatus('unsaved');

      if (saveTimeoutRef.current !== null) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = window.setTimeout(() => {
        void persistMarkdown(markdownContent, { trackEdit: true });
      }, SAVE_DEBOUNCE_MS);

      return nextFrontmatter;
    });
  }, [content, persistMarkdown]);

  // Handle content changes from editor
  const handleUpdate = useCallback(() => {
    // Skip save during animation (content is being driven externally)
    if (animatingRef.current) return;
    // Skip save status update if we're just highlighting search results
    if (isSearchHighlightingRef.current) return;

    setSaveStatus('unsaved');

    if (saveTimeoutRef.current !== null) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(() => {
      saveContent();
    }, SAVE_DEBOUNCE_MS);
  }, [saveContent]);

  // Calculate diff segments (unchanged + diff hunks interleaved)
  // IMPORTANT: We preserve exact content (no trimming) so we can reconstruct the document
  const calculateDiffSegments = useCallback((currentMarkdown: string, newDiskMarkdown: string): DiffSegment[] => {
    const changes = Diff.diffLines(currentMarkdown, newDiskMarkdown);
    const segments: DiffSegment[] = [];
    let segmentId = 0;

    let i = 0;
    while (i < changes.length) {
      const change = changes[i];

      if (!change.added && !change.removed) {
        // Unchanged content - keep ALL content including whitespace-only segments
        segments.push({
          type: 'unchanged',
          id: segmentId++,
          content: change.value, // No trim - preserve exact structure
        });
        i++;
      } else {
        // Diff hunk - collect consecutive added/removed
        let oldContent = '';
        let newContent = '';

        while (i < changes.length && (changes[i].added || changes[i].removed)) {
          if (changes[i].removed) {
            oldContent += changes[i].value;
          }
          if (changes[i].added) {
            newContent += changes[i].value;
          }
          i++;
        }

        segments.push({
          type: 'diff',
          id: segmentId++,
          oldContent, // No trim - preserve exact structure
          newContent, // No trim - preserve exact structure
        });
      }
    }

    return segments;
  }, []);

  const applyDiskMarkdownUpdate = useCallback(async (newDiskMarkdown: string) => {
    try {
      let baseMarkdown: string;
      if (showingDiff && resolvedDocumentRef.current) {
        baseMarkdown = resolvedDocumentRef.current;
      } else if (animating) {
        baseMarkdown = lastSavedContentRef.current;
      } else {
        const currentJson = editorRef.current?.getJSON();
        baseMarkdown = currentJson
          ? serializeEditorMarkdown(currentJson)
          : lastSavedContentRef.current;
      }

      const decision = shouldShowDiff(newDiskMarkdown, lastSavedContentRef.current, baseMarkdown);
      if (!decision.shouldShowDiff) {
        if (decision.reason === 'content-match' && showingDiff) {
          lastSavedContentRef.current = newDiskMarkdown;
          applyMarkdownDocument(newDiskMarkdown);
          setDiffSegments([]);
          setShowingDiff(false);
          setSaveStatus('saved');
          resolvedDocumentRef.current = '';
        }
        return;
      }

      if (!resolvedDocumentRef.current) {
        resolvedDocumentRef.current = baseMarkdown;
      }

      console.log('[MarkdownViewer] External change detected, calculating diff');

      if (baseMarkdown === newDiskMarkdown) {
        lastSavedContentRef.current = newDiskMarkdown;

        if (showingDiff) {
          applyMarkdownDocument(newDiskMarkdown);
          setDiffSegments([]);
          setShowingDiff(false);
          setSaveStatus('saved');
          resolvedDocumentRef.current = '';
        }
        return;
      }

      const segments = calculateDiffSegments(baseMarkdown, newDiskMarkdown);
      const hasDiffs = segments.some(s => s.type === 'diff');

      if (hasDiffs) {
        if (shouldUseMarkdownDiffReview({
          hasDiffs,
          reviewMarkdownEdits,
          lastSavedContent: lastSavedContentRef.current,
          editorContent: baseMarkdown,
        })) {
          setCurrentMarkdownRef(baseMarkdown);
          setDiskContent(newDiskMarkdown);
          setDiffSegments(segments);
          setShowingDiff(true);
        } else {
          animationCancelRef.current = false;
          animatingRef.current = true;
          setAnimating(true);

          editorRef.current?.setEditable(false);

          runEditorAnimation(baseMarkdown, newDiskMarkdown, {
            setContentJSON: (json) => editorRef.current?.setContentJSON(json as Record<string, unknown>),
            setEditable: (editable) => editorRef.current?.setEditable(editable),
            isCancelled: () => animationCancelRef.current,
          }).then(() => {
            if (!animationCancelRef.current) {
              applyMarkdownDocument(newDiskMarkdown);
              lastSavedContentRef.current = newDiskMarkdown;
              setSaveStatus('saved');
            }
          }).catch((err) => {
            console.error('[MarkdownViewer] Animation error:', err);
          }).finally(() => {
            animatingRef.current = false;
            setAnimating(false);
            editorRef.current?.setEditable(true);
          });
        }
      }
    } catch (err) {
      console.error('[MarkdownViewer] Error during diff calculation:', err);
    }
  }, [animating, applyMarkdownDocument, calculateDiffSegments, reviewMarkdownEdits, serializeEditorMarkdown, showingDiff]);

  const readSettledDiskMarkdown = useCallback(async (): Promise<string> => {
    let previous = (await readFile(filePath)).content || '';

    for (let attempt = 1; attempt < EXTERNAL_REFRESH_MAX_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, EXTERNAL_REFRESH_SETTLE_CHECK_MS));
      const next = (await readFile(filePath)).content || '';
      if (next === previous) {
        return next;
      }
      previous = next;
    }

    return previous;
  }, [filePath]);

  const scheduleDiskRefresh = useCallback((source: 'agent' | 'external') => {
    const requestId = ++refreshRequestRef.current;

    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;

      void (async () => {
        try {
          const newDiskMarkdown = await readSettledDiskMarkdown();
          if (requestId !== refreshRequestRef.current) {
            return;
          }
          await applyDiskMarkdownUpdate(newDiskMarkdown);
        } catch (err) {
          console.error(`[MarkdownViewer] Error processing ${source} refresh:`, err);
        }
      })();
    }, source === 'external' ? EXTERNAL_REFRESH_QUIET_MS : 0);
  }, [applyDiskMarkdownUpdate, readSettledDiskMarkdown]);

  useFileRefresh(filePath, {
    onAgentRefresh: () => scheduleDiskRefresh('agent'),
    onExternalRefresh: () => scheduleDiskRefresh('external'),
  });

  // Listen for editor:file-drop events (files dropped onto this markdown tab's center)
  useEffect(() => {
    const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

    const handler = (e: CustomEvent) => {
      const { filePath: droppedPath, fileName, isDirectory, editorFilePath } = e.detail;
      // Only handle drops targeted at this editor's file
      if (editorFilePath !== filePath || !editorRef.current) return;

      const name = fileName || pathBasename(droppedPath) || droppedPath;
      const ext = name.split('.').pop()?.toLowerCase() || '';

      // Convert to a relative path from this markdown file's directory
      const mdDir = pathDirname(filePath);
      let insertPath = droppedPath;
      if (droppedPath.startsWith(mdDir) && (droppedPath[mdDir.length] === '/' || droppedPath[mdDir.length] === '\\')) {
        insertPath = droppedPath.slice(mdDir.length + 1); // e.g. "images/photo.png"
      }

      if (!isDirectory && IMAGE_EXTENSIONS.has(ext)) {
        editorRef.current.insertLinkedImage(insertPath, name, droppedPath);
      } else {
        editorRef.current.insertFileMention(insertPath, name, isDirectory);
      }
    };

    window.addEventListener('editor:file-drop', handler as EventListener);
    return () => window.removeEventListener('editor:file-drop', handler as EventListener);
  }, [filePath]);

  // Listen for mention:scroll-to events to scroll to a heading or line
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.path !== filePath) return;

      const editor = editorRef.current?.getEditor?.();
      if (!editor) return;

      if (detail.fragment) {
        scrollToHeading(editor, detail.fragment);
      } else if (detail.lineStart != null) {
        const lineTarget = resolveSourceLineTarget(detail.lineStart, detail.lineEnd);
        if (lineTarget.region === 'frontmatter') {
          scrollFrontmatterCardIntoView();
          return;
        }

        scrollToLine(editor, lineTarget.lineStart, lineTarget.lineEnd);
      }
    };

    window.addEventListener('mention:scroll-to', handler);
    return () => window.removeEventListener('mention:scroll-to', handler);
  }, [filePath, resolveSourceLineTarget, scrollFrontmatterCardIntoView]);

  // Listen for mention:hover-start/end to highlight specific lines or headings
  useEffect(() => {
    let cleanup: (() => void) | null = null;

    const handleHoverStart = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.path !== filePath) return;

      // Clean up any previous highlight
      if (cleanup) {
        cleanup();
        cleanup = null;
      }

      const editor = editorRef.current?.getEditor?.();
      if (!editor) return;

      const hasLineRef = detail.fragment || detail.lineStart != null;

      // Smooth-scroll to the target lines/heading when line-specific
      if (hasLineRef) {
        if (detail.fragment) {
          scrollToHeading(editor, detail.fragment);
        } else if (detail.lineStart != null) {
          const lineTarget = resolveSourceLineTarget(detail.lineStart, detail.lineEnd);
          if (lineTarget.region === 'frontmatter') {
            scrollFrontmatterCardIntoView();
          } else {
            scrollToLine(editor, lineTarget.lineStart, lineTarget.lineEnd);
          }
        }
      }

      // Apply CSS highlight
      if (detail.fragment) {
        cleanup = highlightHeadingRange(editor, detail.fragment);
      } else if (detail.lineStart != null) {
        const lineTarget = resolveSourceLineTarget(detail.lineStart, detail.lineEnd);
        cleanup = lineTarget.region === 'frontmatter'
          ? highlightFrontmatterCard()
          : highlightLineRange(editor, lineTarget.lineStart, lineTarget.lineEnd);
      }

      // Dispatch highlight-rect for line-specific mentions so ConnectionOverlay
      // can draw the box around the specific lines instead of the whole pane
      if (hasLineRef) {
        // Small delay to let scroll settle before measuring rects
        setTimeout(() => {
          let rect: DOMRect | null = null;
          if (detail.fragment) {
            rect = getHeadingElementRect(editor, detail.fragment);
          } else if (detail.lineStart != null) {
            const lineTarget = resolveSourceLineTarget(detail.lineStart, detail.lineEnd);
            rect = lineTarget.region === 'frontmatter'
              ? getFrontmatterCardRect()
              : getLineElementsRect(editor, lineTarget.lineStart, lineTarget.lineEnd);
          }
          if (rect) {
            window.dispatchEvent(new CustomEvent('mention:highlight-rect', {
              detail: { path: detail.path, rect },
            }));
          }
        }, 50);
      }
    };

    const handleHoverEnd = () => {
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
    };

    window.addEventListener('mention:hover-start', handleHoverStart);
    window.addEventListener('mention:hover-end', handleHoverEnd);
    return () => {
      window.removeEventListener('mention:hover-start', handleHoverStart);
      window.removeEventListener('mention:hover-end', handleHoverEnd);
      if (cleanup) cleanup();
    };
  }, [
    filePath,
    getFrontmatterCardRect,
    highlightFrontmatterCard,
    resolveSourceLineTarget,
    scrollFrontmatterCardIntoView,
  ]);

  // Helper to build content from segments - join with '' to preserve exact structure
  const buildContentFromSegments = useCallback((segments: DiffSegment[]): string => {
    return segments
      .filter(s => s.type === 'unchanged')
      .map(s => s.content ?? '')
      .join(''); // Empty join preserves original line structure
  }, []);

  // Cancel animation on unmount
  useEffect(() => {
    return () => {
      animationCancelRef.current = true;
    };
  }, []);

  // Handle keeping a diff (accept agent's change for this hunk)
  const handleKeepHunk = useCallback((segmentId: number) => {
    setDiffSegments(prev => {
      const updated = prev.map(seg => {
        if (seg.id === segmentId && seg.type === 'diff') {
          // Convert diff to unchanged with new content
          return {
            type: 'unchanged' as const,
            id: seg.id,
            content: seg.newContent || '',
          };
        }
        return seg;
      });

      // Update the resolved document to reflect this decision
      // For unresolved diffs, use oldContent; for resolved (unchanged), use content
      // Join with '' to preserve exact structure
      const currentResolved = updated
        .map(seg => seg.type === 'unchanged' ? (seg.content ?? '') : (seg.oldContent ?? ''))
        .join('');
      resolvedDocumentRef.current = currentResolved;

      // Check if any diffs remain
      const hasRemainingDiffs = updated.some(s => s.type === 'diff');
      if (!hasRemainingDiffs) {
        // All resolved - build final content and apply
        const finalContent = buildContentFromSegments(updated);

        applyMarkdownDocument(finalContent);
        lastSavedContentRef.current = finalContent;
        setShowingDiff(false);
        setSaveStatus('saved');
        resolvedDocumentRef.current = '';

        // Save to disk
        writeFile(filePath, finalContent).catch(console.error);
      }

      return updated;
    });
  }, [applyMarkdownDocument, buildContentFromSegments, filePath]);

  // Handle undoing a diff (reject agent's change, keep current)
  const handleUndoHunk = useCallback((segmentId: number) => {
    setDiffSegments(prev => {
      const updated = prev.map(seg => {
        if (seg.id === segmentId && seg.type === 'diff') {
          // Convert diff to unchanged with old content
          return {
            type: 'unchanged' as const,
            id: seg.id,
            content: seg.oldContent || '',
          };
        }
        return seg;
      });

      // Update the resolved document to reflect current state
      // Join with '' to preserve exact structure
      const currentResolved = updated
        .map(seg => seg.type === 'unchanged' ? (seg.content ?? '') : (seg.oldContent ?? ''))
        .join('');
      resolvedDocumentRef.current = currentResolved;

      // Check if any diffs remain
      const hasRemainingDiffs = updated.some(s => s.type === 'diff');
      if (!hasRemainingDiffs) {
        // All resolved - build final content and apply
        const finalContent = buildContentFromSegments(updated);

        applyMarkdownDocument(finalContent);
        lastSavedContentRef.current = finalContent;
        setShowingDiff(false);
        setSaveStatus('saved');
        resolvedDocumentRef.current = '';

        // Save to disk
        writeFile(filePath, finalContent).catch(console.error);
      }

      return updated;
    });
  }, [applyMarkdownDocument, buildContentFromSegments, filePath]);

  // Handle keep all (accept all agent changes)
  const handleKeepAll = useCallback(() => {
    applyMarkdownDocument(diskContent);
    lastSavedContentRef.current = diskContent;
    setDiffSegments([]);
    setShowingDiff(false);
    setSaveStatus('saved');
    resolvedDocumentRef.current = '';
  }, [applyMarkdownDocument, diskContent]);

  // Handle undo all (reject all agent changes)
  const handleUndoAll = useCallback(() => {
    // Restore current content and save to overwrite disk
    applyMarkdownDocument(currentMarkdownRef);
    setDiffSegments([]);
    setShowingDiff(false);
    resolvedDocumentRef.current = '';

    lastSavedContentRef.current = currentMarkdownRef;
    writeFile(filePath, currentMarkdownRef).then(() => {
      setSaveStatus('saved');
    }).catch(console.error);
  }, [applyMarkdownDocument, currentMarkdownRef, filePath]);

  // Search functions
  const performSearch = useCallback((query: string) => {
    isSearchHighlightingRef.current = true;

    if (!editorRef.current || !query) {
      setSearchMatches([]);
      setCurrentMatchIndex(0);
      editorRef.current?.clearHighlights();
      isSearchHighlightingRef.current = false;
      return;
    }

    const matches = editorRef.current.search(query);
    setSearchMatches(matches);
    setCurrentMatchIndex(0);

    if (matches.length > 0) {
      editorRef.current.highlightMatch(matches[0]);
    } else {
      editorRef.current.clearHighlights();
    }

    // Reset flag after a short delay to allow for async updates
    setTimeout(() => {
      isSearchHighlightingRef.current = false;
    }, 50);
  }, []);

  const goToNextMatch = useCallback(() => {
    if (searchMatches.length === 0) return;

    isSearchHighlightingRef.current = true;
    const nextIndex = (currentMatchIndex + 1) % searchMatches.length;
    setCurrentMatchIndex(nextIndex);
    editorRef.current?.highlightMatch(searchMatches[nextIndex]);

    setTimeout(() => {
      isSearchHighlightingRef.current = false;
    }, 50);
  }, [searchMatches, currentMatchIndex]);

  const goToPrevMatch = useCallback(() => {
    if (searchMatches.length === 0) return;

    isSearchHighlightingRef.current = true;
    const prevIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
    setCurrentMatchIndex(prevIndex);
    editorRef.current?.highlightMatch(searchMatches[prevIndex]);

    setTimeout(() => {
      isSearchHighlightingRef.current = false;
    }, 50);
  }, [searchMatches, currentMatchIndex]);

  const closeSearch = useCallback(() => {
    isSearchHighlightingRef.current = true;
    setIsSearchOpen(false);
    setSearchQuery('');
    setSearchMatches([]);
    setCurrentMatchIndex(0);
    editorRef.current?.clearHighlights();

    setTimeout(() => {
      isSearchHighlightingRef.current = false;
    }, 50);
  }, []);

  // Keyboard handler for CMD+F and search navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // CMD+F or Ctrl+F to open search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
        // Focus the search input after it's rendered
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }

      // Escape to close search
      if (e.key === 'Escape' && isSearchOpen) {
        e.preventDefault();
        closeSearch();
      }

      // Enter to go to next match when search is open
      if (e.key === 'Enter' && isSearchOpen && !e.shiftKey) {
        e.preventDefault();
        goToNextMatch();
      }

      // Shift+Enter to go to previous match when search is open
      if (e.key === 'Enter' && isSearchOpen && e.shiftKey) {
        e.preventDefault();
        goToPrevMatch();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSearchOpen, closeSearch, goToNextMatch, goToPrevMatch]);

  // Context menu handler for view mode switching
  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    if (isWorkstationReadOnly()) return;
    e.preventDefault();

    const items: ContextMenuItem[] = [
      {
        label: viewMode === 'raw' ? t('markdown.context.switchToFormatted') : t('markdown.context.switchToRaw'),
        action: viewMode === 'raw' ? 'rich' : 'raw',
      },
      { label: '', action: '', separator: true },
      {
        label: showToolbar ? t('markdown.context.hideToolbar') : t('markdown.context.showToolbar'),
        action: 'toggle-toolbar',
      },
    ];

    const action = await showContextMenu(items, 'markdown_viewer');
    if (action === 'rich' || action === 'raw') {
      handleModeSwitch(action);
    } else if (action === 'toggle-toolbar') {
      setShowToolbar(prev => !prev);
    }
  }, [handleModeSwitch, showToolbar, t, viewMode]);

  // Count remaining diffs
  const remainingDiffs = diffSegments.filter(s => s.type === 'diff').length;
  const hasHydratedContent = Boolean(content) || rawContent.length > 0;
  const isInitialViewReady = !loading && noteContextReady;
  const showEditableToolbar = showToolbar && !isWorkstationReadOnly();
  const toolbarStyle = {
    height: showEditableToolbar ? TOOLBAR_HEIGHT : '0px',
    opacity: showEditableToolbar ? 1 : 0,
    visibility: showEditableToolbar ? 'visible' : 'hidden',
    pointerEvents: showEditableToolbar ? 'auto' : 'none',
    background: 'var(--oa-surface-center)',
    transition: toolbarTransitionsEnabled ? undefined : 'none',
  } as const;

  if ((!isInitialViewReady && showLoading) && !hasHydratedContent) {
    return (
        <div className="flex items-center justify-center h-full text-muted-foreground">
          {t('common.loading')}
        </div>
      );
  }

  if (!isInitialViewReady && !showLoading && !hasHydratedContent) {
    return (
      <div className="flex flex-col h-full bg-[var(--oa-surface-center)]">
        <div className="voice-focus-content-toolbar overflow-hidden" style={toolbarStyle}>
          <div
            className="flex items-center justify-between"
            style={{ height: TOOLBAR_HEIGHT, paddingLeft: 'var(--unit-padding)', paddingRight: 'var(--unit-padding)', paddingTop: 'var(--unit-padding)', paddingBottom: 'var(--unit-padding)' }}
          />
        </div>
        <div className="voice-focus-content-surface flex-1 overflow-auto p-4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <div className="text-muted-foreground">{t('markdown.errorLoad')}</div>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={() => setReloadTrigger(t => t + 1)}
              className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
            >
              {t('common.tryAgain')}
            </button>
              <button
                onClick={() => openFeedbackPopover()}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                {t('common.reportBug')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      key={filePath}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduceMotion ? { duration: 0.01 } : { duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      className="flex h-full flex-col relative bg-[var(--oa-surface-center)]"
    >
      {/* Toolbar — animated slide up/down with fade */}
      <div
        className="voice-focus-content-toolbar overflow-x-auto overflow-y-hidden"
        style={toolbarStyle}
      >
        <div
          className="flex h-full w-full min-w-max items-center justify-between gap-3 [&>*]:shrink-0"
          style={{ height: TOOLBAR_HEIGHT, paddingLeft: 'var(--unit-padding)', paddingRight: 'var(--unit-padding)', paddingTop: 'var(--unit-padding)', paddingBottom: 'var(--unit-padding)' }}
        >
          <div className="flex items-center gap-1">
            <div className={`flex items-center gap-1 ${viewMode === 'raw' || animating ? 'opacity-30 pointer-events-none' : ''}`}>
              {/* Text formatting */}
              <Button
                variant="ghost"
                size="icon-row"
                title={`${t('help.markdown.bold.title')} (${formatPrimaryShortcut('B')})`}
                data-help-title={t('help.markdown.bold.title')}
                data-help-description={t('help.markdown.bold.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleBold(); }}
              >
                <Bold />
              </Button>
              <Button
                variant="ghost"
                size="icon-row"
                title={`${t('help.markdown.italic.title')} (${formatPrimaryShortcut('I')})`}
                data-help-title={t('help.markdown.italic.title')}
                data-help-description={t('help.markdown.italic.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleItalic(); }}
              >
                <Italic />
              </Button>
              <Button
                variant="ghost"
                size="icon-row"
                title={`${t('help.markdown.underline.title')} (${formatPrimaryShortcut('U')})`}
                data-help-title={t('help.markdown.underline.title')}
                data-help-description={t('help.markdown.underline.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleUnderline(); }}
              >
                <Underline />
              </Button>
              <Button
                variant="ghost"
                size="icon-row"
                title={t('help.markdown.strikethrough.title')}
                data-help-title={t('help.markdown.strikethrough.title')}
                data-help-description={t('help.markdown.strikethrough.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleStrike(); }}
              >
                <Strikethrough />
              </Button>
              <Button
                variant="ghost"
                size="icon-row"
                title={t('help.markdown.inlineCode.title')}
                data-help-title={t('help.markdown.inlineCode.title')}
                data-help-description={t('help.markdown.inlineCode.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleCode(); }}
              >
                <Code />
              </Button>

              <EditorToolbarSeparator className="mx-1" />

              {/* Headings */}
              <Button
                variant="ghost"
                size="icon-row"
                title={t('help.markdown.heading1.title')}
                data-help-title={t('help.markdown.heading1.title')}
                data-help-description={t('help.markdown.heading1.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleHeading(1); }}
              >
                <Heading1 />
              </Button>
              <Button
                variant="ghost"
                size="icon-row"
                title={t('help.markdown.heading2.title')}
                data-help-title={t('help.markdown.heading2.title')}
                data-help-description={t('help.markdown.heading2.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleHeading(2); }}
              >
                <Heading2 />
              </Button>
              <Button
                variant="ghost"
                size="icon-row"
                title={t('help.markdown.heading3.title')}
                data-help-title={t('help.markdown.heading3.title')}
                data-help-description={t('help.markdown.heading3.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleHeading(3); }}
              >
                <Heading3 />
              </Button>

              <EditorToolbarSeparator className="mx-1" />

              {/* Lists */}
              <Button
                variant="ghost"
                size="icon-row"
                title={t('help.markdown.bulletList.title')}
                data-help-title={t('help.markdown.bulletList.title')}
                data-help-description={t('help.markdown.bulletList.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleBulletList(); }}
              >
                <List />
              </Button>
              <Button
                variant="ghost"
                size="icon-row"
                title={t('help.markdown.numberedList.title')}
                data-help-title={t('help.markdown.numberedList.title')}
                data-help-description={t('help.markdown.numberedList.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleOrderedList(); }}
              >
                <ListOrdered />
              </Button>
              <Button
                variant="ghost"
                size="icon-row"
                title={t('help.markdown.taskList.title')}
                data-help-title={t('help.markdown.taskList.title')}
                data-help-description={t('help.markdown.taskList.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleTaskList(); }}
              >
                <ListTodo />
              </Button>
              <Button
                variant="ghost"
                size="icon-row"
                title={t('help.markdown.blockquote.title')}
                data-help-title={t('help.markdown.blockquote.title')}
                data-help-description={t('help.markdown.blockquote.description')}
                onMouseDown={(e) => { e.preventDefault(); editorRef.current?.toggleBlockquote(); }}
              >
                <Quote />
              </Button>
            </div>

            <EditorToolbarSeparator className="mx-1" />

            {/* Raw toggle */}
            <Button
              variant="ghost"
              size="row"
              title={viewMode === 'raw' ? t('help.markdown.formatted.title') : t('help.markdown.raw.title')}
              data-help-title={viewMode === 'raw' ? t('help.markdown.formatted.title') : t('help.markdown.raw.title')}
              data-help-description={viewMode === 'raw' ? t('help.markdown.formatted.description') : t('help.markdown.raw.description')}
              className={`text-xs ${viewMode === 'raw' ? 'bg-hover' : ''} ${animating ? 'opacity-30 pointer-events-none' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); if (!animating) handleModeSwitch(viewMode === 'raw' ? 'rich' : 'raw'); }}
            >
              {t('markdown.rawToggle')}
            </Button>
            {!isMetadataOpen && shouldShowMetadataPanel ? (
              <>
                <EditorToolbarSeparator className="mx-1" />
                <Button
                  variant="ghost"
                  size="row"
                  className="text-xs"
                  onMouseDown={(e) => { e.preventDefault(); setIsMetadataOpen(true); }}
                >
                  Show Metadata
                </Button>
              </>
            ) : null}
          </div>
          <SaveStatus status={saveStatus} />
        </div>
      </div>

      {/* Search bar */}
      {isSearchOpen && (
        <div
          className="flex items-center gap-2 px-4 py-2"
          style={{
            borderBottom: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 50%, transparent)',
            background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 42%, transparent)',
          }}
        >
          <Input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              performSearch(e.target.value);
            }}
            placeholder={t('help.markdown.search.title')}
            data-help-title={t('help.markdown.search.title')}
            data-help-description={t('help.markdown.search.description')}
            className="flex-1"
            autoFocus
          />
          <div className="text-ui-sm text-muted-foreground min-w-[60px] text-center">
            {searchMatches.length > 0 ? `${currentMatchIndex + 1}/${searchMatches.length}` : t('markdown.searchNoResults')}
          </div>
          <Button
            onClick={goToPrevMatch}
            disabled={searchMatches.length === 0}
            variant="ghost"
            size="icon-toolbar"
            title={`${t('help.markdown.previousMatch.title')} (Shift+Enter)`}
            data-help-title={t('help.markdown.previousMatch.title')}
            data-help-description={t('help.markdown.previousMatch.description')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </Button>
          <Button
            onClick={goToNextMatch}
            disabled={searchMatches.length === 0}
            variant="ghost"
            size="icon-toolbar"
            title={`${t('help.markdown.nextMatch.title')} (Enter)`}
            data-help-title={t('help.markdown.nextMatch.title')}
            data-help-description={t('help.markdown.nextMatch.description')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </Button>
          <Button
            onClick={closeSearch}
            variant="ghost"
            size="icon-toolbar"
            title={`${t('help.markdown.closeSearch.title')} (Escape)`}
            data-help-title={t('help.markdown.closeSearch.title')}
            data-help-description={t('help.markdown.closeSearch.description')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </Button>
        </div>
      )}

      {/* Editor area or diff view */}
      <div className="flex-1 overflow-auto" data-mention-connection-scope="markdown-editor">
        {showingDiff ? (
          // Inline diff view - shows full document with diff strips
          <div className="pb-4">
            {diffSegments.map((segment) => {
              if (segment.type === 'unchanged') {
                // Render unchanged content normally
                return segment.content ? (
                  <div key={segment.id} className="px-4 py-3">
                    <TipTapViewer
                      content={markdownToTiptap(segment.content, baseDir)}
                      className="text-foreground"
                      resolveImageSrc={resolveImageSrc}
                    />
                  </div>
                ) : null;
              } else {
                // Render diff hunk - minimal style
                return (
                  <div key={segment.id}>
                    {/* Old content (current) */}
                    {segment.oldContent && (
                      <div
                        className="relative mx-4 my-3 overflow-hidden rounded-[18px] px-4 py-3"
                        style={{
                          background: 'color-mix(in srgb, rgb(239 68 68) 7%, var(--background) 93%)',
                          border: 'var(--border-width) solid color-mix(in srgb, rgb(239 68 68) 18%, transparent)',
                          borderLeft: '2px solid rgb(239 68 68 / 0.38)',
                        }}
                      >
                        <div className="mb-3 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                          <span>Current</span>
                          <Button
                            onClick={() => handleUndoHunk(segment.id)}
                            variant="ghost"
                            size="xs"
                            className="relative right-0 top-0"
                          >
                            Undo
                          </Button>
                        </div>
                        <TipTapViewer
                          content={markdownToTiptap(segment.oldContent, baseDir)}
                          className="text-foreground"
                          resolveImageSrc={resolveImageSrc}
                        />
                      </div>
                    )}

                    {/* New content (agent) */}
                    {segment.newContent && (
                      <div
                        className="relative mx-4 my-3 overflow-hidden rounded-[18px] px-4 py-3"
                        style={{
                          background: 'color-mix(in srgb, rgb(34 197 94) 7%, var(--background) 93%)',
                          border: 'var(--border-width) solid color-mix(in srgb, rgb(34 197 94) 18%, transparent)',
                          borderLeft: '2px solid rgb(34 197 94 / 0.38)',
                        }}
                      >
                        <div className="mb-3 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                          <span>Proposed</span>
                          <Button
                            onClick={() => handleKeepHunk(segment.id)}
                            variant="ghost"
                            size="xs"
                            className="relative right-0 top-0"
                          >
                            Keep
                          </Button>
                        </div>
                        <TipTapViewer
                          content={markdownToTiptap(segment.newContent, baseDir)}
                          className="text-foreground"
                          resolveImageSrc={resolveImageSrc}
                        />
                      </div>
                    )}
                  </div>
                );
              }
            })}
          </div>
        ) : viewMode === 'raw' ? (
          // Raw markdown editor
          <textarea
            ref={rawTextareaRef}
            value={rawContent}
            onChange={handleRawChange}
            onContextMenu={handleContextMenu}
            className="h-full w-full resize-none bg-transparent p-4 font-mono text-ui-sm text-foreground outline-none"
            placeholder={t('markdown.placeholder')}
            spellCheck={false}
          />
        ) : (
          // Rich text editor view
          <div
            ref={mentionContainerRef}
            className={`p-4 min-h-full w-full ${animating ? 'cursor-default' : 'cursor-text'}`}
            onContextMenu={animating ? undefined : handleContextMenu}
            onClick={(e) => {
              // Focus editor when clicking on empty space (the wrapper itself)
              if (!animating && e.target === e.currentTarget) {
                editorRef.current?.focus();
              }
            }}
          >
            {shouldShowMetadataPanel ? (
              <motion.div
                ref={frontmatterCardRef}
                initial={false}
                animate={reduceMotion
                  ? { opacity: isMetadataOpen ? 1 : 0 }
                  : {
                    opacity: isMetadataOpen ? 1 : 0,
                    height: isMetadataOpen ? 'auto' : 0,
                    y: isMetadataOpen ? 0 : -8,
                  }}
                transition={reduceMotion ? { duration: 0.01 } : { duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
                style={{
                  overflow: isMetadataOpen ? 'visible' : 'hidden',
                  pointerEvents: isMetadataOpen ? 'auto' : 'none',
                }}
              >
                <div
                  aria-hidden={!isMetadataOpen}
                  style={{ visibility: isMetadataOpen ? 'visible' : 'hidden' }}
                >
                  <MarkdownFrontmatterCard
                    frontmatter={frontmatter}
                    onChange={handleFrontmatterChange}
                    onClose={() => setIsMetadataOpen(false)}
                    readOnly={isWorkstationReadOnly()}
                  >
                  <MarkdownNoteContextCard
                    filePath={filePath}
                    initialContext={initialNoteContext}
                    initialError={initialNoteContextError}
                    skipInitialLoad={true}
                    onContextChange={(context) => {
                      const note = context?.note ?? null;
                      setHasLinkMetadata(Boolean(
                        note
                        && (
                          note.outgoingLinks.length > 0
                          || note.backlinks.length > 0
                        ),
                      ));
                    }}
                  />
                </MarkdownFrontmatterCard>
              </div>
            </motion.div>
          ) : null}
            {content ? (
              <TipTapViewer
                ref={editorRef}
                content={content}
                filePath={filePath}
                editable={!isWorkstationReadOnly()}
                placeholder={t('markdown.placeholder')}
                onUpdate={handleUpdate}
                resolveImageSrc={resolveImageSrc}
                mentionContainer={getMentionContainer}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                {t('markdown.emptyFile')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sticky bottom banner for Keep All / Undo All */}
      {showingDiff && remainingDiffs > 0 && (
        <div
          className="sticky bottom-0 left-0 right-0 flex items-center justify-between px-4 py-2"
          style={{
            borderTop: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 50%, transparent)',
            background: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 90%, transparent)',
            backdropFilter: 'blur(10px)',
          }}
        >
          <div className="text-ui-sm text-muted-foreground">
            {remainingDiffs} change{remainingDiffs !== 1 ? 's' : ''}
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleUndoAll}
              variant="ghost"
              size="xs"
              data-testid="undo-all-button"
            >
              Undo All
            </Button>
            <Button
              onClick={handleKeepAll}
              variant="ghost"
              size="xs"
              data-testid="keep-all-button"
            >
              Keep All
            </Button>
          </div>
        </div>
      )}
    </motion.div>
  );
}
