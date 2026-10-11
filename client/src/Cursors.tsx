import type { CursorState } from "./types";

interface CursorsProps {
  peers: Map<number, CursorState>;
}

/**
 * Renders every other participant's cursor as a plain absolutely-positioned
 * overlay in front of the canvas (not drawn inside Konva) - awareness state
 * changes far more often than shapes and doesn't need to participate in
 * Konva's own redraw/hit-testing, so keeping it in the DOM layer is both
 * simpler and cheaper.
 */
export function Cursors({ peers }: CursorsProps) {
  return (
    <div className="cursors-overlay">
      {Array.from(peers.entries()).map(([clientId, state]) => {
        if (state.x === null || state.y === null) return null;
        return (
          <div
            key={clientId}
            className="cursor"
            style={{ transform: `translate(${state.x}px, ${state.y}px)` }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20">
              <path d="M2 2 L18 9 L10 11 L8 18 Z" fill={state.color} stroke="white" strokeWidth="1" />
            </svg>
            <span className="cursor-label" style={{ background: state.color }}>
              {state.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
