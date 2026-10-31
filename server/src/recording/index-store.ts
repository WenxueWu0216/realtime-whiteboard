import type { Db } from "mongodb";
import type { BoardMeta, SegmentMeta, SnapshotMeta } from "./types.js";

/**
 * Small metadata index over what's in S3, so a seek never has to LIST the
 * bucket:
 *   - snapshots: seq -> key (+ ts)          "nearest snapshot at or before seq"
 *   - segments:  [startSeq,endSeq] -> key   "which objects hold ops (a, b]"
 *                [startTs,endTs]            "timestamp -> seq" lookups
 *   - boards:    startTs, flushedSeq, lastSnapshotSeq (recorder checkpoint)
 *
 * Each document is a few hundred bytes; a 50k-op session with the default
 * settings is ~100 segment docs and ~50 snapshot docs.
 */
export interface RecordingIndex {
  getBoard(board: string): Promise<BoardMeta>;
  addSegment(seg: SegmentMeta): Promise<void>;
  addSnapshot(snap: SnapshotMeta): Promise<void>;
  findSnapshotAtOrBefore(board: string, seq: number): Promise<SnapshotMeta | null>;
  /** Segments that contain any seq in [fromSeq, toSeq], ordered by startSeq. */
  segmentsInRange(board: string, fromSeq: number, toSeq: number): Promise<SegmentMeta[]>;
  /** The last segment whose startTs <= ts (the one that may contain ts). */
  segmentAtTime(board: string, ts: number): Promise<SegmentMeta | null>;
  listSnapshots(board: string): Promise<SnapshotMeta[]>;
}

function emptyBoard(board: string): BoardMeta {
  return { board, startTs: null, flushedSeq: 0, flushedTs: null, lastSnapshotSeq: 0, lastSnapshotTs: null };
}

export class MemoryRecordingIndex implements RecordingIndex {
  private readonly boards = new Map<string, BoardMeta>();
  private readonly segments = new Map<string, SegmentMeta[]>();
  private readonly snapshots = new Map<string, SnapshotMeta[]>();

  async getBoard(board: string): Promise<BoardMeta> {
    return { ...(this.boards.get(board) ?? emptyBoard(board)) };
  }

  async addSegment(seg: SegmentMeta): Promise<void> {
    const list = this.segments.get(seg.board) ?? [];
    if (!list.some((s) => s.startSeq === seg.startSeq)) list.push(seg);
    list.sort((a, b) => a.startSeq - b.startSeq);
    this.segments.set(seg.board, list);
    const b = this.boards.get(seg.board) ?? emptyBoard(seg.board);
    b.startTs ??= seg.startTs;
    if (seg.endSeq > b.flushedSeq) {
      b.flushedSeq = seg.endSeq;
      b.flushedTs = seg.endTs;
    }
    this.boards.set(seg.board, b);
  }

  async addSnapshot(snap: SnapshotMeta): Promise<void> {
    const list = this.snapshots.get(snap.board) ?? [];
    if (!list.some((s) => s.seq === snap.seq)) list.push(snap);
    list.sort((a, b) => a.seq - b.seq);
    this.snapshots.set(snap.board, list);
    const b = this.boards.get(snap.board) ?? emptyBoard(snap.board);
    if (snap.seq > b.lastSnapshotSeq) {
      b.lastSnapshotSeq = snap.seq;
      b.lastSnapshotTs = snap.ts;
    }
    this.boards.set(snap.board, b);
  }

  async findSnapshotAtOrBefore(board: string, seq: number): Promise<SnapshotMeta | null> {
    const list = this.snapshots.get(board) ?? [];
    // binary search for the last snapshot with snap.seq <= seq
    let lo = 0;
    let hi = list.length - 1;
    let ans: SnapshotMeta | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].seq <= seq) {
        ans = list[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  async segmentsInRange(board: string, fromSeq: number, toSeq: number): Promise<SegmentMeta[]> {
    return (this.segments.get(board) ?? []).filter((s) => s.endSeq >= fromSeq && s.startSeq <= toSeq);
  }

  async segmentAtTime(board: string, ts: number): Promise<SegmentMeta | null> {
    const list = this.segments.get(board) ?? [];
    let ans: SegmentMeta | null = null;
    for (const s of list) {
      if (s.startTs <= ts) ans = s;
      else break;
    }
    return ans;
  }

  async listSnapshots(board: string): Promise<SnapshotMeta[]> {
    return [...(this.snapshots.get(board) ?? [])];
  }
}

export class MongoRecordingIndex implements RecordingIndex {
  constructor(private readonly db: Db) {}

  private get boards() {
    return this.db.collection<BoardMeta>("rec_boards");
  }
  private get segments() {
    return this.db.collection<SegmentMeta>("rec_segments");
  }
  private get snapshots() {
    return this.db.collection<SnapshotMeta>("rec_snapshots");
  }

  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.boards.createIndex({ board: 1 }, { unique: true }),
      this.segments.createIndex({ board: 1, startSeq: 1 }, { unique: true }),
      this.segments.createIndex({ board: 1, endSeq: 1 }),
      this.segments.createIndex({ board: 1, startTs: 1 }),
      this.snapshots.createIndex({ board: 1, seq: 1 }, { unique: true }),
      this.snapshots.createIndex({ board: 1, ts: 1 }),
    ]);
  }

  async getBoard(board: string): Promise<BoardMeta> {
    const doc = await this.boards.findOne({ board }, { projection: { _id: 0 } });
    return doc ? { ...emptyBoard(board), ...doc } : emptyBoard(board);
  }

  async addSegment(seg: SegmentMeta): Promise<void> {
    await this.segments.updateOne(
      { board: seg.board, startSeq: seg.startSeq },
      { $setOnInsert: seg },
      { upsert: true },
    );
    await this.boards.updateOne(
      { board: seg.board },
      { $setOnInsert: { startTs: seg.startTs }, $max: { flushedSeq: seg.endSeq, flushedTs: seg.endTs } },
      { upsert: true },
    );
  }

  async addSnapshot(snap: SnapshotMeta): Promise<void> {
    await this.snapshots.updateOne({ board: snap.board, seq: snap.seq }, { $setOnInsert: snap }, { upsert: true });
    await this.boards.updateOne(
      { board: snap.board },
      { $max: { lastSnapshotSeq: snap.seq, lastSnapshotTs: snap.ts } },
      { upsert: true },
    );
  }

  async findSnapshotAtOrBefore(board: string, seq: number): Promise<SnapshotMeta | null> {
    return await this.snapshots.findOne(
      { board, seq: { $lte: seq } },
      { sort: { seq: -1 }, projection: { _id: 0 } },
    );
  }

  async segmentsInRange(board: string, fromSeq: number, toSeq: number): Promise<SegmentMeta[]> {
    return await this.segments
      .find({ board, endSeq: { $gte: fromSeq }, startSeq: { $lte: toSeq } }, { projection: { _id: 0 } })
      .sort({ startSeq: 1 })
      .toArray();
  }

  async segmentAtTime(board: string, ts: number): Promise<SegmentMeta | null> {
    return await this.segments.findOne(
      { board, startTs: { $lte: ts } },
      { sort: { startTs: -1, startSeq: -1 }, projection: { _id: 0 } },
    );
  }

  async listSnapshots(board: string): Promise<SnapshotMeta[]> {
    return await this.snapshots.find({ board }, { projection: { _id: 0 } }).sort({ seq: 1 }).toArray();
  }
}
