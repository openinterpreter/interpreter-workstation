/**
 * Base Tiptap Composer
 *
 * Rich text editor with @ mention support for files/folders.
 * Used in agent chat composer and user message editing.
 */

import { useEditor, EditorContent, Editor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import StarterKit from '@tiptap/starter-kit';
import HardBreak from '@tiptap/extension-hard-break';
import Placeholder from '@tiptap/extension-placeholder';
import { useState, useEffect, useCallback, forwardRef, useImperativeHandle, useRef, useContext } from 'react';
import { ArrowUpIcon, Plus, Square } from 'lucide-react';
import React from 'react';
import { FileMention } from './mention/FileMentionExtension';
import { createFileMentionSuggestion } from './mention/fileMentionSuggestion';
import { SkillMention } from './mention/SkillMentionExtension';
import { createSkillMentionSuggestion, setSkillItemRegistry, getSkillItemById } from './mention/skillMentionSuggestion';
import type { SkillMentionDropdownData, SkillMentionItem } from './mention/SkillMentionDropdown';
import { ToolKeywordHighlight } from './ToolKeywordHighlight';
import { VoiceDiffMark } from './VoiceDiffMark';
import { parseDragData, isFileDragData, isBrowserTabDragData } from '../../../shared/types/drag';
import { MAIN_COMPOSER_INPUT_ID, MAIN_COMPOSER_SEND_BUTTON_ID } from '../../../shared/element-ids';
import { humanizeSkillName } from '../../../shared/utils/skillDisplay';
import { parseSkillMentionToken } from '../../../shared/utils/skillMentions';
import type { SkillOption } from '../../../shared/types/skill';
import { isAbsolutePath, pathBasename, pathDirname } from '@/ipc';
import { useToast } from '@/contexts/ToastContext';
import { Tooltip, TooltipTrigger, TooltipContent } from '../../../src/components/ui/tooltip';
import { LayoutContext } from '../../../src/contexts/LayoutContext';
import { resolvePaneTabDragData } from '../../../src/utils/paneTabDrag';
import { getComposerTabMentionData } from '../../../src/utils/composerDrop';
import { resolveProfileShortcutSlot } from './profileShortcut';
import type { FocusComposerDetail } from '../../utils/focusComposer';
import { AttachmentChip } from './attachment/AttachmentChipExtension';
import { AttachmentPreviewPopover } from './attachment/AttachmentPreviewPopover';
import { createAttachmentStore, type AttachmentStore } from './attachment/attachmentStore';
import { serializeEditorWithAttachments } from './attachment/serialize';
import {
  buildPastedTextLabel,
  shouldChipifyPastedText,
} from './attachment/composerPaste';
import {
  hasSerializedPastedContent,
  parsePastedContentSegments,
} from './attachment/pastedContent';
import type { ComposerAttachmentAttrs, SerializedComposerSubmission } from './attachment/types';
import { ComposerSecondaryButton } from './ComposerSecondaryButton';
import { refocusMainComposer } from './refocusMainComposer';
import { FileSystemProxy } from '../../../src/components/FileSystemProxy';
import {
  pickAgentComposerPlaceholder,
  pickRandomComposerPlaceholder,
} from '../../../shared/utils/composerPlaceholder';
import './AgentComposer.css';
import './attachment/attachment.css';

export const COMPOSER_PROFILE_SHORTCUT_EVENT = 'composer:profile-shortcut';

const PREVIEW_SKILL_TOKEN_REGEX = /skill:\[[^\]]+\]\([^)\n]+\)/g;

function renderPreviewText(text: string) {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  PREVIEW_SKILL_TOKEN_REGEX.lastIndex = 0;

  while ((match = PREVIEW_SKILL_TOKEN_REGEX.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    const parsed = parseSkillMentionToken(match[0]);
    if (parsed) {
      const skillDir = pathDirname(parsed.path);
      nodes.push(
        <FileSystemProxy
          key={`${parsed.id}:${match.index}`}
          path={skillDir || undefined}
          filename={parsed.label}
          type="directory"
          variant="inline"
          dragContext={`preview-skill-${parsed.id}`}
          disableDrag
          showPath
          showTooltip={false}
          className="mx-0.5 select-none align-baseline"
        />,
      );
    } else {
      nodes.push(match[0]);
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

export interface ComposerProfileShortcutDetail {
  scope: string;
  slot: number;
}

/**
 * Parse a single line for markdown links and skill mentions, converting to TipTap content nodes.
 * Returns an array of text and mention nodes.
 *
 * Recognized patterns:
 * - @[label](path) or [label](/path) — file mentions
 * - [label](browser://id) — browser tab mentions
 * - skill:[Label](payload) — skill mentions
 */
function isSkillTokenBoundary(nextChar: string | undefined): boolean {
  return nextChar === undefined || /[\s.,!?;:)\]}]/.test(nextChar);
}

function findNextSkillToken(
  line: string,
  fromIndex: number,
): { start: number; end: number; parsed: NonNullable<ReturnType<typeof parseSkillMentionToken>> } | null {
  let start = line.indexOf('skill:[', fromIndex);

  while (start !== -1) {
    const labelEnd = line.indexOf('](', start + 'skill:['.length);
    if (labelEnd === -1) {
      return null;
    }

    let closingParen = line.indexOf(')', labelEnd + 2);
    while (closingParen !== -1) {
      const candidate = line.slice(start, closingParen + 1);
      const parsed = parseSkillMentionToken(candidate);
      if (parsed && isSkillTokenBoundary(line[closingParen + 1])) {
        return {
          start,
          end: closingParen + 1,
          parsed,
        };
      }
      closingParen = line.indexOf(')', closingParen + 1);
    }

    start = line.indexOf('skill:[', start + 'skill:['.length);
  }

  return null;
}

function findNextFileOrBrowserMention(
  line: string,
  fromIndex: number,
): RegExpExecArray | null {
  const mentionRegex = /[*_~]*@?\[([^\]]+)\]\(([^)]+)\)[*_~]*/g;
  mentionRegex.lastIndex = fromIndex;

  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(line)) !== null) {
    const prefix = line.slice(Math.max(0, match.index - 'skill:'.length), match.index);
    if (!prefix.endsWith('skill:')) {
      return match;
    }
  }

  return null;
}

