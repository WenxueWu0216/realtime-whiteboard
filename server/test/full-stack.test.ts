import type { ChildProcess } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WS from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { hasBinary, randomPort, startRedis, startServer, waitFor } from "./helpers/procs.js";

const WebSocketPolyfill = WS as unknown as typeof WebSocket;

/**
 * End-to-end against real infrastructure: Redis, MongoDB and an
 * S3-compatible store (LocalStack or MinIO). Opt-in, because it needs those
 * running:
 *
 *   TEST_S3_ENDPOINT=http://localhost:4566 TEST_MONGO_URL=mongodb://localhost:27017 npm test
 */
const S3 = process.env.TEST_S3_ENDPOINT;
const MONGO = process.env.TEST_MONGO_URL;

describe.skipIf(!S3 || !MONGO || !hasBinary("redis-server"))("recording + replay on Redis/Mongo/S3 with 2 instances", () => {
  const redisPort = randomPort();
  const ports = [randomPort(), randomPort()];
  const procs: ChildProcess[] = [];
  const bucket = `wb-test-${Date.now()}`;
  const db = `wb_test_${Date.now()}`;
  let env: Record<string, string>;

  beforeAll(async () => {
    procs.push(await startRedis(redisPort));
    env = {
      REDIS_URL: `redis://localhost:${redisPort}`,
      MONGO_URL: `${MONGO}/${db}`,
      MONGO_DB: db,
      S3_BUCKET: bucket,
      S3_ENDPOINT: S3!,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      AWS_REGION: "us-east-1",
      SNAPSHOT_EVERY_OPS: "50",
      SEGMENT_MAX_OPS: "20",
      SEGMENT_MAX_AGE_MS: "300",
      RECORDER_TICK_MS: "100",
      RECORDER_LEASE_MS: "2000",
      EMPTY_ROOM_TTL_MS: "500",
    };
    for (const [i, port] of ports.entries()) procs.push(await startServer(port, { ...env, INSTANCE_ID: `pod-${i}` }));
  }, 60_000);

  afterAll(() => {
    for (const p of procs.reverse()) p.kill("SIGKILL");
  });

  it("records to S3 and any pod can seek to any point via snapshot + ops", async () => {
    const board = `fs-${Date.now()}`;
    const mk = (port: number) => {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(`ws://localhost:${port}`, board, doc, { WebSocketPolyfill });
      return { doc, provider, shapes: doc.getMap<Record<string, unknown>>("shapes") };
    };
    const a = mk(ports[0]);
    const b = mk(ports[1]);
    await waitFor(() => a.provider.synced && b.provider.synced);

    // Record ground truth after every op as the clients see it.
    const N = 230;
    for (let i = 0; i < N; i++) {
      const c = i % 2 ? b : a;
      c.shapes.set(`shape-${i % 17}`, { x: i, y: i * 2, by: i % 2 });
      await new Promise((r) => setTimeout(r, 2));
    }
    await waitFor(() => JSON.stringify(Object.entries(a.shapes.toJSON()).sort()) === JSON.stringify(Object.entries(b.shapes.toJSON()).sort()));

    // Wait until everything has been flushed to S3.
    await waitFor(async () => {
      const t = await (await fetch(`http://localhost:${ports[1]}/boards/${board}/timeline`)).json();
      return t.headSeq === N && t.flushedSeq === N;
    }, 15_000);

    const timeline = await (await fetch(`http://localhost:${ports[0]}/boards/${board}/timeline`)).json();
    expect(timeline.snapshots.map((s: { seq: number }) => s.seq)).toEqual([50, 100, 150, 200]);

    // Server-side reconstruction from either pod, at the head.
    for (const port of ports) {
      const r = await (await fetch(`http://localhost:${port}/boards/${board}/replay?seq=${N}`)).json();
      expect(r.seq).toBe(N);
      expect(r.snapshot.seq).toBe(200);
      expect(r.opsApplied).toBe(30);
      expect(r.shapes).toEqual(a.shapes.toJSON());
    }

    // Mid-session seek equals a full replay of ops 1..k.
    const full = new Y.Doc();
    let k = 0;
    for (const target of [1, 49, 50, 51, 123, 199, 230]) {
      const r = await (await fetch(`http://localhost:${ports[1]}/boards/${board}/replay?at=seq:${target}`)).json();
      const plan = await (await fetch(`http://localhost:${ports[0]}/boards/${board}/ops?after=${k}&to=${target}`)).json();
      for (const seg of plan.segments) {
        // presigned URLs are directly downloadable without credentials
        const body = new Uint8Array(await (await fetch(seg.url)).arrayBuffer());
        for (const line of gunzipSync(body).toString().split("\n").filter(Boolean)) {
          const op = JSON.parse(line);
          if (op.seq > k && op.seq <= target) {
            Y.applyUpdate(full, Buffer.from(op.op, "base64"));
            k = op.seq;
          }
        }
      }
      for (const op of plan.tail) {
        if (op.seq > k && op.seq <= target) {
          Y.applyUpdate(full, Buffer.from(op.op, "base64"));
          k = op.seq;
        }
      }
      expect(k).toBe(target);
      expect(r.shapes).toEqual(full.getMap("shapes").toJSON());
      expect(r.opsApplied).toBe(target % 50);
    }

    // Plan mode: presigned snapshot URL works and decodes.
    const plan = await (await fetch(`http://localhost:${ports[0]}/boards/${board}/replay?seq=120&mode=plan`)).json();
    expect(plan.snapshot.seq).toBe(100);
    expect(plan.snapshot.url).toContain("X-Amz-Signature");
    const snap = JSON.parse(gunzipSync(new Uint8Array(await (await fetch(plan.snapshot.url)).arrayBuffer())).toString());
    expect(snap.seq).toBe(100);

    a.provider.destroy();
    b.provider.destroy();
  }, 60_000);

  it("a surviving pod takes over recording when the lease holder dies, without losing ops", async () => {
    const board = `takeover-${Date.now()}`;
    const docs = ports.map((port) => {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(`ws://localhost:${port}`, board, doc, { WebSocketPolyfill });
      return { doc, provider, shapes: doc.getMap<Record<string, unknown>>("shapes") };
    });
    await waitFor(() => docs.every((d) => d.provider.synced));
    for (let i = 0; i < 40; i++) docs[i % 2].shapes.set(`k${i}`, i);
    await new Promise((r) => setTimeout(r, 300));

    const metrics = await Promise.all(ports.map(async (p) => (await fetch(`http://localhost:${p}/metrics`)).json()));
    const holderIdx = metrics.findIndex((m) => m.recorders.some((r: { board: string; holding: boolean }) => r.board === board && r.holding));
    expect(holderIdx).toBeGreaterThanOrEqual(0);
    const survivor = 1 - holderIdx;

    procs[1 + holderIdx].kill("SIGKILL"); // hard crash: no flush
    docs[holderIdx].provider.destroy();
    for (let i = 40; i < 80; i++) docs[survivor].shapes.set(`k${i}`, i);

    await waitFor(async () => {
      const t = await (await fetch(`http://localhost:${ports[survivor]}/boards/${board}/timeline`)).json();
      return t.flushedSeq === 80;
    }, 15_000);
    const r = await (await fetch(`http://localhost:${ports[survivor]}/boards/${board}/replay`)).json();
    expect(r.seq).toBe(80);
    expect(r.shapes).toEqual(docs[survivor].shapes.toJSON());

    // restart the crashed pod for any later tests
    procs[1 + holderIdx] = await startServer(ports[holderIdx], { ...env, INSTANCE_ID: `pod-${holderIdx}-b` });
    docs[survivor].provider.destroy();
  }, 60_000);
});
