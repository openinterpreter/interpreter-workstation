import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import TaskList from '@tiptap/extension-task-list';
import { useEffect, forwardRef, useImperativeHandle, useRef, useCallback, useMemo, useState } from 'react';
import Underline from '@tiptap/extension-underline';
import { DraggableTaskItem } from '../extensions/DraggableTaskItem';
import { ResizableImage, type ResolveImageSrc } from '../extensions/ResizableImage';
import { AnimationHighlight } from '../extensions/AnimationHighlight';
import { openExternal, showContextMenu, vault, workspace, type ContextMenuItem } from '@/ipc';
import { markdownToTiptap } from '../utils/markdown-parser';
import { resolveLocalLinkTarget } from '../utils/localLinkDetection';
import { shouldRefreshUnlinkedMentionCandidatesFromWorkspaceEvent } from '../utils/unlinkedMentionRefresh';
import { FileMention } from '../../agent/components/composer/mention/FileMentionExtension';
import { createFileMentionSuggestion } from '../../agent/components/composer/mention/fileMentionSuggestion';
import { Wikilink } from '../extensions/Wikilink';
import { WikilinkAutocomplete } from '../extensions/WikilinkAutocomplete';
import { openMentionTarget } from '../../agent/components/mentions/openMentionTarget';
import { UnlinkedMentionSuggestions } from '../extensions/UnlinkedMentionSuggestions';
import type { UnlinkedMentionCandidate } from '../utils/unlinkedMentions';
import { buildUnlinkedMentionCandidates } from '../utils/unlinkedMentions';
import { Button } from './ui/button';
import type { WorkspaceFilesChangedEvent } from '../../electron/ipc/registry';

export interface SearchMatch {
  from: number;
  to: number;
}

export interface TipTapViewerRef {
  getJSON: () => Record<string, unknown> | null;
  getEditor: () => any | null;
  search: (query: string) => SearchMatch[];
  highlightMatch: (match: SearchMatch) => void;
  clearHighlights: () => void;
  focus: () => void;
  // Formatting methods
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleUnderline: () => void;
  toggleStrike: () => void;
  toggleCode: () => void;
  toggleBulletList: () => void;
  toggleOrderedList: () => void;
  toggleTaskList: () => void;
  toggleBlockquote: () => void;
  toggleHeading: (level: 1 | 2 | 3) => void;
  // Insertion methods for file drops
  insertImage: (src: string, alt: string) => void;
  insertFileLink: (href: string, text: string) => void;
  insertFileMention: (path: string, name: string, isDirectory: boolean) => void;
  insertLinkedImage: (src: string, alt: string, href: string) => void;
  // Active state checks
  isActive: (name: string, attributes?: Record<string, unknown>) => boolean;
  // Animation methods
  setEditable: (editable: boolean) => void;
  setContentJSON: (json: Record<string, unknown>) => void;
}

interface TipTapViewerProps {
  content: Record<string, unknown>; // Tiptap JSON format
  className?: string;
  editable?: boolean;
  placeholder?: string;
  onUpdate?: () => void;
  filePath?: string;
  /** Resolve a raw image path (absolute or relative) to a displayable URL. */
  resolveImageSrc?: ResolveImageSrc;
  /** Return a container element for positioning the @ mention dropdown. */
  mentionContainer?: () => HTMLElement | null;
}

interface ActiveUnlinkedMention {
  from: number;
  to: number;
  text: string;
  ignoreKey: string;
  targetPath: string;
  targetLabel: string;
  targetRelativePath: string;
  targetWikilink: string;
  rect: DOMRect;
}

const UNLINKED_MENTION_CLOSE_DELAY_MS = 120;
const UNLINKED_MENTION_POPOVER_WIDTH = 280;
const UNLINKED_MENTION_POPOVER_ESTIMATED_HEIGHT = 118;

function isMarkdownNotePath(filePath: string | undefined): boolean {
  return Boolean(filePath && /\.(md|markdown)$/i.test(filePath));
}

