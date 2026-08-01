import { marked } from 'marked';
import React, { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components, type Options as ReactMarkdownOptions } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { FileText, Folder } from 'lucide-react';
import { cn } from '../../../src/lib/utils';
import { remarkFileLinks } from '../composer/remarkFileLinks';
import { remarkSkillLinks } from '../composer/remarkSkillLinks';
import { remarkWikilinks } from '../composer/remarkWikilinks';
import { FileSystemProxy } from '../../../src/components/FileSystemProxy';
import { MENTION_PREVIEW_DELAY_MS, MENTION_PREVIEW_END_EVENT, MENTION_PREVIEW_START_EVENT } from '../../../shared/types/mentionPreview';
import { remarkStandaloneFileLinkGrids, type StandaloneFileLinkItem } from '../../../src/utils/remarkStandaloneFileLinkGrids';
import { openExternal, pathBasename, pathDirname } from '../../../src/ipc';
import {
  fetchMentionPreviewThumbnails,
  FILE_MENTION_PREVIEW_HEIGHT,
  FILE_MENTION_PREVIEW_WIDTH,
} from '../../../src/utils/mentionPreviewThumbnails';
import { getLocalReferenceDisplayLabel } from '../../../src/utils/localReferenceDisplay';
import { resolveLinkNavigationAction } from './linkNavigation';
import { AnimatedCopyButton } from '../../../src/components/ui/message-action-button';
import { openMentionTarget } from '../mentions/openMentionTarget';
import { AttachmentChipBody } from '../composer/attachment/AttachmentChipBody';
import { AttachmentPreviewPopover } from '../composer/attachment/AttachmentPreviewPopover';
import { tokenizePastedContent } from '../composer/attachment/pastedContent';
import type { ComposerAttachmentRecord } from '../composer/attachment/types';
import { useAttachmentPreviewTrigger } from '../composer/attachment/useAttachmentPreviewTrigger';
import { remarkPastedContentTokens } from './remarkPastedContentTokens';
import { useResolvedWikilink } from '../../../src/hooks/useResolvedWikilink';
import { showFileReferenceContextMenu } from '../../../src/utils/fileReferenceContextMenu';

const GRID_CARD_WIDTH = 184;
const GRID_CARD_WIDTH_DENSE = 160;
const GRID_CARD_WIDTH_COMPACT = 144;
const GRID_CARD_MIN_WIDTH = 132;
const GRID_CARD_MIN_WIDTH_DENSE = 116;
const GRID_CARD_MIN_WIDTH_COMPACT = 104;
type RemarkPlugins = NonNullable<ReactMarkdownOptions['remarkPlugins']>;
const AUTO_DIRECTION = 'auto' as const;
const LTR_DIRECTION = 'ltr' as const;

function parseMarkdownIntoBlocks(markdown: string): string[] {
  try {
    const tokens = marked.lexer(markdown);
    return tokens.map((token) => token.raw);
  } catch {
    return [markdown];
  }
}

