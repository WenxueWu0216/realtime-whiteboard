import { useRef, useState } from "react";
import { Stage, Layer, Rect, Ellipse, Text, Group } from "react-konva";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { ShapeData, ShapeType } from "./types";
import { SHAPE_COLORS, randomColor } from "./types";

interface WhiteboardProps {
  shapes: Record<string, ShapeData>;
  onAddShape: (shape: ShapeData) => void;
  onUpdateShape: (id: string, patch: Partial<ShapeData>) => void;
  onDeleteShape: (id: string) => void;
  onCursorMove: (x: number | null, y: number | null) => void;
  onSelect: (id: string | null) => void;
}

const STAGE_WIDTH = 1400;
const STAGE_HEIGHT = 900;

export function Whiteboard({
  shapes,
  onAddShape,
  onUpdateShape,
  onDeleteShape,
  onCursorMove,
  onSelect,
}: WhiteboardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stageRef = useRef<Konva.Stage>(null);

  const select = (id: string | null) => {
    setSelectedId(id);
    onSelect(id);
  };

  const handleStageMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    const pos = e.target.getStage()?.getPointerPosition();
    onCursorMove(pos?.x ?? null, pos?.y ?? null);
  };

  const handleStageMouseLeave = () => onCursorMove(null, null);

  const handleStageClick = (e: KonvaEventObject<MouseEvent>) => {
    if (e.target === e.target.getStage()) select(null);
  };

  const addShape = (type: ShapeType) => {
    const id = crypto.randomUUID();
    const base: ShapeData = {
      id,
      type,
      x: 80 + Math.random() * 300,
      y: 80 + Math.random() * 200,
      width: type === "sticky" ? 160 : 120,
      height: type === "sticky" ? 120 : 90,
      fill: randomColor(SHAPE_COLORS),
      text: type === "sticky" ? "便签" : undefined,
    };
    onAddShape(base);
    select(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
      onDeleteShape(selectedId);
      select(null);
    }
  };

  return (
    <div className="whiteboard-root" tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="toolbar">
        <button onClick={() => addShape("rect")}>+ 矩形</button>
        <button onClick={() => addShape("ellipse")}>+ 圆形</button>
        <button onClick={() => addShape("sticky")}>+ 便签</button>
        {selectedId && (
          <button className="danger" onClick={() => { onDeleteShape(selectedId); select(null); }}>
            删除选中
          </button>
        )}
        <span className="hint">拖拽移动 · Delete 键删除 · {Object.keys(shapes).length} 个图形</span>
      </div>
      <Stage
        ref={stageRef}
        width={STAGE_WIDTH}
        height={STAGE_HEIGHT}
        onMouseMove={handleStageMouseMove}
        onMouseLeave={handleStageMouseLeave}
        onClick={handleStageClick}
        className="konva-stage"
      >
        <Layer>
          {Object.values(shapes).map((shape) => (
            <ShapeNode
              key={shape.id}
              shape={shape}
              isSelected={shape.id === selectedId}
              onSelect={() => select(shape.id)}
              onChange={(patch) => onUpdateShape(shape.id, patch)}
            />
          ))}
        </Layer>
      </Stage>
    </div>
  );
}

function ShapeNode({
  shape,
  isSelected,
  onSelect,
  onChange,
}: {
  shape: ShapeData;
  isSelected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<ShapeData>) => void;
}) {
  const stroke = isSelected ? "#111827" : undefined;
  const strokeWidth = isSelected ? 3 : 0;

  const commonProps = {
    x: shape.x,
    y: shape.y,
    draggable: true,
    onClick: onSelect,
    onTap: onSelect,
    onDragEnd: (e: KonvaEventObject<DragEvent>) =>
      onChange({ x: e.target.x(), y: e.target.y() }),
    stroke,
    strokeWidth,
  };

  if (shape.type === "ellipse") {
    return (
      <Ellipse
        {...commonProps}
        radiusX={shape.width / 2}
        radiusY={shape.height / 2}
        x={shape.x + shape.width / 2}
        y={shape.y + shape.height / 2}
        fill={shape.fill}
        onDragEnd={(e) =>
          onChange({ x: e.target.x() - shape.width / 2, y: e.target.y() - shape.height / 2 })
        }
      />
    );
  }

  if (shape.type === "sticky") {
    return (
      <Group {...commonProps}>
        <Rect width={shape.width} height={shape.height} fill={shape.fill} shadowBlur={4} cornerRadius={2} />
        <Text
          text={shape.text ?? ""}
          width={shape.width}
          height={shape.height}
          padding={10}
          fontSize={16}
          align="center"
          verticalAlign="middle"
          onDblClick={() => {
            const next = window.prompt("便签内容", shape.text ?? "");
            if (next !== null) onChange({ text: next });
          }}
        />
      </Group>
    );
  }

  return <Rect {...commonProps} width={shape.width} height={shape.height} fill={shape.fill} cornerRadius={4} />;
}