function parseActiveUnlinkedMention(element: HTMLElement): ActiveUnlinkedMention | null {
  const from = Number(element.getAttribute('data-from'));
  const to = Number(element.getAttribute('data-to'));
  const ignoreKey = element.getAttribute('data-ignore-key');
  const targetPath = element.getAttribute('data-target-path');
  const targetLabel = element.getAttribute('data-target-label');
  const targetRelativePath = element.getAttribute('data-target-relative-path');
  const targetWikilink = element.getAttribute('data-target-wikilink');
  const text = element.textContent ?? '';

  if (
    !Number.isFinite(from)
    || !Number.isFinite(to)
    || !ignoreKey
    || !targetPath
    || !targetLabel
    || !targetRelativePath
    || !targetWikilink
    || !text
  ) {
    return null;
  }

  return {
    from,
    to,
    text,
    ignoreKey,
    targetPath,
    targetLabel,
    targetRelativePath,
    targetWikilink,
    rect: element.getBoundingClientRect(),
  };
}

function getUnlinkedMentionPopoverPosition(rect: DOMRect): { left: number; top: number } {
  const maxLeft = Math.max(12, window.innerWidth - UNLINKED_MENTION_POPOVER_WIDTH - 12);
  const centeredLeft = rect.left + rect.width / 2 - UNLINKED_MENTION_POPOVER_WIDTH / 2;
  const left = Math.min(maxLeft, Math.max(12, centeredLeft));
  const preferredTop = rect.bottom + 10;
  const shouldPlaceAbove = preferredTop + UNLINKED_MENTION_POPOVER_ESTIMATED_HEIGHT > window.innerHeight - 12;
  const top = shouldPlaceAbove
    ? Math.max(12, rect.top - UNLINKED_MENTION_POPOVER_ESTIMATED_HEIGHT - 10)
    : preferredTop;
  return { left, top };
}

/**
 * TipTap editor/viewer component for displaying and editing markdown content
 * with full support for tables, images, and links
 */