function healStreamingMarkdown(markdown: string): string {
  const fences = Array.from(markdown.matchAll(/(?:^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*/g));
  const last = fences[fences.length - 1]?.[1];
  if (!last || fences.length % 2 === 0) {
    return markdown;
  }

  return `${markdown}\n${last}`;
}

function extractLanguage(className?: string): string {
  if (!className) return 'plaintext';
  const match = className.match(/language-(\w+)/);
  return match ? match[1] : 'plaintext';
}

type FileLinkProps = {
  'data-path': string;
  'data-type': string;
  'data-display-text'?: string;
  'data-line-start'?: string;
  'data-line-end'?: string;
  'data-fragment'?: string;
  children?: React.ReactNode;
};

type SkillLinkProps = {
  'data-id': string;
  'data-name': string;
  'data-path': string;
  'data-display-text'?: string;
  children?: React.ReactNode;
};

type InlineLocalReferenceMentionProps = {
  path: string;
  type: 'file' | 'directory';
  displayLabel: string;
  dragContext: string;
  onClick: () => void;
  fragment?: string;
  lineStart?: number;
  lineEnd?: number;
  hoverEnabled?: boolean;
  dangling?: boolean;
  resolveHoverPath?: () => Promise<string | null | undefined>;
};

function InlineLocalReferenceMention({
  path,
  type,
  displayLabel,
  dragContext,
  onClick,
  fragment,
  lineStart,
  lineEnd,
  hoverEnabled = true,
  dangling = false,
  resolveHoverPath,
}: InlineLocalReferenceMentionProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const [previewSourceKey] = useState(() => `mention-preview-${Math.random().toString(36).slice(2, 10)}`);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHoveredRef = useRef(false);
  const hasRef = fragment || lineStart != null;

  const queuePreviewForPath = useCallback((previewPath: string) => {
    hoverTimeoutRef.current = setTimeout(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const connectionScope = wrapperRef.current?.closest('[data-mention-connection-scope="markdown-editor"]')
        ? 'markdown-editor'
        : undefined;

      window.dispatchEvent(new CustomEvent('mention:hover-start', {
        detail: {
          path: previewPath, fragment, lineStart, lineEnd,
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
          type, sourceKey: previewSourceKey,
          path: previewPath, label: displayLabel, id: previewPath,
          mentionRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        },
      }));
    }, MENTION_PREVIEW_DELAY_MS);
  }, [displayLabel, fragment, lineEnd, lineStart, previewSourceKey, type]);

  const handleMouseEnter = useCallback(() => {
    isHoveredRef.current = true;

    if (hoverEnabled) {
      queuePreviewForPath(path);
      return;
    }

    if (!resolveHoverPath) {
      return;
    }

    void resolveHoverPath().then((resolvedPath) => {
      if (!isHoveredRef.current || !resolvedPath) {
        return;
      }

      queuePreviewForPath(resolvedPath);
    });
  }, [hoverEnabled, path, queuePreviewForPath, resolveHoverPath]);

  const handleMouseLeave = useCallback(() => {
    isHoveredRef.current = false;
    if (hoverTimeoutRef.current) { clearTimeout(hoverTimeoutRef.current); hoverTimeoutRef.current = null; }
    if (previewTimeoutRef.current) { clearTimeout(previewTimeoutRef.current); previewTimeoutRef.current = null; }
    window.dispatchEvent(new CustomEvent('mention:hover-end'));
    window.dispatchEvent(new CustomEvent(MENTION_PREVIEW_END_EVENT));
  }, []);

  useEffect(() => {
    return () => {
      isHoveredRef.current = false;
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
    };
  }, []);

  return (
    <span
      ref={wrapperRef}
      data-mention-preview-key={previewSourceKey}
      data-dangling={dangling || undefined}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="mention-node-view"
      style={dangling ? { opacity: 0.7 } : undefined}
    >
      <FileSystemProxy
        path={path}
        filename={displayLabel}
        type={type}
        variant="inline"
        dragContext={dragContext}
        onClick={onClick}
        showPath={true}
      />
      {hasRef && (
        <span className="text-muted-foreground text-[0.75em] ml-0.5 opacity-60">
          {fragment ? `#${fragment}` : lineStart != null ? `:L${lineStart}${lineEnd != null ? `-${lineEnd}` : ''}` : ''}
        </span>
      )}
    </span>
  );
}

function FileLinkMention({
  path,
  type,
  displayText,
  lineStart,
  lineEnd,
  fragment,
}: StandaloneFileLinkItem) {
  const rawDisplayLabel = (displayText && displayText.trim()) ? displayText : (pathBasename(path) || path);
  const displayLabel = getLocalReferenceDisplayLabel({
    label: rawDisplayLabel,
    path,
    itemType: type,
  });

  const handleClick = useCallback(() => {
    openMentionTarget({ path, itemType: type, fragment, lineStart, lineEnd });
  }, [path, type, fragment, lineStart, lineEnd]);

  return (
    <InlineLocalReferenceMention
      path={path}
      type={type}
      displayLabel={displayLabel}
      dragContext={`mention-${path}`}
      onClick={handleClick}
      fragment={fragment}
      lineStart={lineStart}
      lineEnd={lineEnd}
    />
  );
}

