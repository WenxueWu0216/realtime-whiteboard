/**
 * Seek latency: snapshot + ops vs. full replay from seq 0, on a long session.
 *
 *   npx tsx bench/seek-bench.ts                          # in-process object store
 *   S3_ENDPOINT=http://localhost:4566 S3_BUCKET=bench \
 *   AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
 *   npx tsx bench/seek-bench.ts                          # real S3 API (MinIO/LocalStack/AWS)
 *
 * Options (env): OPS=50000 SEEKS=30 INTERVALS=250,500,1000,2000,5000 MAX_SHAPES=300
 */
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import type { Config } from "../src/config.js";
import { MemoryRecordingIndex } from "../src/recording/index-store.js";
import { MemoryObjectStore, S3ObjectStore, type ObjectStore } from "../src/recording/object-store.js";
import { MemoryOpLog } from "../src/recording/op-log.js";
import { Recorder } from "../src/recording/recorder.js";
import { ReplayService } from "../src/recording/replay.js";
import { generateSession } from "../test/helpers/session.js";

const OPS = Number(process.env.OPS ?? 50_000);
const SEEKS = Number(process.env.SEEKS ?? 30);
const INTERVALS = (process.env.INTERVALS ?? "250,500,1000,2000,5000").split(",").map(Number);
const MAX_SHAPES = Number(process.env.MAX_SHAPES ?? 300);
const useS3 = Boolean(process.env.S3_ENDPOINT || process.env.S3_BUCKET);

