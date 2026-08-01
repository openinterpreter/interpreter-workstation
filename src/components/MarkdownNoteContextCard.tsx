import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { vault, workspace } from '@/ipc';
import type { VaultNoteContext, VaultResolvedLink } from '../../shared/types/vault';
import type { WorkspaceFilesChangedEvent } from '../../electron/ipc/registry';
import { shouldRefreshNoteContextFromWorkspaceEvent } from '../utils/noteContextRefresh';
import { FileSystemProxy } from './FileSystemProxy';
import { MENTION_PREVIEW_DELAY_MS, MENTION_PREVIEW_END_EVENT, MENTION_PREVIEW_START_EVENT } from '../../shared/types/mentionPreview';

interface MarkdownNoteContextCardProps {
  filePath: string;
  initialContext?: VaultNoteContext | null;
  initialError?: string | null;
  skipInitialLoad?: boolean;
  onContextChange?: (context: VaultNoteContext | null) => void;
}

function openNote(path: string, fragment?: string | null): void {
  const windowingAPI = (window as any).windowingAPI;
  windowingAPI?.openFile?.(path);

  if (fragment) {
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('mention:scroll-to', {
        detail: { path, fragment },
      }));
    }, 250);
  }
}

function LinkProxy({
  path,
  label,
  fragment,
  onClick,
}: {
  path: string;
  label: string;
  fragment?: string | null;
  onClick: () => void;
}) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const [previewSourceKey] = useState(() => `mention-preview-${Math.random().toString(36).slice(2, 10)}`);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingPreviews = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    clearPendingPreviews();

    hoverTimeoutRef.current = setTimeout(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const connectionScope = wrapperRef.current?.closest('[data-mention-connection-scope="markdown-editor"]')
        ? 'markdown-editor'
        : undefined;

      window.dispatchEvent(new CustomEvent('mention:hover-start', {
        detail: {
          path,
          fragment,
          connectionScope,
          mentionRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        },
      }));
    }, 50);

    previewTimeoutRef.current = setTimeout(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;

      window.dispatchEvent(new CustomEvent(MENTION_PREVIEW_START_EVENT, {
        detail: {
          type: 'file',
          sourceKey: previewSourceKey,
          path,
          label,
          id: path,
          mentionRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        },
      }));
    }, MENTION_PREVIEW_DELAY_MS);
  }, [clearPendingPreviews, fragment, label, path, previewSourceKey]);

  const handleMouseLeave = useCallback(() => {
    clearPendingPreviews();
    window.dispatchEvent(new CustomEvent('mention:hover-end'));
    window.dispatchEvent(new CustomEvent(MENTION_PREVIEW_END_EVENT));
  }, [clearPendingPreviews]);

  useEffect(() => {
    return () => {
      clearPendingPreviews();
    };
  }, [clearPendingPreviews]);

  return (
    <span
      ref={wrapperRef}
      data-mention-preview-key={previewSourceKey}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="inline-flex items-center"
    >
      <FileSystemProxy
        path={path}
        filename={label}
        type="file"
        variant="inline"
        dragContext={`note-context-${path}`}
        onClick={onClick}
        showPath={true}
        skipAutoFetch={true}
      />
      {fragment ? (
        <span className="ml-0.5 text-ui-xs text-[var(--oa-text-muted)]">#{fragment}</span>
      ) : null}
    </span>
  );
}

function LinkGroup({
  count,
  children,
}: {
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) {
    return null;
  }

  return (
    <div className="min-w-0">{children}</div>
  );
}

