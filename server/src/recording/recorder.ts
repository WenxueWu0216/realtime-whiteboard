import * as Y from "yjs";
import type { Config } from "../config.js";
import { encodeSegment, encodeSnapshot } from "./codec.js";
import type { RecordingIndex } from "./index-store.js";
import type { ObjectStore } from "./object-store.js";
import type { OpLog } from "./op-log.js";
import type { ReplayService } from "./replay.js";
import { keys, type OpRecord } from "./types.js";

export interface RecorderDeps {
  oplog: OpLog;
  store: ObjectStore;
  index: RecordingIndex;
  replay: ReplayService;
  cfg: Config["recording"];
  owner: string;
  now?: () => number;
}

/**
 * Turns one board's hot tail (Redis Stream) into durable S3 objects:
 *
 *   hot tail ──read in seq order──▶ replay doc ──every N ops / T s──▶ snapshot
 *                 │
 *                 └──batch of ops──▶ segment boards/{id}/ops/{start}-{end}.jsonl.gz
 *                                    then XTRIM the flushed ops from Redis
 *
 * The snapshot is taken from a doc built *only* from the log (snapshot S =
 * apply ops 1..S in seq order), never from the live room doc, which on a
 * given pod can be ahead of / behind the log because Redis relay is async.
 * That makes "snapshot + ops (S, k]" provably the same as replaying 1..k.
 *
 * Exactly one pod records a given board at a time (Redis lease). Any pod
 * with the board open competes for the lease, so if the holder dies another
 * pod takes over within RECORDER_LEASE_MS, rebuilding its doc from the last
 * snapshot + flushed segments and continuing from the last flushed seq.
 * Ops are never lost in between: they just wait in the Redis stream.
 */
export class Recorder {
  private holding = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private doc: Y.Doc | null = null;
  private consumedSeq = 0;
  private lastSnapshotSeq = 0;
  private lastSnapshotTs: number | null = null;
  private buffer: OpRecord[] = [];
  private bufferSince = 0;
  private readonly now: () => number;

  /** Counters exposed on /metrics-ish endpoints and in tests. */
  readonly stats = { segments: 0, snapshots: 0, takeovers: 0 };

  constructor(
    readonly board: string,
    private readonly d: RecorderDeps,
  ) {
    this.now = d.now ?? Date.now;
  }

  get isHolding(): boolean {
    return this.holding;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => console.error(`[recorder ${this.board}]`, e)), this.d.cfg.tickMs);
  }

  /** Flush everything still buffered/unflushed and give up the lease. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
    if (this.holding) {
      await this.step(true);
      await this.d.oplog.releaseLease(this.board, this.d.owner);
    }
    this.holding = false;
    this.doc?.destroy();
    this.doc = null;
  }

  /** One recorder iteration. Safe to call concurrently (calls are serialized). */
  async tick(force = false): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        if (!this.holding) {
          if (!(await this.d.oplog.acquireLease(this.board, this.d.owner, this.d.cfg.leaseMs))) return;
          await this.bootstrap();
          this.holding = true;
          this.stats.takeovers++;
        } else if (!(await this.d.oplog.renewLease(this.board, this.d.owner, this.d.cfg.leaseMs))) {
          this.holding = false;
          this.doc?.destroy();
          this.doc = null;
          return;
        }
        await this.step(force);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async bootstrap(): Promise<void> {
    const meta = await this.d.index.getBoard(this.board);
    const rebuilt = await this.d.replay.reconstruct(this.board, meta.flushedSeq);
    this.doc?.destroy();
    this.doc = rebuilt.doc;
    this.consumedSeq = meta.flushedSeq;
    this.lastSnapshotSeq = meta.lastSnapshotSeq;
    this.lastSnapshotTs = meta.lastSnapshotTs ?? meta.startTs;
    this.buffer = [];
  }

  private async step(force: boolean): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const { snapshotEveryOps, snapshotEveryMs, segmentMaxOps, segmentMaxAgeMs } = this.d.cfg;
    const BATCH = 5000;

    for (;;) {
      const ops = await this.d.oplog.readAfter(this.board, this.consumedSeq, undefined, BATCH);
      for (const op of ops) {
        if (op.seq !== this.consumedSeq + 1) {
          throw new Error(`recorder for "${this.board}" expected seq ${this.consumedSeq + 1}, got ${op.seq}`);
        }
        Y.applyUpdate(doc, op.op, "recorder");
        if (this.buffer.length === 0) this.bufferSince = this.now();
        this.buffer.push(op);
        this.consumedSeq = op.seq;
        this.lastSnapshotTs ??= op.ts;

        const dueByOps = op.seq - this.lastSnapshotSeq >= snapshotEveryOps;
        const dueByTime = op.ts - this.lastSnapshotTs >= snapshotEveryMs;
        if (dueByOps || dueByTime) {
          await this.flushSegment();
          await this.writeSnapshot(op.ts);
        } else if (this.buffer.length >= segmentMaxOps) {
          await this.flushSegment();
        }
      }
      if (ops.length < BATCH) break;
    }

    if (this.buffer.length && (force || this.now() - this.bufferSince >= segmentMaxAgeMs)) {
      await this.flushSegment();
    }
  }

  private async flushSegment(): Promise<void> {
    if (!this.buffer.length) return;
    const ops = this.buffer;
    const first = ops[0];
    const last = ops[ops.length - 1];
    const key = keys.segment(this.board, first.seq, last.seq);
    await this.d.store.put(key, encodeSegment(ops), "application/gzip");
    await this.d.index.addSegment({
      board: this.board,
      startSeq: first.seq,
      endSeq: last.seq,
      startTs: first.ts,
      endTs: last.ts,
      key,
      count: ops.length,
    });
    // Only after the segment is durable AND indexed is it safe to drop the ops from Redis.
    await this.d.oplog.trimThrough(this.board, last.seq);
    this.buffer = [];
    this.stats.segments++;
  }

  private async writeSnapshot(ts: number): Promise<void> {
    const doc = this.doc!;
    const seq = this.consumedSeq;
    const key = keys.snapshot(this.board, seq);
    await this.d.store.put(
      key,
      encodeSnapshot({
        board: this.board,
        seq,
        ts,
        state: Y.encodeStateAsUpdate(doc),
        shapes: doc.getMap("shapes").toJSON(),
      }),
      "application/gzip",
    );
    await this.d.index.addSnapshot({ board: this.board, seq, ts, key });
    this.lastSnapshotSeq = seq;
    this.lastSnapshotTs = ts;
    this.stats.snapshots++;
  }
}