function parseLineForMentions(line: string): any[] {
  const content: any[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    const nextSkill = findNextSkillToken(line, cursor);
    const nextFileOrBrowser = findNextFileOrBrowserMention(line, cursor);

    if (!nextSkill && !nextFileOrBrowser) {
      break;
    }

    const useSkill = nextSkill && (!nextFileOrBrowser || nextSkill.start <= nextFileOrBrowser.index);
    const matchStart = useSkill ? nextSkill.start : nextFileOrBrowser!.index;

    // Add text before this match
    if (matchStart > cursor) {
      const textBefore = line.slice(cursor, matchStart);
      if (textBefore) {
        content.push({ type: 'text', text: textBefore });
      }
    }

    if (useSkill && nextSkill) {
      const metadata = getSkillItemById(nextSkill.parsed.id);
      content.push({
        type: 'skillMention',
        attrs: {
          id: nextSkill.parsed.id,
          label: nextSkill.parsed.label,
          name: nextSkill.parsed.name,
          path: nextSkill.parsed.path,
          description: metadata?.description || '',
        },
      });
      cursor = nextSkill.end;
    } else {
      const match = nextFileOrBrowser!;
      // [label](path) pattern
      const label = match[1];
      const path = match[2];

      const isBrowserTab = path.startsWith('browser://');
      const isFilePath = isAbsolutePath(path);

      if (isBrowserTab || isFilePath) {
        const itemType = isBrowserTab
          ? 'browser-tab'
          : (pathBasename(path).includes('.') ? 'file' : 'directory');

        const mentionAttrs: any = {
          id: isBrowserTab ? path.replace('browser://', '') : path,
          label: label,
          itemType: itemType,
        };

        if (isBrowserTab) {
          mentionAttrs.url = path.replace('browser://', '');
        }

        content.push({
          type: 'fileMention',
          attrs: mentionAttrs,
        });
      } else {
        // Regular link - keep as text
        content.push({ type: 'text', text: match[0] });
      }

      cursor = match.index + match[0].length;
    }
  }

  // Add remaining text after last match
  if (cursor < line.length) {
    const textAfter = line.slice(cursor);
    if (textAfter) {
      content.push({ type: 'text', text: textAfter });
    }
  }

  return content;
}

/**
 * Parse text content for markdown links and convert them to TipTap JSON with mention nodes.
 * This allows mentions to render properly when loading saved messages.
 *
 * Pattern: [label](path) where path is:
 * - Absolute file path starting with /
 * - browser://id for browser tabs
 */
export function parseContentWithMentions(
  text: string,
  store?: AttachmentStore | null,
): any {
  // Check if text contains any markdown link or skill mention patterns
  const hasLinks = /\[([^\]]+)\]\(([^)]+)\)/.test(text) || /skill:\[([^\]]+)\]\(([^)]+)\)/.test(text);
  const pastedSegments = parsePastedContentSegments(text);
  const hasPastedContent = pastedSegments.some((segment) => segment.type === 'pasted-content');

  // Check if text contains newlines - need paragraph structure for proper display
  const hasNewlines = text.includes('\n');

  // If no links and no newlines, return plain text (TipTap handles single-line fine)
  if (!hasLinks && !hasNewlines && !hasPastedContent) {
    return text;
  }

  const paragraphs: any[] = [];
  const appendTextParagraphs = (value: string) => {
    if (value.length === 0) return;

    const lines = value.split('\n');
    for (const line of lines) {
      if (hasLinks) {
        const lineContent = parseLineForMentions(line);
        if (lineContent.length > 0) {
          paragraphs.push({
            type: 'paragraph',
            content: lineContent,
          });
        } else {
          paragraphs.push({
            type: 'paragraph',
          });
        }
      } else if (line) {
        paragraphs.push({
          type: 'paragraph',
          content: [{ type: 'text', text: line }],
        });
      } else {
        paragraphs.push({
          type: 'paragraph',
        });
      }
    }
  };

  for (const segment of pastedSegments) {
    if (segment.type === 'text') {
      appendTextParagraphs(segment.text);
      continue;
    }

    if (!store) {
      appendTextParagraphs(
        `<pasted-content label=${JSON.stringify(segment.label)}>\n${segment.text}\n</pasted-content>`,
      );
      continue;
    }

    const record = store.add('pasted-text', {
      label: segment.label,
      text: segment.text,
      size: segment.text.length,
    });

    paragraphs.push({
      type: 'paragraph',
      content: [{
        type: 'attachmentChip',
        attrs: {
          id: record.id,
          kind: record.kind,
          label: record.label,
          mimeType: null,
          size: record.size ?? null,
        },
      }],
    });
  }

  return {
    type: 'doc',
    content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph' }],
  };
}

/**
 * Toggle compact icon-only rendering on leading mention clusters.
 * When 3+ consecutive fileMention nodes sit at the start of the first paragraph
 * (with only whitespace between them), their outer Tiptap wrapper elements get
 * the `mention-chip-compact` class so CSS can hide labels/buttons and show a grid.
 */
function applyMentionCompactClasses(editorEl: HTMLElement) {
  // Clear any existing compact classes across the editor
  editorEl.querySelectorAll('.mention-chip-compact').forEach(el => {
    el.classList.remove('mention-chip-compact');
  });

  const firstP = editorEl.children[0];
  if (!firstP || firstP.tagName !== 'P') return;

  // Walk childNodes (not children) so we can detect text before mentions
  const leadingMentions: Element[] = [];
  for (const child of Array.from(firstP.childNodes)) {
    if (child instanceof HTMLElement) {
      if (child.classList.contains('node-fileMention')) {
        leadingMentions.push(child);
      } else if (child.textContent?.trim() === '') {
        continue; // empty wrapper element
      } else {
        break; // non-mention element content
      }
    } else if (child instanceof Text) {
      if (child.textContent?.trim() === '') {
        continue; // whitespace
      } else {
        break; // real text before mentions
      }
    } else {
      break;
    }
  }

  if (leadingMentions.length >= 3) {
    leadingMentions.forEach(el => el.classList.add('mention-chip-compact'));
  }
}