export function MarkdownNoteContextCard({
  filePath,
  initialContext = null,
  initialError = null,
  skipInitialLoad = false,
  onContextChange,
}: MarkdownNoteContextCardProps) {
  const [context, setContext] = useState<VaultNoteContext | null>(initialContext);
  const [error, setError] = useState<string | null>(initialError);
  const refreshTimerRef = useRef<number | null>(null);

  const loadContext = useCallback(async () => {
    let nextContext: VaultNoteContext | null = null;
    let nextErrorMessage: string | null = null;
    try {
      nextContext = await vault.getNoteContext({ filePath });
    } catch (nextError) {
      nextErrorMessage = nextError instanceof Error ? nextError.message : 'Failed to load note context';
    }

    if (nextErrorMessage) {
      setError(nextErrorMessage);
      if (onContextChange) {
        onContextChange(null);
      }
      return;
    }

    setContext(nextContext);
    setError(null);
    if (onContextChange) {
      onContextChange(nextContext);
    }
  }, [filePath, onContextChange]);

  useEffect(() => {
    setContext(initialContext);
    setError(initialError);
  }, [initialContext, initialError]);

  useEffect(() => {
    if (skipInitialLoad) {
      return;
    }
    void loadContext();
  }, [loadContext, skipInitialLoad]);

  useEffect(() => {
    const unsubscribe = workspace.onFilesChanged((event: WorkspaceFilesChangedEvent) => {
      if (!shouldRefreshNoteContextFromWorkspaceEvent(event, filePath)) {
        return;
      }

      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }

      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void loadContext();
      }, 120);
    });

    return () => {
      unsubscribe();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, [loadContext]);

  const note = context?.note ?? null;
  const hasContent = Boolean(
    note
    && (
      note.outgoingLinks.length > 0
      || note.backlinks.length > 0
    ),
  );

  const outgoingLinks = useMemo(() => note?.outgoingLinks.slice(0, 10) ?? [], [note?.outgoingLinks]);
  const backlinks = useMemo(() => note?.backlinks.slice(0, 10) ?? [], [note?.backlinks]);

  if (!note || (!hasContent && !error)) {
    return null;
  }

  return (
    <>
      {error ? (
        <div className="grid items-start gap-x-5 gap-y-2 md:grid-cols-[minmax(0,120px)_minmax(0,1fr)]">
          <dt className="text-ui-sm text-[var(--oa-text-muted)]">Links</dt>
          <dd className="text-ui-sm text-[var(--oa-text-muted)]">{error}</dd>
        </div>
      ) : null}

      <div className="grid items-start gap-x-5 gap-y-2 md:grid-cols-[minmax(0,120px)_minmax(0,1fr)]">
        <dt className="text-ui-sm text-[var(--oa-text-muted)]">Linked from</dt>
        <dd className="min-w-0">
          <LinkGroup count={note.backlinks.length}>
            <div className="flex flex-wrap gap-2">
              {backlinks.map((backlink) => (
                <LinkProxy
                  key={backlink.path}
                  path={backlink.path}
                  label={backlink.title}
                  onClick={() => openNote(backlink.path)}
                />
              ))}
              {note.backlinks.length > backlinks.length ? (
                <span className="self-center text-ui-xs text-[var(--oa-text-faint)]">
                  +{note.backlinks.length - backlinks.length} more
                </span>
              ) : null}
            </div>
          </LinkGroup>
        </dd>
      </div>

      <div className="grid items-start gap-x-5 gap-y-2 md:grid-cols-[minmax(0,120px)_minmax(0,1fr)]">
        <dt className="text-ui-sm text-[var(--oa-text-muted)]">Links to</dt>
        <dd className="min-w-0">
          <LinkGroup count={note.outgoingLinks.length}>
            <div className="flex flex-wrap gap-2">
              {outgoingLinks.map((link: VaultResolvedLink) => (
                <LinkProxy
                  key={`${link.resolvedPath}#${link.fragment ?? ''}`}
                  path={link.resolvedPath}
                  label={link.resolvedLabel}
                  fragment={link.fragment}
                  onClick={() => openNote(link.resolvedPath, link.fragment)}
                />
              ))}
              {note.outgoingLinks.length > outgoingLinks.length ? (
                <span className="self-center text-ui-xs text-[var(--oa-text-faint)]">
                  +{note.outgoingLinks.length - outgoingLinks.length} more
                </span>
              ) : null}
            </div>
          </LinkGroup>
        </dd>
      </div>
    </>
  );
}
