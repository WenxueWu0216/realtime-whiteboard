/**
 * Ramps WebSocket connections against ONE server instance (one "pod") to
 * find its connection limit, while a probe room of 10 real y-websocket
 * editors measures edit-to-peer sync latency at every step.
 *
 * Load model (configurable):
 *   - connections are grouped into rooms of --room-size (default 10)
 *   - every connection completes the y-websocket sync handshake and then
 *     sends one small doc edit (a shape move) every --edit-interval ms
 *     (default 5000 ms = 0.2 edits/s/conn, each fanned out to the room)
 *   - --edit-interval 0 = idle connections (pure connection capacity)
 *
 * The limit is the first step at which ANY of these hold:
 *   - probe p99 > --p99-limit ms (default 100)
 *   - more than 1% of attempted connections failed / were dropped
 *   - the server stops answering /healthz
 *
 *   npx tsx loadtest/conn-ramp.ts --url ws://localhost:1234 --step 1000 --max 20000 --workers 3
 */
import { fork, type ChildProcess } from "node:child_process";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WS from "ws";
import { WebsocketProvider } from "y-websocket";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "ws://localhost:1234" },
    "http-url": { type: "string" },
    step: { type: "string", default: "1000" },
    max: { type: "string", default: "20000" },
    workers: { type: "string", default: "3" },
    "room-size": { type: "string", default: "10" },
    "edit-interval": { type: "string", default: "5000" },
    "settle-s": { type: "string", default: "5" },
    "measure-s": { type: "string", default: "15" },
    "p99-limit": { type: "string", default: "100" },
    "connect-rate": { type: "string", default: "500" }, // new connections per second per worker
    worker: { type: "string" }, // internal
    json: { type: "string" }, // write results JSON to this path
    docker: { type: "string" }, // container name of the server: sample its CPU% with `docker stats`
  },
});

// ---------------------------------------------------------------- worker ---
if (values.worker !== undefined) {
  const workerId = Number(values.worker);
  const ROOM = Number(values["room-size"]);
  const EDIT_MS = Number(values["edit-interval"]);
  const RATE = Number(values["connect-rate"]);
  let open = 0;
  let failed = 0;
  let dropped = 0;
  let received = 0;
  let index = 0;
  const conns: { ws: WS; timer?: ReturnType<typeof setInterval> }[] = [];

  const connectOne = () => {
    const i = index++;
    // Rooms are shared across workers: global connection number -> room.
    const global = i * Number(process.env.WORKERS) + workerId;
    const room = `ramp-${Math.floor(global / ROOM)}`;
    // Spread source addresses over 127.0.0.0/8 so we don't run out of
    // ephemeral ports (~28k per source IP) at high connection counts.
    const localAddress = `127.0.${1 + (global % 200)}.${1 + workerId}`;
    const ws = new WS(`${values.url}/${room}`, { localAddress, perMessageDeflate: false });
    ws.binaryType = "arraybuffer";
    const doc = new Y.Doc();
    const shapes = doc.getMap<Record<string, number>>("shapes");
    const c: (typeof conns)[number] = { ws };
    conns.push(c);
    let wasOpen = false;
    ws.on("open", () => {
      wasOpen = true;
      open++;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, doc);
      ws.send(encoding.toUint8Array(enc));
      if (EDIT_MS > 0) {
        doc.on("update", (u: Uint8Array) => {
          if (ws.readyState !== ws.OPEN) return;
          const e = encoding.createEncoder();
          encoding.writeVarUint(e, 0);
          syncProtocol.writeUpdate(e, u);
          ws.send(encoding.toUint8Array(e));
        });
        // random phase so edits are spread evenly over the interval
        setTimeout(() => {
          c.timer = setInterval(() => shapes.set(`s${global}`, { x: Math.random() * 1000, y: Math.random() * 800 }), EDIT_MS);
        }, Math.random() * EDIT_MS);
      }
    });
    ws.on("message", (data: ArrayBuffer) => {
      received++;
      // Answer the server's sync step 1 so the handshake completes; we
      // deliberately don't apply incoming updates (keeps the generator cheap).
      const dec = decoding.createDecoder(new Uint8Array(data));
      if (decoding.readVarUint(dec) !== 0) return;
      if (decoding.readVarUint(dec) !== 0) return; // only step1
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep2(enc, doc, decoding.readVarUint8Array(dec));
      ws.send(encoding.toUint8Array(enc));
    });
    ws.on("error", () => {
      if (!wasOpen) failed++;
    });
    ws.on("close", () => {
      if (c.timer) clearInterval(c.timer);
      if (wasOpen) {
        open--;
        dropped++;
      }
    });
  };

  let target = 0;
  setInterval(() => {
    const per = Math.max(1, Math.floor(RATE / 10));
    for (let k = 0; k < per && index < target; k++) connectOne();
  }, 100);
  setInterval(() => process.send!({ open, failed, dropped, attempted: index, received }), 1000);
  process.on("message", (m: { target: number }) => {
    target = m.target;
  });
} else {
  await main();
}

