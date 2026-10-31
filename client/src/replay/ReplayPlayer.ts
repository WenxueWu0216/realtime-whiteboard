import * as Y from "yjs";
import { api, b64ToBytes, fetchSegment, fetchSnapshot, type OpRecord, type ReplayPlan, type Timeline } from "./api";
import type { ShapeData } from "../types";

export interface SeekDebug {
  strategy: "snapshot" | "forward" | "before-first-snapshot";
  target: number;
  snapshotSeq: number | null;
  snapshotKey: string | null;
  opsApplied: number;
  segmentsFetched: number;
  ms: number;
}

export interface PlayerState {
  seq: number;
  ts: number | null;
  playing: boolean;
  speed: number;
  loading: boolean;
  shapes: Record<string, ShapeData>;
  timeline: Timeline | null;
  debug: SeekDebug | null;
  error: string | null;
}

/** Seeking forward by fewer ops than this reuses the buffered ops instead of reloading a snapshot. */
const FORWARD_SEEK_MAX_OPS = 300;
/** Keep at least this many future ops buffered during playback. */
const LOW_WATER = 300;
const FETCH_CHUNK = 2000;
/** Idle gaps longer than this (session time) are compressed during playback. */
const MAX_GAP_MS = 1500;

/**
 * Client-side replay engine.
 *
 * seek(target):
 *   1. ask the server for a plan: nearest snapshot <= target + the segment
 *      objects covering (snapshot, target], as presigned S3 URLs
 *   2. download them directly from S3, load the snapshot into a fresh Y.Doc,
 *      apply only the ops after it
 *   3. keep ops beyond the target from those segments buffered for playback
 * Seeking therefore never replays from the start: cost is bounded by one
 * snapshot interval, regardless of how long the session is.
 */
export class ReplayPlayer {
  private doc = new Y.Doc();
  private buffer: OpRecord[] = [];
  private bufferedTo = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fetching: Promise<void> | null = null;
  private seekToken = 0;
  private listeners = new Set<(s: PlayerState) => void>();
  private renderQueued = false;

  state: PlayerState = {
    seq: 0,
    ts: null,
    playing: false,
    speed: 1,
    loading: false,
    shapes: {},
    timeline: null,
    debug: null,
    error: null,
  };

  constructor(readonly board: string) {}

