import { RefObject, useEffect } from "react";
import { useTreeApi } from "../context";
import { NodeApi } from "../interfaces/node-api";
import { computeDrop } from "./compute-drop";
import { actions as dnd } from "../state/dnd-slice";
import { safeRun } from "../utils";
import { ROOT_ID } from "../data/create-root";

export type DropResult = {
  parentId: string | null;
  index: number | null;
};

export function useDropHook(
  el: RefObject<HTMLElement | null>,
  node: NodeApi<any>,
): void {
  "use no memo";

  const tree = useTreeApi();

  useEffect(() => {
    const element = el.current;
    if (!element) return;

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const offset = { x: e.clientX, y: e.clientY };
      const { cursor, drop } = computeDrop({
        element,
        offset,
        indent: tree.indent,
        node,
        prevNode: node.prev,
        nextNode: node.next,
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

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (!tree.canDrop()) return;

      const { parentId, index, dragIds } = tree.state.dnd;

      // Parse external drop data (from tabs or other sources) if no internal dragIds
      let externalData: { type: string; filePath: string; fileName: string; isDirectory: boolean } | null = null;
      if (dragIds.length === 0 && e.dataTransfer) {
        try {
          const jsonData = e.dataTransfer.getData('application/json');
          if (jsonData) {
            const parsed = JSON.parse(jsonData);
            if (parsed.type === 'file' && parsed.filePath) {
              externalData = parsed;
            }
          }
        } catch {
          // Ignore parse errors
        }
      }

      safeRun(tree.props.onMove, {
        dragIds,
        parentId: parentId === ROOT_ID ? null : parentId,
        index: index === null ? 0 : index,
        dragNodes: tree.dragNodes,
        parentNode: tree.get(parentId),
        externalData,
      });
      tree.open(parentId);
    };

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
    };

    // NOTE(victor): Clear hover state when any drag ends - handles external drags (from tabs)
    // that don't dispatch dragEnd through normal flow
    const handleDocumentDragEnd = () => {
      tree.dispatch(dnd.hovering(null, null));
      tree.hideCursor();
    };

    element.addEventListener("dragover", handleDragOver);
    element.addEventListener("drop", handleDrop);
    element.addEventListener("dragenter", handleDragEnter);
    element.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("dragend", handleDocumentDragEnd);

    return () => {
      element.removeEventListener("dragover", handleDragOver);
      element.removeEventListener("drop", handleDrop);
      element.removeEventListener("dragenter", handleDragEnter);
      element.removeEventListener("dragleave", handleDragLeave);
      document.removeEventListener("dragend", handleDocumentDragEnd);
    };
  }, [node, el.current, tree]);
}
