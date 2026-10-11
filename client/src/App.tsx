import { useMemo, useState } from "react";
import { Whiteboard } from "./Whiteboard";
import { Cursors } from "./Cursors";
import { ConnectionStatus } from "./ConnectionStatus";
import { useYjsRoom } from "./useYjsRoom";
import { CURSOR_COLORS, randomColor } from "./types";

function getRoomFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("room") ?? "demo";
}

function getOrCreateUserName(): string {
  const existing = localStorage.getItem("whiteboard-username");
  if (existing) return existing;
  const name = `访客${Math.floor(Math.random() * 1000)}`;
  localStorage.setItem("whiteboard-username", name);
  return name;
}

export default function App() {
  const room = useMemo(getRoomFromUrl, []);
  const [userName] = useState(getOrCreateUserName);
  const [userColor] = useState(() => randomColor(CURSOR_COLORS));

  const {
    status,
    synced,
    shapes,
    peers,
    addShape,
    updateShape,
    deleteShape,
    setLocalCursor,
    setLocalSelection,
  } = useYjsRoom(room, userName, userColor);

  return (
    <div className="app">
      <header className="app-header">
        <h1>实时协作白板</h1>
        <div className="room-info">
          房间：<code>{room}</code>
          <button
            className="copy-link"
            onClick={() => {
              navigator.clipboard.writeText(window.location.href);
            }}
          >
            复制邀请链接
          </button>
        </div>
        <ConnectionStatus status={status} synced={synced} />
      </header>
      <main className="canvas-wrap">
        <Whiteboard
          shapes={shapes}
          onAddShape={addShape}
          onUpdateShape={updateShape}
          onDeleteShape={deleteShape}
          onCursorMove={setLocalCursor}
          onSelect={setLocalSelection}
        />
        <Cursors peers={peers} />
      </main>
    </div>
  );
}
