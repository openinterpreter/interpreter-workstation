import {
  AppWindow,
  Bot,
  ChevronRight,
  FileCode2,
  FilePenLine,
  FileSearch,
  FileText,
  FolderOpen,
  FolderTree,
  Globe,
  Search,
  ShieldQuestion,
  Sparkles,
  TerminalSquare,
  TestTube2,
  WandSparkles,
} from 'lucide-react';
import { diffWords } from 'diff';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import React, { useCallback, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { COLLAPSE_TRANSITION, FAST_TWEEN } from '@/lib/animationConfig';
import { useLiveToolCall } from '@/hooks/useLiveToolCall';
import { TOOL_CALL_ID } from '../../../shared/element-ids';
import { SUBAGENT_TOOLS } from '../../../shared/toolMetadata';
import type { QuestionRequest } from '../../../shared/types/approval';
import {
  MENTION_PREVIEW_DELAY_MS,
  MENTION_PREVIEW_END_EVENT,
  MENTION_PREVIEW_START_EVENT,
} from '../../../shared/types/mentionPreview';
import { displayToolName } from '../../../shared/utils/mcpToolName';
import { approvals as approvalsIpc, files as filesIpc, isAbsolutePath, pathBasename, pathDirname, pathNormalize, pathResolve } from '../../../src/ipc';
import { FileSystemProxy } from '../../../src/components/FileSystemProxy';
import { AnimatedCopyButton } from '../../../src/components/ui/message-action-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../src/components/ui/tooltip';
import type { ToolCallInfo } from '../../../src/hooks/use-chat';
import type { v2 } from '../../../server/handlers/codex-generated-types/index';
import {
  extractCommandActions,
  extractToolCategory,
  extractToolPaths,
  extractToolQuery,
  parseInterpreterAppServiceToolCommand,
  type ToolMention,
  parseShellCommand,
  unwrapShellCommand,
} from '../../../src/lib/codex/tool-call-format';
import { Markdown } from './markdown';
import { TextShimmer } from './text-shimmer';

const READ_TOOLS = new Set([
  'read_file',
  'read_multiple_files',
  'Read',
  'read_image',
  'read_pdf',
  'read_docx',
  'read_word',
  'read_xlsx',
  'read_pptx',
  'read_cell',
  'read_range',
  'read_worksheet',
  'read_spreadsheet',
  'browser_read_page',
  'browser_get_text',
  'browser_get_html',
  'read_page',
]);

const SEARCH_TOOLS = new Set([
  'search_files',
  'grep',
  'indexed_search',
  'search_cells',
  'web_search',
  'nylas_search_messages',
  'whatsapp_search_messages',
  'telegram_search_messages',
]);

const LIST_TOOLS = new Set([
  'directory_tree',
  'list_directory',
  'list_allowed_directories',
  'list_open_tabs',
  'list_mcp_servers',
  'get_mcp_server_tools',
  'list_sheets',
  'PptxShapeList',
  'PptxSlideList',
  'PptxAnimationList',
]);

const WRITE_TOOLS = new Set([
  'write_file',
  'write_file_content',
  'Edit',
  'apply_patch',
  'create_directory',
  'move_file',
  'copy_file',
  'delete_file',
  'download_file',
  'open_file',
  'interpreter_set',
  'interpreter_settings_set',
  'close_tab',
  'interpreter_close_tab',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_select',
  'browser_hover',
  'browser_back',
  'browser_go_back',
  'browser_forward',
  'browser_go_forward',
  'browser_refresh',
  'browser_reload',
  'browser_close',
  'browser_form_input',
  'create_pdf',
  'write_docx',
  'write_xlsx',
  'write_worksheet',
  'write_pptx',
  'create_presentation',
  'convert_file',
]);

type Tone = 'explore' | 'edit' | 'run' | 'browse' | 'workstation' | 'other' | 'danger';
type ToolIcon = FC<{ className?: string }>;

type View = {
  tone: Tone;
  icon: ToolIcon;
  eyebrow: string;
  title: string;
  caption?: string;
  detail?: string;
  filePath?: string;
  filePaths?: string[];
  query?: string;
};

function dynamicAppToolService(item: Extract<v2.ThreadItem, { type: 'dynamicToolCall' }>): { serviceId: string; toolName: string } | null {
  if (item.namespace?.trim()) {
    return { serviceId: item.namespace.trim(), toolName: item.tool };
  }

  const separatorIndex = item.tool.indexOf('__');
  if (separatorIndex <= 0 || separatorIndex >= item.tool.length - 2) {
    return null;
  }

  return {
    serviceId: item.tool.slice(0, separatorIndex),
    toolName: item.tool.slice(separatorIndex + 2),
  };
}

function openFile(filePath: string | undefined) {
  if (!filePath) return;
  (window as { windowingAPI?: { openFile?: (value: string) => void } })?.windowingAPI?.openFile?.(filePath);
}

function openFolder(folderPath: string | undefined) {
  if (!folderPath) return;
  (window as { windowingAPI?: { openFolder?: (value: string) => void } })?.windowingAPI?.openFolder?.(folderPath);
}

function openPath(path: string | undefined, itemType: ToolMention['itemType']) {
  if (itemType === 'directory') {
    openFolder(path);
    return;
  }
  openFile(path);
}

function toolName(item: Extract<v2.ThreadItem, { type: 'mcpToolCall' }>): string {
  return displayToolName(item.tool);
}

function isJsReplToolCall(tc: ToolCallInfo): boolean {
  return tc.item?.type === 'commandExecution'
    && (tc.item.command === 'js_repl' || tc.sourceToolName === 'js_repl');
}

function commandSourceFor(tc: ToolCallInfo): string | undefined {
  if (tc.item?.type !== 'commandExecution') {
    return undefined;
  }

  if (isJsReplToolCall(tc)) {
    return tc.sourceInput ?? tc.item.command;
  }

  return tc.item.command;
}

function commandActionsFor(tc: ToolCallInfo) {
  if (tc.item?.type !== 'commandExecution') {
    return [];
  }

  const actions = extractCommandActions(tc.item, tc.sourceInput, tc.sourceToolName);
  const outputMentions = commandOutputFileMentions(tc.output, tc.item.cwd);
  if (outputMentions.length === 0) {
    return actions;
  }

  return actions.map((entry) => entry.mentions.length > 0
    ? entry
    : { ...entry, mentions: outputMentions });
}

function commandOutputFileMentions(output: string | undefined, cwd: string | undefined): ToolMention[] {
  if (!output) {
    return [];
  }

  const outputTexts = commandOutputTextBlocks(output);
  const mentions = outputTexts
    .flatMap((text) => text.split(/\r?\n/))
    .flatMap((line) => {
      const match = /^(?:File saved:|Output file:|Wrote\s+)\s*(.+?)\s*$/.exec(line);
      const rawPath = match?.[1]?.trim();
      if (!rawPath || !isMentionableOutputPath(rawPath)) {
        return [];
      }
      const path = isAbsolutePath(rawPath) ? rawPath : pathResolve(cwd ?? '', rawPath);
      return [{
        path,
        itemType: 'file' as const,
        label: pathBasename(path) || path,
      }];
    });

  return uniqMentions(mentions);
}

function commandOutputTextBlocks(output: string): string[] {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { content?: unknown }).content)) {
      const texts = (parsed as { content: unknown[] }).content
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const text = (item as { text?: unknown }).text;
          return typeof text === 'string' ? text : null;
        })
        .filter((text): text is string => Boolean(text));
      if (texts.length > 0) {
        return texts;
      }
    }
  } catch {
    // Fall through to raw output. Some command results are plain text.
  }

  return [output];
}

function isMentionableOutputPath(value: string): boolean {
  if (
    value.includes('"')
    || value.includes('{')
    || value.includes('}')
    || value.includes(',')
    || value.includes('\\n')
  ) {
    return false;
  }

  const trimmed = value.trim();
  if (!/\.(?:xlsx|xls|csv|tsv|pdf|docx|md|txt|json)$/i.test(trimmed)) {
    return false;
  }

  return trimmed.startsWith('/')
    || trimmed.startsWith('./')
    || trimmed.startsWith('../')
    || /^[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)+$/.test(trimmed);
}

function commandLanguageFor(tc: ToolCallInfo): 'bash' | 'javascript' {
  return isJsReplToolCall(tc) ? 'javascript' : 'bash';
}

function commandPromptFor(tc: ToolCallInfo): string | null {
  return isJsReplToolCall(tc) ? null : '$';
}

function commandInputLabelFor(tc: ToolCallInfo): string {
  return isJsReplToolCall(tc) ? 'Code' : 'Command';
}

function toolIsQuestion(tc: ToolCallInfo): boolean {
  return tc.item?.type === 'mcpToolCall' && toolName(tc.item) === 'ask_user_question';
}

function questionCount(tc: ToolCallInfo): number {
  if (tc.item?.type !== 'mcpToolCall') return 0;
  const questions = (tc.item.arguments as { questions?: unknown } | null)?.questions;
  return Array.isArray(questions) ? questions.length : 0;
}

function fileChangeKind(item: Extract<v2.ThreadItem, { type: 'fileChange' }>): 'write' | 'delete' | 'edit' {
  const first = item.changes[0];
  if (first?.kind.type === 'add') return 'write';
  if (first?.kind.type === 'delete') return 'delete';
  return 'edit';
}

function fileChangeTitle(item: Extract<v2.ThreadItem, { type: 'fileChange' }>): string {
  const kind = fileChangeKind(item);
  if (kind === 'write') return 'Write file';
  if (kind === 'delete') return 'Delete file';
  return item.changes.length > 1 ? 'Edit files' : 'Edit file';
}

function toneName(tc: ToolCallInfo): Tone {
  if (tc.state === 'error') return 'danger';
  if (!tc.item) return 'other';

  const raw = extractToolCategory(tc.item);
  if (raw === 'explore') return 'explore';
  if (raw === 'edit') return 'edit';
  if (raw === 'run') return 'run';
  if (raw === 'browse') return 'browse';
  if (raw === 'workstation') return 'workstation';
  return 'other';
}