// ---------------------------------------------------------------- parent ---
async function main() {
  const W = Number(values.workers);
  const STEP = Number(values.step);
  const MAX = Number(values.max);
  const P99_LIMIT = Number(values["p99-limit"]);
  const httpUrl = values["http-url"] ?? values.url!.replace(/^ws/, "http");

  const stats = new Map<number, { open: number; failed: number; dropped: number; attempted: number; received: number }>();
  const workers: ChildProcess[] = [];
  for (let w = 0; w < W; w++) {
    const args = process.argv.slice(2).filter((a, i, arr) => a !== "--json" && arr[i - 1] !== "--json");
    const child = fork(new URL(import.meta.url).pathname, [...args, "--worker", String(w)], {
      env: { ...process.env, WORKERS: String(W) },
      execArgv: process.execArgv,
    });
    child.on("message", (m: typeof stats extends Map<number, infer V> ? V : never) => stats.set(w, m));
    workers.push(child);
  }
  const totals = () => {
    const t = { open: 0, failed: 0, dropped: 0, attempted: 0, received: 0 };
    for (const s of stats.values()) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += s[k];
    return t;
  };

  // Probe room: 10 real editors measuring edit -> peer latency.
  const samples: number[] = [];
  const probeRoom = `probe-${Date.now()}`;
  const probeEditors = Array.from({ length: 10 }, (_, i) => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(values.url!, probeRoom, doc, {
      WebSocketPolyfill: WS as unknown as typeof WebSocket,
      disableBc: true,
    });
    const shapes = doc.getMap<{ by: number; t: number }>("shapes");
    shapes.observe((ev) => {
      if (ev.transaction.local) return;
      const now = performance.now();
      for (const k of ev.keysChanged) {
        const v = shapes.get(k);
        if (v && v.by !== i) samples.push(now - v.t);
      }
    });
    return { provider, shapes, i };
  });
  const probeTimer = setInterval(() => {
    for (const p of probeEditors) if (p.provider.wsconnected) p.shapes.set(`p${p.i}`, { by: p.i, t: performance.now() });
  }, 200); // 5 edits/s per probe editor

  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const dockerCpu = async (): Promise<number | null> => {
    if (!values.docker) return null;
    const { execFile } = await import("node:child_process");
    return await new Promise((resolve) =>
      execFile("docker", ["stats", "--no-stream", "--format", "{{.CPUPerc}}", values.docker!], (err, out) =>
        resolve(err ? null : parseFloat(out)),
      ),
    );
  };
  const serverMetrics = async () => {
    try {
      const r = await fetch(`${httpUrl}/metrics`, { signal: AbortSignal.timeout(3000) });
      return (await r.json()) as { connections: number; rssBytes: number; eventLoopDelayMs?: { p99: number; max: number } };
    } catch {
      return null;
    }
  };

  const genLoop = monitorEventLoopDelay({ resolution: 10 });
  genLoop.enable();
  console.log(
    `ramp: step=${STEP} max=${MAX} room=${values["room-size"]} editInterval=${values["edit-interval"]}ms workers=${W} p99Limit=${P99_LIMIT}ms`,
  );
  console.log("| target conns | open | failed+dropped | server conns | server CPU % | server RSS MB | server loop delay p99/max ms | probe p50 ms | probe p99 ms | probe max ms | generator loop max ms | msgs recv/s (clients) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");

  const results: Record<string, unknown>[] = [];
  let limit: { target: number; reason: string } | null = null;
  let lastGood = 0;
  for (let target = STEP; target <= MAX; target += STEP) {
    workers.forEach((w, i) => w.send({ target: Math.floor(target / W) + (i < target % W ? 1 : 0) }));
    // wait until the workers have attempted all their connections
    const t0 = Date.now();
    while (totals().attempted < target && Date.now() - t0 < 120_000) await sleep(500);
    await sleep(Number(values["settle-s"]) * 1000);
    samples.length = 0;
    await serverMetrics(); // reset the server's event-loop histogram
    genLoop.reset();
    const recv0 = totals().received;
    const m0 = Date.now();
    const cpu: number[] = [];
    const measureEnd = Date.now() + Number(values["measure-s"]) * 1000;
    while (Date.now() < measureEnd) {
      const c = await dockerCpu();
      if (c !== null) cpu.push(c);
      await sleep(Math.min(3000, Math.max(0, measureEnd - Date.now())));
    }
    const recvRate = (totals().received - recv0) / ((Date.now() - m0) / 1000);
    const t = totals();
    const m = await serverMetrics();
    const row = {
      target,
      open: t.open,
      failed: t.failed + t.dropped,
      serverConns: m?.connections ?? null,
      rssMB: m ? Math.round(m.rssBytes / 1048576) : null,
      p50: +q(samples, 50).toFixed(2),
      p99: +q(samples, 99).toFixed(2),
      max: +Math.max(...samples).toFixed(2),
      probeSamples: samples.length,
      recvPerSec: Math.round(recvRate),
      serverLoopP99: m?.eventLoopDelayMs?.p99 ?? null,
      serverLoopMax: m?.eventLoopDelayMs?.max ?? null,
      probeLoopMax: +(genLoop.max / 1e6).toFixed(1),
      serverCpuPct: cpu.length ? Math.round(cpu.reduce((a, b) => a + b, 0) / cpu.length) : null,
    };
    results.push(row);
    console.log(
      `| ${target} | ${row.open} | ${row.failed} | ${row.serverConns ?? "down"} | ${row.serverCpuPct ?? "-"} | ${row.rssMB ?? "-"} | ${row.serverLoopP99 ?? "-"} / ${row.serverLoopMax ?? "-"} | ${row.p50} | ${row.p99} | ${row.max} | ${row.probeLoopMax} | ${row.recvPerSec} |`,
    );
    const failRatio = (t.failed + t.dropped) / Math.max(1, t.attempted);
    if (!m) limit = { target, reason: "server stopped answering /metrics" };
    else if (failRatio > 0.01) limit = { target, reason: `${(failRatio * 100).toFixed(1)}% connections failed/dropped` };
    else if (!(row.p99 <= P99_LIMIT)) limit = { target, reason: `probe p99 ${row.p99} ms > ${P99_LIMIT} ms` };
    if (limit) break;
    lastGood = target;
  }

  const summary = limit
    ? `limit reached at ${limit.target} connections (${limit.reason}); last healthy step: ${lastGood}`
    : `no limit reached up to ${MAX} connections`;
  console.log(`\n${summary}`);
  if (values.json) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(values.json, JSON.stringify({ args: values, results, limit, lastGood }, null, 2));
  }
  clearInterval(probeTimer);
  probeEditors.forEach((p) => p.provider.destroy());
  workers.forEach((w) => w.kill());
  process.exit(0);
}
