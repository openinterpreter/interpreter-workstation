import { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, X } from 'lucide-react';
import { useLayout } from '../hooks/useLayout';
import { useAgentActivityMap } from '../hooks/useAgentActivityMap';
import { usePendingApprovalsByAgent } from '../hooks/usePendingApprovalsByAgent';
import { findPaneByTabId } from '../utils/treeOperations';
import { resolveLocalLinkTarget } from '../utils/localLinkDetection';
import { getLocalReferenceDisplayLabel } from '../utils/localReferenceDisplay';
import { CONVERSATION_HISTORY_LIST_ID, CONVERSATION_ITEM_ID } from '../../shared/element-ids';
import { Input } from './ui/input';
import { AgentAttentionIndicator } from './AgentAttentionIndicator';
import { FileSystemProxy } from './FileSystemProxy';
import { getAgentIndicatorTone, type AgentIndicatorTone } from '../../shared/utils/agentAttention';
import type { v2 } from '../../server/handlers/codex-generated-types/index';
import { agentThreads, getApiUrl, showContextMenu } from '@/ipc';
import { isThreadListResponse } from '@/lib/codex/thread-history-guards';
import { stripWorkstationContext, stripFileLinks } from '../../shared/utils/formatWorkstationContext';
import { isAgentTab } from '../../shared/types/layout';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from './ui/alert-dialog';
 
const DEFAULT_VISIBLE_HISTORICAL_COUNT = 3;
const HISTORICAL_PAGE_SIZE = 10;
const TITLE_LINK_REGEX = /[*_~]*@?\[([^\]]+)\]\((<[^>\n]+>|[^)\n]+)\)[*_~]*/g;


