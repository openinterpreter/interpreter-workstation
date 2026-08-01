/**
 * MentionNodeView Component
 *
 * React component that renders file/folder/browser-tab mentions as FileSystemProxy.
 * Used by Tiptap's ReactNodeViewRenderer.
 * Dispatches hover events for inter-document connection lines.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { FileSystemProxy } from '../../../../src/components/FileSystemProxy';
import { useLayoutActions } from '../../../../src/hooks/useLayout';
import { FILE_SYSTEM_PROXY_TYPE_FILE, FILE_SYSTEM_PROXY_TYPE_DIRECTORY, MENTION_NODE_VIEW_CLASS } from '../../../../shared/element-ids';
import { MENTION_PREVIEW_DELAY_MS, MENTION_PREVIEW_END_EVENT, MENTION_PREVIEW_START_EVENT } from '../../../../shared/types/mentionPreview';
import { openMentionTarget } from '../../mentions/openMentionTarget';
import { getLocalReferenceDisplayLabel } from '../../../../src/utils/localReferenceDisplay';

export function MentionNodeView({ node, deleteNode }: any) {
  const { id, label, itemType, url, faviconUrl, fragment, lineStart, lineEnd } = node.attrs;
  const { openFile, openFolder, openBrowser } = useLayoutActions();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const [previewSourceKey] = useState(() => `mention-preview-${Math.random().toString(36).slice(2, 10)}`);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isBrowserTab = itemType === 'browser-tab';
  const displayLabel = getLocalReferenceDisplayLabel({
    label,
    path: isBrowserTab ? undefined : id,
    itemType,
  });

  const handleClick = useCallback(() => {
    if (itemType === 'browser-tab' && url) {
      openBrowser(url);
    } else if (id) {
      openMentionTarget(
        { path: id, itemType, fragment, lineStart, lineEnd },
        {
          windowingApi: {
            openFile,
            openFolder,
          },
        },
      );
    }
  }, [itemType, id, url, fragment, lineStart, lineEnd, openFile, openFolder, openBrowser]);

  const handleMouseEnter = useCallback(() => {
    if (itemType !== 'browser-tab' && id) {
      // Keep existing fast hover behavior for connection lines.
      hoverTimeoutRef.current = setTimeout(() => {
        const rect = wrapperRef.current?.getBoundingClientRect();
        if (!rect) return;
        const connectionScope = wrapperRef.current?.closest('[data-mention-connection-scope="markdown-editor"]')
          ? 'markdown-editor'
          : undefined;

        window.dispatchEvent(new CustomEvent('mention:hover-start', {
          detail: {
            path: id,
            fragment,
            lineStart,
            lineEnd,
            connectionScope,
            mentionRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          },
        }));
      }, 50);
    }

    if (!id && !url) return;

    // 500ms dwell for mention detail preview popovers.
    previewTimeoutRef.current = setTimeout(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;

      window.dispatchEvent(new CustomEvent(MENTION_PREVIEW_START_EVENT, {
        detail: {
          type: itemType,
          sourceKey: previewSourceKey,
          id,
          label: displayLabel,
          path: itemType === 'browser-tab' ? undefined : id,
          url,
          faviconUrl,
          mentionRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        },
      }));
    }, MENTION_PREVIEW_DELAY_MS);
  }, [id, itemType, fragment, lineStart, lineEnd, displayLabel, url, faviconUrl, previewSourceKey]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    window.dispatchEvent(new CustomEvent('mention:hover-end'));
    window.dispatchEvent(new CustomEvent(MENTION_PREVIEW_END_EVENT));
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
    };
  }, []);

  if (!node?.attrs) {
    return null;
  }

  const testId = itemType === 'directory' ? FILE_SYSTEM_PROXY_TYPE_DIRECTORY : FILE_SYSTEM_PROXY_TYPE_FILE;
  const hasFragmentRef = !isBrowserTab && (fragment || lineStart != null);

  return (
    <NodeViewWrapper
      as="span"
      className={MENTION_NODE_VIEW_CLASS}
      data-mention-preview-key={previewSourceKey}
      ref={wrapperRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <FileSystemProxy
        path={isBrowserTab ? undefined : id}
        filename={displayLabel}
        type={itemType}
        variant="inline"
        dragContext={`mention-${id}`}
        onClick={handleClick}
        onRemove={deleteNode}
        showPath={true}
        url={isBrowserTab ? url : undefined}
        browserId={isBrowserTab ? id : undefined}
        faviconUrl={isBrowserTab ? faviconUrl : undefined}
        testId={testId}
      />
      {hasFragmentRef && (
        <span className="text-muted-foreground text-[0.75em] ml-0.5 opacity-60">
          {fragment ? `#${fragment}` : lineStart != null ? `:L${lineStart}${lineEnd != null ? `-${lineEnd}` : ''}` : ''}
        </span>
      )}
    </NodeViewWrapper>
  );
}
