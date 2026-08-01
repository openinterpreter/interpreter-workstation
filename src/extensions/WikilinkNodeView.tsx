/**
 * WikilinkNodeView
 *
 * Renders Obsidian-style [[wikilink]] nodes inside the Tiptap editor using
 * the same FileSystemProxy pill behavior as file mentions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { FileSystemProxy } from '../components/FileSystemProxy';
import { FILE_SYSTEM_PROXY_TYPE_FILE, MENTION_NODE_VIEW_CLASS } from '../../shared/element-ids';
import { MENTION_PREVIEW_DELAY_MS, MENTION_PREVIEW_END_EVENT, MENTION_PREVIEW_START_EVENT } from '../../shared/types/mentionPreview';
import { getLocalReferenceDisplayLabel } from '../utils/localReferenceDisplay';
import { useResolvedWikilink } from '../hooks/useResolvedWikilink';

export function WikilinkNodeView({ node, deleteNode }: any) {
  const { target, fragment, display } = node.attrs;
  const resolved = useResolvedWikilink(target || '');
  const isHoveredRef = useRef(false);
  const rawVisibleLabel = (display && display.trim()) ? display : resolved.label;
  const displayLabel = getLocalReferenceDisplayLabel({
    label: rawVisibleLabel,
    path: resolved.path,
    itemType: 'file',
  });
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

  const queuePreviewForPath = useCallback((previewPath: string) => {
    clearPendingPreviews();

    hoverTimeoutRef.current = setTimeout(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const connectionScope = wrapperRef.current?.closest('[data-mention-connection-scope="markdown-editor"]')
        ? 'markdown-editor'
        : undefined;

      window.dispatchEvent(new CustomEvent('mention:hover-start', {
        detail: {
          path: previewPath,
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
          id: previewPath,
          label: displayLabel,
          path: previewPath,
          mentionRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        },
      }));
    }, MENTION_PREVIEW_DELAY_MS);
  }, [clearPendingPreviews, displayLabel, fragment, previewSourceKey]);

  const handleClick = useCallback(() => {
    if (!target) return;
    window.dispatchEvent(new CustomEvent('wikilink:open', {
      detail: {
        target,
        display,
        fragment,
        resolvedPath: resolved.found ? resolved.path : undefined,
      },
    }));
  }, [display, fragment, resolved.found, resolved.path, target]);

  const handleMouseEnter = useCallback(() => {
    isHoveredRef.current = true;

    if (resolved.found) {
      queuePreviewForPath(resolved.path);
      return;
    }

    void resolved.resolvePath().then((resolvedPathFromApi) => {
      if (!isHoveredRef.current || !resolvedPathFromApi) {
        return;
      }

      queuePreviewForPath(resolvedPathFromApi);
    });
  }, [queuePreviewForPath, resolved]);

  const handleMouseLeave = useCallback(() => {
    isHoveredRef.current = false;
    clearPendingPreviews();
    window.dispatchEvent(new CustomEvent('mention:hover-end'));
    window.dispatchEvent(new CustomEvent(MENTION_PREVIEW_END_EVENT));
  }, [clearPendingPreviews]);

  useEffect(() => {
    return () => {
      isHoveredRef.current = false;
      clearPendingPreviews();
    };
  }, [clearPendingPreviews]);

  if (!target) return null;

  return (
    <NodeViewWrapper
      as="span"
      className={MENTION_NODE_VIEW_CLASS}
      data-wikilink=""
      data-target={target}
      data-display={display || undefined}
      data-fragment={fragment || undefined}
      data-dangling={!resolved.found && !resolved.isPending || undefined}
      data-mention-preview-key={previewSourceKey}
      ref={wrapperRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={resolved.found || resolved.isPending ? undefined : { opacity: 0.7 }}
    >
      <FileSystemProxy
        path={resolved.path}
        filename={displayLabel}
        type="file"
        variant="inline"
        dragContext={`wikilink-${target}`}
        onClick={handleClick}
        onRemove={deleteNode}
        showPath={true}
        skipAutoFetch={true}
        testId={FILE_SYSTEM_PROXY_TYPE_FILE}
      />
      {fragment && (
        <span className="text-muted-foreground text-[0.75em] ml-0.5 opacity-60">
          #{fragment}
        </span>
      )}
    </NodeViewWrapper>
  );
}
