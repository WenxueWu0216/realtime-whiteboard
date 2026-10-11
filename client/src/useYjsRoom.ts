import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { CursorState, ShapeData } from "./types";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

const SERVER_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:1234";

interface RoomHandle {
  doc: Y.Doc;
  provider: WebsocketProvider;
  shapesMap: Y.Map<ShapeData>;
}

/**
 * Owns one room's Y.Doc + WebsocketProvider for the lifetime of the
 * component tree that uses it, and re-renders whenever the shared `shapes`
 * map or the other participants' awareness state changes.
 *
 * This is the entire "sync" layer as far as the UI is concerned: components
 * read `shapes`/`peers` and call `updateShape`/`setLocalCursor` - they never
 * touch the WebSocket or think about merge conflicts. That's the CRDT value
 * proposition: local writes are immediate and always succeed, and eventual
 * consistency with everyone else is Yjs's problem, not the component's.
 *
 * The doc/provider are created inside the effect (not in render, e.g. via
 * useMemo) on purpose: React 18 StrictMode intentionally double-invokes
 * render in dev to surface exactly this class of bug, and a WebSocket
 * connection opened as a side effect of a throwaway render leaks a
 * half-open socket that never gets cleaned up. Effects, unlike render, are
 * guaranteed a matching setup/cleanup pair even under StrictMode.
 */
export function useYjsRoom(roomName: string, userName: string, userColor: string) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [synced, setSynced] = useState(false);
  const [shapes, setShapes] = useState<Record<string, ShapeData>>({});
  const [peers, setPeers] = useState<Map<number, CursorState>>(new Map());
  const [localClientId, setLocalClientId] = useState<number | null>(null);

  const roomRef = useRef<RoomHandle | null>(null);
  const userRef = useRef({ userName, userColor });
  userRef.current = { userName, userColor };

  useEffect(() => {
    const doc = new Y.Doc();
    const shapesMap = doc.getMap<ShapeData>("shapes");
    const provider = new WebsocketProvider(SERVER_URL, roomName, doc);
    const room: RoomHandle = { doc, provider, shapesMap };
    roomRef.current = room;
    setLocalClientId(doc.clientID);
    setStatus("connecting");
    setSynced(false);
    setShapes({});
    setPeers(new Map());

    provider.awareness.setLocalState({
      name: userRef.current.userName,
      color: userRef.current.userColor,
      x: null,
      y: null,
      selectedShapeId: null,
    } satisfies CursorState);

    const syncShapes = () => setShapes({ ...(shapesMap.toJSON() as Record<string, ShapeData>) });
    syncShapes();
    shapesMap.observe(syncShapes);

    const syncAwareness = () => {
      const next = new Map<number, CursorState>();
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === doc.clientID) return; // don't render our own cursor
        if (state && typeof state === "object" && "name" in state) {
          next.set(clientId, state as CursorState);
        }
      });
      setPeers(next);
    };
    syncAwareness();
    provider.awareness.on("change", syncAwareness);

    const onStatus = ({ status }: { status: ConnectionStatus }) => setStatus(status);
    const onSync = (isSynced: boolean) => setSynced(isSynced);
    provider.on("status", onStatus);
    provider.on("sync", onSync);

    return () => {
      shapesMap.unobserve(syncShapes);
      provider.awareness.off("change", syncAwareness);
      provider.off("status", onStatus);
      provider.off("sync", onSync);
      provider.disconnect();
      provider.destroy();
      doc.destroy();
      if (roomRef.current === room) roomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- userName/userColor are read via userRef, not re-run per keystroke
  }, [roomName]);

  const addShape = (shape: ShapeData) => {
    const room = roomRef.current;
    if (!room) return;
    room.doc.transact(() => {
      room.shapesMap.set(shape.id, shape);
    });
  };

  const updateShape = (id: string, patch: Partial<ShapeData>) => {
    const room = roomRef.current;
    if (!room) return;
    const current = room.shapesMap.get(id);
    if (!current) return;
    room.doc.transact(() => {
      room.shapesMap.set(id, { ...current, ...patch, lastEditedBy: room.doc.clientID });
    });
  };

  const deleteShape = (id: string) => {
    const room = roomRef.current;
    if (!room) return;
    room.doc.transact(() => {
      room.shapesMap.delete(id);
    });
  };

  // Cursor broadcasts are throttled to animation-frame rate: awareness
  // updates don't go through the CRDT history (cheap), but at 60fps of raw
  // mousemove events they'd still be the majority of WebSocket traffic in a
  // busy room, so we coalesce to one update per frame.
  const rafRef = useRef<number | null>(null);
  const pendingCursorRef = useRef<{ x: number | null; y: number | null } | null>(null);
  const setLocalCursor = (x: number | null, y: number | null) => {
    pendingCursorRef.current = { x, y };
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const pending = pendingCursorRef.current;
      const room = roomRef.current;
      if (!pending || !room) return;
      const current = room.provider.awareness.getLocalState() as CursorState | null;
      room.provider.awareness.setLocalState({
        name: userRef.current.userName,
        color: userRef.current.userColor,
        selectedShapeId: current?.selectedShapeId ?? null,
        ...pending,
      });
    });
  };

  const setLocalSelection = (shapeId: string | null) => {
    const room = roomRef.current;
    if (!room) return;
    const current = room.provider.awareness.getLocalState() as CursorState | null;
    room.provider.awareness.setLocalState({
      name: userRef.current.userName,
      color: userRef.current.userColor,
      x: current?.x ?? null,
      y: current?.y ?? null,
      selectedShapeId: shapeId,
    });
  };

  return {
    status,
    synced,
    shapes,
    peers,
    addShape,
    updateShape,
    deleteShape,
    setLocalCursor,
    setLocalSelection,
    localClientId,
  };
}
