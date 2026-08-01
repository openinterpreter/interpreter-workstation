import { useEffect } from "react";
import { useTreeApi } from "../context";
import { computeDrop } from "./compute-drop";
import { actions as dnd } from "../state/dnd-slice";

export function useOuterDrop() {
  const tree = useTreeApi();

  useEffect(() => {
    const element = tree.listEl.current;
    if (!element) return;

    const handleDragOver = (e: DragEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[role="treeitem"]')) {
        return;
      }

      e.preventDefault();

      const offset = { x: e.clientX, y: e.clientY };
      const { cursor, drop } = computeDrop({
        element,
        offset,
        indent: tree.indent,
        node: null,
        prevNode: tree.visibleNodes[tree.visibleNodes.length - 1],
        nextNode: null,
      });

      if (drop) {
        tree.dispatch(dnd.hovering(drop.parentId, drop.index));
      }

      if (tree.canDrop()) {
        if (cursor) tree.showCursor(cursor);
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = "move";
        }
      } else {
        tree.hideCursor();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = "none";
        }
      }
    };

    element.addEventListener("dragover", handleDragOver);

    return () => {
      element.removeEventListener("dragover", handleDragOver);
    };
  }, [tree]);
}