function normalizeSearchText(text: string): string {
  return stripFileLinks(stripWorkstationContext(text))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchQuery(query: string): string[] {
  return Array.from(new Set(normalizeSearchText(query).split(' ').filter(Boolean)));
}

function timestampFromIso(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getConversationRemovalKey(
  conversation: Pick<ConversationPreview, 'conversationId' | 'threadId'>,
): string {
  return conversation.threadId ?? `conversation:${conversation.conversationId}`;
}

export function removePendingConversationKey(
  current: ReadonlySet<string>,
  conversation: Pick<ConversationPreview, 'conversationId' | 'threadId'>,
): Set<string> {
  const next = new Set(current);
  next.delete(getConversationRemovalKey(conversation));
  return next;
}

export function getDeleteAllConversationScope(
  showArchived: boolean,
  visibleScope: ReadonlyArray<ConversationPreview>,
  activeScope: ReadonlyArray<ConversationPreview>,
): ConversationPreview[] {
  if (!showArchived) {
    return [...visibleScope];
  }

  const conversations: ConversationPreview[] = [];
  const seenKeys = new Set<string>();
  for (const conversation of [...visibleScope, ...activeScope]) {
    const key = getConversationRemovalKey(conversation);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    conversations.push(conversation);
  }
  return conversations;
}

function HighlightedText({
  text,
  searchTerms,
}: {
  text: string;
  searchTerms: string[];
}) {
  if (searchTerms.length === 0 || !text) {
    return <>{text}</>;
  }

  const lowerText = text.toLowerCase();
  const orderedTerms = [...searchTerms].sort((a, b) => b.length - a.length);
  const segments: React.ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let nextIndex = -1;
    let nextTerm = '';

    for (const term of orderedTerms) {
      const index = lowerText.indexOf(term, cursor);
      if (index === -1) continue;
      if (nextIndex === -1 || index < nextIndex || (index === nextIndex && term.length > nextTerm.length)) {
        nextIndex = index;
        nextTerm = term;
      }
    }

    if (nextIndex === -1) {
      segments.push(text.slice(cursor));
      break;
    }

    if (nextIndex > cursor) {
      segments.push(text.slice(cursor, nextIndex));
    }

    segments.push(
      <mark
        key={`${nextIndex}-${nextTerm}`}
        className="rounded-sm bg-amber-400/30 px-[1px] text-inherit"
      >
        {text.slice(nextIndex, nextIndex + nextTerm.length)}
      </mark>,
    );

    cursor = nextIndex + nextTerm.length;
  }

  return <>{segments}</>;
}

type ConversationTitleSegment =
  | { type: 'text'; text: string; key: string }
  | {
    type: 'mention';
    key: string;
    path: string;
    displayText: string;
    itemType: 'file' | 'directory';
    fragment?: string;
    lineStart?: number;
    lineEnd?: number;
  };

function unwrapMarkdownLinkDestination(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function tokenizeConversationTitle(
  rawTitle: string,
  fallbackTitle: string,
): ConversationTitleSegment[] {
  const title = stripWorkstationContext(rawTitle).trim() || fallbackTitle;
  TITLE_LINK_REGEX.lastIndex = 0;

  const segments: ConversationTitleSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = TITLE_LINK_REGEX.exec(title)) !== null) {
    if (match.index > cursor) {
      segments.push({
        type: 'text',
        text: title.slice(cursor, match.index),
        key: `text-${cursor}`,
      });
    }

    const displayText = match[1];
    const href = unwrapMarkdownLinkDestination(match[2]);
    const resolved = resolveLocalLinkTarget(href);

    if (resolved) {
      segments.push({
        type: 'mention',
        key: `mention-${match.index}-${resolved.path}`,
        path: resolved.path,
        displayText,
        itemType: resolved.itemType,
        fragment: resolved.fragment,
        lineStart: resolved.lineStart,
        lineEnd: resolved.lineEnd,
      });
    } else {
      segments.push({
        type: 'text',
        text: displayText,
        key: `text-${match.index}`,
      });
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < title.length) {
    segments.push({
      type: 'text',
      text: title.slice(cursor),
      key: `text-${cursor}`,
    });
  }

  if (segments.length === 0) {
    return [{ type: 'text', text: title, key: 'text-0' }];
  }

  return segments;
}

export function ConversationTitleContent({
  title,
  fallbackTitle,
  searchTerms,
}: {
  title: string;
  fallbackTitle: string;
  searchTerms: string[];
}) {
  const segments = useMemo(
    () => tokenizeConversationTitle(title, fallbackTitle),
    [fallbackTitle, title],
  );

  return (
    <>
      {segments.map((segment) => {
        if (segment.type === 'text') {
          return (
            <HighlightedText
              key={segment.key}
              text={segment.text}
              searchTerms={searchTerms}
            />
          );
        }

        const hasReference = segment.fragment || segment.lineStart != null;
        const displayLabel = getLocalReferenceDisplayLabel({
          label: segment.displayText,
          path: segment.path,
          itemType: segment.itemType,
        });

        return (
          <span key={segment.key}>
            <span className="mention-node-view">
              <FileSystemProxy
                path={segment.path}
                filename={displayLabel}
                type={segment.itemType}
                variant="inline"
                showPath={true}
                disableDrag
              />
            </span>
            {hasReference && (
              <span className="ml-0.5 text-[0.75em] text-muted-foreground opacity-60">
                {segment.fragment
                  ? `#${segment.fragment}`
                  : `:L${segment.lineStart}${segment.lineEnd != null ? `-${segment.lineEnd}` : ''}`}
              </span>
            )}
          </span>
        );
      })}
    </>
  );
}

function HistoryItem({
  conv,
  searchTerms,
  onSelect,
  onContextMenu,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  cardStyle = false,
  indicatorTone,
}: {
  conv: ConversationPreview;
  searchTerms: string[];
  onSelect: () => void;
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  isRenaming?: boolean;
  renameValue?: string;
  onRenameChange?: (value: string) => void;
  onRenameSubmit?: () => void;
  onRenameCancel?: () => void;
  cardStyle?: boolean;
  indicatorTone?: AgentIndicatorTone;
}) {
  const { t } = useTranslation();
  const fallbackTitle = t('panel.history.untitled');
  const tone = indicatorTone ?? 'idle';
  const showIndicator = tone !== 'idle';
  const titleContent = isRenaming ? (
    <input
      autoFocus
      value={renameValue ?? ''}
      onChange={(event) => onRenameChange?.(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onBlur={() => onRenameSubmit?.()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onRenameSubmit?.();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onRenameCancel?.();
        }
      }}
      aria-label={t('panel.history.renameConversation')}
      className="h-6 w-full min-w-0 rounded-[var(--control-radius)] bg-[var(--oa-bg-input,var(--background))] px-2 text-ui-sm text-foreground outline-none"
      style={{
        border: 'var(--border-width) solid var(--border)',
      }}
    />
  ) : (
    <ConversationTitleContent
      title={conv.title}
      fallbackTitle={fallbackTitle}
      searchTerms={searchTerms}
    />
  );

  if (cardStyle) {
    return (
      <div
        data-testid={CONVERSATION_ITEM_ID(conv.conversationId)}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        className={`cursor-default select-none py-2.5 transition-colors duration-150 ${
          conv.isSelected
            ? 'text-foreground'
            : conv.isOpen
              ? 'text-foreground/84 hover:text-foreground'
              : 'text-foreground/72 hover:text-foreground/88'
        }`}
      >
        <div className="flex min-w-0 items-center justify-between gap-4">
          <div className={`min-w-0 flex-1 ${showIndicator ? 'flex items-center gap-3' : ''}`}>
            {showIndicator ? (
              <AgentAttentionIndicator tone={tone} className="mt-px size-1.5 shrink-0" />
            ) : null}
            <div
              className="min-w-0 overflow-hidden"
              style={{
                maskImage: 'linear-gradient(to right, black 85%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to right, black 85%, transparent 100%)'
              }}
            >
              <div
                className={[
                  isRenaming ? 'text-[13px] leading-5 text-inherit' : 'whitespace-nowrap text-[13px] leading-5 text-inherit',
                  conv.isSelected ? 'font-medium' : 'font-normal',
                ].join(' ')}
              >
                {titleContent}
              </div>
            </div>
          </div>
          <span className="flex-shrink-0 whitespace-nowrap text-[11px] font-normal tracking-[0.01em] text-muted-foreground/64">
            {formatRelativeTime(conv.updatedAt, t)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid={CONVERSATION_ITEM_ID(conv.conversationId)}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      style={{
        paddingLeft: 'calc(var(--unit-padding) * 2)',
        paddingRight: 'calc(var(--unit-padding) * 2)',
        paddingTop: 'var(--unit-padding)',
        paddingBottom: 'var(--unit-padding)',
      }}
      className={`cursor-default select-none border-b border-border/80 last:border-transparent transition-colors ${
        conv.isOpen
          ? conv.isSelected
            ? 'bg-foreground/[0.055] text-foreground'
            : 'bg-foreground/[0.035] text-foreground'
          : 'text-foreground/75 hover:bg-hover hover:text-foreground'
      }`}
    >
      <div className="flex items-center gap-[var(--unit-padding)]">
        <AgentAttentionIndicator tone={tone} className="size-1.5" />
        <div
          className="flex-1 min-w-0 overflow-hidden"
          style={{
            maskImage: 'linear-gradient(to right, black 85%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to right, black 85%, transparent 100%)'
          }}
        >
          <div className={isRenaming ? 'text-ui-sm text-foreground' : 'whitespace-nowrap text-ui-sm text-foreground'}>
            {titleContent}
          </div>
        </div>
        <span className="flex-shrink-0 text-ui-sm text-muted-foreground whitespace-nowrap">
          {formatRelativeTime(conv.updatedAt, t)}
        </span>
      </div>
    </div>
  );
}

function HistorySearchField({
  value,
  onChange,
  onArrowDown,
  onArrowUp,
  onEnter,
  onEscape,
}: {
  value: string;
  onChange: (value: string) => void;
  onArrowDown?: () => void;
  onArrowUp?: () => void;
  onEnter?: () => void;
  onEscape?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="group relative overflow-hidden rounded-[var(--control-radius-lg)] transition-colors duration-150 focus-within:bg-[color-mix(in_srgb,var(--oa-bg-input,var(--background))_88%,transparent)]"
      style={{
        border: '1px solid color-mix(in srgb, var(--oa-border, var(--border)) 40%, transparent)',
        background: 'transparent',
        boxShadow: 'none',
      }}
    >
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            onArrowDown?.();
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            onArrowUp?.();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            onEnter?.();
          } else if (event.key === 'Escape') {
            onEscape?.();
          }
        }}
        placeholder={t('help.history.search.title')}
        aria-label={t('help.history.search.title')}
        data-help-title={t('help.history.search.title')}
        data-help-description={t('help.history.search.description')}
        className="!h-[var(--oa-control-h-md)] !border-transparent !bg-transparent !text-ui-sm !shadow-none placeholder:!text-[var(--oa-text-muted)] placeholder:opacity-60 focus-visible:!border-transparent focus-visible:!ring-0 focus-visible:!shadow-none"
        style={{
          paddingLeft: '12px',
          paddingRight: value ? '40px' : '12px',
          borderRadius: 'inherit',
        }}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-3 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-[var(--oa-text-muted)]/76 transition-colors hover:text-[var(--oa-text)]"
          aria-label={t('help.history.clearSearch.title')}
          data-help-title={t('help.history.clearSearch.title')}
          data-help-description={t('help.history.clearSearch.description')}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function HistoryDisclosureButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-default text-[11px] font-normal tracking-[0.01em] text-muted-foreground/62 transition-colors hover:text-muted-foreground/82 active:scale-[0.98]"
    >
      {children}
    </button>
  );
}

