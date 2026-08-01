export type CursorLocation = {
  index: number | null;
  level: number | null;
  parentId: string | null;
};

export type XYCoord = {
  x: number;
  y: number;
};

export type DragItem = {
  id: string;
  dragIds: string[];
};
