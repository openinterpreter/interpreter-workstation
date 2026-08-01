import { RefObject, useEffect } from "react";
import { useTreeApi } from "../context";
import { NodeApi } from "../interfaces/node-api";
import { DragItem } from "../types/dnd";
import { actions as dnd } from "../state/dnd-slice";

export type DragRefCallback = (el: HTMLElement | null) => void;

export function useDragHook<T>(
  el: RefObject<HTMLElement | null>,
  node: NodeApi<T>
): DragRefCallback {
  "use no memo";

  const tree = useTreeApi();

  useEffect(() => {
    const element = el.current;
    if (!element) return;

    element.draggable = node.isDraggable;

    const handleDragStart = (e: DragEvent) => {
      if (!node.isDraggable) {
        e.preventDefault();
        return;
      }

      const ids = tree.selectedIds;
      const dragIds = tree.isSelected(node.id) ? Array.from(ids) : [node.id];
      tree.dispatch(dnd.dragStart(node.id, dragIds));

      const dragData: DragItem = { id: node.id, dragIds };
      e.dataTransfer?.setData("application/x-tree-node", JSON.stringify(dragData));
      e.dataTransfer?.setData("text/plain", node.id);

      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
      }
    };

    const handleDragEnd = () => {
      tree.hideCursor();
      tree.dispatch(dnd.dragEnd());
    };

    element.addEventListener("dragstart", handleDragStart);
    element.addEventListener("dragend", handleDragEnd);

    return () => {
      element.removeEventListener("dragstart", handleDragStart);
      element.removeEventListener("dragend", handleDragEnd);
    };
  }, [node.id, node.isDraggable, tree]);

  return (handleEl: HTMLElement | null) => {
    if (handleEl) {
      handleEl.draggable = node.isDraggable;
    }
  };
}
