import * as Y from "yjs";
import { decodeSegment, decodeSnapshot } from "./codec.js";
import type { RecordingIndex } from "./index-store.js";
import type { ObjectStore } from "./object-store.js";
import type { OpLog } from "./op-log.js";
import type { OpRecord, SegmentMeta, SnapshotMeta } from "./types.js";

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
  /** Ops not yet flushed to S3 (still only in the Redis hot tail), inlined. */
  tail: { seq: number; ts: number; op: string }[];
}

export interface Timeline {
  board: string;
  startTs: number | null;
  headSeq: number;
  headTs: number | null;
  flushedSeq: number;
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
      const segs = await this.index.segmentsInRange(board, next, toSeq);
      for (const seg of segs) {
        if (seg.endSeq < next) continue;
        const body = await this.store.get(seg.key);
        segmentsFetched++;
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
        const snap = decodeSnapshot(await this.store.get(snapshot.key));
        Y.applyUpdate(doc, snap.state, "replay");
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
   * What a client needs to rebuild the board at targetSeq itself: a
   * presigned snapshot URL, presigned segment URLs, and the unflushed tail.
   * With includeSnapshot=false it's an "ops after X" plan used to keep
   * buffering ahead during playback.
   */
  async plan(board: string, afterSeq: number | null, targetSeq: number): Promise<ReplayPlan> {
    const [head, startTs] = await Promise.all([this.headSeq(board), this.startTs(board)]);
    targetSeq = Math.min(targetSeq, head.seq);

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
    let covered = base;
    if (targetSeq > base) {
      for (const seg of await this.index.segmentsInRange(board, base + 1, targetSeq)) {
        segments.push({ ...seg, url: await this.store.presignGet(seg.key) });
        covered = Math.max(covered, seg.endSeq);
      }
    }
    const tail =
      covered < targetSeq
        ? (await this.loadOps(board, covered, targetSeq)).ops.map((o) => ({
            seq: o.seq,
            ts: o.ts,
            op: Buffer.from(o.op).toString("base64"),
          }))
        : [];

    let targetTs: number | null = null;
    if (tail.length) targetTs = tail[tail.length - 1].ts;
    else if (segments.length) targetTs = null; // client learns it from the segment
    else if (snapshot) targetTs = snapshot.ts;

    return { board, targetSeq, targetTs, startTs, headSeq: head.seq, snapshot, segments, tail };
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
      snapshots: snaps.map((s) => ({ seq: s.seq, ts: s.ts })),
    };
  }
}