/**
 * Insert a file mention into the editor
 */
function insertFileMention(editor: Editor, filePath: string, fileName: string, isDirectory: boolean) {
  const { state, dispatch } = editor.view;
  const { schema } = state;

  if (!schema.nodes.fileMention) {
    return false;
  }

  const mention = schema.nodes.fileMention.create({
    id: filePath,
    label: fileName,
    itemType: isDirectory ? 'directory' : 'file',
  });

  const tr = state.tr.replaceSelectionWith(mention);
  dispatch(tr);
  editor.commands.focus();
  return true;
}

export interface BaseTiptapComposerRef {
  focus: () => void;
  insertText: (text: string) => void;
  setContent: (text: string) => void;
  setContentWithTokenFlash: (text: string, ranges: Array<{ start: number; end: number }>) => void;
  setPreviewText: (text: string | null) => void;
  getContent: () => string;
  getSubmission: () => SerializedComposerSubmission;
  clearContent: () => void;
}

interface BaseTiptapComposerProps {
  placeholder?: string;
  initialContent?: string;
  onSend: (
    text: string,
    submission?: SerializedComposerSubmission,
  ) => boolean | void | Promise<boolean | void>;
  onCancel?: () => void;
  sendButtonLabel?: string;
  autoFocus?: boolean;
  className?: string;
  noPadding?: boolean;
  editable?: boolean;
  showControls?: boolean;
  viewMode?: boolean;
  onClick?: (e?: React.MouseEvent) => void;
  hideControlsOnBlur?: boolean;
  isMainComposer?: boolean;
  hasPendingTools?: boolean;
  onStop?: () => void;
  settingsContent?: React.ReactNode;
  contextContent?: React.ReactNode;
  leadingControl?: React.ReactNode;
  agentId?: string;
  profileShortcutScope?: string;
  renderSendButton?: (props: { onSend: () => void; disabled: boolean }) => React.ReactNode;
  highlightToolKeywords?: boolean;
  disableSkillMentions?: boolean;
  skillsWorkspacePath?: string | null;
}