/** Counts bytes actually downloaded during a seek. */
class CountingStore implements ObjectStore {
  bytesRead = 0;
  bytesWritten = 0;
  snapshotBytes = 0;
  segmentBytes = 0;
  constructor(private readonly inner: ObjectStore) {}
  get kind() {
    return this.inner.kind;
  }
  async put(key: string, body: Uint8Array, ct: string) {
    this.bytesWritten += body.byteLength;
    if (key.includes("/snapshots/")) this.snapshotBytes += body.byteLength;
    else this.segmentBytes += body.byteLength;
    return this.inner.put(key, body, ct);
  }
  async get(key: string) {
    const b = await this.inner.get(key);
    this.bytesRead += b.byteLength;
    return b;
  }
  presignGet(key: string) {
    return this.inner.presignGet(key);
  }
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const f = (n: number) => n.toFixed(1);
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

console.log(`generating ${OPS} ops (6 editors, <= ${MAX_SHAPES} shapes)...`);
const ops = generateSession({ ops: OPS, clients: 6, seed: 99, maxShapes: MAX_SHAPES });
const finalDoc = new Y.Doc();
for (const op of ops) Y.applyUpdate(finalDoc, op);
console.log(
  `session: ${ops.length} ops, ${kb(ops.reduce((a, o) => a + o.byteLength, 0))} raw updates, final state ${kb(
    Y.encodeStateAsUpdate(finalDoc).byteLength,
  )}, ${finalDoc.getMap("shapes").size} shapes`,
);
console.log(`object store: ${useS3 ? `S3 API at ${process.env.S3_ENDPOINT ?? "AWS"}` : "in-process memory"}\n`);

// Same random targets for every configuration.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const targets = Array.from({ length: SEEKS }, () => 1 + Math.floor(rnd() * OPS));

const rows: string[] = [];
for (const interval of INTERVALS) {
  const board = `bench-${interval}-${Date.now()}`;
  let clock = 1_700_000_000_000;
  const oplog = new MemoryOpLog(() => clock);
  const inner: ObjectStore = useS3
    ? new S3ObjectStore({
        bucket: process.env.S3_BUCKET ?? "bench",
        region: process.env.AWS_REGION ?? "us-east-1",
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: Boolean(process.env.S3_ENDPOINT),
        presignTtlSeconds: 300,
      })
    : new MemoryObjectStore();
  if (inner instanceof S3ObjectStore && process.env.S3_ENDPOINT) await inner.ensureBucket();
  const store = new CountingStore(inner);
  const index = new MemoryRecordingIndex();
  const replay = new ReplayService(store, index, oplog);
  const cfg: Config["recording"] = {
    enabled: true,
    snapshotEveryOps: interval,
    snapshotEveryMs: 1e12,
    segmentMaxOps: 500,
    segmentMaxAgeMs: 0,
    tickMs: 1e9,
    leaseMs: 1e9,
  };
  const rec = new Recorder(board, { oplog, store, index, replay, cfg, owner: "bench", now: () => clock });
  for (const op of ops) {
    clock += 80;
    oplog.appendSync(board, op);
  }
  await rec.tick(true);

  const m = {
    viewSnap: [] as number[],
    viewFull: [] as number[],
    exactSnap: [] as number[],
    exactFull: [] as number[],
    viewSnapBytes: [] as number[],
    viewFullBytes: [] as number[],
    viewSnapOps: [] as number[],
  };
  // warm-up (JIT, connection pool)
  await replay.view(board, targets[0]);
  (await replay.reconstruct(board, targets[0])).doc.destroy();

  const canon = (shapes: Record<string, unknown>) => JSON.stringify(Object.entries(shapes).sort(([x], [y]) => x.localeCompare(y)));
  for (const t of targets) {
    store.bytesRead = 0;
    let t0 = performance.now();
    const v = await replay.view(board, t);
    m.viewSnap.push(performance.now() - t0);
    m.viewSnapBytes.push(store.bytesRead);
    m.viewSnapOps.push(v.opsApplied);

    store.bytesRead = 0;
    t0 = performance.now();
    const vf = await replay.view(board, t, { useSnapshots: false });
    m.viewFull.push(performance.now() - t0);
    m.viewFullBytes.push(store.bytesRead);

    t0 = performance.now();
    const a = await replay.reconstruct(board, t);
    m.exactSnap.push(performance.now() - t0);

    t0 = performance.now();
    const b = await replay.reconstruct(board, t, { useSnapshots: false });
    m.exactFull.push(performance.now() - t0);

    // all four paths must agree (canonical JSON + Yjs state vector)
    const sv = (d: Y.Doc) => Buffer.from(Y.encodeStateVector(d)).toString("base64");
    const truth = canon(b.doc.getMap("shapes").toJSON());
    if (canon(v.shapes) !== truth || canon(vf.shapes) !== truth || canon(a.doc.getMap("shapes").toJSON()) !== truth || sv(a.doc) !== sv(b.doc)) {
      throw new Error(`mismatch at seq ${t}`);
    }
    a.doc.destroy();
    b.doc.destroy();
  }
  const trio = (xs: number[]) => `${f(pct(xs, 50))} / ${f(pct(xs, 95))} / ${f(Math.max(...xs))}`;
  rows.push(
    `| ${interval} | ${(OPS / interval) | 0} | ${kb(store.snapshotBytes)} | **${trio(m.viewSnap)}** | ${pct(m.viewSnapOps, 50)} | ${kb(
      pct(m.viewSnapBytes, 50),
    )} | ${trio(m.viewFull)} | ${kb(pct(m.viewFullBytes, 50))} | **${(pct(m.viewFull, 50) / pct(m.viewSnap, 50)).toFixed(0)}x** | ${f(
      pct(m.exactSnap, 50),
    )} | ${f(pct(m.exactFull, 50))} |`,
  );
  console.log(`interval ${interval} done (segments ${kb(store.segmentBytes)})`);
}

console.log(`\n${SEEKS} random seeks over a ${OPS}-op session (${useS3 ? "S3 API" : "in-process store"}), latency in ms p50 / p95 / max:\n`);
console.log(
  "| snapshot every N ops | snapshots | snapshot storage (visible + CRDT) | **seek: snapshot + ops** ms | ops applied (p50) | bytes read (p50) | full replay from seq 0 ms | bytes read (p50) | speedup (p50) | exact CRDT seek p50 ms | exact CRDT full replay p50 ms |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(r);
process.exit(0);