export interface ConversationPreview {
  conversationId: string;
  threadId: string | null;
  agentId: string;
  profileId: string;
  workspacePath: string;
  title: string;
  lastMessagePreview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  source: 'active' | 'history';
  isArchived: boolean;
  isOpen: boolean;
  isSelected: boolean;
}

type DeleteThreadResult = {
  success: boolean;
  error?: string;
};

type DeleteAllThreadsResult = {
  success: boolean;
  error?: string;
};

type RenameThreadResult = {
  success: boolean;
  name?: string;
  error?: string;
};

type ArchiveThreadResult = {
  success: boolean;
  error?: string;
};

export async function deleteConversationWithConfirmedClose(
  conversation: Pick<ConversationPreview, 'threadId' | 'isOpen' | 'agentId'>,
  dependencies: {
    deleteThread: (threadId: string) => Promise<DeleteThreadResult>;
    closeTab: (agentId: string) => void;
  },
): Promise<void> {
  if (conversation.threadId) {
    const response = await dependencies.deleteThread(conversation.threadId);
    if (!response.success) {
      throw new Error(response.error ?? 'Failed to delete conversation.');
    }
  }

  if (conversation.isOpen) {
    dependencies.closeTab(conversation.agentId);
  }
}

export async function deleteAllConversationsWithConfirmedClose(
  conversations: ReadonlyArray<Pick<ConversationPreview, 'isOpen' | 'agentId'>>,
  dependencies: {
    deleteAll: () => Promise<DeleteAllThreadsResult>;
    closeTab: (agentId: string) => void;
  },
): Promise<void> {
  const response = await dependencies.deleteAll();
  if (!response.success) {
    throw new Error(response.error ?? 'Failed to delete all conversations.');
  }

  for (const conversation of conversations) {
    if (conversation.isOpen) {
      dependencies.closeTab(conversation.agentId);
    }
  }
}

export async function renameConversationWithConfirmedSave(
  conversation: Pick<ConversationPreview, 'threadId' | 'isOpen' | 'agentId'>,
  name: string,
  dependencies: {
    renameThread: (threadId: string, name: string) => Promise<RenameThreadResult>;
    updateTabLabel: (agentId: string, label: string) => void;
  },
): Promise<string> {
  if (!conversation.threadId) {
    throw new Error('Conversation has no saved thread to rename.');
  }

  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Conversation name is required.');
  }

  const response = await dependencies.renameThread(conversation.threadId, trimmedName);
  if (!response.success) {
    throw new Error(response.error ?? 'Failed to rename conversation.');
  }

  const savedName = response.name ?? trimmedName;
  if (conversation.isOpen) {
    dependencies.updateTabLabel(conversation.agentId, savedName);
  }

  return savedName;
}

export async function archiveConversationWithConfirmedClose(
  conversation: Pick<ConversationPreview, 'threadId' | 'isOpen' | 'agentId'>,
  dependencies: {
    archiveThread: (threadId: string) => Promise<ArchiveThreadResult>;
    closeTab: (agentId: string) => void;
  },
): Promise<void> {
  if (!conversation.threadId) {
    throw new Error('Conversation has no saved thread to archive.');
  }

  const response = await dependencies.archiveThread(conversation.threadId);
  if (!response.success) {
    throw new Error(response.error ?? 'Failed to archive conversation.');
  }

  if (conversation.isOpen) {
    dependencies.closeTab(conversation.agentId);
  }
}

export async function unarchiveConversationWithConfirmedRefresh(
  conversation: Pick<ConversationPreview, 'threadId'>,
  dependencies: {
    unarchiveThread: (threadId: string) => Promise<ArchiveThreadResult>;
  },
): Promise<void> {
  if (!conversation.threadId) {
    throw new Error('Conversation has no saved thread to unarchive.');
  }

  const response = await dependencies.unarchiveThread(conversation.threadId);
  if (!response.success) {
    throw new Error(response.error ?? 'Failed to unarchive conversation.');
  }
}

function ArchivedHistoryFilter({
  showArchived,
  onHide,
}: {
  showArchived: boolean;
  onHide: () => void;
}) {
  const { t } = useTranslation();
  if (!showArchived) {
    return null;
  }

  return (
    <div className="mb-2 flex justify-end">
      <button
        type="button"
        onClick={onHide}
        className="cursor-default rounded-[var(--control-radius)] px-2 py-1 text-[11px] text-muted-foreground/72 transition-colors hover:bg-hover hover:text-foreground"
      >
        {t('panel.history.hideArchived')}
      </button>
    </div>
  );
}