function plainLine(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const line = value
    .split('\n')
    .map((entry) => entry.trim())
    .find(Boolean);

  if (!line) return undefined;

  const next = line
    .replace(/[`*_>#~-]+/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return next || undefined;
}

function uniqMentions(mentions: ToolMention[]): ToolMention[] {
  const seen = new Set<string>();
  return mentions.filter((entry) => {
    const key = `${entry.itemType}:${entry.itemType === 'service' ? entry.path : pathNormalize(entry.path)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SUMMARY_CONTINUATION_WORDS = new Set([
  'Reasoning',
  'Reasoned',
  'Viewing',
  'Viewed',
  'Reading',
  'Read',
  'Searching',
  'Searched',
  'Exploring',
  'Explored',
  'Updating',
  'Updated',
  'Running',
  'Ran',
  'Waiting',
  'Asked',
  'Delegating',
  'Delegated',
  'Planning',
  'Planned',
  'Working',
  'Worked',
  'Creating',
  'Created',
  'Deleting',
  'Deleted',
  'Editing',
  'Edited',
  'Interacted',
]);

function normalizeSummaryContinuationCase(value: string): string {
  const trimmed = value.trim();
  const firstWord = trimmed.match(/^[A-Za-z]+/)?.[0];
  if (!firstWord || !SUMMARY_CONTINUATION_WORDS.has(firstWord)) {
    return value;
  }

  return value.replace(firstWord, `${firstWord[0]?.toLowerCase() ?? ''}${firstWord.slice(1)}`);
}

function joinSummary(values: string[], loading: boolean) {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length === 0) {
    return loading ? 'Working...' : 'Completed';
  }
  if (unique.length === 1) {
    return loading ? `${unique[0]}...` : unique[0];
  }

  const [first, ...rest] = unique;
  const normalized = [first, ...rest.map(normalizeSummaryContinuationCase)];
  const head = normalized.slice(0, -1);
  const tail = normalized[normalized.length - 1];
  const text = head.length === 1 ? `${head[0]} and ${tail}` : `${head.join(', ')}, and ${tail}`;
  return loading ? `${text}...` : text;
}

function clampSummaryText(text: string, loading: boolean, childCount: number) {
  if (childCount <= 1) {
    return text;
  }

  return text.length > 30
    ? (loading ? 'Working' : 'Show work')
    : text;
}

function naturalDurationText(durationMs: number | null | undefined): string | null {
  if (!Number.isFinite(durationMs) || !durationMs || durationMs <= 0) {
    return null;
  }

  if (durationMs < 1000) {
    return 'less than a second';
  }

  const totalSeconds = Math.ceil(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    if (seconds === 0) {
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    return `${minutes} minute${minutes === 1 ? '' : 's'} ${seconds} second${seconds === 1 ? '' : 's'}`;
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (remMinutes === 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'} ${remMinutes} minute${remMinutes === 1 ? '' : 's'}`;
}

function activeGroupStartedAt(toolCalls: ToolCallInfo[]): number | null {
  const starts = toolCalls
    .map((tc) => tc.startedAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return starts.length > 0 ? Math.min(...starts) : null;
}

function completedGroupEndedAt(toolCalls: ToolCallInfo[]): number | null {
  const ends = toolCalls
    .map((tc) => tc.completedAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return ends.length > 0 ? Math.max(...ends) : null;
}

function useTicker(active: boolean, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }

    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [active, intervalMs]);

  return now;
}

function toolCallDurationMs(tc: ToolCallInfo, now = Date.now()): number | null {
  if (!tc.item) return null;
  if ('durationMs' in tc.item && typeof tc.item.durationMs === 'number') {
    return tc.item.durationMs;
  }
  if (tc.state === 'loading' && typeof tc.startedAt === 'number') {
    return Math.max(0, now - tc.startedAt);
  }
  return null;
}

function totalDurationText(toolCalls: ToolCallInfo[], now = Date.now()): string | null {
  const totalDurationMs = toolCalls.reduce((sum, tc) => sum + (toolCallDurationMs(tc, now) ?? 0), 0);
  return naturalDurationText(totalDurationMs);
}

function groupWorkedText(toolCalls: ToolCallInfo[], summary: { live: boolean; text: string }, now = Date.now()) {
  const startedAt = activeGroupStartedAt(toolCalls);
  const endedAt = summary.live ? now : completedGroupEndedAt(toolCalls);
  const durationText = startedAt !== null && endedAt !== null && endedAt >= startedAt
    ? naturalDurationText(endedAt - startedAt)
    : null;
  if (summary.live) {
    return durationText ? `Working for ${durationText}` : 'Working';
  }

  return durationText ? `Worked for ${durationText}` : 'Worked';
}

type GroupSummaryKind =
  | 'reasoning'
  | 'image'
  | 'read'
  | 'search'
  | 'list'
  | 'write'
  | 'command'
  | 'question'
  | 'agent'
  | 'plan'
  | 'web'
  | 'other';

function commandActionSummaryKind(action: ReturnType<typeof extractCommandActions>[number]): GroupSummaryKind {
  if (action.kind === 'read') return 'read';
  if (action.kind === 'search') return 'search';
  if (action.kind === 'list') return 'list';
  if (action.kind === 'write') return 'write';
  return 'command';
}

function toolCallGroupKind(tc: ToolCallInfo): GroupSummaryKind {
  if (!tc.item) {
    return 'other';
  }

  if (tc.item.type === 'reasoning') return 'reasoning';
  if (tc.item.type === 'imageView') return 'image';
  if (tc.item.type === 'webSearch') return 'web';
  if (tc.item.type === 'collabAgentToolCall') return 'agent';
  if (tc.item.type === 'plan') return 'plan';
  if (tc.item.type === 'commandExecution') return 'command';
  if (tc.item.type === 'fileChange') return 'write';

  if (tc.item.type === 'mcpToolCall') {
    const name = toolName(tc.item);
    if (toolIsQuestion(tc)) return 'question';
    if (READ_TOOLS.has(name)) return 'read';
    if (SEARCH_TOOLS.has(name)) return 'search';
    if (LIST_TOOLS.has(name)) return 'list';
    if (WRITE_TOOLS.has(name)) return 'write';
  }

  if (tc.item.type === 'dynamicToolCall') {
    const serviceTool = dynamicAppToolService(tc.item);
    const name = displayToolName(serviceTool?.toolName ?? tc.item.tool);
    if (READ_TOOLS.has(name)) return 'read';
    if (SEARCH_TOOLS.has(name)) return 'search';
    if (LIST_TOOLS.has(name)) return 'list';
    if (WRITE_TOOLS.has(name)) return 'write';
  }

  return 'other';
}

function pluralizeCount(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

type GroupSummaryEntry = {
  kind: GroupSummaryKind;
  count: number;
  mentions?: ToolMention[];
};

function uniqueMentionPathCount(
  mentions: ToolMention[],
  itemType: ToolMention['itemType'],
) {
  const paths = new Set(
    mentions
      .filter((mention) => mention.itemType === itemType)
      .map((mention) => pathNormalize(mention.path)),
  );
  return paths.size;
}

function uniqueMentionPathTotal(mentions: ToolMention[]) {
  return new Set(mentions.map((mention) => (
    mention.itemType === 'service' ? mention.path : pathNormalize(mention.path)
  ))).size;
}

function summaryEntriesForToolCall(tc: ToolCallInfo): GroupSummaryEntry[] {
  if (!tc.item) {
    switch (tc.type) {
      case 'reasoning':
        return [{ kind: 'reasoning', count: 1 }];
      case 'commandExecution':
        return [{ kind: 'command', count: 1 }];
      case 'fileChange':
        return [{ kind: 'write', count: 1 }];
      case 'imageView':
        return [{ kind: 'image', count: 1 }];
      case 'webSearch':
        return [{ kind: 'web', count: 1 }];
      case 'collabAgentToolCall':
        return [{ kind: 'agent', count: 1 }];
      case 'plan':
        return [{ kind: 'plan', count: 1 }];
      case 'mcpToolCall': {
        const name = tc.label;
        if (name === 'ask_user_question') return [{ kind: 'question', count: 1 }];
        if (READ_TOOLS.has(name)) return [{ kind: 'read', count: 1 }];
        if (SEARCH_TOOLS.has(name)) return [{ kind: 'search', count: 1 }];
        if (LIST_TOOLS.has(name)) return [{ kind: 'list', count: 1 }];
        if (WRITE_TOOLS.has(name)) return [{ kind: 'write', count: 1 }];
        return [{ kind: 'other', count: 1 }];
      }
      case 'dynamicToolCall': {
        const name = displayToolName(tc.label);
        if (READ_TOOLS.has(name)) return [{ kind: 'read', count: 1 }];
        if (SEARCH_TOOLS.has(name)) return [{ kind: 'search', count: 1 }];
        if (LIST_TOOLS.has(name)) return [{ kind: 'list', count: 1 }];
        if (WRITE_TOOLS.has(name)) return [{ kind: 'write', count: 1 }];
        return [{ kind: 'other', count: 1 }];
      }
      default:
        return [{ kind: 'other', count: 1 }];
    }
  }

  if (tc.item.type === 'commandExecution') {
    const actions = visibleCommandActions(commandActionsFor(tc));
    const orderedKinds: GroupSummaryKind[] = [];
    const counts = new Map<GroupSummaryKind, number>();

    for (const action of actions) {
      const kind = commandActionSummaryKind(action);
      const nextCount = (() => {
        if (kind === 'list') {
          return uniqueMentionPathCount(action.mentions, 'directory') || 1;
        }
        if (kind === 'read') {
          return uniqueMentionPathCount(action.mentions, 'file') || 1;
        }
        if (kind === 'write') {
          return uniqueMentionPathCount(action.mentions, 'file') || uniqueMentionPathCount(action.mentions, 'directory') || 1;
        }
        if (kind === 'search') {
          return uniqueMentionPathCount(action.mentions, 'directory') || 1;
        }
        return 1;
      })();

      if (!counts.has(kind)) {
        orderedKinds.push(kind);
        counts.set(kind, nextCount);
        continue;
      }

      if (kind === 'command') {
        counts.set(kind, (counts.get(kind) ?? 0) + nextCount);
      } else {
        counts.set(kind, Math.max(counts.get(kind) ?? 0, nextCount));
      }
    }

    return orderedKinds.map((kind) => ({
      kind,
      count: counts.get(kind) ?? 1,
      mentions: uniqMentions(actions
        .filter((action) => commandActionSummaryKind(action) === kind)
        .flatMap((action) => action.mentions)),
    }));
  }

  return [{ kind: toolCallGroupKind(tc), count: 1 }];
}

function aggregateGroupSummary(toolCalls: ToolCallInfo[], loading: boolean, now = Date.now()): string | null {
  if (toolCalls.length === 0) {
    return null;
  }

  const summaryTextForKind = (kind: GroupSummaryKind, count: number): string | null => {
    if (!kind || kind === 'other') {
      return null;
    }

    switch (kind) {
      case 'reasoning':
        if (loading) {
          return totalDurationText(toolCalls, now)
            ? `Reasoning for ${totalDurationText(toolCalls, now)}`
            : 'Reasoning';
        }
        return totalDurationText(toolCalls, now)
          ? `Reasoned for ${totalDurationText(toolCalls, now)}`
          : 'Reasoned';
      case 'image':
        return loading ? `Viewing ${pluralizeCount(count, 'image', 'images')}` : `Viewed ${pluralizeCount(count, 'image', 'images')}`;
      case 'read':
        return loading ? `Reading ${pluralizeCount(count, 'file', 'files')}` : `Read ${pluralizeCount(count, 'file', 'files')}`;
      case 'search':
        return loading ? `Searching ${pluralizeCount(count, 'source', 'sources')}` : `Searched ${pluralizeCount(count, 'source', 'sources')}`;
      case 'list':
        return loading ? `Exploring ${pluralizeCount(count, 'folder', 'folders')}` : `Explored ${pluralizeCount(count, 'folder', 'folders')}`;
      case 'write':
        return loading ? `Updating ${pluralizeCount(count, 'file', 'files')}` : `Updated ${pluralizeCount(count, 'file', 'files')}`;
      case 'command':
        return groupWorkedText(toolCalls, { live: loading, text: loading ? 'Working' : 'Show work' }, now);
      case 'question':
        return loading ? 'Waiting for approval' : `Asked ${pluralizeCount(count, 'question', 'questions')}`;
      case 'agent':
        return loading ? `Delegating ${pluralizeCount(count, 'task', 'tasks')}` : `Delegated ${pluralizeCount(count, 'task', 'tasks')}`;
      case 'plan':
        return loading ? 'Planning next steps' : 'Planned next steps';
      case 'web':
        return loading ? `Searching the web ${count > 1 ? `${count} times` : ''}`.trim() : `Searched the web ${count > 1 ? `${count} times` : ''}`.trim();
      default:
        return null;
    }
  };

  const orderedKinds: GroupSummaryKind[] = [];
  const counts = new Map<GroupSummaryKind, number>();
  const mentionsByKind = new Map<GroupSummaryKind, ToolMention[]>();
  for (const tc of toolCalls) {
    for (const entry of summaryEntriesForToolCall(tc)) {
      if (entry.mentions?.length) {
        mentionsByKind.set(entry.kind, uniqMentions([
          ...(mentionsByKind.get(entry.kind) ?? []),
          ...entry.mentions,
        ]));
      }

      if (!counts.has(entry.kind)) {
        orderedKinds.push(entry.kind);
        counts.set(entry.kind, entry.count);
        continue;
      }

      const mentions = mentionsByKind.get(entry.kind) ?? [];
      if (
        (entry.kind === 'read' || entry.kind === 'write')
        && uniqueMentionPathCount(mentions, 'file') > 0
      ) {
        counts.set(entry.kind, uniqueMentionPathCount(mentions, 'file'));
      } else if (
        (entry.kind === 'list' || entry.kind === 'search')
        && uniqueMentionPathCount(mentions, 'directory') > 0
      ) {
        counts.set(entry.kind, uniqueMentionPathCount(mentions, 'directory'));
      } else if (uniqueMentionPathTotal(mentions) > 0) {
        counts.set(entry.kind, uniqueMentionPathTotal(mentions));
      } else {
        counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + entry.count);
      }
    }
  }

  const nonReasoningKinds = orderedKinds.filter((kind) => kind !== 'reasoning' && kind !== 'other');
  if (nonReasoningKinds.length === 0) {
    const reasoningCount = counts.get('reasoning');
    return reasoningCount ? summaryTextForKind('reasoning', reasoningCount) : null;
  }

  if (nonReasoningKinds.length > 3) {
    return null;
  }

  const parts = nonReasoningKinds
    .map((kind) => summaryTextForKind(kind, counts.get(kind) ?? 0))
    .filter((value): value is string => Boolean(value));

  if (parts.length === 0 || parts.length > 3) {
    return null;
  }

  return joinSummary(parts, false);
}

function preferredGroupSummaryItemCount(toolCalls: ToolCallInfo[]): number | null {
  if (toolCalls.length === 0) {
    return null;
  }

  const orderedKinds = [
    ...new Set(
      toolCalls.flatMap((tc) => summaryEntriesForToolCall(tc).map((entry) => entry.kind)),
    ),
  ];
  const nonReasoningKinds = orderedKinds.filter((kind) => kind !== 'reasoning' && kind !== 'other');
  if (nonReasoningKinds.length > 0) {
    return nonReasoningKinds.length;
  }

  return orderedKinds.includes('reasoning') ? 1 : null;
}

function focusedGroupSummaryText(toolCalls: ToolCallInfo[]): string | null {
  const counts = new Map<GroupSummaryKind, number>();
  const mentionsByKind = new Map<GroupSummaryKind, ToolMention[]>();
  const orderedKinds: GroupSummaryKind[] = [];

  for (const tc of toolCalls) {
    for (const entry of summaryEntriesForToolCall(tc)) {
      if (entry.mentions?.length) {
        mentionsByKind.set(entry.kind, uniqMentions([
          ...(mentionsByKind.get(entry.kind) ?? []),
          ...entry.mentions,
        ]));
      }
      if (!counts.has(entry.kind)) {
        orderedKinds.push(entry.kind);
      }
      const mentions = mentionsByKind.get(entry.kind) ?? [];
      if (
        (entry.kind === 'read' || entry.kind === 'write')
        && uniqueMentionPathCount(mentions, 'file') > 0
      ) {
        counts.set(entry.kind, uniqueMentionPathCount(mentions, 'file'));
      } else if (
        (entry.kind === 'list' || entry.kind === 'search')
        && uniqueMentionPathCount(mentions, 'directory') > 0
      ) {
        counts.set(entry.kind, uniqueMentionPathCount(mentions, 'directory'));
      } else {
        counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + entry.count);
      }
    }
  }

  const nonReasoningKinds = orderedKinds.filter((kind) => kind !== 'reasoning' && kind !== 'other');
  if (nonReasoningKinds.length !== 1) {
    return null;
  }

  const primaryKind = nonReasoningKinds[0];
  if (!primaryKind || (counts.get(primaryKind) ?? 0) !== 1) {
    return null;
  }

  const focus = [...toolCalls].reverse().find((tc) =>
    summaryEntriesForToolCall(tc).some((entry) => entry.kind === primaryKind),
  );
  if (!focus) {
    return null;
  }

  return actionSummary(focus, focus.state === 'loading' ? 'active' : 'actual').text.replace(/\.\.\.$/, '');
}

function groupHeaderText(toolCalls: ToolCallInfo[], summary: { live: boolean; text: string }, now = Date.now()) {
  const focused = focusedGroupSummaryText(toolCalls);
  if (focused) {
    return focused;
  }

  const aggregate = aggregateGroupSummary(toolCalls, summary.live, now);
  if (aggregate) {
    return aggregate;
  }

  if ((preferredGroupSummaryItemCount(toolCalls) ?? 0) > 3) {
    return groupWorkedText(toolCalls, summary, now);
  }

  if (summary.text !== 'Show work' && summary.text !== 'Working') {
    return summary.text;
  }

  return groupWorkedText(toolCalls, summary, now);
}

function finalizeSummary(text: string, mentions: ToolMention[], loading: boolean, childCount: number) {
  const clamped = clampSummaryText(text, loading, childCount);
  return {
    text: clamped,
    mentions: clamped === text ? mentions : [],
  };
}

function mcpMentionType(name: string): 'file' | 'directory' {
  if (LIST_TOOLS.has(name) || name === 'create_directory' || name === 'directory_tree') {
    return 'directory';
  }
  return 'file';
}

function toolMentions(tc: ToolCallInfo): ToolMention[] {
  if (!tc.item) {
    return [];
  }

  if (tc.item.type === 'commandExecution') {
    const item = tc.item;
    const mentions = uniqMentions(commandActionsFor(tc).flatMap((entry) => entry.mentions));
    if (!item.cwd || mentions.length === 0 || mentions.some((entry) => entry.path === item.cwd)) {
      return mentions;
    }

    return uniqMentions([
      ...mentions,
      {
        path: item.cwd,
        itemType: 'directory',
        label: pathBasename(item.cwd) || item.cwd,
      },
    ]);
  }

  if (tc.item.type === 'fileChange') {
    return uniqMentions(tc.item.changes.flatMap((change) => {
      const path = change.kind.type === 'update' && change.kind.move_path
        ? change.kind.move_path
        : change.path;
      return path
        ? [{ path, itemType: 'file' as const, label: pathBasename(path) || path }]
        : [];
    }));
  }

  if (tc.item.type === 'imageView') {
    return [{ path: tc.item.path, itemType: 'file', label: pathBasename(tc.item.path) || tc.item.path }];
  }

  if (tc.item.type === 'mcpToolCall') {
    const name = toolName(tc.item);
    return uniqMentions(
      extractToolPaths(tc.item).map((path) => ({
        path,
        itemType: mcpMentionType(name),
        label: pathBasename(path) || path,
      })),
    );
  }

  if (tc.item.type === 'dynamicToolCall') {
    return [];
  }

  return [];
}

function useCloseOnOutsideClick(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const node = ref.current;
      const target = event.target;
      if (!node || !(target instanceof Node)) return;
      const ownerScrollContainer = node.closest('[data-chat-scroll-container="true"]');
      const targetScrollContainer = target instanceof Element
        ? target.closest('[data-chat-scroll-container="true"]')
        : null;
      if (!ownerScrollContainer || targetScrollContainer !== ownerScrollContainer) {
        return;
      }
      if (node.contains(target)) return;
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [onClose, open, ref]);
}

function actionSummaryParts(tc: ToolCallInfo, mode: 'actual' | 'active' = 'actual') {
  const loading = mode === 'active' || tc.state === 'loading';

  if (!tc.item) {
    const fallbackMentions = tc.filePath
      ? [{
          path: tc.filePath,
          itemType: 'file' as const,
          label: pathBasename(tc.filePath) || tc.filePath,
        }]
      : [];
    const verb = loading
      ? tc.verb?.active
      : tc.verb?.past;
    const summaryText = [verb, tc.target]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join(' ')
      .trim();
    return [{
      text: summaryText || (loading ? 'Working...' : (plainLine(tc.label) || 'Completed')),
      mentions: fallbackMentions,
    }];
  }

  if (tc.item.type === 'reasoning') {
    return [{
      text: loading ? 'Reasoning...' : 'Reasoned',
      mentions: [] as ToolMention[],
    }];
  }

  if (tc.item.type === 'commandExecution') {
    const serviceTool = parseInterpreterAppServiceToolCommand(tc.item.command);
    if (serviceTool) {
      const actions = visibleCommandActions(commandActionsFor(tc));
      const mentions = uniqMentions(actions.flatMap((entry) => entry.mentions));
      return [{
        text: loading ? serviceTool.active : serviceTool.past,
        mentions,
      }];
    }

    return visibleCommandActions(commandActionsFor(tc)).map((entry) => {
      if (entry.kind === 'search' && entry.query) {
        return {
          text: loading
            ? `Searching for ${entry.query}`
            : `Searched for ${entry.query}`,
          mentions: uniqMentions(entry.mentions),
        };
      }

      return {
        text: loading
          ? entry.active.replace(/\.\.\.$/, '')
          : entry.past,
        mentions: uniqMentions(entry.mentions),
      };
    });
  }

  if (tc.item.type === 'fileChange') {
    const kind = fileChangeKind(tc.item);
    return [{
      text: kind === 'write'
        ? loading ? 'Creating file...' : 'Created'
        : kind === 'delete'
          ? loading ? 'Deleting file...' : 'Deleted'
          : loading ? 'Editing file...' : 'Edited',
      mentions: toolMentions(tc),
    }];
  }

  if (tc.item.type === 'imageView') {
    return [{
      text: loading ? 'Viewing image...' : 'Viewed image',
      mentions: toolMentions(tc),
    }];
  }

  if (tc.item.type === 'webSearch') {
    return [{
      text: loading
        ? `Searching for ${tc.item.query || 'results'}...`
        : `Searched for ${tc.item.query || 'results'}`,
      mentions: [],
    }];
  }

  if (tc.item.type === 'collabAgentToolCall') {
    return [{
      text: loading ? 'Delegating task...' : 'Delegated task',
      mentions: [],
    }];
  }

  if (tc.item.type === 'mcpToolCall') {
    const name = toolName(tc.item);
    const query = extractToolQuery(tc.item);
    const mentions = toolMentions(tc);

    if (toolIsQuestion(tc)) {
      return [{
        text: loading ? 'Waiting for approval...' : 'Asked a question',
        mentions,
      }];
    }

    if (READ_TOOLS.has(name)) {
      return [{
        text: loading ? 'Reading file...' : 'Read',
        mentions,
      }];
    }

    if (SEARCH_TOOLS.has(name)) {
      return [{
        text: loading
          ? `Searching${query ? ` for ${query}` : ''}...`
          : `Searched${query ? ` for ${query}` : ''}`,
        mentions,
      }];
    }

    if (LIST_TOOLS.has(name)) {
      return [{
        text: loading ? 'Exploring folder...' : 'Explored folder',
        mentions,
      }];
    }

    if (WRITE_TOOLS.has(name)) {
      return [{
        text: loading ? 'Updating files...' : 'Updated',
        mentions,
      }];
    }

    return [{
      text: loading ? `${humanizeToolName(name)}...` : humanizeToolName(name),
      mentions,
    }];
  }

  if (tc.item.type === 'dynamicToolCall') {
    const serviceTool = dynamicAppToolService(tc.item);
    const name = displayToolName(serviceTool?.toolName ?? tc.item.tool);
    return [{
      text: loading ? `${humanizeToolName(name)}...` : humanizeToolName(name),
      mentions: [],
    }];
  }

  return [{
    text: loading ? 'Working...' : (plainLine(tc.label) || 'Completed'),
    mentions: toolMentions(tc),
  }];
}

function actionSummary(tc: ToolCallInfo, mode: 'actual' | 'active' = 'actual') {
  const parts = actionSummaryParts(tc, mode);
  const loading = mode === 'active' || tc.state === 'loading';
  const text = joinSummary(parts.map((entry) => entry.text.replace(/\.\.\.$/, '')), loading);
  return finalizeSummary(text, uniqMentions(parts.flatMap((entry) => entry.mentions)), loading, parts.length);
}

function detachedSummary(tc: ToolCallInfo) {
  const summary = actionSummary(tc, 'active');

  if (tc.backgroundState === 'waiting') {
    return {
      text: 'Waiting for background terminal',
      mentions: summary.mentions,
    };
  }

  if (tc.backgroundState === 'interacted') {
    return {
      text: 'Interacted with background terminal',
      mentions: summary.mentions,
    };
  }

  return summary;
}

function summarizeToolCalls(
  toolCalls: ToolCallInfo[],
  activeDetachedToolCallIds?: Set<string>,
) {
  const detached = toolCalls.filter((tc) => activeDetachedToolCallIds?.has(tc.id));

  if (detached.length > 0) {
    const summaries = toolCalls.map((tc) => activeDetachedToolCallIds?.has(tc.id)
      ? detachedSummary(tc)
      : actionSummary(tc));
    const text = joinSummary(summaries.map((entry) => entry.text), false);
    return {
      ...finalizeSummary(text, uniqMentions(summaries.flatMap((entry) => entry.mentions)), false, summaries.length),
      live: true,
      shimmer: detached.some((tc) => tc.backgroundState !== 'interacted'),
    };
  }

  const loading = toolCalls.some((tc) => tc.state === 'loading');
  const summaries = toolCalls.flatMap((tc) => actionSummaryParts(tc, tc.state === 'loading' ? 'active' : 'actual'));
  const labels = summaries.map((entry) => entry.text.replace(/\.\.\.$/, ''));
  const text = joinSummary(labels, loading);
  return {
    ...finalizeSummary(text, uniqMentions(summaries.flatMap((entry) => entry.mentions)), loading, labels.length),
    live: loading,
    shimmer: loading,
  };
}

function viewFor(tc: ToolCallInfo): View {
  const tone = toneName(tc);
  const paths = tc.item ? extractToolPaths(tc.item) : [];
  const filePath = tc.filePath ?? paths[0];

  if (!tc.item) {
    return {
      tone,
      icon: WandSparkles,
      eyebrow: 'Operation',
      title: tc.label,
      caption: tc.target,
      filePath,
      filePaths: paths,
    };
  }

  if (tc.item.type === 'reasoning') {
    return {
      tone,
      icon: Sparkles,
      eyebrow: 'Reasoning',
      title: plainLine(tc.output) || 'Working',
      detail: tc.output,
      filePaths: [],
    };
  }

  if (tc.item.type === 'commandExecution') {
    const serviceTool = parseInterpreterAppServiceToolCommand(tc.item.command);
    if (serviceTool) {
      const actions = visibleCommandActions(commandActionsFor(tc));
      const mentions = uniqMentions(actions.flatMap((entry) => entry.mentions));
      const filePaths = mentions
        .filter((mention) => mention.itemType === 'file')
        .map((mention) => mention.path);
      return {
        tone,
        icon: TerminalSquare,
        eyebrow: serviceTool.serviceLabel,
        title: tc.state === 'loading' ? serviceTool.active.replace(/\.\.\.$/, '') : serviceTool.past,
        caption: serviceTool.toolLabel,
        detail: commandSourceFor(tc),
        filePath: filePaths[0],
        filePaths,
      };
    }

    if (isJsReplToolCall(tc)) {
      const actions = visibleCommandActions(commandActionsFor(tc));
      const first = actions[0];
      const loading = tc.state === 'loading';

      return {
        tone,
        icon: Globe,
        eyebrow: 'Browser',
        title: first
          ? commandActionText(first, loading)
          : (loading ? 'Running JavaScript' : 'Ran JavaScript'),
        caption: 'Playwright browser control',
        detail: commandSourceFor(tc),
        filePaths: [],
      };
    }

    const intent = parseShellCommand(tc.item.command);
    if (intent.kind === 'read') {
      return {
        tone,
        icon: FileSearch,
        eyebrow: 'Read',
        title: intent.path ? `Read ${pathBasename(intent.path)}` : intent.label,
        caption: intent.path ? pathDirname(intent.path) : tc.item.command,
        detail: tc.item.command,
        filePath: intent.path,
        filePaths: intent.path ? [intent.path] : [],
      };
    }

    if (intent.kind === 'search') {
      return {
        tone,
        icon: Search,
        eyebrow: 'Search',
        title: intent.query ? `Search for ${intent.query}` : intent.label,
        caption: intent.path ? pathBasename(intent.path) : tc.item.command,
        detail: intent.path ? pathDirname(intent.path) === '.' ? intent.path : intent.path : tc.item.command,
        filePath: intent.path,
        filePaths: intent.path ? [intent.path] : [],
        query: intent.query,
      };
    }

    if (intent.kind === 'list') {
      return {
        tone,
        icon: FolderTree,
        eyebrow: 'List',
        title: intent.path ? `List ${pathBasename(intent.path)}` : intent.label,
        caption: intent.path ? pathDirname(intent.path) : tc.item.cwd,
        detail: tc.item.command,
        filePath: intent.path,
        filePaths: intent.path ? [intent.path] : [],
      };
    }

    if (intent.kind === 'git') {
      return {
        tone,
        icon: Sparkles,
        eyebrow: 'Git',
        title: intent.subcommand ? `Git ${intent.subcommand}` : 'Git',
        caption: intent.path ? pathBasename(intent.path) : tc.item.command,
        detail: tc.item.command,
        filePath: intent.path,
        filePaths: intent.path ? [intent.path] : [],
        query: intent.query,
      };
    }

    if (intent.kind === 'test') {
      return {
        tone,
        icon: TestTube2,
        eyebrow: 'Checks',
        title: intent.label,
        caption: intent.path ? pathBasename(intent.path) : tc.item.command,
        detail: tc.item.command,
        filePath: intent.path,
        filePaths: intent.path ? [intent.path] : [],
      };
    }

    return {
      tone,
      icon: TerminalSquare,
      eyebrow: 'Command',
      title: unwrapShellCommand(tc.item.command),
      caption: tc.item.cwd,
      filePath: intent.path,
      filePaths: intent.path ? [intent.path] : [],
    };
  }

  if (tc.item.type === 'fileChange') {
    return {
      tone,
      icon: FilePenLine,
      eyebrow: 'Edit',
      title: fileChangeTitle(tc.item),
      caption: paths[0] ? pathBasename(paths[0]) : tc.label,
      detail: paths.length > 1 ? `${paths.length} touched paths` : paths[0] ? pathDirname(paths[0]) : undefined,
      filePath,
      filePaths: paths,
    };
  }

  if (tc.item.type === 'webSearch') {
    return {
      tone,
      icon: Globe,
      eyebrow: 'Web',
      title: 'Search the web',
      caption: tc.item.query,
      detail: tc.details,
      filePaths: [],
      query: tc.item.query,
    };
  }

  if (tc.item.type === 'collabAgentToolCall') {
    return {
      tone,
      icon: Bot,
      eyebrow: 'Agent',
      title: 'Delegate task',
      caption: tc.item.prompt || tc.target || tc.item.tool,
      detail: tc.output,
      filePaths: [],
    };
  }

  if (tc.item.type === 'plan') {
    return {
      tone,
      icon: Sparkles,
      eyebrow: 'Plan',
      title: 'Plan next steps',
      caption: 'Structured plan',
      detail: tc.output,
      filePaths: [],
    };
  }

  if (tc.item.type === 'imageView') {
    return {
      tone,
      icon: FileText,
      eyebrow: 'Image',
      title: 'View image',
      caption: pathBasename(tc.item.path),
      detail: pathDirname(tc.item.path),
      filePath: tc.item.path,
      filePaths: [tc.item.path],
    };
  }

  if (tc.item.type === 'mcpToolCall') {
    const name = toolName(tc.item);
    const query = extractToolQuery(tc.item);

    if (toolIsQuestion(tc)) {
      const count = questionCount(tc);
      return {
        tone,
        icon: ShieldQuestion,
        eyebrow: 'Question',
        title: count > 1 ? 'Ask questions' : 'Ask question',
        caption: count > 0 ? `${count} ${count === 1 ? 'prompt' : 'prompts'}` : 'Awaiting your input',
        detail: tc.output,
        filePaths: [],
      };
    }

    if (READ_TOOLS.has(name)) {
      const list = paths.length > 0 ? paths : [filePath].filter((value): value is string => Boolean(value));
      return {
        tone,
        icon: FileSearch,
        eyebrow: 'Read',
        title: list.length > 1 ? `Read ${list.length} files` : list[0] ? `Read ${pathBasename(list[0])}` : 'Read file',
        caption: list[0] ? pathDirname(list[0]) : name,
        detail: list.length > 1 ? pathDirname(list[0] || '') : list[0] ? pathDirname(list[0]) : undefined,
        filePath: list[0],
        filePaths: list,
      };
    }

    if (SEARCH_TOOLS.has(name)) {
      return {
        tone,
        icon: Search,
        eyebrow: 'Search',
        title: query ? `Search for ${query}` : name === 'web_search' ? 'Search the web' : 'Search files',
        caption: filePath ? pathBasename(filePath) : tc.target ?? name,
        detail: filePath ? pathDirname(filePath) : tc.target,
        filePath,
        filePaths: paths,
        query,
      };
    }

    if (LIST_TOOLS.has(name)) {
      return {
        tone,
        icon: FolderOpen,
        eyebrow: 'List',
        title: filePath ? `List ${pathBasename(filePath)}` : 'List contents',
        caption: filePath ? pathDirname(filePath) : tc.target ?? name,
        detail: filePath ? pathDirname(filePath) : undefined,
        filePath,
        filePaths: paths,
      };
    }

    if (WRITE_TOOLS.has(name)) {
      return {
        tone,
        icon: FilePenLine,
        eyebrow: 'Edit',
        title: filePath ? `${humanizeToolName(name)} ${pathBasename(filePath)}` : humanizeToolName(name),
        caption: filePath ? pathDirname(filePath) : tc.target ?? name,
        detail: filePath ? pathDirname(filePath) : tc.output,
        filePath,
        filePaths: paths,
      };
    }

    if (name.startsWith('browser_') || name === 'navigate') {
      return {
        tone,
        icon: Globe,
        eyebrow: 'Browser',
        title: humanizeToolName(name),
        caption: tc.target ?? query ?? name,
        detail: tc.output,
        filePath,
        filePaths: paths,
        query,
      };
    }

    if (name.startsWith('workstation_') || name === 'open_file' || name === 'list_open_tabs') {
      return {
        tone,
        icon: AppWindow,
        eyebrow: 'Workspace',
        title: humanizeToolName(name),
        caption: filePath ? pathBasename(filePath) : tc.target ?? name,
        detail: filePath ? pathDirname(filePath) : tc.output,
        filePath,
        filePaths: paths,
        query,
      };
    }

    return {
      tone,
      icon: FileCode2,
      eyebrow: 'Tool',
      title: humanizeToolName(name),
      caption: filePath ? pathBasename(filePath) : tc.target ?? name,
      detail: tc.output,
      filePath,
      filePaths: paths,
      query,
    };
  }

  if (tc.item.type === 'dynamicToolCall') {
    void dynamicAppToolService(tc.item);
  }

  return {
    tone,
    icon: WandSparkles,
    eyebrow: 'Tool',
    title: tc.label,
    caption: tc.target,
    detail: tc.output,
    filePath,
    filePaths: paths,
  };
}

function humanizeToolName(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function toPrettyJson(value: unknown): string | undefined {
  if (value == null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function paramsTextForToolCall(tc: ToolCallInfo): string | undefined {
  if (!tc.item) return undefined;

  switch (tc.item.type) {
    case 'commandExecution':
      return commandSourceFor(tc);
    case 'mcpToolCall':
      return undefined;
    case 'dynamicToolCall':
      return undefined;
    case 'collabAgentToolCall':
      return tc.item.prompt || tc.item.tool;
    case 'webSearch':
      return tc.item.query;
    case 'imageView':
      return tc.item.path;
    case 'fileChange':
      return toPrettyJson(tc.item.changes.map((change) => ({
        path: change.path,
        kind: change.kind.type,
        movePath: change.kind.type === 'update' ? change.kind.move_path : undefined,
      })));
    default:
      return undefined;
  }
}

function hasBody(tc: ToolCallInfo): boolean {
  if (!tc.item) {
    return Boolean(tc.output?.trim() || tc.details?.trim());
  }

  if (tc.item.type === 'imageView') return false;
  if (tc.item.type === 'fileChange') return tc.item.changes.length > 0;
  if (tc.item.type === 'commandExecution') return Boolean(commandSourceFor(tc) || tc.output?.trim());
  if (tc.item.type === 'plan') return Boolean(tc.output?.trim());
  if (tc.item.type === 'collabAgentToolCall') return true;
  if (tc.item.type === 'mcpToolCall' && (SUBAGENT_TOOLS as readonly string[]).includes(toolName(tc.item))) return true;
  return Boolean(tc.output?.trim() || tc.details?.trim());
}

function defaultOpen(tc: ToolCallInfo): boolean {
  // Tool calls start collapsed. The only auto-expand case is failures —
  // the user wants the error visible immediately without having to click.
  // Previously subagents and collab-agent tool calls also opened by default;
  // dropped per product direction.
  if (tc.state === 'error') {
    return true;
  }

  return false;
}

export const AUTO_COLLAPSE_DELAY_MS = 1200;

export function useAutoCollapseAfterSuccess(params: {
  open: boolean;
  setOpen: (value: boolean) => void;
  state: ToolCallInfo['state'];
  defaultOpen: boolean;
}): { onUserToggle: () => void } {
  const { open, setOpen, state, defaultOpen: shouldDefaultOpen } = params;
  const previousStateRef = useRef<ToolCallInfo['state']>(state);
  const hasUserToggledRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = state;

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (state === 'error') {
      return;
    }

    if (previous !== 'loading' || state !== 'complete') {
      return;
    }

    if (hasUserToggledRef.current) {
      return;
    }

    if (!open) {
      return;
    }

    // Skip auto-collapse for cards that defaultOpen — those wanted to be open.
    if (shouldDefaultOpen) {
      return;
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (!hasUserToggledRef.current) {
        setOpen(false);
      }
    }, AUTO_COLLAPSE_DELAY_MS);
  }, [open, setOpen, shouldDefaultOpen, state]);

  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
  }, []);

  return {
    onUserToggle: useCallback(() => {
      hasUserToggledRef.current = true;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }, []),
  };
}

function shouldHideToolCall(tc: ToolCallInfo): boolean {
  if (toolIsQuestion(tc) && tc.state === 'loading') {
    return true;
  }

  if (tc.item?.type === 'reasoning' && tc.state !== 'loading' && !tc.output?.trim()) {
    return true;
  }

  return false;
}

function defaultOpenGroup(toolCalls: ToolCallInfo[]): boolean {
  void toolCalls;
  return false;
}

function Frame(props: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
  padded?: boolean;
}) {
  return (
    <section className="oa-tool-section">
      <div className="oa-tool-section-head">
        <span className="text-[12px] font-medium text-[var(--oa-text-muted)]">
          {props.label}
        </span>
        {props.action}
      </div>
      <div className={props.padded === false ? undefined : 'oa-tool-section-body'}>
        {props.children}
      </div>
    </section>
  );
}

function ExpandableToolSection(props: {
  open: boolean;
  outerClassName: string;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false}>
      {props.open ? (
        <motion.div
          className={props.outerClassName}
          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={reduceMotion ? { duration: 0 } : COLLAPSE_TRANSITION}
          style={{ overflow: 'hidden' }}
        >
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -2 }}
            transition={reduceMotion ? { duration: 0 } : FAST_TWEEN}
          >
            {props.children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// Soft cap for raw tool output. Beyond this we collapse the visible window
// to OUTPUT_PREVIEW_LINES until the user clicks "Show full output." This
// matches the reference's "show full output" footer pattern from Doc 03
// and avoids painting 5000-line `<pre>` blocks during scroll.
const OUTPUT_LARGE_THRESHOLD_LINES = 80;
const OUTPUT_PREVIEW_LINES = 30;

function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function takeFirstLines(text: string, lines: number): string {
  let cursor = 0;
  let seen = 0;
  while (cursor < text.length && seen < lines) {
    const nl = text.indexOf('\n', cursor);
    if (nl === -1) return text;
    cursor = nl + 1;
    seen += 1;
  }
  return text.slice(0, cursor);
}

const OutputText = React.memo(function OutputText(props: {
  text: string;
  label: string;
  variant?: 'params' | 'command' | 'output' | 'details' | 'editor';
}) {
  const text = props.text.trimEnd();
  const variant = props.variant ?? 'output';
  const showCopyButton = variant !== 'editor';
  const copyLabel = `Copy ${props.label.toLowerCase()}`;

  const totalLines = useMemo(() => countLines(text), [text]);
  const isLarge = totalLines > OUTPUT_LARGE_THRESHOLD_LINES;
  const [expanded, setExpanded] = useState(false);

  const visibleText = useMemo(() => {
    if (!isLarge || expanded) return text;
    return takeFirstLines(text, OUTPUT_PREVIEW_LINES);
  }, [expanded, isLarge, text]);

  if (!text) return null;

  return (
    <Frame
      label={props.label}
      padded={false}
    >
      <div className={`oa-tool-block oa-tool-block--${variant}`}>
        {showCopyButton ? (
          <AnimatedCopyButton text={text} label={copyLabel} className="oa-tool-copy-button oa-tool-copy-button--floating" />
        ) : null}
        <div className={`oa-tool-output oa-tool-output--${variant}`}>
          <pre className={`oa-tool-pre oa-tool-pre--${variant}`}>
            <code>{visibleText}</code>
          </pre>
        </div>
        {isLarge && !expanded ? (
          <button
            type="button"
            className="oa-tool-output-show-more"
            onClick={() => setExpanded(true)}
          >
            Show full output ({totalLines} lines)
          </button>
        ) : null}
      </div>
    </Frame>
  );
});

function ToolBodySections(props: {
  params?: string;
  paramsLabel?: string;
  output?: string;
  outputLabel?: string;
  details?: string;
}) {
  const sections = [
    props.params ? <OutputText key="params" label={props.paramsLabel ?? 'Params'} text={props.params} variant={props.paramsLabel === 'Command' ? 'command' : 'params'} /> : null,
    props.output ? <OutputText key="output" label={props.outputLabel ?? 'Output'} text={props.output} variant="output" /> : null,
    props.details && props.details !== props.output ? <OutputText key="details" label="Details" text={props.details} variant="details" /> : null,
  ].filter(Boolean);

  if (sections.length === 0) return null;
  return <div className="oa-tool-body-sections">{sections}</div>;
}

// Plain monospace rendering. Used to call shiki for bash/JS highlighting;
// removed — this isn't a code editor and the colors weren't pulling weight.
function HighlightedCode(props: { code: string; language?: 'bash' | 'javascript' }) {
  return (
    <pre className="oa-command-transcript-code">
      <code>{props.code}</code>
    </pre>
  );
}


function CommandTranscript(props: {
  command: string;
  output?: string;
  outputLabel?: string;
  language?: 'bash' | 'javascript';
  prompt?: string | null;
  inputLabel?: string;
}) {
  const output = props.output?.trim();
  const language = props.language ?? 'bash';
  const prompt = props.prompt === undefined ? '$' : props.prompt;
  const inputLabel = props.inputLabel ?? (language === 'javascript' ? 'Code' : 'Command');

  return (
    <div className="oa-command-transcript">
      <div className="oa-command-transcript-section oa-command-transcript-section--input">
        <AnimatedCopyButton
          text={props.command}
          label={`Copy ${inputLabel.toLowerCase()}`}
          className="oa-tool-copy-button oa-tool-copy-button--floating"
        />
        <div className="oa-command-transcript-line">
          {prompt ? (
            <span className="oa-command-transcript-prompt" aria-hidden="true">{prompt}</span>
          ) : null}
          <HighlightedCode code={props.command} language={language} />
        </div>
      </div>

      {output ? (
        <>
          <div className="oa-command-transcript-divider" />
          <div className="oa-command-transcript-section oa-command-transcript-section--output">
            <AnimatedCopyButton
              text={output}
              label={`Copy ${(props.outputLabel ?? 'output').toLowerCase()}`}
              className="oa-tool-copy-button oa-tool-copy-button--floating"
            />
            <pre className="oa-command-transcript-output">
              <code>{output}</code>
            </pre>
          </div>
        </>
      ) : null}
    </div>
  );
}

function extractCatHeredocWriteContent(command: string): string | null {
  const raw = unwrapShellCommand(command);
  const start = raw.indexOf("<<");
  if (start < 0) {
    return null;
  }

  const markerMatch = raw.slice(start).match(/^<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/);
  if (!markerMatch) {
    return null;
  }

  const marker = markerMatch[2];
  if (!marker) {
    return null;
  }

  const afterMarkerIndex = start + markerMatch[0].length;
  const firstNewlineIndex = raw.indexOf("\n", afterMarkerIndex);
  if (firstNewlineIndex < 0) {
    return null;
  }

  const body = raw.slice(firstNewlineIndex + 1);
  const closingPattern = new RegExp(`(?:^|\\n)${marker}(?:\\n|$)`);
  const closingMatch = body.match(closingPattern);
  if (!closingMatch || typeof closingMatch.index !== "number") {
    return null;
  }

  return body.slice(0, closingMatch.index).replace(/\n$/, "");
}

function CommandWritePreview(props: { content: string }) {
  return <OutputText label="Content" text={props.content} variant="editor" />;
}

export function shouldStackToolHeader(params: {
  containerWidth: number;
  titleWidth: number;
  mentionsWidth: number;
  gap?: number;
}): boolean {
  if (params.mentionsWidth <= 0) {
    return false;
  }

  // mentionsWidth is measured from the meta container, so it already includes
  // the inline left gutter from `.oa-tool-header-meta`.
  return (params.titleWidth + params.mentionsWidth + (params.gap ?? 8)) > params.containerWidth;
}

export function getToolHeaderTitleWidth(title: Pick<HTMLElement, 'querySelector' | 'scrollWidth'>): number {
  const titleNode = title.querySelector<HTMLElement>('.oa-tool-title, .oa-activity-title');
  return titleNode?.scrollWidth ?? title.scrollWidth;
}

function ToolMentions(props: {
  mentions: ToolMention[];
  maxVisible?: number;
  wrap?: boolean;
}) {
  const [existingPaths, setExistingPaths] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const candidates = props.mentions.filter((mention) => (
      (mention.itemType === 'file' || mention.itemType === 'directory')
      && mention.path
      && existingPaths[mention.path] === undefined
    ));
    if (candidates.length === 0) {
      return;
    }

    let cancelled = false;
    void Promise.all(candidates.map(async (mention) => {
      const stats = await filesIpc.getStats(mention.path);
      const exists = mention.itemType === 'directory'
        ? stats.isDirectory
        : !stats.isDirectory && stats.size !== null;
      return [mention.path, exists] as const;
    })).then((results) => {
      if (cancelled) {
        return;
      }
      setExistingPaths((current) => ({
        ...current,
        ...Object.fromEntries(results),
      }));
    }).catch(() => {
      if (cancelled) {
        return;
      }
      setExistingPaths((current) => ({
        ...current,
        ...Object.fromEntries(candidates.map((mention) => [mention.path, false])),
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [existingPaths, props.mentions]);

  const validatedMentions = uniqMentions(props.mentions.filter((mention) => {
    if (mention.itemType !== 'file' && mention.itemType !== 'directory') {
      return true;
    }
    return existingPaths[mention.path] === true;
  }));

  if (validatedMentions.length === 0) return null;

  const hidden = typeof props.maxVisible === 'number'
    ? Math.max(0, validatedMentions.length - props.maxVisible)
    : 0;
  const visible = hidden > 0
    ? validatedMentions.slice(0, props.maxVisible)
    : validatedMentions;

  return (
    <div
      className="oa-tool-mentions"
      data-wrap={props.wrap ? 'true' : undefined}
      data-tooltip-suppress="true"
      onClick={(event) => event.stopPropagation()}
    >
      {visible.map((entry, index) => (
        <ToolMentionChip
          key={`${entry.itemType}:${entry.path}:${index}`}
          mention={entry}
        />
      ))}
      {hidden > 0 ? (
        <span className="oa-tool-mention-count">
          +{hidden}
        </span>
      ) : null}
    </div>
  );
}

function ToolHeaderLayout(props: {
  title: ReactNode;
  mentions: ToolMention[];
  leadingIcon?: ReactNode;
  maxVisible?: number;
  titleClassName?: string;
  mentionsClassName?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const mentionsRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);

  useEffect(() => {
    if (props.mentions.length === 0) {
      setStacked(false);
      return;
    }

    const root = rootRef.current;
    const title = titleRef.current;
    const mentions = mentionsRef.current;
    if (!root || !title || !mentions) {
      return;
    }

    const updateLayout = () => {
      const next = shouldStackToolHeader({
        containerWidth: root.clientWidth,
        titleWidth: getToolHeaderTitleWidth(title),
        mentionsWidth: mentions.scrollWidth,
      });
      setStacked((current) => current === next ? current : next);
    };

    updateLayout();

    const observer = new ResizeObserver(updateLayout);
    observer.observe(root);
    observer.observe(title);
    observer.observe(mentions);

    return () => {
      observer.disconnect();
    };
  }, [props.mentions, props.maxVisible, props.title]);

  return (
    <div
      ref={rootRef}
      className="oa-tool-header-layout"
      data-layout={stacked ? 'stacked' : 'inline'}
    >
      <div
        ref={titleRef}
        className={props.titleClassName ?? 'oa-tool-header-main'}
      >
        {props.leadingIcon ? (
          <span className="oa-tool-leading-icon" aria-hidden="true">
            {props.leadingIcon}
          </span>
        ) : null}
        {props.title}
      </div>
      <div
        ref={mentionsRef}
        className={props.mentionsClassName ?? 'oa-tool-header-meta'}
        data-empty={props.mentions.length === 0 ? 'true' : undefined}
      >
        {props.mentions.length > 0 ? (
          <ToolMentions
            mentions={props.mentions}
            maxVisible={props.maxVisible}
            wrap={stacked}
          />
        ) : null}
      </div>
    </div>
  );
}

function ToolMentionChip(props: {
  mention: ToolMention;
}) {
  if (props.mention.itemType !== 'file' && props.mention.itemType !== 'directory') {
    return (
      <span className="oa-tool-mention">
        {props.mention.label}
      </span>
    );
  }

  return <FileToolMentionChip mention={props.mention as ToolMention & { itemType: 'file' | 'directory' }} />;
}

function FileToolMentionChip(props: {
  mention: ToolMention & { itemType: 'file' | 'directory' };
}) {
  const [previewSourceKey] = useState(() => `tool-mention-preview-${Math.random().toString(36).slice(2, 10)}`);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (props.mention.itemType !== 'file') {
      return;
    }

    previewTimeoutRef.current = setTimeout(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;

      window.dispatchEvent(new CustomEvent(MENTION_PREVIEW_START_EVENT, {
        detail: {
          type: 'file',
          sourceKey: previewSourceKey,
          path: props.mention.path,
          label: props.mention.label,
          id: props.mention.path,
          mentionRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        },
      }));
    }, MENTION_PREVIEW_DELAY_MS);
  }, [previewSourceKey, props.mention]);

  const handleMouseLeave = useCallback(() => {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }

    window.dispatchEvent(new CustomEvent('mention:hover-end'));
    window.dispatchEvent(new CustomEvent(MENTION_PREVIEW_END_EVENT));
  }, []);

  useEffect(() => {
    return () => {
      if (previewTimeoutRef.current) {
        clearTimeout(previewTimeoutRef.current);
      }
    };
  }, []);

  return (
    <span
      ref={wrapperRef}
      data-mention-preview-key={previewSourceKey}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <FileSystemProxy
        path={props.mention.path}
        filename={props.mention.label}
        type={props.mention.itemType}
        variant="inline"
        onClick={() => openPath(props.mention.path, props.mention.itemType)}
        showPath
        className="oa-tool-mention"
        disableDrag
      />
    </span>
  );
}

function HoverTooltip(props: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [suppressed, setSuppressed] = useState(false);

  if (props.disabled) {
    return <>{props.children}</>;
  }

  return (
    <Tooltip
      delayDuration={1000}
      open={suppressed ? false : open}
      onOpenChange={(nextOpen) => setOpen(suppressed ? false : nextOpen)}
    >
      <div
        onPointerMoveCapture={(event) => {
          const target = event.target;
          const nextSuppressed = target instanceof HTMLElement && Boolean(target.closest('[data-tooltip-suppress="true"]'));
          if (nextSuppressed !== suppressed) {
            setSuppressed(nextSuppressed);
          }
          if (nextSuppressed && open) {
            setOpen(false);
          }
        }}
        onPointerLeave={() => {
          if (suppressed) {
            setSuppressed(false);
          }
        }}
      >
        <TooltipTrigger asChild>
          {props.children}
        </TooltipTrigger>
      </div>
      <TooltipContent
        side="left"
        sideOffset={8}
        className="pointer-events-none"
      >
        {props.label}
      </TooltipContent>
    </Tooltip>
  );
}

function commandActionText(action: ReturnType<typeof extractCommandActions>[number], loading: boolean) {
  if (action.kind === 'search' && action.query) {
    return loading ? `Searching for ${action.query}` : `Searched for ${action.query}`;
  }

  return loading ? action.active.replace(/\.\.\.$/, '') : action.past;
}

function commandActionProgram(command: string): string {
  const raw = unwrapShellCommand(command).trim();
  const first = raw.match(/\S+/)?.[0] ?? '';
  const base = first.split('/').pop() ?? first;
  return base.toLowerCase();
}

function isDecorativeCommandAction(action: ReturnType<typeof extractCommandActions>[number]): boolean {
  if (action.kind !== 'run') {
    return false;
  }

  const program = commandActionProgram(action.command);
  if (program !== 'echo' && program !== 'printf') {
    return false;
  }

  return action.mentions.length === 0;
}

function visibleCommandActions(actions: ReturnType<typeof extractCommandActions>) {
  const filtered = actions.filter((entry) => !isDecorativeCommandAction(entry));
  const base = filtered.length > 0 ? filtered : actions;
  const deduped: typeof base = [];

  for (const entry of base) {
    const prev = deduped[deduped.length - 1];
    const sameMentions = prev && prev.mentions.length === entry.mentions.length
      && prev.mentions.every((mention, index) => {
        const next = entry.mentions[index];
        return next && next.path === mention.path && next.itemType === mention.itemType;
      });

    if (
      prev
      && prev.kind === entry.kind
      && prev.past === entry.past
      && prev.active === entry.active
      && prev.query === entry.query
      && sameMentions
    ) {
      continue;
    }

    deduped.push(entry);
  }

  return deduped;
}

function commandSequenceActions(tc: ToolCallInfo) {
  if (tc.item?.type !== 'commandExecution') {
    return null;
  }

  const actions = visibleCommandActions(commandActionsFor(tc));
  return actions.length > 1 ? actions : null;
}

function commandOutputLabel(actions: ReturnType<typeof extractCommandActions>, state: ToolCallInfo['state']) {
  if (state === 'error') return 'Error';
  if (actions.length !== 1) return 'Output';

  const first = actions[0];
  if (!first) return 'Output';
  if (first.kind === 'read') return 'Preview';
  if (first.kind === 'search') return 'Matches';
  if (first.kind === 'list') return 'Contents';
  return 'Output';
}

function CommandSequenceRow(props: {
  action: ReturnType<typeof extractCommandActions>[number];
  loading: boolean;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  return (
    <div className="oa-tool-call oa-tool-call--nested" data-open={props.detailsOpen}>
      <button
        type="button"
        className="oa-tool-trigger-button"
        onClick={props.onToggleDetails}
      >
        <ToolHeaderLayout
          mentions={props.action.mentions}
          title={(
            <span className="oa-tool-title">
              {commandActionText(props.action, props.loading)}
            </span>
          )}
        />
      </button>
    </div>
  );
}

function CommandSequenceDetails(props: {
  command: string;
  output?: string;
  outputLabel: string;
  language?: 'bash' | 'javascript';
  prompt?: string | null;
  inputLabel?: string;
}) {
  return (
    <CommandTranscript
      command={props.command}
      output={props.output}
      outputLabel={props.outputLabel}
      language={props.language}
      prompt={props.prompt}
      inputLabel={props.inputLabel}
    />
  );
}

function CommandExecutionSequence(props: {
  actions: ReturnType<typeof extractCommandActions>;
  command: string;
  output?: string;
  state: ToolCallInfo['state'];
  collapseSignal?: number;
  language?: 'bash' | 'javascript';
  prompt?: string | null;
  inputLabel?: string;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const outputLabel = commandOutputLabel(props.actions, props.state);

  useEffect(() => {
    if (!props.collapseSignal) return;
    setDetailsOpen(false);
  }, [props.collapseSignal]);

  return (
    <HoverTooltip label="Click to expand" disabled={detailsOpen}>
      <div
        className="oa-tool-call oa-command-sequence"
        data-open={detailsOpen ? 'true' : undefined}
      >
        <div className="oa-command-sequence-list">
          {props.actions.map((action, index) => (
            <CommandSequenceRow
              key={`${action.kind}:${action.command}:${index}`}
              action={action}
              loading={props.state === 'loading'}
              detailsOpen={detailsOpen}
              onToggleDetails={() => setDetailsOpen((value) => !value)}
            />
          ))}
        </div>

        <ExpandableToolSection open={detailsOpen} outerClassName="oa-tool-body">
          <div className="oa-tool-body-clip">
            <div className="oa-tool-body-inner oa-command-sequence-details-inner">
              <CommandSequenceDetails
                command={props.command}
                output={props.output}
                outputLabel={outputLabel}
                language={props.language}
                prompt={props.prompt}
                inputLabel={props.inputLabel}
              />
            </div>
          </div>
        </ExpandableToolSection>
      </div>
    </HoverTooltip>
  );
}

function CommandExecutionBody({ tc }: { tc: ToolCallInfo }) {
  if (tc.item?.type !== 'commandExecution') return null;

  const actions = visibleCommandActions(commandActionsFor(tc));
  const command = commandSourceFor(tc) ?? tc.item.command;
  const output = tc.output?.trim();
  const parsed = actions.filter((entry) => entry.kind !== 'run');
  const fallback = actions.filter((entry) => entry.kind === 'run');
  const label = commandOutputLabel(actions, tc.state);
  const language = commandLanguageFor(tc);
  const prompt = commandPromptFor(tc);
  const inputLabel = commandInputLabelFor(tc);

  if (actions.length > 1) {
    return (
      <CommandExecutionSequence
        actions={actions}
        command={command}
        output={output}
        state={tc.state}
        language={language}
        prompt={prompt}
        inputLabel={inputLabel}
      />
    );
  }

  if (fallback.length === 1) {
    const first = fallback[0];
    if (!first) {
      return null;
    }

    return (
      <CommandTranscript
        command={command}
        output={output}
        outputLabel={label}
        language={language}
        prompt={prompt}
        inputLabel={inputLabel}
      />
    );
  }

  if (parsed.length === 1) {
    const first = parsed[0];
    if (!first) {
      return null;
    }

    if (first.kind === 'write') {
      const content = extractCatHeredocWriteContent(first.command);
      if (content) {
        return <CommandWritePreview content={content} />;
      }
    }

    return (
      <CommandTranscript
        command={command}
        output={output}
        outputLabel={label}
        language={language}
        prompt={prompt}
        inputLabel={inputLabel}
      />
    );
  }

  return null;
}

function ReasoningBody({ tc }: { tc: ToolCallInfo }) {
  const content = tc.output?.trim() || tc.details?.trim();
  if (!content) return null;

  return (
    <div data-component="reasoning-part" className="oa-reasoning-body">
      <Markdown renderFileCollections={false}>
        {content}
      </Markdown>
    </div>
  );
}

function ReadBody({ tc, label = 'Preview' }: { tc: ToolCallInfo; label?: string }) {
  const output = tc.output?.trim();
  const details = tc.state === 'error' && !output ? tc.details?.trim() : undefined;

  return (
    <ToolBodySections
      params={paramsTextForToolCall(tc)}
      output={output}
      outputLabel={label}
      details={details}
    />
  );
}

function SearchBody({ tc }: { tc: ToolCallInfo }) {
  const output = tc.output?.trim();
  const details = tc.state === 'error' && !output ? tc.details?.trim() : undefined;

  return (
    <ToolBodySections
      params={paramsTextForToolCall(tc)}
      output={output}
      outputLabel="Output"
      details={details}
    />
  );
}

function ListBody({ tc }: { tc: ToolCallInfo }) {
  const output = tc.output?.trim();
  const details = tc.state === 'error' && !output ? tc.details?.trim() : undefined;

  return (
    <ToolBodySections
      params={paramsTextForToolCall(tc)}
      output={output}
      outputLabel="Output"
      details={details}
    />
  );
}

function GenericBody({ tc }: { tc: ToolCallInfo }) {
  const output = tc.output?.trim();
  const details = tc.state === 'error' && !output ? tc.details?.trim() : undefined;
  const showDetails = details && details !== output;

  return (
    <ToolBodySections
      params={paramsTextForToolCall(tc)}
      output={output}
      details={showDetails ? details : undefined}
    />
  );
}

function SubagentBody({
  tc,
  pending,
}: {
  tc: ToolCallInfo;
  pending: boolean;
}) {
  const output = tc.output?.trim();

  return (
    <ToolBodySections
      params={paramsTextForToolCall(tc)}
      output={output}
      details={pending ? 'Running' : undefined}
    />
  );
}

function PlanBody({ tc }: { tc: ToolCallInfo }) {
  return (
    <ToolBodySections
      output={tc.output?.trim()}
      details={tc.details?.trim()}
    />
  );
}

type FileDiffLine =
  | { kind: 'context'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'remove'; text: string };

type FileDiffGroup =
  | { kind: 'context'; lines: FileDiffLine[] }
  | { kind: 'add'; lines: FileDiffLine[] }
  | { kind: 'remove'; lines: FileDiffLine[] };

function parseFileDiff(diff: string): FileDiffLine[] {
  return diff
    .split('\n')
    .filter((line) => !(line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')))
    .map((line): FileDiffLine => {
      if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
      if (line.startsWith('-')) return { kind: 'remove', text: line.slice(1) };
      return { kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line };
    });
}

function groupFileDiffLines(lines: FileDiffLine[]): FileDiffGroup[] {
  const groups: FileDiffGroup[] = [];

  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (!last || last.kind !== line.kind) {
      groups.push({ kind: line.kind, lines: [line] } as FileDiffGroup);
      continue;
    }
    last.lines.push(line);
  }

  return groups;
}

function InlineDiffTokens(props: { before: string; after: string; kind: 'add' | 'remove' }) {
  const parts = diffWords(props.before, props.after);
  return (
    <>
      {parts.map((part, index) => {
        const active = props.kind === 'remove' ? part.removed : part.added;
        return (
          <span
            key={`${props.kind}-${index}-${part.value}`}
            className={active ? `oa-file-diff-inline oa-file-diff-inline--${props.kind}` : undefined}
          >
            {part.value}
          </span>
        );
      })}
    </>
  );
}

function FileDiffLineRow(props: { line: FileDiffLine; pairedWith?: string }) {
  const prefix = props.line.kind === 'add'
    ? '+'
    : props.line.kind === 'remove'
      ? '-'
      : ' ';

  return (
    <div className={`oa-file-diff-line oa-file-diff-line--${props.line.kind}`}>
      <span className="oa-file-diff-prefix" aria-hidden="true">{prefix}</span>
      <span className="oa-file-diff-text">
        {props.pairedWith ? (
          props.line.kind === 'remove'
            ? <InlineDiffTokens before={props.line.text} after={props.pairedWith} kind="remove" />
            : <InlineDiffTokens before={props.pairedWith} after={props.line.text} kind="add" />
        ) : (
          props.line.text || ' '
        )}
      </span>
    </div>
  );
}

function FileDiffView(props: { diff: string }) {
  const groups = useMemo(() => groupFileDiffLines(parseFileDiff(props.diff)), [props.diff]);

  return (
    <div className="oa-file-diff">
      <div className="oa-file-diff-body">
        {groups.map((group, index) => {
          const next = groups[index + 1];
          const paired =
            group.kind === 'remove'
            && next?.kind === 'add'
            && group.lines.length === next.lines.length
            && group.lines.length > 0
            && group.lines.length <= 3;

          if (paired && next) {
            return (
              <div key={`pair-${index}`} className="oa-file-diff-pair">
                <div className="oa-file-diff-group oa-file-diff-group--remove">
                  {group.lines.map((line, lineIndex) => (
                    <FileDiffLineRow
                      key={`remove-${lineIndex}-${line.text}`}
                      line={line}
                      pairedWith={next.lines[lineIndex]?.text}
                    />
                  ))}
                </div>
                <div className="oa-file-diff-group oa-file-diff-group--add">
                  {next.lines.map((line, lineIndex) => (
                    <FileDiffLineRow
                      key={`add-${lineIndex}-${line.text}`}
                      line={line}
                      pairedWith={group.lines[lineIndex]?.text}
                    />
                  ))}
                </div>
              </div>
            );
          }

          if (index > 0 && groups[index - 1]?.kind === 'remove' && group.kind === 'add' && group.lines.length <= 3) {
            return null;
          }

          return (
            <div
              key={`${group.kind}-${index}`}
              className={`oa-file-diff-group oa-file-diff-group--${group.kind}`}
            >
              {group.lines.map((line, lineIndex) => (
                <FileDiffLineRow key={`${group.kind}-${lineIndex}-${line.text}`} line={line} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileChangeBody({ tc }: { tc: ToolCallInfo }) {
  if (tc.item?.type !== 'fileChange') return null;

  const singleChange = tc.item.changes.length === 1;

  return (
    <div className="oa-file-change-body">
      {tc.item.changes.map((change, index) => {
        const filePath = change.kind.type === 'update' && change.kind.move_path
          ? change.kind.move_path
          : change.path;
        const diff = change.diff?.trim();
        const movedFrom = change.kind.type === 'update' && change.kind.move_path
          ? change.path
          : undefined;

        return (
          <div
            key={`${filePath}-${index}`}
            className="oa-file-change-entry"
          >
            {!singleChange && filePath ? (
              <div className="oa-file-change-entry-head">
                <span className="oa-file-change-entry-name">{pathBasename(filePath) || filePath}</span>
              </div>
            ) : null}
            {!singleChange && filePath ? (
              <div className="oa-file-change-entry-subtle">
                {pathDirname(filePath)}
              </div>
            ) : null}
            {movedFrom ? (
              <div className="oa-file-change-entry-subtle">
                Moved from {movedFrom}
              </div>
            ) : null}
            {diff ? (
              <FileDiffView diff={diff} />
            ) : null}
            {!diff && filePath ? (
              <div className="oa-file-change-entry-empty">
                {change.kind.type === 'delete' ? 'Deleted file' : 'Updated file'}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ToolBody({ tc }: { tc: ToolCallInfo }) {
  if (!tc.item) {
    return <GenericBody tc={tc} />;
  }

  if (tc.item.type === 'commandExecution') {
    return <CommandExecutionBody tc={tc} />;
  }

  if (tc.item.type === 'reasoning') return <ReasoningBody tc={tc} />;
  if (tc.item.type === 'fileChange') return <FileChangeBody tc={tc} />;
  if (tc.item.type === 'plan') return <PlanBody tc={tc} />;
  if (tc.item.type === 'webSearch') return <SearchBody tc={tc} />;
  if (tc.item.type === 'imageView') return <ReadBody tc={tc} label="Path" />;
  if (tc.item.type === 'collabAgentToolCall') {
    return <SubagentBody tc={tc} pending={tc.state === 'loading'} />;
  }

  if (tc.item.type === 'mcpToolCall') {
    if ((SUBAGENT_TOOLS as readonly string[]).includes(toolName(tc.item))) {
      return <SubagentBody tc={tc} pending={tc.state === 'loading'} />;
    }

    const name = toolName(tc.item);
    if (READ_TOOLS.has(name)) return <ReadBody tc={tc} label="Preview" />;
    if (SEARCH_TOOLS.has(name)) return <SearchBody tc={tc} />;
    if (LIST_TOOLS.has(name)) return <ListBody tc={tc} />;
  }

  return <GenericBody tc={tc} />;
}

interface ToolCallCardProps {
  tc: ToolCallInfo;
  mode?: 'standalone' | 'nested';
  collapseSignal?: number;
  activeDetachedToolCallIds?: Set<string>;
  hoveredDetachedToolCallId?: string | null;
  onHoverDetachedToolCallId?: (toolCallId: string | null) => void;
}

const ToolCallCardInner: FC<ToolCallCardProps> = ({
  tc: incomingTc,
  mode = 'standalone',
  collapseSignal,
  activeDetachedToolCallIds,
  hoveredDetachedToolCallId,
  onHoverDetachedToolCallId,
}) => {
  // Subscribe to per-item streaming snapshots. While a turn is in
  // flight, useChat publishes per-tool snapshots to liveItemsStore; this
  // hook returns the latest snapshot for THIS card without re-rendering
  // sibling cards. After the turn commits, the live entry is cleared
  // and we fall back to the prop value.
  const tc = useLiveToolCall(incomingTc);
  const ref = useRef<HTMLDivElement>(null);
  const pending = tc.state === 'loading';
  const nested = mode === 'nested';
  const view = useMemo(() => viewFor(tc), [tc]);
  const detachedActive = Boolean(activeDetachedToolCallIds?.has(tc.id));
  const detachedHovered = Boolean(detachedActive && hoveredDetachedToolCallId === tc.id);
  const summary = useMemo(
    () => detachedActive ? detachedSummary(tc) : actionSummary(tc),
    [detachedActive, tc],
  );
  const body = <ToolBody tc={tc} />;
  const bodyInnerClassName = tc.item?.type === 'fileChange'
    ? 'oa-tool-body-inner oa-tool-body-inner--file-change'
    : 'oa-tool-body-inner';
  const openable = hasBody(tc);
  const initialOpen = defaultOpen(tc);
  const [open, setOpen] = useState(() => openable && initialOpen);
  const [pendingApproval, setPendingApproval] = useState<QuestionRequest | null>(null);
  const lastAutoRevealedApprovalIdRef = useRef<string | null>(null);

  const { onUserToggle: markUserToggled } = useAutoCollapseAfterSuccess({
    open,
    setOpen,
    state: tc.state,
    defaultOpen: initialOpen,
  });

  useEffect(() => {
    if (tc.state === 'error' && openable && !open) {
      setOpen(true);
    }
  }, [open, openable, tc.state]);

  useEffect(() => {
    if (!tc.id || tc.state !== 'loading') {
      setPendingApproval(null);
      return;
    }

    let cancelled = false;

    const sync = (approvals: QuestionRequest[]) => {
      if (cancelled) {
        return;
      }
      setPendingApproval(approvals.find((approval) => approval.toolCallId === tc.id) ?? null);
    };

    approvalsIpc.get({ toolCallId: tc.id })
      .then((response: { approvals: QuestionRequest[] }) => {
        sync(response.approvals);
      })
      .catch(() => {});

    const unsubscribe = approvalsIpc.onListChanged((event: { approvals: QuestionRequest[] }) => {
      sync(event.approvals);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [tc.id, tc.state]);

  useEffect(() => {
    if (mode !== 'standalone') {
      return;
    }

    const approvalId = pendingApproval?.id ?? null;
    if (!approvalId || lastAutoRevealedApprovalIdRef.current === approvalId) {
      return;
    }

    const node = ref.current;
    if (!node) {
      return;
    }

    lastAutoRevealedApprovalIdRef.current = approvalId;
    requestAnimationFrame(() => {
      node.scrollIntoView({ behavior: 'auto', block: 'center' });
    });
  }, [mode, pendingApproval?.id]);

  useEffect(() => {
    if (!tc.id) return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ toolCallId?: string; approvalId?: string }>).detail;
      if (detail?.toolCallId !== tc.id && detail?.approvalId !== pendingApproval?.id) return;

      const node = ref.current;
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.add('animate-highlight');
      setTimeout(() => node.classList.remove('animate-highlight'), 2000);
    };

    window.addEventListener('highlight-approval', handler);
    return () => {
      window.removeEventListener('highlight-approval', handler);
    };
  }, [pendingApproval?.id, tc.id]);

  useCloseOnOutsideClick(ref, open, () => {
    if (mode !== 'standalone') {
      return;
    }
    setOpen(false);
  });

  useEffect(() => {
    if (!collapseSignal) return;
    setOpen(false);
  }, [collapseSignal]);

  useEffect(() => {
    if (!pendingApproval || !openable) {
      return;
    }
    setOpen(true);
  }, [openable, pendingApproval?.id]);

  return (
    <div
      ref={ref}
      data-testid={TOOL_CALL_ID(tc.type)}
      data-tool-call-id={tc.id}
      data-state={tc.state}
      data-tone={view.tone}
      data-open={open}
      data-background-active={detachedActive ? 'true' : undefined}
      data-background-hovered={detachedHovered ? 'true' : undefined}
      className={nested ? 'oa-tool-call oa-tool-call--nested' : 'oa-tool-call'}
      onMouseEnter={() => {
        if (!detachedActive) {
          return;
        }
        onHoverDetachedToolCallId?.(tc.id);
      }}
      onMouseLeave={() => {
        if (!detachedActive) {
          return;
        }
        onHoverDetachedToolCallId?.(null);
      }}
    >
      <HoverTooltip label="Click to expand" disabled={!openable || open}>
        <button
          type="button"
          onClick={() => {
            if (!openable) return;
            markUserToggled();
            setOpen((value) => !value);
          }}
          className="oa-tool-trigger-button"
          disabled={!openable}
        >
          <ToolHeaderLayout
            mentions={summary.mentions}
            maxVisible={2}
            leadingIcon={undefined}
            title={(
              <div className="oa-inline-disclosure-row min-w-0 flex flex-1 items-center">
                <TextShimmer
                  text={summary.text}
                  active={pending || (detachedActive && tc.backgroundState !== 'interacted')}
                  className="oa-tool-title"
                />
                {openable && !nested ? (
                  <span aria-hidden="true" className="oa-tool-disclosure">
                    <ChevronRight className="size-4" />
                  </span>
                ) : null}
              </div>
            )}
          />
        </button>
      </HoverTooltip>

      {openable ? (
        <ExpandableToolSection open={open} outerClassName="oa-tool-body">
          <div className="oa-tool-body-clip">
            <div className={bodyInnerClassName}>
              <div className="space-y-2">
                {body}
              </div>
            </div>
          </div>
        </ExpandableToolSection>
      ) : null}

    </div>
  );
};

// Memo gate. Parent re-renders for transient reasons (sibling stream
// tick, hovered detached id, etc.) — skip those. But when `tc` itself
// has a render-meaningful change (typically: stream-end transitions
// where settleInactiveReasoningParts flips `loading` → `complete`), we
// MUST re-render. The previous "id-only" comparator skipped any prop
// change where id stayed the same, trusting the live store to push
// updates — that broke at stream end when the live store gets cleared
// and the only signal left is the prop change. Reasoning cards then
// stayed in "Reasoning…" shimmer state forever.
function areToolCallCardPropsEqual(
  prev: ToolCallCardProps,
  next: ToolCallCardProps,
): boolean {
  if (prev.tc !== next.tc) {
    if (prev.tc.id !== next.tc.id) return false;
    if (prev.tc.state !== next.tc.state) return false;
    if (prev.tc.type !== next.tc.type) return false;
    if (prev.tc.label !== next.tc.label) return false;
    if (prev.tc.output !== next.tc.output) return false;
    if (prev.tc.details !== next.tc.details) return false;
    if (prev.tc.backgroundState !== next.tc.backgroundState) return false;
    if (prev.tc.filePath !== next.tc.filePath) return false;
    if (prev.tc.target !== next.tc.target) return false;
    if (prev.tc.item !== next.tc.item) return false;
  }
  if (prev.mode !== next.mode) return false;
  if (prev.collapseSignal !== next.collapseSignal) return false;
  if (prev.onHoverDetachedToolCallId !== next.onHoverDetachedToolCallId) return false;

  const id = next.tc.id;
  const prevDetached = id ? (prev.activeDetachedToolCallIds?.has(id) ?? false) : false;
  const nextDetached = id ? (next.activeDetachedToolCallIds?.has(id) ?? false) : false;
  if (prevDetached !== nextDetached) return false;

  const prevHover = prev.hoveredDetachedToolCallId === id;
  const nextHover = next.hoveredDetachedToolCallId === id;
  if (prevHover !== nextHover) return false;

  return true;
}

export const ToolCallCard = React.memo(ToolCallCardInner, areToolCallCardPropsEqual);

export function isOrphanApprovalForThread(
  approval: {
    serverId: string;
    toolName: string;
    context?: { threadId?: string; [key: string]: unknown };
    toolCallId?: string;
    agentId?: string;
  },
  threadId: string | undefined,
  knownToolCallIds: Set<string>,
  agentId?: string,
): boolean {
  const unclaimed = !approval.toolCallId || !knownToolCallIds.has(approval.toolCallId);
  if (!unclaimed) {
    return false;
  }

  if (
    typeof threadId === 'string'
    && approval.serverId === 'main-agent-server'
    && approval.toolName === 'view_image'
    && approval.context?.threadId === threadId
  ) {
    return true;
  }

  if (typeof agentId === 'string' && approval.agentId === agentId) {
    return true;
  }

  return false;
}

export function resolveInlineGroupApproval(params: {
  approvals: QuestionRequest[];
  groupToolCallIds: Set<string>;
  visibleToolCallIds: Set<string>;
  allowOrphanApprovals: boolean;
  threadId?: string;
  knownToolCallIds: Set<string>;
  agentId?: string;
}): QuestionRequest | null {
  // NOTE(mcp-approval-correlation): Inline tool-card approvals depend on
  // `approval.toolCallId === tc.id`. Backend correlation is preserved by
  // `server/utils/codexMcpBridge.ts` and `ToolManager.callTool()`; this function
  // is the renderer-side match/escape hatch for hidden grouped or orphaned
  // approvals.
  const hiddenOwnedApproval = params.approvals.find((approval) =>
    typeof approval.toolCallId === 'string'
    && params.groupToolCallIds.has(approval.toolCallId)
    && !params.visibleToolCallIds.has(approval.toolCallId),
  );
  if (hiddenOwnedApproval) {
    return hiddenOwnedApproval;
  }

  if (!params.allowOrphanApprovals) {
    return null;
  }

  return params.approvals.find((approval) =>
    isOrphanApprovalForThread(
      approval,
      params.threadId,
      params.knownToolCallIds,
      params.agentId,
    ),
  ) ?? null;
}

interface ToolCallGroupProps {
  toolCalls: ToolCallInfo[];
  allowOrphanApprovals?: boolean;
  threadId?: string;
  agentId?: string;
  activityLayoutId?: string;
  knownToolCallIds?: Set<string>;
  activeDetachedToolCallIds?: Set<string>;
  hoveredDetachedToolCallId?: string | null;
  onHoverDetachedToolCallId?: (toolCallId: string | null) => void;
}

const TOOL_GROUP_CHILD_INDENT = 'calc(12px + var(--unit-padding-small))';

export function getExpandedToolGroupBodyStyle() {
  return {
    marginTop: 'var(--unit-padding-small)',
    paddingTop: '0.125rem',
    paddingLeft: TOOL_GROUP_CHILD_INDENT,
  };
}

export const ToolCallGroup: FC<ToolCallGroupProps> = ({
  toolCalls,
  allowOrphanApprovals = false,
  threadId,
  agentId,
  knownToolCallIds,
  activeDetachedToolCallIds,
  hoveredDetachedToolCallId,
  onHoverDetachedToolCallId,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useMemo(
    () => toolCalls.filter((tc) => !shouldHideToolCall(tc)),
    [toolCalls],
  );
  const visibleToolCallIds = useMemo(
    () => new Set(visible.map((tc) => tc.id)),
    [visible],
  );
  const summary = useMemo(
    () => summarizeToolCalls(visible, activeDetachedToolCallIds),
    [activeDetachedToolCallIds, visible],
  );
  const tickNow = useTicker(summary.live);
  const headerText = useMemo(
    () => groupHeaderText(visible, summary, tickNow),
    [summary, tickNow, visible],
  );
  const groupToolCallIds = useMemo(
    () => new Set(toolCalls.map((tc) => tc.id).filter(Boolean)),
    [toolCalls],
  );
  const detachedGroupToolCallIds = useMemo(
    () => visible.map((tc) => tc.id).filter((value) => activeDetachedToolCallIds?.has(value)),
    [activeDetachedToolCallIds, visible],
  );
  const detachedHovered = Boolean(
    hoveredDetachedToolCallId
    && detachedGroupToolCallIds.includes(hoveredDetachedToolCallId),
  );
  const [open, setOpen] = useState(() => defaultOpenGroup(visible));
  const [collapseSignal, setCollapseSignal] = useState(0);
  const [groupPendingApproval, setGroupPendingApproval] = useState<QuestionRequest | null>(null);

  const groupAggregateState = useMemo<ToolCallInfo['state']>(() => {
    if (visible.some((tc) => tc.state === 'error')) return 'error';
    if (summary.live) return 'loading';
    return 'complete';
  }, [summary.live, visible]);

  const { onUserToggle: markGroupUserToggled } = useAutoCollapseAfterSuccess({
    open,
    setOpen,
    state: groupAggregateState,
    defaultOpen: false,
  });

  useEffect(() => {
    if (groupAggregateState === 'error' && !open) {
      setOpen(true);
    }
  }, [groupAggregateState, open]);

  useEffect(() => {
    const fallbackKnownToolCallIds = knownToolCallIds ?? groupToolCallIds;
    let cancelled = false;

    const sync = (approvals: QuestionRequest[]) => {
      if (cancelled) {
        return;
      }
      setGroupPendingApproval(resolveInlineGroupApproval({
        approvals,
        groupToolCallIds,
        visibleToolCallIds,
        allowOrphanApprovals,
        threadId,
        knownToolCallIds: fallbackKnownToolCallIds,
        agentId,
      }));
    };

    approvalsIpc.get({})
      .then((response: { approvals: QuestionRequest[] }) => {
        sync(response.approvals);
      })
      .catch(() => {});

    const unsubscribe = approvalsIpc.onListChanged((event: { approvals: QuestionRequest[] }) => {
      sync(event.approvals);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    agentId,
    allowOrphanApprovals,
    groupToolCallIds,
    knownToolCallIds,
    threadId,
    visibleToolCallIds,
  ]);

  useCloseOnOutsideClick(ref, open, () => {
    setOpen(false);
    setCollapseSignal((value) => value + 1);
  });

  useEffect(() => {
    if (!groupPendingApproval) {
      return;
    }
    setOpen(true);
  }, [groupPendingApproval?.id]);

  if (visible.length === 0) {
    return null;
  }

  if (visible.length === 1) {
    const first = visible[0];
    if (!first) return null;
    return (
      <ToolCallCard
        tc={first}
        activeDetachedToolCallIds={activeDetachedToolCallIds}
        hoveredDetachedToolCallId={hoveredDetachedToolCallId}
        onHoverDetachedToolCallId={onHoverDetachedToolCallId}
      />
    );
  }

  return (
    <div
      ref={ref}
      className="oa-activity-group"
      data-open={open}
      data-state={summary.live ? 'loading' : 'complete'}
      data-background-active={detachedGroupToolCallIds.length > 0 ? 'true' : undefined}
      data-background-hovered={detachedHovered ? 'true' : undefined}
    >
      <HoverTooltip label="Click to show work" disabled={open}>
        <button
          type="button"
          className="oa-activity-trigger"
          onClick={() => {
            markGroupUserToggled();
            setOpen((value) => {
              const next = !value;
              if (!next) {
                setCollapseSignal((signal) => signal + 1);
              }
              return next;
            });
          }}
        >
          <ToolHeaderLayout
            mentions={summary.mentions}
            maxVisible={3}
            title={(
              <div className="oa-inline-disclosure-row min-w-0 flex flex-1 items-center">
                <div className="min-w-0">
                  <TextShimmer
                    text={headerText}
                    active={summary.shimmer}
                    className="oa-activity-title"
                  />
                </div>
                <div aria-hidden="true" className="oa-activity-caret">
                  <ChevronRight className="size-4" />
                </div>
              </div>
            )}
            mentionsClassName="oa-tool-header-meta oa-activity-meta"
          />
        </button>
      </HoverTooltip>

      <ExpandableToolSection open={open} outerClassName="oa-activity-body">
        <div className="oa-activity-body-clip">
          <div className="oa-activity-list">
            {visible.map((tc) => (
              (() => {
                const actions = commandSequenceActions(tc);
                if (actions && tc.item?.type === 'commandExecution') {
                return (
                  <CommandExecutionSequence
                    key={tc.id}
                    actions={actions}
                    command={commandSourceFor(tc) ?? tc.item.command}
                    output={tc.output?.trim()}
                    state={tc.state}
                    collapseSignal={collapseSignal}
                    language={commandLanguageFor(tc)}
                    prompt={commandPromptFor(tc)}
                    inputLabel={commandInputLabelFor(tc)}
                  />
                );
                }

                return (
                  <ToolCallCard
                    key={tc.id}
                    tc={tc}
                    mode="nested"
                    collapseSignal={collapseSignal}
                    activeDetachedToolCallIds={activeDetachedToolCallIds}
                    hoveredDetachedToolCallId={hoveredDetachedToolCallId}
                    onHoverDetachedToolCallId={onHoverDetachedToolCallId}
                  />
                );
              })()
            ))}
          </div>
        </div>
      </ExpandableToolSection>
    </div>
  );
};

export type DetachedToolCall = {
  toolCallId: string;
  toolCall: ToolCallInfo;
};

export const DetachedToolCallRail: FC<{
  toolCalls: DetachedToolCall[];
  onStopProcess?: (toolCallIds: string[]) => Promise<void> | void;
  hoveredToolCallId?: string | null;
  onHoverToolCallId?: (toolCallId: string | null) => void;
  onRevealToolCall?: (toolCallId: string) => void;
}> = ({
  toolCalls,
  onStopProcess,
  hoveredToolCallId,
  onHoverToolCallId,
  onRevealToolCall,
}) => {
  "use no memo";

  const [stopping, setStopping] = useState(false);
  const commandToolCallIds = useMemo(
    () => toolCalls
      .filter((entry) => entry.toolCall.type === 'commandExecution')
      .map((entry) => entry.toolCallId),
    [toolCalls],
  );
  const showStop = useMemo(
    () => Boolean(onStopProcess) && commandToolCallIds.length > 0,
    [commandToolCallIds.length, onStopProcess],
  );

  if (toolCalls.length === 0) {
    return null;
  }

  return (
    <div className="oa-background-rail">
      <div className="oa-background-strip">
        <div className="oa-background-strip-main">
          {toolCalls.map((entry) => {
            const text = detachedSummary(entry.toolCall).text;
            const shimmer = entry.toolCall.backgroundState !== 'interacted';
            return (
              <button
                type="button"
                key={entry.toolCallId}
                className="oa-background-pill"
                data-running={shimmer ? 'true' : undefined}
                data-linked={hoveredToolCallId === entry.toolCallId ? 'true' : undefined}
                onMouseEnter={() => onHoverToolCallId?.(entry.toolCallId)}
                onMouseLeave={() => onHoverToolCallId?.(null)}
                onClick={() => onRevealToolCall?.(entry.toolCallId)}
              >
                <TextShimmer
                  text={text}
                  active={shimmer}
                  className="oa-background-pill-title"
                />
              </button>
            );
          })}
        </div>

        {showStop ? (
          <button
            type="button"
            className="oa-background-strip-stop"
            aria-label="Stop running commands"
            disabled={stopping}
            onClick={async (event) => {
              event.stopPropagation();
              if (stopping) {
                return;
              }
              setStopping(true);
              try {
                await onStopProcess?.(commandToolCallIds);
              } catch {
                setStopping(false);
              }
            }}
          >
            Stop running commands
          </button>
        ) : null}
      </div>
    </div>
  );
};
