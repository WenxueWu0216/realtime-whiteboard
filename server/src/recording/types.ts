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
  key: string;
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
};

// Zero-padded so S3 listings sort numerically.
function pad(n: number): string {
  return String(n).padStart(12, "0");
}