function formatRelativeTime(dateStr: string, t: (key: string) => string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('panel.history.justNow');
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface ConversationHistoryPanelProps {
  showHeader?: boolean;
  fillHeight?: boolean;
  onSelect?: () => void;
  onClose?: () => void;
  onOpenConversation?: (conversation: ConversationPreview) => void;
  onLoadingChange?: (loading: boolean) => void;
  externalConversations?: ReadonlyArray<ConversationPreview>;
  readOnly?: boolean;
  indicatorToneOverride?: AgentIndicatorTone;
}

export function ConversationHistoryPanel({
  showHeader = false,
  fillHeight = true,
  onSelect,
  onClose,
  onOpenConversation,
  onLoadingChange,
  externalConversations,
  readOnly = false,
  indicatorToneOverride,
}: ConversationHistoryPanelProps) {
  "use no memo";

  const { t } = useTranslation();
  const {
    state,
    closeTab,
    setActiveTab,
    setSidebarActiveTab,
    setRightSidebarOpen,
    setActiveTabRegion,
    updateTabLabel,
  } = useLayout();
  const activityMap = useAgentActivityMap();
  const pendingApprovalsByAgent = usePendingApprovalsByAgent();
  const [conversationList, setConversationList] = useState<ConversationPreview[]>(
    () => externalConversations ? [...externalConversations] : [],
  );
  const [loading, setLoading] = useState(externalConversations === undefined);
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleHistoricalLimit, setVisibleHistoricalLimit] = useState<number>(DEFAULT_VISIBLE_HISTORICAL_COUNT);
  const [keyboardSelectedIndex, setKeyboardSelectedIndex] = useState<number>(-1);
  const [isDeleteAllDialogOpen, setIsDeleteAllDialogOpen] = useState(false);
  const [isDeletingConversationId, setIsDeletingConversationId] = useState<string | null>(null);
  const [isRenamingConversationId, setIsRenamingConversationId] = useState<string | null>(null);
  const [isArchivingConversationId, setIsArchivingConversationId] = useState<string | null>(null);
  const [isDeletingAll, setIsDeletingAll] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const skipNextRenameSubmitRef = useRef(false);
  const [pendingDeletedConversationKeys, setPendingDeletedConversationKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const refreshSourceRef = useRef<object>({});
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const loadConversations = useCallback(async (options: { showLoading?: boolean } = {}) => {
    if (externalConversations) {
      setConversationList([...externalConversations]);
      setLoading(false);
      return;
    }
    const showLoading = options.showLoading ?? true;
    if (showLoading) {
      setLoading(true);
    }
    try {
      const loadThreadPreviews = async (archived: boolean): Promise<ConversationPreview[]> => {
        const response = await fetch(
          await getApiUrl(archived ? '/api/agent/threads?archived=1' : '/api/agent/threads'),
          { credentials: 'include' },
        );
        if (!response.ok) {
          throw new Error(`Failed to load thread list (${response.status})`);
        }

        const payload: unknown = await response.json();
        if (!isThreadListResponse(payload)) {
          throw new Error('Invalid thread list response shape.');
        }

        return payload.data.map((thread: v2.Thread) => ({
          conversationId: thread.id,
          threadId: thread.id,
          agentId: `agent-${thread.id}`,
          profileId: '',
          workspacePath: thread.cwd,
          title: thread.name ?? (stripWorkstationContext(thread.preview || '') || t('panel.history.untitled')),
          lastMessagePreview: thread.preview ?? '',
          messageCount: 0,
          createdAt: new Date(thread.createdAt * 1000).toISOString(),
          updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
          source: 'history',
          isArchived: archived,
          isOpen: false,
          isSelected: false,
        }));
      };

      const [recentPreviews, archivedPreviews] = await Promise.all([
        loadThreadPreviews(false),
        showArchived ? loadThreadPreviews(true) : Promise.resolve([]),
      ]);

      setConversationList([...recentPreviews, ...archivedPreviews]);
    } catch (error) {
      console.error('[ConversationHistoryPanel] Failed to load conversations:', error);
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [externalConversations, showArchived, t]);

  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  useEffect(() => {
    void loadConversations({ showLoading: true });
  }, [loadConversations]);

  useEffect(() => {
    const handleRefresh = (event: Event) => {
      const source = (event as CustomEvent<{ source?: object }>).detail?.source;
      if (source === refreshSourceRef.current) {
        return;
      }
      void loadConversations({ showLoading: false });
    };

    window.addEventListener('conversation-history:refresh', handleRefresh);
    return () => {
      window.removeEventListener('conversation-history:refresh', handleRefresh);
    };
  }, [loadConversations]);

  useEffect(() => {
    // Reset pagination whenever the search term changes.
    setVisibleHistoricalLimit(DEFAULT_VISIBLE_HISTORICAL_COUNT);
  }, [deferredSearchQuery]);

  const searchTerms = useMemo(() => tokenizeSearchQuery(deferredSearchQuery), [deferredSearchQuery]);

  const activeConversations = useMemo(() => {
    // A controlled list is authoritative for remote/read-only hosts. Their
    // browser-local tabs can use synthetic thread markers, so merging those
    // tabs back into the supplied list would show the same remote thread twice.
    if (externalConversations) return [];

    const defaultAgentLabel = t('common.newAgent');
    const previews: ConversationPreview[] = [];

    for (const tab of Object.values(state.tabs)) {
      if (!isAgentTab(tab)) continue;

      const pane = findPaneByTabId(state.tree, tab.id);
      const isPinned = state.sidebarPane?.tabIds.includes(tab.id) ?? false;
      if (!pane && !isPinned) continue;

      const activity = activityMap.get(tab.id);
      const title = stripWorkstationContext(tab.label || '').trim();
      const lastMessagePreview = stripWorkstationContext(activity?.lastMessagePreview || '').trim();
      const hasRenderableContent = Boolean(
        tab.agent.session.codexThreadId
        || (activity?.messageCount ?? 0) > 0
        || lastMessagePreview
        || (title && title !== defaultAgentLabel),
      );
      if (!hasRenderableContent) continue;

      previews.push({
        conversationId: tab.agent.session.codexThreadId ?? tab.agent.session.conversationId ?? tab.id,
        threadId: tab.agent.session.codexThreadId ?? null,
        agentId: tab.id,
        profileId: tab.agent.runtime.modelConfig?.profileId ?? '',
        workspacePath: tab.agent.runtime.workspacePath ?? '',
        title: title && title !== defaultAgentLabel
          ? title
          : (lastMessagePreview || defaultAgentLabel),
        lastMessagePreview,
        messageCount: activity?.messageCount ?? 0,
        createdAt: new Date(tab.createdAt ?? Date.now()).toISOString(),
        updatedAt: activity?.updatedAt ?? new Date(tab.createdAt ?? Date.now()).toISOString(),
        source: 'active',
        isArchived: false,
        isOpen: true,
        isSelected: isPinned
          ? state.sidebarPane?.activeTabId === tab.id
          : pane?.activeTabId === tab.id,
      });
    }

    return previews.sort((a, b) => timestampFromIso(b.updatedAt) - timestampFromIso(a.updatedAt));
  }, [activityMap, externalConversations, state.sidebarPane, state.tabs, state.tree, t]);

  const mergedConversations = useMemo(() => {
    const historicalByThreadId = new Map<string, ConversationPreview>();
    for (const conversation of conversationList) {
      if (conversation.threadId) {
        historicalByThreadId.set(conversation.threadId, conversation);
      }
    }

    const mergedActive = activeConversations.map((conversation) => {
      const historical = conversation.threadId ? historicalByThreadId.get(conversation.threadId) : undefined;
      if (conversation.threadId) {
        historicalByThreadId.delete(conversation.threadId);
      }

      return {
        ...(historical ?? {}),
        ...conversation,
        title: conversation.title !== t('common.newAgent')
          ? conversation.title
          : (historical?.title ?? conversation.title),
        lastMessagePreview: conversation.lastMessagePreview || historical?.lastMessagePreview || '',
        workspacePath: conversation.workspacePath || historical?.workspacePath || '',
        createdAt: historical?.createdAt ?? conversation.createdAt,
        updatedAt: timestampFromIso(conversation.updatedAt) >= timestampFromIso(historical?.updatedAt ?? '')
          ? conversation.updatedAt
          : historical!.updatedAt,
      };
    });

    const remainingHistorical = Array.from(historicalByThreadId.values()).sort(
      (a, b) => timestampFromIso(b.updatedAt) - timestampFromIso(a.updatedAt),
    );

    return [...mergedActive, ...remainingHistorical];
  }, [activeConversations, conversationList, t]);

  const visibleConversations = useMemo(
    () => mergedConversations.filter(
      (conversation) => !pendingDeletedConversationKeys.has(getConversationRemovalKey(conversation)),
    ),
    [mergedConversations, pendingDeletedConversationKeys],
  );

  const filteredConversations = useMemo(() => {
    if (searchTerms.length === 0) {
      return visibleConversations;
    }

    return visibleConversations.filter((conversation) => {
      const searchableText = normalizeSearchText([
        conversation.title,
        conversation.lastMessagePreview,
        conversation.workspacePath,
      ].join(' '));

      return searchTerms.every((term) => searchableText.includes(term));
    });
  }, [searchTerms, visibleConversations]);

  const activeResults = useMemo(
    () => filteredConversations.filter((conversation) => conversation.isOpen),
    [filteredConversations],
  );
  const historicalResults = useMemo(
    () => filteredConversations.filter((conversation) => !conversation.isOpen),
    [filteredConversations],
  );

  const visibleHistoricalResults = useMemo(() => {
    return historicalResults.slice(0, visibleHistoricalLimit);
  }, [historicalResults, visibleHistoricalLimit]);

  const hiddenHistoricalCount = Math.max(
    0,
    historicalResults.length - visibleHistoricalResults.length,
  );
  const nextPageSize = Math.min(HISTORICAL_PAGE_SIZE, hiddenHistoricalCount);
  const canCollapseHistorical = visibleHistoricalLimit > DEFAULT_VISIBLE_HISTORICAL_COUNT;
  const handleShowMoreHistorical = useCallback(() => {
    setVisibleHistoricalLimit((prev) => prev + HISTORICAL_PAGE_SIZE);
  }, []);
  const handleCollapseHistorical = useCallback(() => {
    setVisibleHistoricalLimit(DEFAULT_VISIBLE_HISTORICAL_COUNT);
  }, []);

  const displayedConversations = useMemo(
    () => [...activeResults, ...visibleHistoricalResults],
    [activeResults, visibleHistoricalResults],
  );

  const focusLiveConversation = useCallback((conversation: ConversationPreview): boolean => {
    if (!conversation.isOpen || !state.tabs[conversation.agentId]) return false;

    if (state.sidebarPane?.tabIds.includes(conversation.agentId)) {
      setSidebarActiveTab(conversation.agentId);
      setRightSidebarOpen(true);
      setActiveTabRegion('sidebar');
    } else {
      setActiveTab(conversation.agentId);
    }

    onSelect?.();
    return true;
  }, [
    onSelect,
    setActiveTab,
    setActiveTabRegion,
    setRightSidebarOpen,
    setSidebarActiveTab,
    state.sidebarPane,
    state.tabs,
  ]);

  const handleSelect = (conv: ConversationPreview) => {
    if (focusLiveConversation(conv)) {
      return;
    }

    onOpenConversation?.(conv);

    if (!onOpenConversation && conv.threadId) {
      window.dispatchEvent(new CustomEvent('conversation-history:open', {
        detail: {
          conversationId: conv.conversationId,
          threadId: conv.threadId,
          agentId: conv.agentId,
          profileId: conv.profileId,
          title: conv.title,
          workspacePath: conv.workspacePath,
        },
      }));
    }

    onSelect?.();
  };

  const refreshConversationHistory = useCallback(async () => {
    await loadConversations({ showLoading: false });
    window.dispatchEvent(new CustomEvent('conversation-history:refresh', {
      detail: { source: refreshSourceRef.current },
    }));
  }, [loadConversations]);

  const handleDeleteConversation = useCallback(async (conv: ConversationPreview) => {
    const removalKey = getConversationRemovalKey(conv);
    setIsDeletingConversationId(conv.conversationId);
    setPendingDeletedConversationKeys((current) => new Set(current).add(removalKey));
    setConversationList((current) => current.filter(
      (conversation) => getConversationRemovalKey(conversation) !== removalKey,
    ));

    try {
      console.log(
        `[ConversationHistoryPanel] Delete conversation requested threadId=${conv.threadId ?? 'null'} agentId=${conv.agentId}`,
      );
      await deleteConversationWithConfirmedClose(conv, {
        deleteThread: agentThreads.deleteThread,
        closeTab,
      });

      await refreshConversationHistory();
      setPendingDeletedConversationKeys((current) => removePendingConversationKey(current, conv));
    } catch (error) {
      setPendingDeletedConversationKeys((current) => {
        const next = new Set(current);
        next.delete(removalKey);
        return next;
      });
      void loadConversations();
      console.error('[ConversationHistoryPanel] Failed to delete conversation:', error);
    } finally {
      setIsDeletingConversationId((current) => (current === conv.conversationId ? null : current));
    }
  }, [closeTab, loadConversations, refreshConversationHistory]);

  const handleStartRenameConversation = useCallback((conv: ConversationPreview) => {
    if (!conv.threadId) return;
    skipNextRenameSubmitRef.current = false;
    setRenamingConversationId(conv.conversationId);
    setRenameDraft(conv.title);
  }, []);

  const clearRenameConversation = useCallback(() => {
    setRenamingConversationId(null);
    setRenameDraft('');
  }, []);

  const handleCancelRenameConversation = useCallback(() => {
    skipNextRenameSubmitRef.current = true;
    clearRenameConversation();
  }, [clearRenameConversation]);

  const handleSubmitRenameConversation = useCallback(async (conv: ConversationPreview) => {
    if (skipNextRenameSubmitRef.current) {
      skipNextRenameSubmitRef.current = false;
      return;
    }

    const nextName = renameDraft.trim();
    if (!conv.threadId || !nextName || nextName === conv.title.trim()) {
      clearRenameConversation();
      return;
    }

    setIsRenamingConversationId(conv.conversationId);
    setConversationList((current) => current.map((conversation) => (
      getConversationRemovalKey(conversation) === getConversationRemovalKey(conv)
        ? { ...conversation, title: nextName }
        : conversation
    )));

    try {
      const savedName = await renameConversationWithConfirmedSave(conv, nextName, {
        renameThread: agentThreads.renameThread,
        updateTabLabel,
      });

      setConversationList((current) => current.map((conversation) => (
        getConversationRemovalKey(conversation) === getConversationRemovalKey(conv)
          ? { ...conversation, title: savedName }
          : conversation
      )));
      await refreshConversationHistory();
    } catch (error) {
      void loadConversations();
      console.error('[ConversationHistoryPanel] Failed to rename conversation:', error);
    } finally {
      setIsRenamingConversationId((current) => (current === conv.conversationId ? null : current));
      clearRenameConversation();
    }
  }, [
    clearRenameConversation,
    loadConversations,
    refreshConversationHistory,
    renameDraft,
    updateTabLabel,
  ]);

  const handleArchiveConversation = useCallback(async (conv: ConversationPreview) => {
    const removalKey = getConversationRemovalKey(conv);
    setIsArchivingConversationId(conv.conversationId);
    setPendingDeletedConversationKeys((current) => new Set(current).add(removalKey));

    try {
      await archiveConversationWithConfirmedClose(conv, {
        archiveThread: agentThreads.archiveThread,
        closeTab,
      });

      await refreshConversationHistory();
      setPendingDeletedConversationKeys((current) => removePendingConversationKey(current, conv));
    } catch (error) {
      setPendingDeletedConversationKeys((current) => {
        const next = new Set(current);
        next.delete(removalKey);
        return next;
      });
      void loadConversations();
      console.error('[ConversationHistoryPanel] Failed to archive conversation:', error);
    } finally {
      setIsArchivingConversationId((current) => (current === conv.conversationId ? null : current));
    }
  }, [closeTab, loadConversations, refreshConversationHistory]);

  const handleUnarchiveConversation = useCallback(async (conv: ConversationPreview) => {
    const removalKey = getConversationRemovalKey(conv);
    setIsArchivingConversationId(conv.conversationId);
    setPendingDeletedConversationKeys((current) => new Set(current).add(removalKey));

    try {
      await unarchiveConversationWithConfirmedRefresh(conv, {
        unarchiveThread: agentThreads.unarchiveThread,
      });

      await refreshConversationHistory();
      setPendingDeletedConversationKeys((current) => removePendingConversationKey(current, conv));
    } catch (error) {
      setPendingDeletedConversationKeys((current) => {
        const next = new Set(current);
        next.delete(removalKey);
        return next;
      });
      void loadConversations();
      console.error('[ConversationHistoryPanel] Failed to unarchive conversation:', error);
    } finally {
      setIsArchivingConversationId((current) => (current === conv.conversationId ? null : current));
    }
  }, [loadConversations, refreshConversationHistory]);

  const handleConfirmDeleteAll = useCallback(async () => {
    const conversationsToDelete = getDeleteAllConversationScope(showArchived, mergedConversations, activeConversations);
    const removalKeys = conversationsToDelete.map((conversation) => getConversationRemovalKey(conversation));
    setIsDeletingAll(true);
    setPendingDeletedConversationKeys((current) => {
      const next = new Set(current);
      for (const removalKey of removalKeys) {
        next.add(removalKey);
      }
      return next;
    });
    setConversationList([]);

    try {
      console.log(
        `[ConversationHistoryPanel] Delete all conversations requested count=${visibleConversations.length}`,
      );
      await deleteAllConversationsWithConfirmedClose(conversationsToDelete, {
        deleteAll: agentThreads.deleteAll,
        closeTab,
      });

      setIsDeleteAllDialogOpen(false);
      await refreshConversationHistory();
    } catch (error) {
      setPendingDeletedConversationKeys((current) => {
        const next = new Set(current);
        for (const removalKey of removalKeys) {
          next.delete(removalKey);
        }
        return next;
      });
      void loadConversations();
      console.error('[ConversationHistoryPanel] Failed to delete all conversations:', error);
    } finally {
      setIsDeletingAll(false);
    }
  }, [
    activeConversations,
    closeTab,
    loadConversations,
    mergedConversations,
    refreshConversationHistory,
    showArchived,
    visibleConversations.length,
  ]);

  const openConversationContextMenu = useCallback(async (
    event: React.MouseEvent<HTMLDivElement>,
    conv?: ConversationPreview,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (readOnly) return;

    const items = conv
      ? [
          {
            label: t('panel.history.renameConversation'),
            action: 'rename-conversation',
            disabled: !conv.threadId
              || isDeletingAll
              || isDeletingConversationId === conv.conversationId
              || isRenamingConversationId === conv.conversationId
              || isArchivingConversationId === conv.conversationId,
          },
          {
            label: conv.isArchived ? t('panel.history.unarchiveConversation') : t('panel.history.archiveConversation'),
            action: conv.isArchived ? 'unarchive-conversation' : 'archive-conversation',
            disabled: !conv.threadId
              || isDeletingAll
              || isDeletingConversationId === conv.conversationId
              || isRenamingConversationId === conv.conversationId
              || isArchivingConversationId === conv.conversationId,
          },
          {
            label: '',
            action: 'separator',
            separator: true,
          },
          {
            label: t('panel.history.deleteConversation'),
            action: 'delete-conversation',
            disabled: isDeletingAll
              || isDeletingConversationId === conv.conversationId
              || isRenamingConversationId === conv.conversationId
              || isArchivingConversationId === conv.conversationId,
          },
          {
            label: '',
            action: 'separator',
            separator: true,
          },
          {
            label: showArchived ? t('panel.history.hideArchived') : t('panel.history.showArchived'),
            action: showArchived ? 'hide-archived' : 'include-archived',
          },
          {
            label: t('panel.history.deleteAllConversations'),
            action: 'delete-all-conversations',
            disabled: isDeletingAll || visibleConversations.length === 0,
          },
        ]
      : [
          {
            label: showArchived ? t('panel.history.hideArchived') : t('panel.history.showArchived'),
            action: showArchived ? 'hide-archived' : 'include-archived',
          },
          {
            label: '',
            action: 'separator',
            separator: true,
          },
          {
            label: t('panel.history.deleteAllConversations'),
            action: 'delete-all-conversations',
            disabled: isDeletingAll || visibleConversations.length === 0,
          },
        ];

    const action = await showContextMenu(items, 'conversation_history');

    if (action === 'include-archived') {
      setShowArchived(true);
      return;
    }

    if (action === 'hide-archived') {
      setShowArchived(false);
      return;
    }

    if (action === 'rename-conversation' && conv) {
      handleStartRenameConversation(conv);
      return;
    }

    if (action === 'archive-conversation' && conv) {
      void handleArchiveConversation(conv);
      return;
    }

    if (action === 'unarchive-conversation' && conv) {
      void handleUnarchiveConversation(conv);
      return;
    }

    if (action === 'delete-conversation' && conv) {
      void handleDeleteConversation(conv);
      return;
    }

    if (action === 'delete-all-conversations') {
      setIsDeleteAllDialogOpen(true);
    }
  }, [
    handleArchiveConversation,
    handleDeleteConversation,
    handleStartRenameConversation,
    handleUnarchiveConversation,
    isArchivingConversationId,
    isDeletingAll,
    isDeletingConversationId,
    isRenamingConversationId,
    showArchived,
    t,
    visibleConversations.length,
    readOnly,
  ]);

  const handleKeyboardNavigate = useCallback((dir: 'up' | 'down' | 'enter' | 'escape') => {
    const total = displayedConversations.length;
    if (total === 0) {
      setKeyboardSelectedIndex(-1);
      return;
    }
    if (dir === 'down') {
      setKeyboardSelectedIndex((prev) => {
        if (prev < 0) return 0;
        return Math.min(prev + 1, total - 1);
      });
      return;
    }
    if (dir === 'up') {
      setKeyboardSelectedIndex((prev) => {
        if (prev <= 0) return -1;
        return prev - 1;
      });
      return;
    }
    if (dir === 'enter') {
      const idx = keyboardSelectedIndex;
      if (idx >= 0 && idx < total) {
        handleSelect(displayedConversations[idx]);
      }
      return;
    }
    if (dir === 'escape') {
      setKeyboardSelectedIndex(-1);
    }
  }, [displayedConversations, keyboardSelectedIndex]);

  // Keep keyboard selection in bounds as the list changes.
  useEffect(() => {
    if (keyboardSelectedIndex >= displayedConversations.length) {
      setKeyboardSelectedIndex(-1);
    }
  }, [displayedConversations.length, keyboardSelectedIndex]);

  const useCardStyle = !fillHeight;

  const getConvIndicatorTone = useCallback((conv: ConversationPreview): AgentIndicatorTone => {
    if (indicatorToneOverride) return indicatorToneOverride;
    if (!conv.isOpen) return 'idle';
    const activity = activityMap.get(conv.agentId);
    return getAgentIndicatorTone({
      hasPendingApproval: (pendingApprovalsByAgent.get(conv.agentId) || 0) > 0,
      isRunning: activity?.isRunning ?? false,
      unreadCount: activity?.unreadCount ?? 0,
    });
  }, [activityMap, indicatorToneOverride, pendingApprovalsByAgent]);

  return (
    <div className={fillHeight ? 'h-full flex flex-col' : 'flex flex-col'}>
      {showHeader && (
        <div
          className="flex items-center justify-between flex-shrink-0"
          style={{
            paddingLeft: 'var(--unit-padding)',
            paddingRight: 'var(--unit-padding-small)',
            height: 'var(--unit-element-height)',
          }}
        >
          <span className="text-ui-sm text-foreground font-normal">{t('panel.history.title')}</span>
          {onClose && (
            <span
              role="button"
              tabIndex={0}
              onClick={onClose}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onClose();
                }
              }}
              className="size-5 flex items-center justify-center text-muted-foreground agent-tab-close"
              style={{ borderRadius: 'var(--control-radius)' }}
              aria-label={t('panel.history.closeHistory')}
              data-help-title={t('help.history.close.title')}
              data-help-description={t('help.history.close.description')}
            >
              <X className="size-3.5" />
            </span>
          )}
        </div>
      )}

      {useCardStyle ? (
        /* Card-style layout for embedded contexts (new tab page) */
        <>
          {!readOnly ? <div className="mb-3">
            <ArchivedHistoryFilter
              showArchived={showArchived}
              onHide={() => setShowArchived(false)}
            />
            <HistorySearchField
              value={searchQuery}
              onChange={setSearchQuery}
              onArrowDown={() => handleKeyboardNavigate('down')}
              onArrowUp={() => handleKeyboardNavigate('up')}
              onEnter={() => handleKeyboardNavigate('enter')}
              onEscape={() => handleKeyboardNavigate('escape')}
            />
          </div> : null}

          <div
            className="flex flex-col gap-0 mx-auto"
            style={{ width: 'calc(100% - 3rem)' }}
            data-testid={CONVERSATION_HISTORY_LIST_ID}
            onContextMenu={readOnly ? undefined : (event) => {
              void openConversationContextMenu(event);
            }}
          >
            {loading ? (
              <div className="py-5 text-ui-sm text-muted-foreground">{t('panel.history.loading')}</div>
            ) : displayedConversations.length === 0 ? (
              <div className="py-5 text-ui-sm text-muted-foreground">
                {t('panel.history.noConversations')}
              </div>
            ) : (
              <div style={{ opacity: 0.75 }}>
                {displayedConversations.map((conv, index) => {
                  // Fade the final visible item as a visual hint that more
                  // history exists below the fold. Only while collapsed and
                  // not actively searching.
                  const isLast = index === displayedConversations.length - 1;
                  const shouldFade = isLast
                    && !canCollapseHistorical
                    && searchTerms.length === 0
                    && hiddenHistoricalCount > 0;
                  const isKeyboardSelected = index === keyboardSelectedIndex;
                  const rowStyle: React.CSSProperties = {
                    ...(shouldFade ? { opacity: 0.5 } : {}),
                    ...(isKeyboardSelected
                      ? {
                          background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 70%, transparent)',
                          borderRadius: '8px',
                          paddingInline: '10px',
                          marginInline: '-10px',
                        }
                      : {}),
                  };
                  return (
                    <div
                      key={`${conv.source}-${conv.agentId}-${conv.threadId ?? conv.conversationId}`}
                      style={rowStyle}
                    >
                      <HistoryItem
                        conv={conv}
                        searchTerms={searchTerms}
                        onSelect={() => handleSelect(conv)}
                        onContextMenu={readOnly ? undefined : (event) => {
                          void openConversationContextMenu(event, conv);
                        }}
                        isRenaming={renamingConversationId === conv.conversationId}
                        renameValue={renameDraft}
                        onRenameChange={setRenameDraft}
                        onRenameSubmit={() => {
                          void handleSubmitRenameConversation(conv);
                        }}
                        onRenameCancel={handleCancelRenameConversation}
                        cardStyle
                        indicatorTone={getConvIndicatorTone(conv)}
                      />
                    </div>
                  );
                })}

                {hiddenHistoricalCount > 0 ? (
                  <div className="flex justify-center pt-5">
                    <HistoryDisclosureButton onClick={handleShowMoreHistorical}>
                      Show {nextPageSize} more
                    </HistoryDisclosureButton>
                  </div>
                ) : null}

                {canCollapseHistorical ? (
                  <div className="flex justify-center pt-5">
                    <HistoryDisclosureButton onClick={handleCollapseHistorical}>
                      Show less
                    </HistoryDisclosureButton>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </>
      ) : (
        /* List-style layout for sidebar/panel contexts */
        <>
          <div
            className="flex-shrink-0 border-b border-border/80"
            style={{
              padding: 'var(--unit-padding)',
            }}
          >
            <ArchivedHistoryFilter
              showArchived={showArchived}
              onHide={() => setShowArchived(false)}
            />
            <HistorySearchField
              value={searchQuery}
              onChange={setSearchQuery}
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-muted-foreground text-ui-base">{t('panel.history.loading')}</div>
            ) : displayedConversations.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground text-ui-base">
                {t('panel.history.noConversations')}
              </div>
            ) : (
              <div
                data-testid={CONVERSATION_HISTORY_LIST_ID}
                onContextMenu={readOnly ? undefined : (event) => {
                  void openConversationContextMenu(event);
                }}
              >
                {displayedConversations.map(conv => (
                  <HistoryItem
                    key={`${conv.source}-${conv.agentId}-${conv.threadId ?? conv.conversationId}`}
                    conv={conv}
                    searchTerms={searchTerms}
                    onSelect={() => handleSelect(conv)}
                    onContextMenu={readOnly ? undefined : (event) => {
                      void openConversationContextMenu(event, conv);
                    }}
                    isRenaming={renamingConversationId === conv.conversationId}
                    renameValue={renameDraft}
                    onRenameChange={setRenameDraft}
                    onRenameSubmit={() => {
                      void handleSubmitRenameConversation(conv);
                    }}
                    onRenameCancel={handleCancelRenameConversation}
                    indicatorTone={getConvIndicatorTone(conv)}
                  />
                ))}

                {hiddenHistoricalCount > 0 ? (
                  <div
                    className="flex items-center justify-center"
                    style={{ padding: '20px var(--unit-padding) 0' }}
                  >
                    <HistoryDisclosureButton onClick={handleShowMoreHistorical}>
                      Show {nextPageSize} more
                    </HistoryDisclosureButton>
                  </div>
                ) : null}

                {canCollapseHistorical ? (
                  <div
                    className="flex items-center justify-center"
                    style={{ padding: '20px var(--unit-padding) var(--unit-padding)' }}
                  >
                    <HistoryDisclosureButton onClick={handleCollapseHistorical}>
                      Show less
                    </HistoryDisclosureButton>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </>
      )}

      {!readOnly ? <AlertDialog open={isDeleteAllDialogOpen} onOpenChange={(open) => {
        if (!isDeletingAll) {
          setIsDeleteAllDialogOpen(open);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-[var(--oa-danger-soft)] text-[var(--oa-danger)]">
              <AlertTriangle className="size-5" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('panel.history.deleteAllTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('panel.history.deleteAllDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingAll}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isDeletingAll}
              onClick={() => {
                void handleConfirmDeleteAll();
              }}
            >
              {isDeletingAll ? t('common.loading') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog> : null}
    </div>
  );
}