function SkillLinkMention({
  id,
  name,
  path,
  displayText,
}: {
  id: string;
  name: string;
  path: string;
  displayText: string;
}) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const [previewSourceKey] = useState(() => `mention-preview-${Math.random().toString(36).slice(2, 10)}`);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skillDirPath = useMemo(() => pathDirname(path), [path]);

  const handleMouseEnter = useCallback(() => {
    previewTimeoutRef.current = setTimeout(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      window.dispatchEvent(new CustomEvent(MENTION_PREVIEW_START_EVENT, {
        detail: {
          type: 'skill',
          sourceKey: previewSourceKey,
          id,
          label: displayText,
          description: name,
          mentionRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        },
      }));
    }, MENTION_PREVIEW_DELAY_MS);
  }, [displayText, id, name, previewSourceKey]);

  const handleMouseLeave = useCallback(() => {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    window.dispatchEvent(new CustomEvent(MENTION_PREVIEW_END_EVENT));
  }, []);

  useEffect(() => {
    return () => {
      if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
    };
  }, []);

  return (
    <span
      ref={wrapperRef}
      data-mention-preview-key={previewSourceKey}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="mention-node-view"
    >
      <FileSystemProxy
        path={skillDirPath}
        filename={displayText}
        type="directory"
        variant="inline"
        dragContext={`mention-${id}`}
        onClick={() => openMentionTarget({ path: skillDirPath, itemType: 'directory' })}
        showPath={true}
      />
    </span>
  );
}

function HoverScrollableFilename({
  text,
  isHovered,
}: {
  text: string;
  isHovered: boolean;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflowDistance, setOverflowDistance] = useState(0);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) {
      return;
    }

    setOverflowDistance(Math.max(0, inner.scrollWidth - outer.clientWidth));
  }, [text]);

  const durationMs = Math.max(2200, overflowDistance * 18);

  return (
    <div ref={outerRef} className="overflow-hidden whitespace-nowrap text-ui-sm leading-tight">
      <span
        ref={innerRef}
        className="inline-block whitespace-nowrap"
        style={{
          '--mention-filename-scroll-distance': `${overflowDistance}px`,
          animationName: isHovered && overflowDistance > 0 ? 'mention-filename-marquee' : undefined,
          animationDuration: `${durationMs}ms`,
          animationTimingFunction: 'linear',
          animationIterationCount: 'infinite',
          animationDirection: 'alternate',
        }}
      >
        {text}
      </span>
    </div>
  );
}

function getGridCardSize(count: number): { maxWidth: number; minWidth: number } {
  if (count >= 10) {
    return { maxWidth: GRID_CARD_WIDTH_COMPACT, minWidth: GRID_CARD_MIN_WIDTH_COMPACT };
  }
  if (count >= 6) {
    return { maxWidth: GRID_CARD_WIDTH_DENSE, minWidth: GRID_CARD_MIN_WIDTH_DENSE };
  }
  return { maxWidth: GRID_CARD_WIDTH, minWidth: GRID_CARD_MIN_WIDTH };
}

const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp']);

function isVideoFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

function displayNameForCollectionItem(item: StandaloneFileLinkItem): string {
  const basename = pathBasename(item.path) || item.path;
  const label = item.displayText?.trim();
  if (!label) {
    return basename;
  }

  if (/^\d+$/.test(label) || label.length <= 3) {
    return basename;
  }

  return label;
}

