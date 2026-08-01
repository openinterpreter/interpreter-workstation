import { useDndContext, useTreeApi } from "../context";
import { DefaultDragPreview } from "./default-drag-preview";

export function DragPreviewContainer() {
  const tree = useTreeApi();
  const dndState = useDndContext();
  
  const isDragging = dndState.dragId !== null;
  const DragPreview = tree.props.renderDragPreview || DefaultDragPreview;

  return (
    <DragPreview
      offset={null}
      mouse={null}
      id={dndState.dragId}
      dragIds={dndState.dragIds}
      isDragging={isDragging}
    />
  );
}
