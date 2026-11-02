/**
 * Edit-to-peer sync latency with N concurrent editors in one room.
 *
 * Every editor is a real y-websocket client (same library the browser uses).
 * Each edit embeds a send timestamp; every *other* editor records
 * receive_time - send_time when the change is applied to its doc. All clients
 * live in this one process, so they share one monotonic clock and no clock
 * sync is needed. One edit with 10 editors = 9 latency samples.
 *
 *   npx tsx loadtest/sync-latency.ts --urls ws://localhost:1234 --editors 10 --rate 10 --duration 30
 *   # editors spread across two pods (adds the Redis pub/sub hop for most pairs):
 *   npx tsx loadtest/sync-latency.ts --urls ws://localhost:1234,ws://localhost:1235
 */
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import WS from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

const { values } = parseArgs({
  options: {
    urls: { type: "string", default: "ws://localhost:1234" },
    editors: { type: "string", default: "10" },
    rate: { type: "string", default: "10" }, // edits per second per editor
    duration: { type: "string", default: "30" }, // seconds
    warmup: { type: "string", default: "3" },
    room: { type: "string", default: `latency-${Date.now()}` },
    json: { type: "boolean", default: false },
  },
});

const urls = values.urls!.split(",");
const E = Number(values.editors);
const RATE = Number(values.rate);
const DURATION = Number(values.duration) * 1000;
const WARMUP = Number(values.warmup) * 1000;

interface Edit {
  by: number;
  n: number;
  t: number;
  x: number;
  y: number;
}

const samples: number[] = [];
const received = new Map<string, number>(); // "by:n" -> how many peers got it
let sent = 0;
let measuring = false;

const editors = Array.from({ length: E }, (_, i) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(urls[i % urls.length], values.room!, doc, {
    WebSocketPolyfill: WS as unknown as typeof WebSocket,
    disableBc: true,
  });
  const shapes = doc.getMap<Edit>("shapes");
  shapes.observe((ev) => {
    if (ev.transaction.local) return;
    const now = performance.now();
    for (const key of ev.keysChanged) {
      const e = shapes.get(key);
      if (!e || e.by === i || e.t < 0) continue;
      if (measuring) {
        samples.push(now - e.t);
        const id = `${e.by}:${e.n}`;
        received.set(id, (received.get(id) ?? 0) + 1);
      }
    }
  });
  return { doc, provider, shapes, n: 0 };
});

await Promise.all(
  editors.map((e) => new Promise<void>((r) => (e.provider.synced ? r() : e.provider.once("sync", () => r())))),
);

const sentIds: string[] = [];
const timers = editors.map((e, i) =>
  setInterval(
    () => {
      const n = ++e.n;
      // each editor drags its own shape (like a real user moving an object)
      e.shapes.set(`shape-${i}`, { by: i, n, t: performance.now(), x: n % 1000, y: i * 50 });
      if (measuring) {
        sent++;
        sentIds.push(`${i}:${n}`);
      }
    },
    1000 / RATE,
  ),
);

await new Promise((r) => setTimeout(r, WARMUP));
measuring = true;
await new Promise((r) => setTimeout(r, DURATION));
measuring = false;
timers.forEach(clearInterval);
await new Promise((r) => setTimeout(r, 1000)); // let in-flight deliveries land

const s = [...samples].sort((a, b) => a - b);
const q = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
// An edit can be superseded by the same editor's next edit before a peer
// applies it (Yjs merges them), so "missing" counts are expected to be ~0
// at these rates but are reported, not hidden.
const incomplete = sentIds.filter((id) => (received.get(id) ?? 0) < E - 1).length;
const result = {
  editors: E,
  pods: urls.length,
  ratePerEditor: RATE,
  durationS: DURATION / 1000,
  edits: sent,
  samples: s.length,
  incompleteEdits: incomplete,
  p50: +q(50).toFixed(2),
  p90: +q(90).toFixed(2),
  p99: +q(99).toFixed(2),
  max: +(s[s.length - 1] ?? NaN).toFixed(2),
  mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
};
if (values.json) console.log(JSON.stringify(result));
else {
  console.log(`room=${values.room} editors=${E} pods=${urls.length} rate=${RATE}/s/editor duration=${DURATION / 1000}s`);
  console.log(`edits=${sent} latency samples=${s.length} edits not seen by every peer=${incomplete}`);
  console.log(`edit -> peer latency ms: p50=${result.p50} p90=${result.p90} p99=${result.p99} max=${result.max} mean=${result.mean}`);
}
editors.forEach((e) => e.provider.destroy());
process.exit(0);
