/**
 * One recorded board operation. `op` is the raw Yjs update a client sent
 * (exactly the bytes that were applied to the live doc), `seq` is the
 * per-board sequence number assigned atomically in Redis, and `ts` is the
 * server timestamp (ms since epoch, Redis clock, never decreasing per board).
 */
export interface OpRecord {
  seq: number;
  ts: number;
  op: Uint8Array;
  /**
   * Effect of this op on the *visible* board, computed by the recorder while
   * applying ops in seq order: shapes set (new value) and shapes deleted.
   * Present on ops read back from S3 segments; absent on hot-tail ops.
   */
  diff?: ShapeDiff;
}

export interface ShapeDiff {
  s?: Record<string, unknown>;
  d?: string[];
}

export interface SegmentMeta {
  board: string;
  startSeq: number;
  endSeq: number;
  startTs: number;
  endTs: number;
  key: string;
  count: number;
}

export interface SnapshotMeta {
  board: string;
  seq: number;
  ts: number;
  /** Visible board state (shapes JSON) - what viewers download. */
  key: string;
  /** Full Yjs CRDT state - for exact reconstruction and recorder takeover. */
  stateKey: string;
}

export interface BoardMeta {
  board: string;
  /** Timestamp of seq 1 - "ms offset" in the replay API is relative to this. */
  startTs: number | null;
  /** Highest seq durably written to an S3 segment. */
  flushedSeq: number;
  flushedTs: number | null;
  lastSnapshotSeq: number;
  lastSnapshotTs: number | null;
}

export const keys = {
  segment: (board: string, startSeq: number, endSeq: number) =>
    `boards/${encodeURIComponent(board)}/ops/${pad(startSeq)}-${pad(endSeq)}.jsonl.gz`,
  snapshot: (board: string, seq: number) =>
    `boards/${encodeURIComponent(board)}/snapshots/${pad(seq)}.json.gz`,
  snapshotState: (board: string, seq: number) =>
    `boards/${encodeURIComponent(board)}/snapshots/${pad(seq)}.yjs.gz`,
};

// Zero-padded so S3 listings sort numerically.
function pad(n: number): string {
  return String(n).padStart(12, "0");
}