export const BaseTiptapComposer = forwardRef<BaseTiptapComposerRef, BaseTiptapComposerProps>(
  ({
    placeholder,
    initialContent = '',
    onSend,
    onCancel: _onCancel,
    sendButtonLabel: _sendButtonLabel = 'Send message (Enter)',
    autoFocus = false,
    className,
    noPadding = false,
    editable = true,
    showControls = true,
    viewMode = false,
    onClick,
    hideControlsOnBlur = false,
    isMainComposer = false,
    hasPendingTools = false,
    onStop,
    settingsContent,
    contextContent,
    leadingControl,
    agentId,
    profileShortcutScope,
    renderSendButton,
    highlightToolKeywords = false,
    disableSkillMentions = false,
    skillsWorkspacePath,
  }, ref) => {
  "use no memo";

  const { t } = useTranslation();

  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const [composerPreviewText, setComposerPreviewText] = useState<string | null>(null);
  const hasContentRef = useRef(false);
  const { showToast } = useToast();
  const composerRef = useRef<HTMLDivElement>(null);
  const voiceDiffClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attachmentStoreRef = useRef<AttachmentStore>(createAttachmentStore());
  const resolveAttachmentRecord = useCallback(
    (attachmentId: string) => attachmentStoreRef.current.get(attachmentId),
    [],
  );
  const randomPlaceholderRef = useRef<string>(pickRandomComposerPlaceholder());
  const skillDropdownDataRef = useRef<SkillMentionDropdownData>({
    globalRootPath: '',
    projectRootPath: null,
    globalItems: [],
    projectItems: [],
  });
  const layout = useContext(LayoutContext);
  const tabsRef = useRef(layout?.state.tabs ?? {});
  const resolvedPlaceholder = placeholder
    ?? (agentId ? pickAgentComposerPlaceholder(agentId) : randomPlaceholderRef.current);

  const isComposerVisible = useCallback((): boolean => {
    const container = composerRef.current;
    if (!container || !container.isConnected) return false;

    const persistentTab = container.closest<HTMLElement>('[data-persistent-tab]');
    if (persistentTab) {
      return persistentTab.getAttribute('data-persistent-visible') === 'true';
    }

    const style = window.getComputedStyle(container);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }, []);

  useEffect(() => {
    tabsRef.current = layout?.state.tabs ?? {};
  }, [layout?.state.tabs]);

  const getSerializedSubmission = useCallback((
    editorLike?: Editor | null,
  ): SerializedComposerSubmission => {
    if (!editorLike) {
      return { text: '', attachments: [] };
    }

    return serializeEditorWithAttachments(
      editorLike.getJSON(),
      attachmentStoreRef.current,
    );
  }, []);

  const hasSubmissionContent = useCallback((submission: SerializedComposerSubmission): boolean => (
    submission.text.trim().length > 0 || submission.attachments.length > 0
  ), []);

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    focus: () => {
      if (editorInstance) {
        editorInstance.commands.focus();
      }
    },
    insertText: (text: string) => {
      if (editorInstance) {
        editorInstance.commands.insertContent(text);
        editorInstance.commands.focus();
      }
    },
    setContent: (text: string) => {
      if (editorInstance) {
        // Clear and set new content - this REPLACES everything
        // Use parseContentWithMentions to properly handle newlines and mentions
        attachmentStoreRef.current.clear();
        editorInstance.commands.setContent(
          parseContentWithMentions(text, attachmentStoreRef.current),
        );
        editorInstance.commands.focus('end');
      }
    },
    setContentWithTokenFlash: (text: string, ranges: Array<{ start: number; end: number }>) => {
      if (!editorInstance) return;

      attachmentStoreRef.current.clear();
      editorInstance.commands.setContent(
        parseContentWithMentions(text, attachmentStoreRef.current),
      );
      editorInstance.commands.focus('end');

      if (voiceDiffClearTimerRef.current) {
        clearTimeout(voiceDiffClearTimerRef.current);
        voiceDiffClearTimerRef.current = null;
      }

      const markType = editorInstance.state.schema.marks.voiceDiff;
      if (!markType || ranges.length === 0) return;

      let plainTextOffset = 0;
      let tr = editorInstance.state.tr;
      let hasMark = false;

      editorInstance.state.doc.descendants((node, pos) => {
        if (!node.isText) return true;

        const nodeText = node.text ?? '';
        const nodeStartOffset = plainTextOffset;
        const nodeEndOffset = nodeStartOffset + nodeText.length;
        plainTextOffset = nodeEndOffset;

        for (const range of ranges) {
          const overlapStart = Math.max(range.start, nodeStartOffset);
          const overlapEnd = Math.min(range.end, nodeEndOffset);
          if (overlapStart >= overlapEnd) continue;

          const from = pos + (overlapStart - nodeStartOffset);
          const to = pos + (overlapEnd - nodeStartOffset);
          tr = tr.addMark(from, to, markType.create());
          hasMark = true;
        }

        return true;
      });

      if (!hasMark) return;

      tr.setMeta('addToHistory', false);
      editorInstance.view.dispatch(tr);

      voiceDiffClearTimerRef.current = setTimeout(() => {
        if (editorInstance.isDestroyed) return;
        const latestMarkType = editorInstance.state.schema.marks.voiceDiff;
        if (!latestMarkType) return;
        const docEnd = editorInstance.state.doc.content.size;
        if (docEnd <= 0) return;

        const clearTr = editorInstance.state.tr.removeMark(
          1,
          docEnd,
          latestMarkType,
        );
        clearTr.setMeta('addToHistory', false);
        editorInstance.view.dispatch(clearTr);
      }, 200);
    },
    setPreviewText: (text: string | null) => {
      setComposerPreviewText(text);
    },
    getContent: () => getSerializedSubmission(editorInstance).text,
    getSubmission: () => getSerializedSubmission(editorInstance),
    clearContent: () => {
      if (editorInstance) {
        editorInstance.commands.clearContent();
      }
      attachmentStoreRef.current.clear();
    },
  }), [editorInstance, getSerializedSubmission]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3, 4, 5, 6],
        },
        // Disable default hardBreak - we add our own with Shift+Enter only
        hardBreak: false,
      }),
      // HardBreak only on Shift+Enter
      HardBreak.extend({
        addKeyboardShortcuts() {
          return {
            'Shift-Enter': () => this.editor.commands.setHardBreak(),
          };
        },
      }),
      Placeholder.configure({
        placeholder: resolvedPlaceholder,
      }),
      FileMention.configure({
        suggestion: createFileMentionSuggestion(),
      }),
      ...(disableSkillMentions ? [] : [
        SkillMention.configure({
          suggestion: createSkillMentionSuggestion({
            getDropdownData: () => skillDropdownDataRef.current,
          }),
        }),
      ]),
      // Highlight tool keywords (PubMed, etc.) when enabled
      ...(highlightToolKeywords ? [ToolKeywordHighlight] : []),
      VoiceDiffMark,
      AttachmentChip,
    ],
    content: parseContentWithMentions(initialContent),
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'max-w-none text-foreground focus:outline-none [&_p]:leading-5 [&_p]:my-0',
        // Test ID from shared/test-ids.ts - DO NOT hardcode strings
        ...(isMainComposer ? { 'data-testid': MAIN_COMPOSER_INPUT_ID } : {}),
      },
      handleDOMEvents: {
        click: (view, event) => {
          if (!editable && onClick) {
            const target = event.target as HTMLElement;
            const isUIControl =
              target.closest('button') ||
              target.closest('[role="button"]') ||
              target.tagName === 'BUTTON';

            if (isUIControl) {
              return false;
            }

            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (pos) {
              (editor as any).__clickPosition = pos.pos;
            }
            onClick();
            return true;
          }
          return false;
        },
        dragover: (_view, event) => {
          const dragEvent = event as DragEvent;
          const paneTabDrag = dragEvent.dataTransfer
            ? resolvePaneTabDragData(dragEvent.dataTransfer)
            : null;

          if (
            paneTabDrag
            && !getComposerTabMentionData(tabsRef.current[paneTabDrag.tabId])
          ) {
            return false;
          }

          const types = dragEvent.dataTransfer?.types || [];
          // Accept internal JSON, external files, or URLs from web pages
          if (
            types.includes('application/json') ||
            types.includes('Files') ||
            types.includes('text/uri-list') ||
            types.includes('DownloadURL') ||
            types.includes('text/x-moz-url') ||
            types.includes('text/plain') ||
            types.includes('text/html')
          ) {
            event.preventDefault();
            dragEvent.dataTransfer!.dropEffect = 'move';
            return true;
          }
          return false;
        },
        drop: (view, event) => {
          const dragEvent = event as DragEvent;
          const paneTabDrag = dragEvent.dataTransfer
            ? resolvePaneTabDragData(dragEvent.dataTransfer)
            : null;
          if (
            paneTabDrag
            && !getComposerTabMentionData(tabsRef.current[paneTabDrag.tabId])
          ) {
            return false;
          }

          event.preventDefault();
          event.stopPropagation();

          const pos = view.posAtCoords({ left: dragEvent.clientX, top: dragEvent.clientY });
          if (!pos) {
            return false;
          }

          const { schema } = view.state;
          if (!schema.nodes.fileMention) {
            return false;
          }

          const extractUrlFromDataTransfer = (dt: DataTransfer | null | undefined): { url: string; mimeType?: string } | null => {
            if (!dt) return null;

            const uriList = dt.getData('text/uri-list');
            if (uriList) {
              const urls = uriList.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
              if (urls.length > 0) return { url: urls[0] };
            }

            const mozUrl = dt.getData('text/x-moz-url');
            if (mozUrl) {
              const url = mozUrl.split('\n')[0]?.trim();
              if (url) return { url };
            }

            const downloadUrl = dt.getData('DownloadURL');
            if (downloadUrl) {
              const match = /^([^:]+):([^:]*):(.*)$/.exec(downloadUrl);
              const mimeType = match?.[1]?.trim();
              const url = (match?.[3] ?? downloadUrl).trim();
              if (url) return { url, mimeType };
            }

            const plain = dt.getData('text/plain')?.trim();
            const plainFirstLine = plain ? plain.split('\n')[0]?.trim() : '';
            if (plainFirstLine && /^https?:\/\//i.test(plainFirstLine)) return { url: plainFirstLine };

            const html = dt.getData('text/html');
            if (html) {
              const srcMatch = /\ssrc=["']([^"']+)["']/i.exec(html);
              const hrefMatch = /\shref=["']([^"']+)["']/i.exec(html);
              const url = (srcMatch?.[1] ?? hrefMatch?.[1] ?? '').trim();
              if (url && /^https?:\/\//i.test(url)) return { url };
            }

            return null;
          };

          const isProbablyImageUrl = (url: string, mimeType?: string) => {
            if (mimeType && /^image\//i.test(mimeType)) return true;
            if (/\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?.*)?$/i.test(url)) return true;
            // Common “image CDN” patterns where extensions may be missing.
            if (url.includes('images.unsplash.com')) return true;
            if (url.includes('pbs.twimg.com')) return true;
            if (url.includes('i.imgur.com')) return true;
            return false;
          };

          // 1. Handle internal JSON drag data (files/folders/browser tabs from within app)
          const jsonData = dragEvent.dataTransfer?.getData('application/json');
          if (jsonData) {
            const data = parseDragData(jsonData);
            if (data) {
              if (isFileDragData(data)) {
                const mention = schema.nodes.fileMention.create({
                  id: data.filePath,
                  label: data.fileName || pathBasename(data.filePath),
                  itemType: data.isDirectory ? 'directory' : 'file',
                });
                view.dispatch(view.state.tr.insert(pos.pos, mention));
                return true;
              }

              if (isBrowserTabDragData(data)) {
                const mention = schema.nodes.fileMention.create({
                  id: data.browserId,
                  label: data.fileName,
                  itemType: 'browser-tab',
                  url: data.url,
                  faviconUrl: data.faviconUrl,
                });
                view.dispatch(view.state.tr.insert(pos.pos, mention));
                return true;
              }
            }

          }

          if (paneTabDrag) {
            const mentionData = getComposerTabMentionData(tabsRef.current[paneTabDrag.tabId]);
            if (mentionData) {
              const mention = schema.nodes.fileMention.create(mentionData);
              view.dispatch(view.state.tr.insert(pos.pos, mention));
              return true;
            }
          }

          // 2. Handle URL drops (from web pages / embedded browser)
          const extracted = extractUrlFromDataTransfer(dragEvent.dataTransfer);
          if (extracted?.url) {
            const { url, mimeType } = extracted;
            const isImageUrl = isProbablyImageUrl(url, mimeType);

            if (isImageUrl && window.electron?.files?.downloadUrl) {
              // Download image asynchronously and insert mention
              (async () => {
                try {
                  const result = await window.electron.files.downloadUrl(url);
                  if (result.success && result.filePath) {
                    const fileName = pathBasename(result.filePath) || 'image';
                    const mention = schema.nodes.fileMention.create({
                      id: result.filePath,
                      label: fileName,
                      itemType: 'file',
                    });
                    view.dispatch(view.state.tr.insert(pos.pos, mention));
                  }
                } catch (err) {
                  console.error('[BaseTiptapComposer] Failed to download URL:', err);
                }
              })();
              return true;
            }

            // If it's a non-image URL, just insert the URL text.
            view.dispatch(view.state.tr.insertText(url, pos.pos));
            return true;
          }

          // 3. Handle native file drops (from Finder/Desktop) as file mentions.
          // The desktop composer does not turn dropped images into image
          // payload attachments.
          const files = dragEvent.dataTransfer?.files;
          if (files && files.length > 0) {
            const nodes: any[] = [];
            for (const file of Array.from(files)) {
              const filePath = window.electron?.getPathForFile?.(file);
              if (filePath) {
                nodes.push(schema.nodes.fileMention.create({
                  id: filePath,
                  label: file.name,
                  itemType: 'file',
                }));
              }
            }
            if (nodes.length > 0) {
              view.dispatch(view.state.tr.insert(pos.pos, nodes));
            }
            return true;
          }

          return false;
        },
        paste: (view, event) => {
          const clipboardEvent = event as ClipboardEvent;
          const items = clipboardEvent.clipboardData?.items;
          if (!items) return false;

          const text = clipboardEvent.clipboardData?.getData('text/plain');
          if (text) {
            // Spreadsheet apps often expose both plain text and image clipboard flavors.
            // Prefer text in the composer so cell copies paste as text instead of triggering
            // the image paste path.
            event.preventDefault();

            // Long / multi-line pastes become an inline "Pasted (N lines)" chip
            // so the composer stays readable. The full body is inlined at send
            // time via the attachment store.
            if (shouldChipifyPastedText(text)) {
              const { schema } = view.state;
              const chipType = schema.nodes.attachmentChip;
              if (chipType) {
                const record = attachmentStoreRef.current.add('pasted-text', {
                  label: buildPastedTextLabel(text),
                  text,
                  size: text.length,
                });
                const node = chipType.create({
                  id: record.id,
                  kind: record.kind,
                  label: record.label,
                  mimeType: null,
                  size: record.size ?? null,
                });
                view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
                return true;
              }
            }

            const parsed = parseContentWithMentions(text);
            const { state } = view;
            const { from, to } = state.selection;

            if (typeof parsed === 'string') {
              view.dispatch(state.tr.insertText(parsed, from, to));
              return true;
            }

            const slice = view.state.schema.nodeFromJSON(parsed);
            view.dispatch(state.tr.replaceWith(from, to, slice.content));
            return true;
          }

          const imageItem = Array.from(items).find(
            item => item.kind === 'file' && item.type.startsWith('image/')
          );
          const imageFile = imageItem?.getAsFile();
          if (imageFile && window.electron?.files?.saveClipboardImage) {
            event.preventDefault();

            (async () => {
              try {
                // Desktop clipboard images stay on the file-reference path:
                // save to disk, then insert a file mention. The overlay is the
                // surface that emits image payload attachments.
                const result = await window.electron.files.saveClipboardImage({
                  imageData: await imageFile.arrayBuffer(),
                  mimeType: imageFile.type || 'image/png',
                  suggestedFilename: imageFile.name || undefined,
                });
                if (result.success && result.filePath) {
                  const { schema } = view.state;
                  if (!schema.nodes.fileMention) return;
                  const filename = pathBasename(result.filePath) || 'paste.png';
                  const mention = schema.nodes.fileMention.create({
                    id: result.filePath,
                    label: filename,
                    itemType: 'file',
                  });
                  view.dispatch(view.state.tr.replaceSelectionWith(mention));
                  return;
                }
                showToast(result.error || 'Failed to paste image', 'error', 4000);
              } catch (err) {
                showToast('Failed to paste image', 'error', 4000);
                console.error('[BaseTiptapComposer] Failed to save clipboard image:', err);
              }
            })();

            return true;
          }

          return false;
        },
      },
    },
    onCreate: ({ editor }) => {
      setEditorInstance(editor);
      if (initialContent && hasSerializedPastedContent(initialContent)) {
        attachmentStoreRef.current.clear();
        editor.commands.setContent(
          parseContentWithMentions(initialContent, attachmentStoreRef.current),
          { emitUpdate: false },
        );
      }
      const nextHasContent = hasSubmissionContent(getSerializedSubmission(editor));
      hasContentRef.current = nextHasContent;
      setHasContent(nextHasContent);
      if (autoFocus) {
        editor.commands.focus();
      }
      if (isMainComposer) {
        editor.view.dom.classList.add('main-composer-editor');
      }
      applyMentionCompactClasses(editor.view.dom);
    },
    onFocus: () => {
      if (!hideControlsOnBlur) {
        setIsFocused(true);
      }
    },
    onBlur: () => {
      if (!hideControlsOnBlur) {
        setTimeout(() => {
          if (composerRef.current && !composerRef.current.contains(document.activeElement)) {
            setIsFocused(false);
          }
        }, 0);
      }
    },
    onUpdate: ({ editor }) => {
      // Avoid re-rendering the full composer on every keystroke. We only need
      // React state updates when the empty/non-empty boundary changes.
      const nextHasContent = hasSubmissionContent(getSerializedSubmission(editor));
      if (nextHasContent !== hasContentRef.current) {
        hasContentRef.current = nextHasContent;
        setHasContent(nextHasContent);
      }
      applyMentionCompactClasses(editor.view.dom);
      // Drop attachment records whose chips were removed from the document.
      const liveIds = new Set<string>();
      editor.state.doc.descendants((descendantNode) => {
        if (descendantNode.type.name === 'attachmentChip') {
          const chipId = (descendantNode.attrs as ComposerAttachmentAttrs).id;
          if (chipId) liveIds.add(chipId);
        }
        return true;
      });
      for (const record of attachmentStoreRef.current.snapshot()) {
        if (!liveIds.has(record.id)) attachmentStoreRef.current.remove(record.id);
      }
    },
  }, [
    disableSkillMentions,
    editable,
    getSerializedSubmission,
    hasSubmissionContent,
    highlightToolKeywords,
  ]);

  const lastAppliedInitialContentRef = useRef<string | null>(null);
  const wasEditableRef = useRef(editable);

  useEffect(() => {
    if (!editor) return;

    const initialContentKey = initialContent ?? '';
    const shouldApply =
      !editable && (
        initialContentKey !== lastAppliedInitialContentRef.current ||
        wasEditableRef.current
      );

    if (shouldApply) {
      attachmentStoreRef.current.clear();
      if (initialContent) {
        editor.commands.setContent(
          parseContentWithMentions(initialContent, attachmentStoreRef.current),
          { emitUpdate: false },
        );
      } else {
        editor.commands.clearContent();
      }
      lastAppliedInitialContentRef.current = initialContentKey;
    }

    wasEditableRef.current = editable;
  }, [editor, editable, initialContent]);

  // Update editor editable state when prop changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(editable);
      if (editable && autoFocus) {
        setTimeout(() => {
          const clickPosition = (editor as any).__clickPosition;
          if (clickPosition !== undefined) {
            editor.commands.focus(clickPosition);
            delete (editor as any).__clickPosition;
          } else {
            editor.commands.focus();
          }
        }, 50);
      }
    }
  }, [editor, editable, autoFocus]);

  // Load skills for slash command dropdown
  useEffect(() => {
    if (!isMainComposer || disableSkillMentions) return;

    const loadSkills = async () => {
      try {
        const { skills: skillsIpc } = await import('../../../src/ipc');
        const response = await skillsIpc.list({ workspacePath: skillsWorkspacePath ?? null });
        if (response.success && response.data) {
          const toItem = (skill: SkillOption): SkillMentionItem => ({
            id: skill.id,
            label: humanizeSkillName(skill.title || skill.name),
            name: skill.name,
            path: skill.filePath,
            description: skill.description,
            source: skill.source,
          });
          const projectItems = response.data.project.skills.map(toItem);
          const globalItems = response.data.global.skills.map(toItem);
          const allItems = [...projectItems, ...globalItems];

          skillDropdownDataRef.current = {
            projectRootPath: response.data.project.rootPath,
            globalRootPath: response.data.global.rootPath,
            projectItems,
            globalItems,
          };
          setSkillItemRegistry(allItems);
        }
      } catch (err) {
        console.error('[BaseTiptapComposer] Failed to load skills:', err);
      }
    };

    loadSkills();

    // Listen for skill changes
    let unsubscribe: (() => void) | undefined;
    import('../../../src/ipc').then(({ skills: skillsIpc }) => {
      unsubscribe = skillsIpc.onChanged?.(() => {
        loadSkills();
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [isMainComposer, disableSkillMentions, skillsWorkspacePath]);

  // Listen for focus-agent-input custom event (Cmd+L shortcut)
  useEffect(() => {
    if (!isMainComposer || !editor) return;

    const handleFocusAgent = (event: Event) => {
      const detail = (event as CustomEvent<FocusComposerDetail>).detail;
      if (detail?.agentId && detail.agentId !== agentId) {
        return;
      }

      if (!isComposerVisible()) {
        return;
      }

      editor.commands.focus();
    };

    window.addEventListener('focus-agent-input', handleFocusAgent);
    return () => {
      window.removeEventListener('focus-agent-input', handleFocusAgent);
    };
  }, [agentId, editor, isComposerVisible, isMainComposer]);

  useEffect(() => {
    return () => {
      if (voiceDiffClearTimerRef.current) {
        clearTimeout(voiceDiffClearTimerRef.current);
        voiceDiffClearTimerRef.current = null;
      }
    };
  }, []);

  // Handle send action
  const handleSend = useCallback(async () => {
    if (!editor) return;

    const submission = getSerializedSubmission(editor);
    if (!hasSubmissionContent(submission)) return;

    const handled = await onSend(submission.text, submission);
    if (handled === false) {
      return;
    }

    attachmentStoreRef.current.clear();

    if (isMainComposer) {
      editor.commands.clearContent();
      refocusMainComposer(editor);
    }
  }, [editor, getSerializedSubmission, hasSubmissionContent, isMainComposer, onSend]);

  // Handle keyboard shortcuts
  useEffect(() => {
    if (!editorInstance) return;

    // Try to get the DOM element - tiptap throws if view not ready
    let editorDom: HTMLElement;
    try {
      editorDom = editorInstance.view.dom;
    } catch {
      // Editor view not mounted yet, will retry when editorInstance updates
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if mention popup is open - don't intercept keys if so
      const mentionPopup = document.querySelector('[data-mention-popup]');
      if (mentionPopup) {
        // Let the mention dropdown handle the key
        return;
      }

      if (
        isMainComposer &&
        profileShortcutScope
      ) {
        const slot = resolveProfileShortcutSlot(event);
        if (slot !== null) {
          event.preventDefault();
          event.stopPropagation();
          window.dispatchEvent(new CustomEvent<ComposerProfileShortcutDetail>(
            COMPOSER_PROFILE_SHORTCUT_EVENT,
            { detail: { scope: profileShortcutScope, slot } },
          ));
          return;
        }
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        setTimeout(() => handleSend(), 0);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        // Just blur the editor instead of cancelling
        editorInstance.commands.blur();
      }
    };

    editorDom.addEventListener('keydown', handleKeyDown, true);

    return () => {
      editorDom.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [editorInstance, handleSend, isMainComposer, profileShortcutScope]);

  // Track clicks for hideControlsOnBlur
  useEffect(() => {
    if (!hideControlsOnBlur) return;

    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;

      if (composerRef.current?.contains(target)) {
        return;
      }

      setIsFocused(false);
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);

    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
    };
  }, [hideControlsOnBlur]);

  // Listen for file drop events from AgentSidebar/Composer wrapper (main composer only)
  useEffect(() => {
    if (!isMainComposer || !editorInstance || !agentId) return;

    const handleFileDrop = (event: CustomEvent) => {
      const { filePath, fileName, isDirectory, agentId: eventAgentId } = event.detail || {};
      console.log('[file-drag-debug] composer:event', {
        composerAgentId: agentId,
        eventAgentId,
        eventType: event.type,
        filePath,
        fileName,
        isDirectory,
      });
      // Only handle events for this agent
      if (eventAgentId !== agentId) {
        console.log('[file-drag-debug] composer:event:ignored-agent-mismatch', {
          composerAgentId: agentId,
          eventAgentId,
          eventType: event.type,
        });
        return;
      }
      if (filePath && editorInstance) {
        const inserted = insertFileMention(editorInstance, filePath, fileName || pathBasename(filePath) || 'file', Boolean(isDirectory));
        console.log('[file-drag-debug] composer:event:inserted', {
          composerAgentId: agentId,
          eventAgentId,
          eventType: event.type,
          filePath,
          fileName,
          isDirectory,
          inserted,
        });
        editorInstance.commands.focus('end');
      }
    };

    // Listen for both event types
    window.addEventListener('agent-sidebar:file-drop', handleFileDrop as EventListener);
    window.addEventListener('composer:file-drop', handleFileDrop as EventListener);

    return () => {
      window.removeEventListener('agent-sidebar:file-drop', handleFileDrop as EventListener);
      window.removeEventListener('composer:file-drop', handleFileDrop as EventListener);
    };
  }, [isMainComposer, editorInstance, agentId]);

  const handleDivClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (hideControlsOnBlur) {
      setIsFocused(true);
    }

    if (e.target === e.currentTarget && editor && editable) {
      editor.commands.focus('end');
    }
  };

  const mainComposerTextInsetStyle = isMainComposer
    ? {
        paddingTop: '0px',
        paddingBottom: '2px',
      }
    : undefined;
  const mainComposerTypographyClassName = 'text-[15px] leading-[1.7rem]';

  return (
    <div
      ref={composerRef}
      className={[
        'w-full',
        className || ''
      ].join(' ')}
      onClick={handleDivClick}
    >
      <div
        className="flex-1 flex min-h-0 flex-col"
        style={noPadding
          ? {
              paddingTop: isMainComposer ? '0.875rem' : 'var(--unit-padding-medium)',
              paddingRight: isMainComposer ? '1rem' : 'var(--unit-padding-medium)',
              paddingBottom: '0.375rem',
              paddingLeft: isMainComposer ? '1rem' : 'var(--unit-padding-medium)',
            }
          : { padding: '0.75rem 0.75rem 0.5rem' }}
      >
        <div className="flex flex-col flex-1 min-h-0">
          <div
            className={[
              noPadding ? '' : 'px-3 py-3',
              'relative flex-1 min-h-0 cursor-text'
            ].join(' ')}
            style={{
              minHeight: isMainComposer ? '4.75rem' : undefined,
            }}
            onClick={(e) => {
              if (hideControlsOnBlur) {
                setIsFocused(true);
              }

              if (editor && editable && !editor.isFocused) {
                e.stopPropagation();
                editor.commands.focus();
              }
            }}
          >
            <EditorContent
              editor={editor}
              className={[
                'tiptap-editor',
                `h-full overflow-y-auto ${mainComposerTypographyClassName}`,
                editable ? 'cursor-text' : '[&_*]:cursor-text',
                isMainComposer && 'main-composer-content'
              ].join(' ')}
              style={mainComposerTextInsetStyle}
            />
            {isMainComposer && (
              <div
                className="oa-main-composer-preview pointer-events-none absolute inset-0 overflow-hidden"
                style={{
                  background: 'var(--oa-composer-surface, var(--oa-bg-input, var(--background)))',
                  display: composerPreviewText ? 'block' : 'none',
                  visibility: composerPreviewText ? 'visible' : 'hidden',
                  opacity: composerPreviewText ? 1 : 0,
                  transition: 'opacity 180ms ease-out',
                  WebkitMaskImage: 'var(--oa-composer-preview-mask, linear-gradient(to bottom, black 78%, transparent 100%))',
                  maskImage: 'var(--oa-composer-preview-mask, linear-gradient(to bottom, black 78%, transparent 100%))',
                  zIndex: 1,
                }}
                aria-hidden
              >
                <div
                  className={mainComposerTypographyClassName}
                  style={{
                    ...mainComposerTextInsetStyle,
                    color: 'color-mix(in srgb, var(--oa-text-muted, var(--muted-foreground)) 68%, transparent)',
                    maxWidth: 'calc(100% - 1rem)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {composerPreviewText ? renderPreviewText(composerPreviewText) : null}
                </div>
              </div>
            )}
            {isMainComposer && !hasContent && (
              <div
                key={resolvedPlaceholder}
                className={`oa-main-composer-placeholder pointer-events-none absolute inset-x-0 ${mainComposerTypographyClassName}`}
                style={{
                  ...mainComposerTextInsetStyle,
                  top: 0,
                  maxWidth: 'calc(100% - 1rem)',
                  color: 'color-mix(in srgb, var(--oa-text-muted, var(--muted-foreground)) 68%, transparent)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                <span>{resolvedPlaceholder}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {showControls && (
        <div
          className={[
            'cursor-text',
            hideControlsOnBlur && !isFocused ? (
              'max-h-0 opacity-0 overflow-hidden pointer-events-none'
            ) : (
              'max-h-20 opacity-100'
            )
          ].join(' ')}
          onMouseDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            if (hideControlsOnBlur) {
              setIsFocused(true);
            }

            const target = e.target as HTMLElement;
            const isButton = target.closest('button') || target.closest('a');
            if (editor && editable && !isButton) {
              editor.commands.focus('end');
            }
          }}
        >
          <div
            className="flex items-center justify-between gap-3"
            style={{
              minHeight: '2.75rem',
              paddingLeft: noPadding ? '0.25rem' : 'var(--unit-padding)',
              paddingRight: noPadding ? '0.25rem' : 'var(--unit-padding)',
              paddingBottom: noPadding ? '0.25rem' : undefined,
            }}
          >
            <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden mr-2">
              {!viewMode && (
                <div className="flex h-11 w-11 shrink-0 items-center justify-center">
                  {leadingControl ?? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <ComposerSecondaryButton
                          type="button"
                          chromeSize="icon"
                          data-help-id="composer-add-attachment"
                          data-help-title={t('help.composer.addAttachment.title')}
                          data-help-description={t('help.composer.addAttachment.description')}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (editor) {
                              editor.commands.insertContent(' @');
                              editor.commands.focus('end');
                            }
                            setIsFocused(true);
                          }}
                        >
                          <Plus />
                        </ComposerSecondaryButton>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <span className="flex items-center gap-1.5">
                          <span>{t('help.composer.addAttachment.title')}</span>
                          <span className="opacity-60">@</span>
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}
              {contextContent}
            </div>

            <div className="flex items-center gap-1">
              {settingsContent}
              {!viewMode && (
                <div className="flex h-11 w-11 shrink-0 items-center justify-center">
                  {renderSendButton ? (
                    renderSendButton({
                      onSend: handleSend,
                      disabled: !editorInstance || !hasContent,
                    })
                  ) : hasPendingTools && onStop ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          data-help-title={t('help.composer.stop.title')}
                          data-help-description={t('help.composer.stop.description')}
                          className="flex size-9 items-center justify-center rounded-full transition-all duration-150 hover:-translate-y-px [&_svg]:size-4"
                          style={{
                            background: 'var(--brand-accent, var(--oa-primary, var(--foreground)))',
                            color: 'var(--brand-accent-foreground, var(--oa-primary-foreground, var(--background)))',
                            boxShadow: 'var(--oa-shadow-sm, 0 8px 30px rgba(0,0,0,0.08))',
                          }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setIsFocused(true);
                            onStop?.();
                          }}
                        >
                          <Square className="fill-current" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">{t('help.composer.stop.title')}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          data-help-title={t('help.composer.send.title')}
                          data-help-description={t('help.composer.send.description')}
                          // Test ID from shared/test-ids.ts - DO NOT hardcode strings
                          data-testid={isMainComposer ? MAIN_COMPOSER_SEND_BUTTON_ID : undefined}
                          className="composer-send-button flex size-9 items-center justify-center rounded-full transition-all duration-150 hover:-translate-y-px [&_svg]:size-4"
                          style={{
                            background: 'var(--brand-accent, var(--oa-primary, var(--foreground)))',
                            color: 'var(--brand-accent-foreground, var(--oa-primary-foreground, var(--background)))',
                            boxShadow: 'var(--oa-shadow-sm, 0 8px 30px rgba(0,0,0,0.08))',
                          }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSend();
                          }}
                        >
                          <ArrowUpIcon />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <span className="flex items-center gap-1.5">
                          <span>{t('help.composer.send.title')}</span>
                          <span className="opacity-60">↵</span>
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <AttachmentPreviewPopover resolveRecord={resolveAttachmentRecord} />
    </div>
  );
});

BaseTiptapComposer.displayName = 'BaseTiptapComposer';
