import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { useDataUpdates, useNodesContext, useTreeApi } from "../context";
import { useDragHook } from "../dnd/drag-hook";
import { useDropHook } from "../dnd/drop-hook";
import { useFreshNode } from "../hooks/use-fresh-node";

type Props = {
  style: React.CSSProperties;
  index: number;
};

export const RowContainer = React.memo(function RowContainer<T>({
  index,
  style,
}: Props) {
  useDataUpdates();
  useNodesContext();
  const tree = useTreeApi<T>();
  const node = useFreshNode<T>(index);

  const el = useRef<HTMLDivElement | null>(null);
  const dragHandle = useDragHook<T>(el, node);
  useDropHook(el, node);

  const innerRef = useCallback(
    (n: HTMLDivElement | null) => {
      el.current = n;
    },
    []
  );

  const indent = tree.indent * node.level;
  const nodeStyle = useMemo(() => ({ paddingLeft: indent }), [indent]);
  const rowStyle = useMemo(
    () => ({
      ...style,
      top:
        parseFloat(style.top as string) +
        (tree.props.padding ?? tree.props.paddingTop ?? 0),
    }),
    [style, tree.props.padding, tree.props.paddingTop]
  );
  const rowAttrs: React.HTMLAttributes<any> = {
    role: "treeitem",
    "aria-level": node.level + 1,
    "aria-selected": node.isSelected,
    "aria-expanded": node.isOpen,
    style: rowStyle,
    tabIndex: -1,
    className: tree.props.rowClassName,
  };

  useEffect(() => {
    if (!node.isEditing && node.isFocused) {
      el.current?.focus({ preventScroll: true });
    }
  }, [node.isEditing, node.isFocused, el.current]);

  const Node = tree.renderNode;
  const Row = tree.renderRow;

  return (
    <Row node={node} innerRef={innerRef} attrs={rowAttrs}>
      <Node node={node} tree={tree} style={nodeStyle} dragHandle={dragHandle} />
    </Row>
  );
});
