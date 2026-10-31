import type { ChildProcess } from "node:child_process";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WS from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { hasBinary, randomPort, startRedis, startServer, waitFor } from "./helpers/procs.js";

const WebSocketPolyfill = WS as unknown as typeof WebSocket;
const haveRedis = hasBinary("redis-server");

/**
 * Two independent server processes behind one Redis: clients on both edit
 * the same board concurrently. The op log must come out as one gap-free,
 * strictly ordered sequence, with non-decreasing server timestamps, that
 * respects causality across pods, and replaying it must reproduce the
 * live state.
 */
describe.skipIf(!haveRedis)("op ordering across 2 server instances", () => {
  const redisPort = randomPort();
  const ports = [randomPort(), randomPort()];
  const procs: ChildProcess[] = [];
  let redis: Redis;

  beforeAll(async () => {
    procs.push(await startRedis(redisPort));
    const env = {
      REDIS_URL: `redis://localhost:${redisPort}`,
      // Keep everything in the hot tail so the test can inspect the raw stream.
      SEGMENT_MAX_OPS: "1000000",
      SEGMENT_MAX_AGE_MS: "100000000",
      SNAPSHOT_EVERY_OPS: "1000000",
      SNAPSHOT_EVERY_MS: "100000000",
    };
    for (const [i, port] of ports.entries()) procs.push(await startServer(port, { ...env, INSTANCE_ID: `pod-${i}` }));
    redis = new Redis(`redis://localhost:${redisPort}`);
  }, 40_000);

  afterAll(async () => {
    await redis?.quit();
    for (const p of procs.reverse()) p.kill("SIGKILL");
  });

  async function readStream(board: string) {
    const rows = await redis.xrangeBuffer(`wb:{${board}}:ops`, "-", "+");
    return rows.map(([id, f]) => {
      const m = new Map<string, Buffer>();
      for (let i = 0; i < f.length; i += 2) m.set(f[i].toString(), f[i + 1]);
      return { seq: Number(id.toString().split("-")[0]), ts: Number(m.get("ts")!.toString()), op: new Uint8Array(m.get("op")!) };
    });
  }

  it("assigns gap-free, ordered seqs and monotonic timestamps under concurrent edits from both pods", async () => {
    const board = `order-${Date.now()}`;
    const clients = Array.from({ length: 10 }, (_, i) => {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(`ws://localhost:${ports[i % 2]}`, board, doc, { WebSocketPolyfill });
      return { doc, provider, shapes: doc.getMap<Record<string, unknown>>("shapes") };
    });
    await waitFor(() => clients.every((c) => c.provider.synced));

    const EDITS = 40;
    await Promise.all(
      clients.map(async (c, i) => {
        for (let e = 0; e < EDITS; e++) {
          c.shapes.set(`c${i}-${e % 5}`, { x: e, y: i, by: i });
          await new Promise((r) => setTimeout(r, Math.random() * 5));
        }
      }),
    );
    // key order in toJSON() depends on arrival order, so compare canonically
    const canon = (m: Y.Map<unknown>) => JSON.stringify(Object.entries(m.toJSON()).sort(([a], [b]) => a.localeCompare(b)));
    await waitFor(() => clients.every((c) => canon(c.shapes) === canon(clients[0].shapes)), 15_000);

    const ops = await readStream(board);
    expect(ops.length).toBe(10 * EDITS);
    ops.forEach((o, i) => expect(o.seq).toBe(i + 1));
    for (let i = 1; i < ops.length; i++) expect(ops[i].ts).toBeGreaterThanOrEqual(ops[i - 1].ts);

    // Replaying the log in seq order reproduces exactly what every client sees live.
    const replayed = new Y.Doc();
    for (const o of ops) Y.applyUpdate(replayed, o.op);
    expect(replayed.getMap("shapes").toJSON()).toEqual(clients[0].shapes.toJSON());
    expect(Buffer.from(Y.encodeStateVector(replayed))).toEqual(Buffer.from(Y.encodeStateVector(clients[0].doc)));

    clients.forEach((c) => c.provider.destroy());
  }, 40_000);

  it("orders causally dependent ops across pods (an edit made after seeing a remote edit gets a higher seq)", async () => {
    const board = `causal-${Date.now()}`;
    const mk = (port: number) => {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(`ws://localhost:${port}`, board, doc, { WebSocketPolyfill });
      return { doc, provider, shapes: doc.getMap<Record<string, unknown>>("shapes") };
    };
    const a = mk(ports[0]);
    const b = mk(ports[1]);
    await waitFor(() => a.provider.synced && b.provider.synced);

    for (let round = 0; round < 25; round++) {
      a.shapes.set("ping", { round });
      await waitFor(() => (b.shapes.get("ping") as { round: number } | undefined)?.round === round);
      b.shapes.set("pong", { round });
      await waitFor(() => (a.shapes.get("pong") as { round: number } | undefined)?.round === round);
    }

    const ops = await readStream(board);
    expect(ops.length).toBe(50);
    // Replay in seq order and record which key each op changed: ping/pong
    // must strictly alternate, i.e. every reply is ordered after its cause.
    const d = new Y.Doc();
    const touched: string[] = [];
    d.getMap("shapes").observe((e) => touched.push(...e.keysChanged));
    for (const o of ops) Y.applyUpdate(d, o.op);
    expect(touched.length).toBe(50);
    touched.forEach((k, i) => expect(k).toBe(i % 2 === 0 ? "ping" : "pong"));

    a.provider.destroy();
    b.provider.destroy();
  }, 40_000);
});