function FileLinkGridCard({
  item,
  thumbnailUrl,
  maxWidth,
}: {
  item: StandaloneFileLinkItem;
  thumbnailUrl: string | null;
  maxWidth: number;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const displayName = displayNameForCollectionItem(item);
  const isVideo = item.type === 'file' && isVideoFile(item.path);

  const handleClick = useCallback(() => {
    openMentionTarget({
      path: item.path,
      itemType: item.type,
      fragment: item.fragment,
      lineStart: item.lineStart,
      lineEnd: item.lineEnd,
    });
  }, [item]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void showFileReferenceContextMenu(item.path, 'markdown_file_preview');
  }, [item.path]);

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
    if (isVideo && videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  }, [isVideo]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    if (isVideo && videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, [isVideo]);

  return (
    <div
      className="mention-grid-card block max-w-full select-none"
      style={{ width: '100%', maxWidth: `${maxWidth}px`, opacity: isHovered ? 0.86 : 1 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={displayName}
    >
      <div
        className="overflow-hidden rounded-[16px]"
        style={{
          background: 'color-mix(in srgb, var(--oa-bg-input, var(--background)) 88%, var(--oa-bg-subtle, var(--hover-bg)) 12%)',
          border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 48%, transparent)',
        }}
      >
        <div
          className="relative w-full overflow-hidden"
          style={{ aspectRatio: `${FILE_MENTION_PREVIEW_WIDTH} / ${FILE_MENTION_PREVIEW_HEIGHT}` }}
        >
          {item.type === 'file' && isVideo ? (
            <>
              <video
                ref={videoRef}
                src={`file://${item.path}`}
                muted
                playsInline
                preload="metadata"
                className="h-full w-full object-cover object-top"
                style={{ display: isHovered ? 'block' : 'none' }}
              />
              {!isHovered && thumbnailUrl ? (
                <img
                  src={thumbnailUrl}
                  alt=""
                  className="h-full w-full object-cover object-top"
                  draggable={false}
                />
              ) : !isHovered ? (
                <div
                  className="flex h-full w-full items-center justify-center text-muted-foreground"
                  style={{ background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 74%, var(--oa-bg-app, var(--background)) 26%)' }}
                >
                  <FileText className="h-7 w-7" />
                </div>
              ) : null}
            </>
          ) : item.type === 'file' && thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt=""
              className="h-full w-full object-cover object-top"
              draggable={false}
            />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center text-muted-foreground"
              style={{ background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 74%, var(--oa-bg-app, var(--background)) 26%)' }}
            >
              {item.type === 'directory' ? (
                <Folder className="h-7 w-7" />
              ) : (
                <FileText className="h-7 w-7" />
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mt-1 px-1 py-1">
        <HoverScrollableFilename text={displayName} isHovered={isHovered} />
      </div>
    </div>
  );
}

const FileLink = (props: FileLinkProps) => {
  const path = props['data-path'];
  const type = props['data-type'] as 'file' | 'directory';
  const displayText = props['data-display-text'];
  const lineStart = props['data-line-start'] ? parseInt(props['data-line-start'], 10) : undefined;
  const lineEnd = props['data-line-end'] ? parseInt(props['data-line-end'], 10) : undefined;
  const fragment = props['data-fragment'];

  return (
    <FileLinkMention
      path={path}
      type={type}
      displayText={displayText}
      lineStart={lineStart}
      lineEnd={lineEnd}
      fragment={fragment}
    />
  );
};

type WikiLinkProps = {
  'data-target': string;
  'data-display'?: string;
  'data-fragment'?: string;
};

const WikiLink = (props: WikiLinkProps) => {
  const target = props['data-target'];
  const displayAttr = props['data-display'];
  const fragment = props['data-fragment'];
  const resolved = useResolvedWikilink(target || '');
  const rawVisibleLabel = (displayAttr && displayAttr.trim()) ? displayAttr : resolved.label;
  const displayLabel = getLocalReferenceDisplayLabel({
    label: rawVisibleLabel,
    path: resolved.path,
    itemType: 'file',
  });

  const handleClick = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('wikilink:open', {
      detail: {
        target,
        display: displayAttr,
        fragment,
        resolvedPath: resolved.found ? resolved.path : undefined,
      },
    }));
  }, [displayAttr, fragment, resolved.found, resolved.path, target]);

  if (!target) return null;

  return (
    <InlineLocalReferenceMention
      path={resolved.path}
      type="file"
      displayLabel={displayLabel}
      dragContext={`wikilink-${target}`}
      onClick={handleClick}
      fragment={fragment}
      hoverEnabled={resolved.found}
      dangling={!resolved.found && !resolved.isPending}
      resolveHoverPath={resolved.resolvePath}
    />
  );
};

const SkillLink = (props: SkillLinkProps) => {
  const id = props['data-id'];
  const name = props['data-name'];
  const filePath = props['data-path'];
  const displayText = props['data-display-text'] || name;

  return (
    <SkillLinkMention
      id={id}
      name={name}
      path={filePath}
      displayText={displayText}
    />
  );
};

type PastedContentProps = {
  'data-attachment-id'?: string;
};

function PastedContentChip({
  record,
}: {
  record: ComposerAttachmentRecord;
}) {
  const {
    wrapperRef,
    previewSourceKey,
    handleMouseEnter,
    handleMouseLeave,
  } = useAttachmentPreviewTrigger({
    id: record.id,
    kind: record.kind,
    label: record.label,
    mimeType: record.mimeType ?? null,
    size: record.size ?? null,
  });

  return (
    <span
      ref={wrapperRef}
      data-attachment-preview-key={previewSourceKey}
      data-attachment-kind={record.kind}
      className="composer-attachment-chip"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <AttachmentChipBody kind={record.kind} label={record.label} />
    </span>
  );
}

const FileLinkGrid = (props: {
  'data-items': string;
}) => {
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const dataItems = props['data-items'];
  const items = useMemo<StandaloneFileLinkItem[] | null>(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataItems);
    } catch {
      return null;
    }
    return Array.isArray(parsed) ? parsed : [];
  }, [dataItems]);

  useEffect(() => {
    if (!items) {
      setThumbnails({});
      return;
    }

    const filePaths = items
      .filter((item) => item.type === 'file')
      .map((item) => item.path);

    if (filePaths.length === 0) {
      setThumbnails({});
      return;
    }

    let cancelled = false;
    fetchMentionPreviewThumbnails(filePaths).then((nextThumbnails) => {
      if (!cancelled) {
        setThumbnails(nextThumbnails);
      }
    }).catch(() => {
      if (!cancelled) {
        setThumbnails({});
      }
    });

    return () => {
      cancelled = true;
    };
  }, [items]);

  if (!items || items.length === 0) {
    return null;
  }

  const { maxWidth, minWidth } = getGridCardSize(items.length);

  return (
    <div
      className="mb-3 mt-10 grid justify-start gap-3 pt-2"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))` }}
    >
      {items.map((item, index) => (
        <FileLinkGridCard
          key={`${item.path}-${item.lineStart ?? ''}-${item.lineEnd ?? ''}-${item.fragment ?? ''}-${index}`}
          item={item}
          thumbnailUrl={thumbnails[item.path] ?? null}
          maxWidth={maxWidth}
        />
      ))}
    </div>
  );
};

const FileLinkListRow = ({
  item,
  thumbnailUrl,
}: {
  item: StandaloneFileLinkItem;
  thumbnailUrl: string | null;
}) => {
  const displayName = displayNameForCollectionItem(item);
  const detailText = item.detailText?.trim();
  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void showFileReferenceContextMenu(item.path, 'markdown_file_preview');
  }, [item.path]);

  return (
    <button
      type="button"
      className="w-full"
      style={{ textAlign: 'start' }}
      onClick={() => openMentionTarget({
        path: item.path,
        itemType: item.type,
        fragment: item.fragment,
        lineStart: item.lineStart,
        lineEnd: item.lineEnd,
      })}
      onContextMenu={handleContextMenu}
      title={displayName}
    >
      <div
        className="overflow-hidden rounded-[18px] px-3 py-3 transition-opacity duration-150 hover:opacity-85"
        style={{
          background: 'color-mix(in srgb, var(--oa-bg-input, var(--background)) 90%, var(--oa-bg-subtle, var(--hover-bg)) 10%)',
          border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 48%, transparent)',
        }}
      >
        <div className="flex items-start gap-4">
          <div
            className="relative shrink-0 overflow-hidden rounded-[14px]"
            style={{
              width: 'min(34vw, 184px)',
              maxWidth: '184px',
              minWidth: '132px',
              aspectRatio: `${FILE_MENTION_PREVIEW_WIDTH} / ${FILE_MENTION_PREVIEW_HEIGHT}`,
              background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 74%, var(--oa-bg-app, var(--background)) 26%)',
            }}
          >
            {item.type === 'file' && thumbnailUrl ? (
              <img
                src={thumbnailUrl}
                alt=""
                className="h-full w-full object-cover object-top"
                draggable={false}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                {item.type === 'directory' ? (
                  <Folder className="h-8 w-8" />
                ) : (
                  <FileText className="h-8 w-8" />
                )}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1 pt-1">
            <div className="flex items-start gap-2">
              {typeof item.ordinal === 'number' ? (
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-ui-xs font-medium"
                  style={{
                    background: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 86%, var(--oa-bg-subtle, var(--hover-bg)) 14%)',
                    border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 44%, transparent)',
                    color: 'var(--oa-text-muted)',
                  }}
                >
                  {item.ordinal}
                </span>
              ) : null}
              <div className="min-w-0 text-[15px] font-medium leading-6 text-[var(--oa-text-strong)]">
                {displayName}
              </div>
            </div>
            {detailText ? (
              <div className="mt-1 whitespace-pre-wrap text-ui-sm leading-6 text-[var(--oa-text-muted)]">
                {detailText}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </button>
  );
};

const FileLinkList = (props: {
  'data-items': string;
}) => {
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const dataItems = props['data-items'];
  const items = useMemo<StandaloneFileLinkItem[] | null>(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataItems);
    } catch {
      return null;
    }
    return Array.isArray(parsed) ? parsed : [];
  }, [dataItems]);

  useEffect(() => {
    if (!items) {
      setThumbnails({});
      return;
    }

    const filePaths = items
      .filter((item) => item.type === 'file')
      .map((item) => item.path);

    if (filePaths.length === 0) {
      setThumbnails({});
      return;
    }

    let cancelled = false;
    fetchMentionPreviewThumbnails(filePaths).then((nextThumbnails) => {
      if (!cancelled) {
        setThumbnails(nextThumbnails);
      }
    }).catch(() => {
      if (!cancelled) {
        setThumbnails({});
      }
    });

    return () => {
      cancelled = true;
    };
  }, [items]);

  if (!items || items.length === 0) {
    return null;
  }

  return (
    <div className="mb-4 mt-10 space-y-3 pt-2">
      {items.map((item, index) => (
        <FileLinkListRow
          key={`${item.path}-${item.lineStart ?? ''}-${item.lineEnd ?? ''}-${item.fragment ?? ''}-${index}`}
          item={item}
          thumbnailUrl={thumbnails[item.path] ?? null}
        />
      ))}
    </div>
  );
};

const BASE_COMPONENTS: Partial<Components> & Record<string, unknown> = {
  h1: ({ className, ...props }) => (
    <h1 dir={AUTO_DIRECTION} className={cn('mb-4 scroll-m-20 text-[1.35rem] font-semibold tracking-[-0.015em] leading-tight last:mb-0', className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 dir={AUTO_DIRECTION} className={cn('mb-3 mt-6 scroll-m-20 text-[1.0625rem] font-semibold tracking-[-0.01em] first:mt-0 last:mb-0', className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 dir={AUTO_DIRECTION} className={cn('mb-2 mt-4 scroll-m-20 text-base font-medium tracking-[-0.01em] first:mt-0 last:mb-0', className)} {...props} />
  ),
  h4: ({ className, ...props }) => (
    <h4 dir={AUTO_DIRECTION} className={cn('mb-2 mt-4 scroll-m-20 text-[15px] font-medium tracking-[-0.01em] first:mt-0 last:mb-0', className)} {...props} />
  ),
  h5: ({ className, ...props }) => (
    <h5 dir={AUTO_DIRECTION} className={cn('my-2 text-[15px] font-medium first:mt-0 last:mb-0', className)} {...props} />
  ),
  h6: ({ className, ...props }) => (
    <h6 dir={AUTO_DIRECTION} className={cn('my-2 text-[14px] font-medium first:mt-0 last:mb-0', className)} {...props} />
  ),
  p: ({ className, ...props }) => (
    <div dir={AUTO_DIRECTION} className={cn('oa-thread-markdown-paragraph leading-[1.78rem] first:mt-0 last:mb-0', className)} {...props} />
  ),
  a: ({ className, href, ...props }) => (
    <a
      href={href}
      className={cn('text-foreground underline underline-offset-4 hover:opacity-70', className)}
      onClick={(e) => {
        if (!href) return;
        e.preventDefault();
        const action = resolveLinkNavigationAction(href);

        if (action.type === 'open-local') {
          openMentionTarget(action.target);
          return;
        }

        if (action.type === 'open-external') {
          void openExternal(action.url);
        }
      }}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      dir={AUTO_DIRECTION}
      className={cn('italic text-muted-foreground', className)}
      style={{
        borderInlineStart: '2px solid var(--border)',
        paddingInlineStart: '1rem',
      }}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn('my-3 list-disc [&>li]:mt-1', className)}
      style={{ marginInlineStart: '1.25rem' }}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn('my-3 list-decimal [&>li]:mt-1', className)}
      style={{ marginInlineStart: '1.25rem' }}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li dir={AUTO_DIRECTION} className={className} {...props} />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn('my-3 border-b border-border', className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className="my-3 w-full overflow-hidden">
      <table className={cn('w-full border-separate border-spacing-0 table-fixed', className)} {...props} />
    </div>
  ),
  th: ({ className, align, style, ...props }) => (
    <th
      dir={AUTO_DIRECTION}
      align={align}
      className={cn('bg-muted px-4 py-2 font-bold break-words [&[align=center]]:text-center [&[align=right]]:text-right', className)}
      style={{
        ...(align ? {} : { textAlign: 'start' }),
        ...style,
      }}
      {...props}
    />
  ),
  td: ({ className, align, style, ...props }) => (
    <td
      dir={AUTO_DIRECTION}
      align={align}
      className={cn('border-b border-border px-4 py-2 break-words [&[align=center]]:text-center [&[align=right]]:text-right', className)}
      style={{
        ...(align ? {} : { textAlign: 'start' }),
        borderInlineStart: 'var(--border-width) solid var(--border)',
        ...style,
      }}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr className={cn('m-0 border-b p-0 first:border-t', className)} {...props} />
  ),
  sup: ({ className, ...props }) => (
    <sup className={cn('[&>a]:text-ui-sm [&>a]:no-underline', className)} {...props} />
  ),
  img: ({ src, alt, className, ...props }) => {
    if (!src || src === '') return null;
    const action = resolveLinkNavigationAction(src);
    const localPath = action.type === 'open-local' ? action.target.path : null;
    return (
      <img
        src={src}
        alt={alt || ''}
        className={cn('my-3 max-w-full rounded-control', className)}
        onContextMenu={localPath ? (event) => {
          event.preventDefault();
          event.stopPropagation();
          void showFileReferenceContextMenu(localPath, 'markdown_image');
        } : undefined}
        {...props}
      />
    );
  },
  'file-link': FileLink,
  'skill-link': SkillLink,
  wikilink: WikiLink,
  'file-link-grid': FileLinkGrid,
  'file-link-list': FileLinkList,
  pre: function PreComponent({ children }) {
    return <>{children}</>;
  },
  code: function CodeComponent({ className, children, ...props }) {
    const isInline =
      !props.node?.position?.start.line ||
      props.node?.position?.start.line === props.node?.position?.end.line;

    if (isInline) {
      return (
        <code
          dir={LTR_DIRECTION}
          className={cn('rounded-[8px] px-1.5 py-0.5 font-mono text-[0.92em]', className)}
          style={{
            background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 80%, transparent)',
            border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 44%, transparent)',
          }}
        >
          {children}
        </code>
      );
    }

    const language = extractLanguage(className);
    const code = String(children).replace(/\n$/, '');
    const hasRealLanguage = className && /language-(?!unknown|text|plaintext)/.test(className);
    const displayLanguage = language && language !== 'unknown' ? language : 'text';

    return (
      <div
        className="my-3 overflow-hidden rounded-[16px]"
        style={{
          background: 'color-mix(in srgb, var(--oa-bg-input, var(--background)) 90%, var(--oa-bg-subtle, var(--hover-bg)) 10%)',
          border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 48%, transparent)',
        }}
      >
        <div className="flex items-center justify-between gap-4 px-4 pb-1.5 pt-3">
          <span className="lowercase text-ui-sm text-[var(--muted-foreground)]">{displayLanguage}</span>
          <AnimatedCopyButton text={code} label="Copy code" />
        </div>
        <pre
          dir={LTR_DIRECTION}
          className="overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words px-4 pb-4 pt-2"
        >
          <code dir={LTR_DIRECTION} className={cn(hasRealLanguage ? 'font-mono' : 'font-sans', 'text-sm', className)}>
            {code}
          </code>
        </pre>
      </div>
    );
  },
};

function MarkdownComponent({
  children,
  className,
  streaming,
  renderFileCollections = true,
}: {
  children: string;
  className?: string;
  streaming?: boolean;
  renderFileCollections?: boolean;
}) {
  const generatedId = useId();
  const content = useMemo(
    () => streaming ? healStreamingMarkdown(children) : children,
    [children, streaming],
  );
  const tokenizedContent = useMemo(
    () => tokenizePastedContent(content, generatedId),
    [content, generatedId],
  );
  const blocks = useMemo(
    () => parseMarkdownIntoBlocks(tokenizedContent.content),
    [tokenizedContent.content],
  );
  const resolvePastedContentRecord = useCallback(
    (attachmentId: string) => tokenizedContent.recordsById[attachmentId],
    [tokenizedContent.recordsById],
  );
  const components = useMemo(
    () => ({
      ...BASE_COMPONENTS,
      'pasted-content': (props: PastedContentProps) => {
        const attachmentId = props['data-attachment-id'];
        if (!attachmentId) return null;
        const record = tokenizedContent.recordsById[attachmentId];
        if (!record) return null;
        return <PastedContentChip record={record} />;
      },
    }),
    [tokenizedContent.recordsById],
  );
  const pastedContentPlugin = useMemo<RemarkPlugins[number]>(
    () => [remarkPastedContentTokens, tokenizedContent.tokenToRecordId],
    [tokenizedContent.tokenToRecordId],
  );
  const remarkPlugins = useMemo<RemarkPlugins>(
    () => renderFileCollections
      ? [remarkGfm, remarkBreaks, pastedContentPlugin, remarkSkillLinks, remarkFileLinks, remarkWikilinks, remarkStandaloneFileLinkGrids]
      : [remarkGfm, remarkBreaks, pastedContentPlugin, remarkSkillLinks, remarkFileLinks, remarkWikilinks],
    [pastedContentPlugin, renderFileCollections],
  );
  const hasPastedContent = Object.keys(tokenizedContent.recordsById).length > 0;

  return (
    <div
      className={cn('max-w-full', className)}
      style={{ '--mention-inline-margin-x': '0.3em' }}
    >
      {blocks.map((block, index) => (
        <ReactMarkdown key={`${generatedId}-${index}`} remarkPlugins={remarkPlugins} components={components}>
          {block}
        </ReactMarkdown>
      ))}
      {hasPastedContent ? (
        <AttachmentPreviewPopover resolveRecord={resolvePastedContentRecord} />
      ) : null}
    </div>
  );
}

export const Markdown = memo(MarkdownComponent);
Markdown.displayName = 'Markdown';
