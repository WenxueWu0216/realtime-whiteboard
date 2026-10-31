import * as Y from "yjs";
import { applyDiff, decodeSegment, decodeSnapshot, decodeState } from "./codec.js";
import type { RecordingIndex } from "./index-store.js";
import type { ObjectStore } from "./object-store.js";
import type { OpLog } from "./op-log.js";
import type { OpRecord, SegmentMeta, SnapshotMeta } from "./types.js";

const SEGMENT_FETCH_CONCURRENCY = 8;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface ReconstructResult {
  doc: Y.Doc;
  seq: number;
  ts: number | null;
  snapshot: SnapshotMeta | null;
  opsApplied: number;
  segmentsFetched: number;
  ms: number;
}

export interface ReplayPlan {
  board: string;
  targetSeq: number;
  targetTs: number | null;
  startTs: number | null;
  headSeq: number;
  snapshot: (SnapshotMeta & { url: string | null }) | null;
  segments: (SegmentMeta & { url: string | null })[];
}

export interface ViewResult {
  shapes: Record<string, unknown>;
  seq: number;
  ts: number | null;
  snapshot: SnapshotMeta | null;
  opsApplied: number;
  segmentsFetched: number;
  /** "view": visible snapshot + recorded diffs. "exact": Yjs state + raw ops (target in the unflushed tail). */
  path: "view" | "exact";
  ms: number;
}

export interface Timeline {
  board: string;
  startTs: number | null;
  headSeq: number;
  headTs: number | null;
  /** Highest seq durable in S3 = how far the replay UI can go (lags live by ~SEGMENT_MAX_AGE_MS). */
  flushedSeq: number;
  flushedTs: number | null;
  snapshots: { seq: number; ts: number }[];
}

/**
 * Seek = nearest snapshot at or before the target + only the ops between that
 * snapshot and the target. Ops come from immutable S3 segments, and from the
 * Redis hot tail for the most recent ops that haven't been flushed yet.
 */
export class ReplayService {
  constructor(
    private readonly store: ObjectStore,
    private readonly index: RecordingIndex,
    private readonly oplog: OpLog,
  ) {}

  /** Ops with afterSeq < seq <= toSeq, gap-free, in seq order. */
  async loadOps(board: string, afterSeq: number, toSeq: number): Promise<{ ops: OpRecord[]; segmentsFetched: number }> {
    if (toSeq <= afterSeq) return { ops: [], segmentsFetched: 0 };
    const ops: OpRecord[] = [];
    let next = afterSeq + 1;
    let segmentsFetched = 0;

    for (let attempt = 0; attempt < 2; attempt++) {
      const segs = (await this.index.segmentsInRange(board, next, toSeq)).filter((s) => s.endSeq >= next);
      // Fetch segments concurrently (bounded), then apply in seq order.
      const bodies = await mapLimit(segs, SEGMENT_FETCH_CONCURRENCY, (seg) => this.store.get(seg.key));
      segmentsFetched += bodies.length;
      for (const body of bodies) {
        for (const op of decodeSegment(body)) {
          if (op.seq === next && op.seq <= toSeq) {
            ops.push(op);
            next++;
          }
        }
      }
      if (next > toSeq) return { ops, segmentsFetched };

      const tail = await this.oplog.readAfter(board, next - 1, toSeq);
      if (tail.length === 0 || tail[0].seq === next) {
        for (const op of tail) {
          if (op.seq !== next) break;
          ops.push(op);
          next++;
        }
        if (next > toSeq) return { ops, segmentsFetched };
      }
      // The recorder flushed + trimmed those ops between our index read and
      // our tail read: re-read the index once and they'll be in a segment.
    }
    throw new Error(`op log gap for board "${board}": missing seq ${next} (wanted up to ${toSeq})`);
  }

  async headSeq(board: string): Promise<{ seq: number; ts: number | null }> {
    const [meta, head] = await Promise.all([this.index.getBoard(board), this.oplog.head(board)]);
    if (head.lastSeq >= meta.flushedSeq) return { seq: head.lastSeq, ts: head.lastTs };
    // Redis lost its state (e.g. a non-persistent cache was restarted): S3 is the source of truth.
    return { seq: meta.flushedSeq, ts: meta.flushedTs };
  }

  async reconstruct(
    board: string,
    targetSeq: number,
    opts: { useSnapshots?: boolean } = {},
  ): Promise<ReconstructResult> {
    const t0 = performance.now();
    const doc = new Y.Doc();
    let snapshot: SnapshotMeta | null = null;
    let base = 0;
    let ts: number | null = null;

    if (opts.useSnapshots !== false) {
      snapshot = await this.index.findSnapshotAtOrBefore(board, targetSeq);
      if (snapshot) {
        Y.applyUpdate(doc, decodeState(await this.store.get(snapshot.stateKey)), "replay");
        base = snapshot.seq;
        ts = snapshot.ts;
      }
    }

    const { ops, segmentsFetched } = await this.loadOps(board, base, targetSeq);
    doc.transact(() => {
      for (const op of ops) Y.applyUpdate(doc, op.op, "replay");
    }, "replay");
    if (ops.length) ts = ops[ops.length - 1].ts;

    return {
      doc,
      seq: base + ops.length,
      ts,
      snapshot,
      opsApplied: ops.length,
      segmentsFetched,
      ms: performance.now() - t0,
    };
  }

