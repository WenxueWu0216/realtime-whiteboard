import { describe, expect, it } from "vitest";
import { fingerprint, generateSession, replayAll } from "./helpers/session.js";
import { recordBoard } from "./helpers/recorded-board.js";
import * as Y from "yjs";

describe("seek over a long session", () => {
  const N = 20_000;
  const SNAP = 500;
  const ops = generateSession({ ops: N, clients: 6, seed: 2024 });

  it("lands on the exact state at any seq while applying at most one snapshot interval of ops", async () => {
    const r = await recordBoard(ops, { cfg: { snapshotEveryOps: SNAP, snapshotEveryMs: 1e12, segmentMaxOps: 250 }, gapMs: (i) => 50 + (i % 7) * 30 });
    const snaps = await r.index.listSnapshots(r.board);
    expect(snaps.length).toBe(Math.floor(N / SNAP));

    // Ground truth checkpoints computed once by a single forward pass.
    const targets = [1, 499, 500, 501, 7_777, 12_345, 15_000, 19_999, N];
    for (let i = 0; i < 20; i++) targets.push(1 + Math.floor(Math.random() * N));
    targets.sort((a, b) => a - b);
    const truth = new Map<number, ReturnType<typeof fingerprint>>();
    const doc = new Y.Doc();
    let applied = 0;
    for (const t of targets) {
      while (applied < t) Y.applyUpdate(doc, ops[applied++]);
      truth.set(t, fingerprint(doc));
    }

    // Seek in random order (backwards and forwards), like a user dragging the scrubber.
    for (const t of [...targets].sort(() => Math.random() - 0.5)) {
      const got = await r.replay.reconstruct(r.board, t);
      expect(got.seq).toBe(t);
      expect(got.snapshot?.seq ?? 0).toBe(Math.floor(t / SNAP) * SNAP === t ? t : Math.floor(t / SNAP) * SNAP);
      expect(got.opsApplied).toBeLessThan(SNAP);
      expect(fingerprint(got.doc)).toEqual(truth.get(t));
      got.doc.destroy();
    }
  }, 60_000);

  it("resolves ?at=<ms offset> to the last op at or before that time", async () => {
    const gap = (i: number) => 100 + (i % 5) * 100; // irregular spacing
    const r = await recordBoard(ops.slice(0, 5_000), { cfg: { snapshotEveryOps: SNAP, snapshotEveryMs: 1e12, segmentMaxOps: 250 }, gapMs: gap });
    const start = r.timestamps[0];
    for (const idx of [0, 1, 999, 2500, 4999]) {
      // exactly at an op's timestamp -> that op
      const exact = await r.replay.resolveTarget(r.board, { atMs: r.timestamps[idx] - start });
      expect(exact.seq).toBe(idx + 1);
      // 1 ms before the next op -> still this op
      if (idx + 1 < r.timestamps.length) {
        const before = await r.replay.resolveTarget(r.board, { atMs: r.timestamps[idx + 1] - 1 - start });
        expect(before.seq).toBe(idx + 1);
      }
    }
    expect((await r.replay.resolveTarget(r.board, { atMs: 10 ** 12 })).seq).toBe(5_000);
    // timestamps never decrease
    for (let i = 1; i < r.timestamps.length; i++) expect(r.timestamps[i]).toBeGreaterThanOrEqual(r.timestamps[i - 1]);
  });

  it("plan mode hands out exactly the objects needed (snapshot + segments after it)", async () => {
    const r = await recordBoard(ops.slice(0, 3_000), { cfg: { snapshotEveryOps: 1000, snapshotEveryMs: 1e12, segmentMaxOps: 200 } });
    const plan = await r.replay.plan(r.board, null, 2_345);
    expect(plan.snapshot?.seq).toBe(2_000);
    expect(plan.segments[0].startSeq).toBeLessThanOrEqual(2_001);
    expect(plan.segments.at(-1)!.endSeq).toBeGreaterThanOrEqual(2_345);
    expect(plan.segments.every((s) => s.endSeq > 2_000)).toBe(true);
    expect(plan.tail).toEqual([]);
    const truth = replayAll(ops, 2_345);
    const rebuilt = await r.replay.reconstruct(r.board, 2_345);
    expect(fingerprint(rebuilt.doc)).toEqual(fingerprint(truth));
  });
});
