/**
 * RefMentionNodeView
 *
 * Renders a block output reference or constant as an inline chip.
 * Constants show both the name and their resolved value (e.g. workspace · /Users/.../project).
 */

import { NodeViewWrapper } from '@tiptap/react';

export function RefMentionNodeView({ node, deleteNode }: any) {
  if (!node?.attrs) return null;

  const { label, id, blockId, resolvedValue } = node.attrs;
  const isConstant = blockId === '__constants__';

  return (
    <NodeViewWrapper as="span" style={{ display: 'inline' }}>
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-foreground text-ui-xs font-mono"
        style={{
          border: 'var(--border-width) solid var(--border)',
          verticalAlign: 'middle',
          marginTop: '-0.2em',
          marginBottom: '-0.1em',
        }}
        title={resolvedValue || id}
      >
        {isConstant ? (
          <>
            <span>{label || id}</span>
            {resolvedValue && (
              <span className="text-muted-foreground" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
                {resolvedValue}
              </span>
            )}
          </>
        ) : (
          <span>{label || id}</span>
        )}
        <button
          className="text-muted-foreground hover:text-foreground ml-0.5 text-ui-xs leading-none"
          onClick={deleteNode}
          contentEditable={false}
        >
          ×
        </button>
      </span>
    </NodeViewWrapper>
  );
}
