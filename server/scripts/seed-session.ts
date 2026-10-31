/**
 * Generates a recorded editing session on a running server so there is
 * something to replay. Several simulated editors add / move / recolor shapes
 * over real WebSocket connections.
 *
 *   npx tsx scripts/seed-session.ts --url ws://localhost:1234 --room demo --ops 600 --editors 3 --gap 30
 */
import { parseArgs } from "node:util";
import WS from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "ws://localhost:1234" },
    room: { type: "string", default: "demo" },
    ops: { type: "string", default: "600" },
    editors: { type: "string", default: "3" },
    gap: { type: "string", default: "30" },
  },
});
const N = Number(values.ops);
const E = Number(values.editors);
const GAP = Number(values.gap);
const COLORS = ["#f97316", "#ef4444", "#22c55e", "#3b82f6", "#a855f7", "#facc15"];

const editors = Array.from({ length: E }, () => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(values.url!, values.room!, doc, {
    WebSocketPolyfill: WS as unknown as typeof WebSocket,
  });
  return { doc, provider, shapes: doc.getMap<Record<string, unknown>>("shapes") };
});

await Promise.all(editors.map((e) => new Promise<void>((r) => (e.provider.synced ? r() : e.provider.once("sync", () => r())))));

for (let i = 0; i < N; i++) {
  const e = editors[i % E];
  const ids = Array.from(e.shapes.keys());
  const r = Math.random();
  if (ids.length < 4 || r < 0.12) {
    const id = `seed-${i}`;
    const type = ["rect", "ellipse", "sticky"][i % 3];
    e.shapes.set(id, {
      id,
      type,
      x: 60 + Math.random() * 1100,
      y: 60 + Math.random() * 650,
      width: type === "sticky" ? 160 : 120,
      height: type === "sticky" ? 120 : 90,
      fill: COLORS[i % COLORS.length],
      text: type === "sticky" ? `note ${i}` : undefined,
    });
  } else if (r < 0.97) {
    // drag: move a shape a little (most real ops are drags)
    const id = ids[Math.floor(Math.random() * ids.length)];
    const cur = e.shapes.get(id)! as { x: number; y: number };
    e.shapes.set(id, {
      ...cur,
      x: Math.max(0, Math.min(1250, cur.x + (Math.random() - 0.5) * 80)),
      y: Math.max(0, Math.min(780, cur.y + (Math.random() - 0.5) * 80)),
    });
  } else {
    e.shapes.delete(ids[Math.floor(Math.random() * ids.length)]);
  }
  await new Promise((res) => setTimeout(res, GAP));
}

await new Promise((r) => setTimeout(r, 500));
console.log(`seeded ${N} ops into room "${values.room}" (${editors[0].shapes.size} shapes)`);
editors.forEach((e) => e.provider.destroy());
process.exit(0);