  subscribe(fn: (s: PlayerState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Coalesce shape re-renders to one per animation frame (4x playback can apply many ops per frame). */
  private queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.set({ shapes: this.doc.getMap<ShapeData>("shapes").toJSON() as Record<string, ShapeData> });
    });
  }

  async init(): Promise<void> {
    const timeline = await api.timeline(this.board);
    this.set({ timeline });
    await this.seek({ seq: timeline.headSeq });
  }

  async refreshTimeline(): Promise<Timeline> {
    const timeline = await api.timeline(this.board);
    this.set({ timeline });
    return timeline;
  }

  destroy() {
    this.pause();
    this.doc.destroy();
    this.listeners.clear();
  }

  async seek(target: { seq?: number; atMs?: number }): Promise<void> {
    const token = ++this.seekToken;
    const wasPlaying = this.state.playing;
    this.stopTimer();
    this.clock = null;
    this.set({ loading: true, error: null });
    const t0 = performance.now();
    try {
      // Cheap path: small forward jump within what we already have buffered.
      const fwdSeq = this.forwardTargetSeq(target);
      if (fwdSeq !== null) {
        await this.ensureBuffered(fwdSeq);
        if (token !== this.seekToken) return;
        const n = this.applyBufferedThrough(fwdSeq);
        this.set({
          debug: { strategy: "forward", target: fwdSeq, snapshotSeq: null, snapshotKey: null, opsApplied: n, segmentsFetched: 0, ms: performance.now() - t0 },
        });
        return;
      }

      const plan = await api.plan(this.board, target);
      if (token !== this.seekToken) return;
      const doc = new Y.Doc();
      let seq = 0;
      let ts: number | null = null;
      if (plan.snapshot?.url) {
        const snap = await fetchSnapshot(plan.snapshot.url);
        Y.applyUpdate(doc, snap.state, "replay");
        seq = snap.seq;
        ts = snap.ts;
      }
      const future: OpRecord[] = [];
      let applied = 0;
      const consume = (ops: OpRecord[]) => {
        for (const op of ops) {
          if (op.seq <= seq) continue;
          if (op.seq <= plan.targetSeq && op.seq === seq + 1) {
            Y.applyUpdate(doc, op.op, "replay");
            seq = op.seq;
            ts = op.ts;
            applied++;
          } else if (op.seq > plan.targetSeq) {
            future.push(op);
          }
        }
      };
      const segOps = await Promise.all(plan.segments.map((s) => fetchSegment(s.url!)));
      for (const ops of segOps) consume(ops);
      consume(plan.tail.map((o) => ({ seq: o.seq, ts: o.ts, op: b64ToBytes(o.op) })));
      if (token !== this.seekToken) {
        doc.destroy();
        return;
      }

      this.doc.destroy();
      this.doc = doc;
      this.buffer = future.sort((a, b) => a.seq - b.seq);
      this.bufferedTo = this.buffer.length ? this.buffer[this.buffer.length - 1].seq : seq;
      this.set({
        seq,
        ts,
        shapes: doc.getMap<ShapeData>("shapes").toJSON() as Record<string, ShapeData>,
        debug: {
          strategy: plan.snapshot ? "snapshot" : "before-first-snapshot",
          target: plan.targetSeq,
          snapshotSeq: plan.snapshot?.seq ?? null,
          snapshotKey: plan.snapshot?.key ?? null,
          opsApplied: applied,
          segmentsFetched: plan.segments.length,
          ms: performance.now() - t0,
        },
      });
      void this.fillBuffer(); // prefetch ahead so play / short forward seeks need no round trip
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (token === this.seekToken) {
        this.set({ loading: false });
        if (wasPlaying) this.play();
      }
    }
  }

  /** If target is a short hop forward from the current position, the seq to advance to; else null. */
  private forwardTargetSeq(target: { seq?: number; atMs?: number }): number | null {
    const cur = this.state.seq;
    if (target.seq !== undefined) {
      return target.seq >= cur && target.seq - cur <= FORWARD_SEEK_MAX_OPS ? target.seq : null;
    }
    const start = this.state.timeline?.startTs;
    if (target.atMs === undefined || start == null || this.state.ts === null) return null;
    const ts = start + target.atMs;
    if (ts < this.state.ts) return null;
    // Only if the buffered ops reach past the target time.
    const last = this.buffer[this.buffer.length - 1];
    if (!last || last.ts < ts) return null;
    let seq = cur;
    for (const op of this.buffer) {
      if (op.ts > ts) break;
      seq = op.seq;
    }
    return seq - cur <= FORWARD_SEEK_MAX_OPS ? seq : null;
  }

  play() {
    if (this.state.playing && this.timer) return;
    this.set({ playing: true });
    this.scheduleNext();
  }

  pause() {
    this.stopTimer();
    this.clock = null;
    this.set({ playing: false });
  }

  setSpeed(speed: number) {
    this.clock = null; // re-anchor so the new speed applies from now
    this.set({ speed });
  }

  private stopTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Playback runs on a virtual session clock instead of one timer per op:
   * every frame we advance session time by (wall time elapsed x speed) and
   * apply every op whose server timestamp is now due. Browsers clamp timers
   * to a few ms, so per-op timers can't keep up with fast edits at 4x; this
   * can, and stays faithful to the recorded timing. Idle gaps longer than
   * MAX_GAP_MS are skipped.
   */
  private clock: { wall: number; session: number } | null = null;

  private scheduleNext() {
    if (!this.state.playing) return;
    this.timer = setTimeout(() => this.playbackTick(), 16);
  }

  private playbackTick() {
    if (!this.state.playing) return;
    if (this.buffer.length < LOW_WATER) void this.fillBuffer();
    const next = this.buffer[0];
    if (!next) {
      this.clock = null;
      // Caught up with what we have: wait for more (live tail) or stop at the head.
      void (async () => {
        await this.fillBuffer();
        if (!this.buffer.length) {
          const tl = await this.refreshTimeline();
          if (tl.headSeq <= this.state.seq) {
            this.pause();
            return;
          }
        }
        this.scheduleNext();
      })();
      return;
    }
    const now = performance.now();
    if (!this.clock) this.clock = { wall: now, session: this.state.ts ?? next.ts };
    let session = this.clock.session + (now - this.clock.wall) * this.state.speed;
    if (next.ts - session > MAX_GAP_MS) session = next.ts - MAX_GAP_MS; // compress idle time
    this.clock = { wall: now, session };

    let through = -1;
    for (const op of this.buffer) {
      if (op.ts > session) break;
      through = op.seq;
    }
    if (through >= 0) this.applyBufferedThrough(through);
    this.scheduleNext();
  }

  private applyBufferedThrough(seq: number): number {
    let n = 0;
    let ts = this.state.ts;
    let cur = this.state.seq;
    this.doc.transact(() => {
      while (this.buffer.length && this.buffer[0].seq <= seq) {
        const op = this.buffer.shift()!;
        if (op.seq !== cur + 1) continue;
        Y.applyUpdate(this.doc, op.op, "replay");
        cur = op.seq;
        ts = op.ts;
        n++;
      }
    }, "replay");
    this.state = { ...this.state, seq: cur, ts };
    this.queueRender();
    for (const l of this.listeners) l(this.state);
    return n;
  }

  private async ensureBuffered(seq: number) {
    while (this.bufferedTo < seq) {
      const before = this.bufferedTo;
      await this.fillBuffer();
      if (this.bufferedTo === before) break;
    }
  }

  private fillBuffer(): Promise<void> {
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      try {
        const after = this.bufferedTo;
        const plan: ReplayPlan = await api.opsAfter(this.board, after, after + FETCH_CHUNK);
        const ops: OpRecord[] = [];
        for (const s of plan.segments) ops.push(...(await fetchSegment(s.url!)));
        ops.push(...plan.tail.map((o) => ({ seq: o.seq, ts: o.ts, op: b64ToBytes(o.op) })));
        if (after !== this.bufferedTo) return; // a seek reset the buffer meanwhile
        let next = after + 1;
        for (const op of ops.sort((a, b) => a.seq - b.seq)) {
          if (op.seq !== next) continue;
          this.buffer.push(op);
          next++;
        }
        this.bufferedTo = next - 1;
      } finally {
        this.fetching = null;
      }
    })();
    return this.fetching;
  }
}
