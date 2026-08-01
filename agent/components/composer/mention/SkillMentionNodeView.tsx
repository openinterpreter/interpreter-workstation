/**
 * SkillMentionNodeView Component
 *
 * Renders instruction skill mentions as inline chips in the composer.
 * Uses Tiptap's ReactNodeViewRenderer.
 */

import { NodeViewWrapper } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pathDirname } from '@/ipc';
import { FileSystemProxy } from '../../../../src/components/FileSystemProxy';
import { MENTION_NODE_VIEW_CLASS } from '../../../../shared/element-ids';
import { MENTION_PREVIEW_DELAY_MS, MENTION_PREVIEW_END_EVENT, MENTION_PREVIEW_START_EVENT } from '../../../../shared/types/mentionPreview';
import { humanizeSkillName } from '../../../../shared/utils/skillDisplay';
import { openMentionTarget } from '../../mentions/openMentionTarget';
import { getSkillItemById } from './skillMentionSuggestion';

export function SkillMentionNodeView({ node, deleteNode }: any) {
  const { id, label, path, description } = node?.attrs ?? {};
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const [previewSourceKey] = useState(() => `mention-preview-${Math.random().toString(36).slice(2, 10)}`);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hoverDescription = useMemo(() => {
    const fromNode = typeof description === 'string' ? description.trim() : '';
    if (fromNode) return fromNode;
    const fromRegistry = getSkillItemById(id)?.description?.trim();
    if (fromRegistry) return fromRegistry;
    return '';
  }, [id, description]);
  const displayLabel = useMemo(() => humanizeSkillName(label), [label]);
  const skillDirPath = useMemo(() => {
    if (typeof path !== 'string' || !path.trim()) {
      return '';
    }
    return pathDirname(path);
  }, [path]);

  const handleMouseEnter = useCallback(() => {
    previewTimeoutRef.current = setTimeout(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      window.dispatchEvent(new CustomEvent(MENTION_PREVIEW_START_EVENT, {
          detail: {
            type: 'skill',
            sourceKey: previewSourceKey,
            id,
            label,
            description: hoverDescription,
          mentionRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        },
      }));
    }, MENTION_PREVIEW_DELAY_MS);
  }, [id, label, hoverDescription, previewSourceKey]);

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

  if (!node?.attrs) {
    return null;
  }

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
        path={skillDirPath || undefined}
        filename={displayLabel}
        type="directory"
        variant="inline"
        dragContext={`mention-${id}`}
        onClick={() => openMentionTarget({ path: skillDirPath, itemType: 'directory' })}
        onRemove={deleteNode}
        showPath={true}
        showTooltip={false}
        className="cursor-default select-none align-baseline"
      />
    </NodeViewWrapper>
  );
}