export const TipTapViewer = forwardRef<TipTapViewerRef, TipTapViewerProps>(
  function TipTapViewer({
    content,
    className = '',
    editable = false,
    placeholder = '',
    onUpdate,
    filePath,
    resolveImageSrc,
    mentionContainer,
  }, ref) {
  "use no memo";

  // Use ref to hold latest onUpdate callback to avoid stale closures
  const onUpdateRef = useRef(onUpdate);
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const unlinkedMentionPopoverRef = useRef<HTMLDivElement>(null);
  const unlinkedMentionCloseTimerRef = useRef<number | null>(null);
  const unlinkedMentionRefreshTimerRef = useRef<number | null>(null);
  const [unlinkedMentionCandidates, setUnlinkedMentionCandidates] = useState<UnlinkedMentionCandidate[]>([]);
  const unlinkedMentionCandidatesRef = useRef<UnlinkedMentionCandidate[]>([]);
  const [ignoredUnlinkedMentionKeys, setIgnoredUnlinkedMentionKeys] = useState<Set<string>>(() => new Set());
  const ignoredUnlinkedMentionKeysRef = useRef<Set<string>>(new Set());
  const [activeUnlinkedMention, setActiveUnlinkedMention] = useState<ActiveUnlinkedMention | null>(null);

  const getUnlinkedMentionCandidates = useCallback(() => unlinkedMentionCandidatesRef.current, []);
  const getIgnoredUnlinkedMentionKeys = useCallback(() => ignoredUnlinkedMentionKeysRef.current, []);

  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  // Memoize mention suggestion config so it doesn't cause editor re-creation
  const mentionSuggestion = useMemo(() => {
    if (editable && mentionContainer) {
      return createFileMentionSuggestion({ getContainer: mentionContainer });
    }
    return undefined;
  }, [editable, mentionContainer]);

  const unlinkedMentionExtension = useMemo(() => {
    if (!editable || !filePath) {
      return undefined;
    }

    return UnlinkedMentionSuggestions.configure({
      getCandidates: getUnlinkedMentionCandidates,
      getIgnoredKeys: getIgnoredUnlinkedMentionKeys,
    });
  }, [editable, filePath, getIgnoredUnlinkedMentionKeys, getUnlinkedMentionCandidates]);

  const viewer = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3, 4, 5, 6],
        },
      }),
      Underline,
      Highlight.configure({
        multicolor: true,
        HTMLAttributes: {
          class: 'search-highlight',
        },
      }),
      Placeholder.configure({
        placeholder,
      }),
      TaskList.configure({
        HTMLAttributes: {
          class: 'task-list',
        },
      }),
      DraggableTaskItem.configure({
        nested: true,
        HTMLAttributes: {
          class: 'task-item',
        },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'underline',
        },
      }),
      ResizableImage.configure({
        inline: true,
        allowBase64: true,
      }),
      AnimationHighlight,
      FileMention.configure({
        suggestion: mentionSuggestion || { char: '@', items: () => [] },
      }),
      Wikilink,
      WikilinkAutocomplete,
      ...(unlinkedMentionExtension ? [unlinkedMentionExtension] : []),
      Table.configure({
        resizable: true,
        HTMLAttributes: {
          class: 'border-collapse table-auto w-full my-4',
        },
      }),
      TableRow,
      TableHeader.configure({
        HTMLAttributes: {
          class: 'border border-border bg-background p-2 text-left font-bold',
        },
      }),
      TableCell.configure({
        HTMLAttributes: {
          class: 'border border-border p-2',
        },
      }),
    ],
    content: content,
    editable: editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: `prose prose-sm max-w-none focus:outline-none ${className}`,
      },
      handleClick: (_view, _pos, event) => {
        const target = event.target as HTMLElement;

        // Wikilinks: dispatch wikilink:open so the workspace resolver can open the target.
        const wikilink = target.closest('[data-wikilink]') as HTMLElement | null;
        if (wikilink) {
          event.preventDefault();
          const wikiTarget = wikilink.getAttribute('data-target') || '';
          const fragment = wikilink.getAttribute('data-fragment') || undefined;
          const display = wikilink.getAttribute('data-display') || undefined;
          if (wikiTarget) {
            window.dispatchEvent(new CustomEvent('wikilink:open', {
              detail: { target: wikiTarget, fragment, display },
            }));
          }
          return true;
        }

        // Local links reuse the same open-target logic as mentions; external links use the system browser.
        const link = target.closest('a') as HTMLAnchorElement | null;
        if (link) {
          event.preventDefault();
          const href = link.getAttribute('href');
          if (href) {
            const localTarget = resolveLocalLinkTarget(href);
            if (localTarget) {
              openMentionTarget(localTarget);
            } else {
              void openExternal(href).catch((error) => {
                console.error('[TipTapViewer] Failed to open external link:', error);
              });
            }
          }
          return true;
        }
        return false;
      },
      handlePaste: (view, event) => {
        // If clipboard has HTML (rich text), let default handler preserve formatting
        const html = event.clipboardData?.getData('text/html');
        if (html) return false;

        // Plain text only - parse as markdown
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;

        // Parse markdown and insert as structured content
        const parsed = markdownToTiptap(text);
        const { state } = view;
        const { from, to } = state.selection;

        // Create a fragment from the parsed content
        const slice = view.state.schema.nodeFromJSON(parsed);
        const fragment = slice.content;

        // Replace selection with the parsed content
        const tr = state.tr.replaceWith(from, to, fragment);
        view.dispatch(tr);

        return true; // Prevent default paste
      },
    },
    onUpdate: () => {
      // Call the latest version of the callback
      if (onUpdateRef.current) {
        onUpdateRef.current();
      }
    },
  });

  useEffect(() => {
    unlinkedMentionCandidatesRef.current = unlinkedMentionCandidates;
    if (viewer) {
      (viewer.storage as any).unlinkedMentionSuggestions?.refresh?.();
    }
  }, [unlinkedMentionCandidates, viewer]);

  useEffect(() => {
    ignoredUnlinkedMentionKeysRef.current = ignoredUnlinkedMentionKeys;
    if (viewer) {
      (viewer.storage as any).unlinkedMentionSuggestions?.refresh?.();
    }
  }, [ignoredUnlinkedMentionKeys, viewer]);

  useEffect(() => {
    setIgnoredUnlinkedMentionKeys(new Set());
    setActiveUnlinkedMention(null);
  }, [filePath]);

  const refreshUnlinkedMentionCandidates = useCallback(async () => {
    if (!editable || !filePath || !isMarkdownNotePath(filePath)) {
      setUnlinkedMentionCandidates([]);
      return;
    }

    try {
      const snapshot = await vault.getSnapshot();
      setUnlinkedMentionCandidates(buildUnlinkedMentionCandidates(snapshot.notes, filePath));
    } catch (error) {
      console.error('[TipTapViewer] Failed to load unlinked mention candidates:', error);
      setUnlinkedMentionCandidates([]);
    }
  }, [editable, filePath]);

  useEffect(() => {
    void refreshUnlinkedMentionCandidates();
  }, [refreshUnlinkedMentionCandidates]);

  useEffect(() => {
    if (!editable || !filePath) {
      return;
    }

    const unsubscribe = workspace.onFilesChanged((event: WorkspaceFilesChangedEvent) => {
      if (!shouldRefreshUnlinkedMentionCandidatesFromWorkspaceEvent(event, filePath)) {
        return;
      }

      if (unlinkedMentionRefreshTimerRef.current !== null) {
        window.clearTimeout(unlinkedMentionRefreshTimerRef.current);
      }

      unlinkedMentionRefreshTimerRef.current = window.setTimeout(() => {
        unlinkedMentionRefreshTimerRef.current = null;
        void refreshUnlinkedMentionCandidates();
      }, 120);
    });

    return () => {
      unsubscribe();
      if (unlinkedMentionRefreshTimerRef.current !== null) {
        window.clearTimeout(unlinkedMentionRefreshTimerRef.current);
      }
    };
  }, [editable, filePath, refreshUnlinkedMentionCandidates]);

  const clearUnlinkedMentionCloseTimer = useCallback(() => {
    if (unlinkedMentionCloseTimerRef.current !== null) {
      window.clearTimeout(unlinkedMentionCloseTimerRef.current);
      unlinkedMentionCloseTimerRef.current = null;
    }
  }, []);

  const openUnlinkedMentionPopover = useCallback((element: HTMLElement) => {
    const parsed = parseActiveUnlinkedMention(element);
    if (!parsed) {
      return;
    }

    clearUnlinkedMentionCloseTimer();
    setActiveUnlinkedMention(parsed);
  }, [clearUnlinkedMentionCloseTimer]);

  const scheduleCloseUnlinkedMentionPopover = useCallback((relatedTarget?: EventTarget | null) => {
    if (relatedTarget instanceof Node) {
      if (
        unlinkedMentionPopoverRef.current?.contains(relatedTarget)
        || (relatedTarget instanceof HTMLElement && relatedTarget.closest('[data-unlinked-mention="true"]'))
      ) {
        return;
      }
    }

    clearUnlinkedMentionCloseTimer();
    unlinkedMentionCloseTimerRef.current = window.setTimeout(() => {
      setActiveUnlinkedMention(null);
      unlinkedMentionCloseTimerRef.current = null;
    }, UNLINKED_MENTION_CLOSE_DELAY_MS);
  }, [clearUnlinkedMentionCloseTimer]);

  // Search function to find all matches of a query
  const searchText = useCallback((query: string): SearchMatch[] => {
    if (!viewer || !query) return [];

    const matches: SearchMatch[] = [];
    const doc = viewer.state.doc;
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
  }, [viewer]);

  // Highlight a specific match and scroll to it
  const highlightMatch = useCallback((match: SearchMatch) => {
    if (!viewer) return;

    // Clear existing highlights first
    viewer.commands.unsetHighlight();

    // Set highlight on the match
    viewer.chain()
      .setTextSelection({ from: match.from, to: match.to })
      .setHighlight({ color: '#ffeb3b' })
      .run();

    // Scroll the selection into view
    const element = viewer.view.dom.querySelector('.search-highlight');
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [viewer]);

  // Clear all highlights
  const clearHighlights = useCallback(() => {
    if (!viewer) return;
    viewer.commands.unsetHighlight();
  }, [viewer]);

  // Expose methods through ref
  useImperativeHandle(ref, () => ({
    getJSON: () => viewer?.getJSON() ?? null,
    getEditor: () => viewer ?? null,
    search: searchText,
    highlightMatch,
    clearHighlights,
    focus: () => viewer?.commands.focus(),
    // Formatting methods
    toggleBold: () => viewer?.chain().focus().toggleBold().run(),
    toggleItalic: () => viewer?.chain().focus().toggleItalic().run(),
    toggleUnderline: () => viewer?.chain().focus().toggleUnderline().run(),
    toggleStrike: () => viewer?.chain().focus().toggleStrike().run(),
    toggleCode: () => viewer?.chain().focus().toggleCode().run(),
    toggleBulletList: () => viewer?.chain().focus().toggleBulletList().run(),
    toggleOrderedList: () => viewer?.chain().focus().toggleOrderedList().run(),
    toggleTaskList: () => viewer?.chain().focus().toggleTaskList().run(),
    toggleBlockquote: () => viewer?.chain().focus().toggleBlockquote().run(),
    toggleHeading: (level: 1 | 2 | 3) => viewer?.chain().focus().toggleHeading({ level }).run(),
    // Insertion methods for file drops
    insertImage: (src: string, alt: string) => viewer?.chain().focus().setImage({ src, alt }).run(),
    insertFileLink: (href: string, text: string) => {
      viewer?.chain().focus().insertContent({
        type: 'text',
        marks: [{ type: 'link', attrs: { href, class: 'file-link' } }],
        text,
      }).run();
    },
    insertFileMention: (path: string, name: string, isDirectory: boolean) => {
      viewer?.chain().focus().insertContent({
        type: 'fileMention',
        attrs: {
          id: path,
          label: name,
          itemType: isDirectory ? 'directory' : 'file',
        },
      }).run();
    },
    insertLinkedImage: (src: string, alt: string, href: string) => {
      viewer?.chain().focus().setImage({ src, alt, href } as any).run();
    },
    // Active state check
    isActive: (name: string, attributes?: Record<string, unknown>) => viewer?.isActive(name, attributes) ?? false,
    // Animation methods
    setEditable: (editable: boolean) => { viewer?.setEditable(editable); },
    setContentJSON: (json: Record<string, unknown>) => { viewer?.commands.setContent(json); },
  }), [viewer, searchText, highlightMatch, clearHighlights]);

  // Set image src resolver on extension storage so the node view can use it.
  // Node views that were created before the resolver was available will retry
  // via setTimeout in applySrc until this is set.
  useEffect(() => {
    if (viewer && resolveImageSrc) {
      (viewer.storage as any).image.resolveImageSrc = resolveImageSrc;
    }
  }, [viewer, resolveImageSrc]);

  // Update viewer content when prop changes
  useEffect(() => {
    if (viewer && content !== undefined) {
      const currentContent = viewer.getJSON();

      // Only update if content actually changed
      if (JSON.stringify(currentContent) !== JSON.stringify(content)) {
        viewer.commands.setContent(content);
      }
    }
  }, [viewer, content]);

  useEffect(() => {
    if (!viewer) {
      return;
    }

    const handleEditorUpdate = () => {
      setActiveUnlinkedMention(null);
    };

    viewer.on('update', handleEditorUpdate);
    return () => {
      viewer.off('update', handleEditorUpdate);
    };
  }, [viewer]);

  useEffect(() => {
    const container = viewerContainerRef.current;
    if (!container || !editable || !filePath) {
      return;
    }

    const handleMouseOver = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const mention = target.closest('[data-unlinked-mention="true"]');
      if (mention instanceof HTMLElement) {
        openUnlinkedMentionPopover(mention);
      }
    };

    const handleMouseOut = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest('[data-unlinked-mention="true"]')) {
        return;
      }
      scheduleCloseUnlinkedMentionPopover(event.relatedTarget);
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const mention = target.closest('[data-unlinked-mention="true"]');
      if (mention instanceof HTMLElement) {
        openUnlinkedMentionPopover(mention);
      }
    };

    const handleFocusOut = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest('[data-unlinked-mention="true"]')) {
        return;
      }
      scheduleCloseUnlinkedMentionPopover(event.relatedTarget);
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const mention = target.closest('[data-unlinked-mention="true"]');
      if (mention instanceof HTMLElement) {
        event.preventDefault();
        openUnlinkedMentionPopover(mention);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearUnlinkedMentionCloseTimer();
        setActiveUnlinkedMention(null);
      }
    };

    const handleViewportChange = () => {
      setActiveUnlinkedMention(null);
    };

    container.addEventListener('mouseover', handleMouseOver);
    container.addEventListener('mouseout', handleMouseOut);
    container.addEventListener('focusin', handleFocusIn);
    container.addEventListener('focusout', handleFocusOut);
    container.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange);

    return () => {
      container.removeEventListener('mouseover', handleMouseOver);
      container.removeEventListener('mouseout', handleMouseOut);
      container.removeEventListener('focusin', handleFocusIn);
      container.removeEventListener('focusout', handleFocusOut);
      container.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange);
    };
  }, [
    clearUnlinkedMentionCloseTimer,
    editable,
    filePath,
    openUnlinkedMentionPopover,
    scheduleCloseUnlinkedMentionPopover,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearUnlinkedMentionCloseTimer();
      viewer?.destroy();
    };
  }, [clearUnlinkedMentionCloseTimer, viewer]);

  // Apply formatting action to the editor
  const applyFormat = useCallback((action: string) => {
    if (!viewer) return;
    viewer.commands.focus();

    switch (action) {
      case 'bold':
        viewer.chain().toggleBold().run();
        break;
      case 'italic':
        viewer.chain().toggleItalic().run();
        break;
      case 'underline':
        viewer.chain().toggleUnderline().run();
        break;
      case 'strikethrough':
        viewer.chain().toggleStrike().run();
        break;
      case 'code':
        viewer.chain().toggleCode().run();
        break;
      case 'heading1':
        viewer.chain().toggleHeading({ level: 1 }).run();
        break;
      case 'heading2':
        viewer.chain().toggleHeading({ level: 2 }).run();
        break;
      case 'heading3':
        viewer.chain().toggleHeading({ level: 3 }).run();
        break;
      case 'paragraph':
        viewer.chain().setParagraph().run();
        break;
      case 'bulletList':
        viewer.chain().toggleBulletList().run();
        break;
      case 'orderedList':
        viewer.chain().toggleOrderedList().run();
        break;
      case 'taskList':
        viewer.chain().toggleTaskList().run();
        break;
      case 'blockquote':
        viewer.chain().toggleBlockquote().run();
        break;
    }
  }, [viewer]);

  // Markdown editor context menu items - defined in ONE place
  const markdownMenuItems: ContextMenuItem[] = [
    { label: 'Cut', action: 'cut', accelerator: 'CmdOrCtrl+X' },
    { label: 'Copy', action: 'copy', accelerator: 'CmdOrCtrl+C' },
    { label: 'Paste', action: 'paste', accelerator: 'CmdOrCtrl+V' },
    { label: '', action: '', separator: true },
    { label: 'Bold', action: 'bold', accelerator: 'CmdOrCtrl+B' },
    { label: 'Italic', action: 'italic', accelerator: 'CmdOrCtrl+I' },
    { label: 'Underline', action: 'underline', accelerator: 'CmdOrCtrl+U' },
    { label: 'Strikethrough', action: 'strikethrough' },
    { label: 'Code', action: 'code' },
    { label: '', action: '', separator: true },
    { label: 'Heading 1', action: 'heading1' },
    { label: 'Heading 2', action: 'heading2' },
    { label: 'Heading 3', action: 'heading3' },
    { label: 'Paragraph', action: 'paragraph' },
    { label: '', action: '', separator: true },
    { label: 'Bullet List', action: 'bulletList' },
    { label: 'Numbered List', action: 'orderedList' },
    { label: 'Task List', action: 'taskList' },
    { label: 'Blockquote', action: 'blockquote' },
  ];

  // Context menu handler - unified for both Electron and browser
  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    if (!editable || !viewer) return;

    // Prevent browser default and Electron's native context-menu
    e.preventDefault();

    // Show context menu with our items (works in both modes)
    const action = await showContextMenu(markdownMenuItems, 'tiptap_viewer');

    if (action) {
      // Handle clipboard actions
      if (action === 'cut') {
        document.execCommand('cut');
      } else if (action === 'copy') {
        document.execCommand('copy');
      } else if (action === 'paste') {
        document.execCommand('paste');
      } else {
        // Handle formatting actions
        applyFormat(action);
      }
    }
  }, [editable, viewer, applyFormat]);

  const handleLinkUnlinkedMention = useCallback(() => {
    if (!viewer || !activeUnlinkedMention) {
      return;
    }

    const wikilinkNode = viewer.state.schema.nodes.wikilink?.create({
      target: activeUnlinkedMention.targetWikilink,
      fragment: null,
      display: activeUnlinkedMention.text === activeUnlinkedMention.targetLabel
        ? null
        : activeUnlinkedMention.text,
    });
    if (!wikilinkNode) {
      return;
    }

    viewer.chain().focus().insertContentAt(
      { from: activeUnlinkedMention.from, to: activeUnlinkedMention.to },
      wikilinkNode,
    ).run();
    setActiveUnlinkedMention(null);
  }, [activeUnlinkedMention, viewer]);

  const handleIgnoreUnlinkedMention = useCallback(() => {
    if (!activeUnlinkedMention) {
      return;
    }

    setIgnoredUnlinkedMentionKeys((previous) => {
      const next = new Set(previous);
      next.add(activeUnlinkedMention.ignoreKey);
      return next;
    });
    setActiveUnlinkedMention(null);
  }, [activeUnlinkedMention]);

  const handleOpenUnlinkedMentionTarget = useCallback(() => {
    if (!activeUnlinkedMention) {
      return;
    }

    openMentionTarget({
      path: activeUnlinkedMention.targetPath,
      itemType: 'file',
    });
  }, [activeUnlinkedMention]);

  if (!viewer) {
    return null;
  }

  return (
    <div
      ref={viewerContainerRef}
      className={`oa-tiptap-viewer h-full text-[var(--oa-text)] [--tw-prose-body:var(--oa-text)] [--tw-prose-headings:var(--oa-text-strong)] [--tw-prose-bold:var(--oa-text-strong)] [--tw-prose-links:var(--oa-link)] [--tw-prose-code:var(--oa-text-strong)] [--tw-prose-counters:var(--oa-text-muted)] [--tw-prose-bullets:var(--oa-text-muted)] [--tw-prose-quotes:var(--oa-text)] [--tw-prose-quote-borders:var(--oa-border)] [--tw-prose-hr:var(--oa-border)] [--tw-prose-th-borders:var(--oa-border)] [--tw-prose-td-borders:var(--oa-border)] ${className}`}
      onContextMenu={handleContextMenu}
    >
      <EditorContent
        editor={viewer}
        className="h-full [&_.ProseMirror]:h-full [&_.ProseMirror]:text-ui-base [&_.ProseMirror]:text-[var(--oa-text)] [&_.ProseMirror]:[color:var(--oa-text)] [&_.ProseMirror]:[-webkit-text-fill-color:var(--oa-text)] [&_.ProseMirror]:[caret-color:var(--oa-text)] [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:text-xl [&_h3]:font-bold [&_.ProseMirror_a.file-link]:bg-[var(--surface-secondary)] [&_.ProseMirror_a.file-link]:border [&_.ProseMirror_a.file-link]:border-[var(--border)] [&_.ProseMirror_a.file-link]:rounded-[var(--control-radius)] [&_.ProseMirror_a.file-link]:px-1.5 [&_.ProseMirror_a.file-link]:py-px [&_.ProseMirror_a.file-link]:text-[0.9em] [&_.ProseMirror_a.file-link]:no-underline [&_.ProseMirror_a.file-link]:text-[var(--oa-link)] [&_.ProseMirror_a.file-link]:whitespace-nowrap"
      />
      {activeUnlinkedMention ? (
        <div
          ref={unlinkedMentionPopoverRef}
          className="rounded-[14px] px-3 py-2 shadow-[var(--oa-shadow-md)]"
          style={{
            position: 'fixed',
            width: `${UNLINKED_MENTION_POPOVER_WIDTH}px`,
            ...getUnlinkedMentionPopoverPosition(activeUnlinkedMention.rect),
            border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border) 82%, transparent)',
            background: 'color-mix(in srgb, var(--oa-bg-app) 94%, white)',
            zIndex: 80,
          }}
          onMouseEnter={clearUnlinkedMentionCloseTimer}
          onMouseLeave={(event) => scheduleCloseUnlinkedMentionPopover(event.relatedTarget)}
        >
          <p className="text-ui-sm text-[var(--oa-text)]">
            Link <span className="font-medium">{activeUnlinkedMention.text}</span> to{' '}
            <span className="font-medium">{activeUnlinkedMention.targetLabel}</span>?
          </p>
          <p className="pt-1 text-ui-xs text-[var(--oa-text-muted)]">
            {activeUnlinkedMention.targetRelativePath}
          </p>
          <div className="flex items-center gap-2 pt-3">
            <Button
              type="button"
              size="sm"
              className="h-7 px-2.5 text-ui-sm"
              onClick={handleLinkUnlinkedMention}
            >
              Link
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-ui-sm"
              onClick={handleIgnoreUnlinkedMention}
            >
              Ignore
            </Button>
            <button
              type="button"
              onClick={handleOpenUnlinkedMentionTarget}
              className="ml-auto text-ui-xs text-[var(--oa-link)]"
            >
              Open note
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
});
