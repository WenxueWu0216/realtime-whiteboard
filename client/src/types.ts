export type ShapeType = "rect" | "sticky" | "ellipse";

export interface ShapeData {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  text?: string;
  rotation?: number;
  // clientID of whoever last touched this shape - purely informational,
  // not used for conflict resolution (Yjs handles that internally).
  lastEditedBy?: number;
}

export interface CursorState {
  name: string;
  color: string;
  x: number | null;
  y: number | null;
  selectedShapeId: string | null;
}

export const SHAPE_COLORS = [
  "#f97316", // orange
  "#ef4444", // red
  "#22c55e", // green
  "#3b82f6", // blue
  "#a855f7", // purple
  "#facc15", // yellow
];

export const CURSOR_COLORS = [
  "#f97316",
  "#ef4444",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
];

export function randomColor(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}