  /**
   * The visible board at targetSeq: visible-state snapshot + the recorded
   * per-op diffs after it. Never touches the CRDT history, so the cost is
   * O(board size + ops since snapshot) however long the session is.
   * Targets in the not-yet-flushed tail fall back to the exact Yjs path.
   */
  async view(board: string, targetSeq: number, opts: { useSnapshots?: boolean } = {}): Promise<ViewResult> {
    const t0 = performance.now();
    const meta = await this.index.getBoard(board);
    if (targetSeq > meta.flushedSeq) {
      const r = await this.reconstruct(board, targetSeq, opts);
      const shapes = r.doc.getMap("shapes").toJSON();
      r.doc.destroy();
      return { ...r, shapes, path: "exact", ms: performance.now() - t0 };
    }
    let shapes: Record<string, unknown> = {};
    let snapshot: SnapshotMeta | null = null;
    let base = 0;
    let ts: number | null = null;
    if (opts.useSnapshots !== false) {
      snapshot = await this.index.findSnapshotAtOrBefore(board, targetSeq);
      if (snapshot) {
        const snap = decodeSnapshot(await this.store.get(snapshot.key));
        shapes = snap.shapes;
        base = snap.seq;
        ts = snap.ts;
      }
    }
    const { ops, segmentsFetched } = await this.loadOps(board, base, targetSeq);
    for (const op of ops) applyDiff(shapes, op.diff);
    if (ops.length) ts = ops[ops.length - 1].ts;
    return {
      shapes,
      seq: base + ops.length,
      ts,
      snapshot,
      opsApplied: ops.length,
      segmentsFetched,
      path: "view",
      ms: performance.now() - t0,
    };
  }

  async startTs(board: string): Promise<number | null> {
    const meta = await this.index.getBoard(board);
    if (meta.startTs !== null) return meta.startTs;
    const [first] = await this.oplog.readAfter(board, 0, undefined, 1);
    return first?.ts ?? null;
  }

  /** Resolve `?seq=` or `?at=<ms offset from session start>` to a concrete seq. */
  async resolveTarget(board: string, target: { seq?: number; atMs?: number }): Promise<{ seq: number; ts: number | null }> {
    const head = await this.headSeq(board);
    if (target.seq !== undefined) {
      const seq = Math.max(0, Math.min(Math.floor(target.seq), head.seq));
      return { seq, ts: null };
    }
    if (target.atMs === undefined) return head;

    const start = await this.startTs(board);
    if (start === null) return { seq: 0, ts: null };
    const ts = start + target.atMs;
    if (ts < start) return { seq: 0, ts: null };

    const meta = await this.index.getBoard(board);
    if (meta.flushedTs !== null && ts < meta.flushedTs) {
      const seg = await this.index.segmentAtTime(board, ts);
      if (seg) {
        let found = seg.startSeq;
        let foundTs = seg.startTs;
        for (const op of decodeSegment(await this.store.get(seg.key))) {
          if (op.ts > ts) break;
          found = op.seq;
          foundTs = op.ts;
        }
        return { seq: found, ts: foundTs };
      }
    }
    // Target is at/after the last flushed op: scan the hot tail.
    let found = meta.flushedSeq;
    let foundTs = meta.flushedTs;
    for (const op of await this.oplog.readAfter(board, meta.flushedSeq)) {
      if (op.ts > ts) break;
      found = op.seq;
      foundTs = op.ts;
    }
    return { seq: found, ts: foundTs };
  }

  /**
   * What a viewer needs to rebuild the visible board at targetSeq itself:
   * a presigned URL for the nearest visible-state snapshot and presigned
   * URLs for the segments after it (each op carries its visible diff). The
   * browser downloads straight from S3; Node never proxies those bytes.
   * Capped at the last flushed seq. With afterSeq set, it's an "ops after X"
   * plan (no snapshot) used to keep buffering ahead during playback.
   */
  async plan(board: string, afterSeq: number | null, targetSeq: number): Promise<ReplayPlan> {
    const [head, startTs, meta] = await Promise.all([this.headSeq(board), this.startTs(board), this.index.getBoard(board)]);
    targetSeq = Math.max(0, Math.min(targetSeq, meta.flushedSeq));

    let snapshot: ReplayPlan["snapshot"] = null;
    let base = afterSeq ?? 0;
    if (afterSeq === null) {
      const s = await this.index.findSnapshotAtOrBefore(board, targetSeq);
      if (s) {
        snapshot = { ...s, url: await this.store.presignGet(s.key) };
        base = s.seq;
      }
    }
    const segments: ReplayPlan["segments"] = [];
    if (targetSeq > base) {
      for (const seg of await this.index.segmentsInRange(board, base + 1, targetSeq)) {
        segments.push({ ...seg, url: await this.store.presignGet(seg.key) });
      }
    }
    const targetTs = segments.length ? null : (snapshot?.ts ?? null);
    return { board, targetSeq, targetTs, startTs, headSeq: head.seq, snapshot, segments };
  }

  async timeline(board: string): Promise<Timeline> {
    const [head, meta, snaps, startTs] = await Promise.all([
      this.headSeq(board),
      this.index.getBoard(board),
      this.index.listSnapshots(board),
      this.startTs(board),
    ]);
    return {
      board,
      startTs,
      headSeq: head.seq,
      headTs: head.ts,
      flushedSeq: meta.flushedSeq,
      flushedTs: meta.flushedTs,
      snapshots: snaps.map((s) => ({ seq: s.seq, ts: s.ts })),
    };
  }
}
