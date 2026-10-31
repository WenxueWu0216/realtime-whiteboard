import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeSegment, decodeSnapshot, encodeSegment, encodeSnapshot } from "../src/recording/codec.js";
import { fingerprint, generateSession, replayAll } from "./helpers/session.js";
import { recordBoard } from "./helpers/recorded-board.js";

describe("codec", () => {
  it("round-trips segments and snapshots", () => {
    const ops = generateSession({ ops: 20, seed: 7 }).map((op, i) => ({ seq: i + 1, ts: 1000 + i, op }));
    expect(decodeSegment(encodeSegment(ops))).toEqual(ops);
    const snap = { board: "b", seq: 5, ts: 9, state: ops[0].op, shapes: { a: 1 } };
    expect(decodeSnapshot(encodeSnapshot(snap))).toEqual(snap);
  });
});

describe("snapshot + ops up to k == replaying all ops 0..k (property)", () => {
  it("holds for random sessions, random snapshot/segment settings and random interleaving of appends and recorder ticks", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          nOps: fc.integer({ min: 0, max: 250 }),
          clients: fc.integer({ min: 1, max: 5 }),
          seed: fc.integer(),
          snapshotEveryOps: fc.integer({ min: 1, max: 60 }),
          snapshotEveryMs: fc.integer({ min: 50, max: 20_000 }),
          segmentMaxOps: fc.integer({ min: 1, max: 50 }),
          tickEvery: fc.integer({ min: 0, max: 40 }),
          maxGapMs: fc.integer({ min: 1, max: 2_000 }),
          ks: fc.array(fc.nat(), { minLength: 1, maxLength: 8 }),
        }),
        async (p) => {
          const ops = generateSession({ ops: p.nOps, clients: p.clients, seed: p.seed });
          let g = p.seed;
          const { board, replay, oplog } = await recordBoard(ops, {
            cfg: {
              snapshotEveryOps: p.snapshotEveryOps,
              snapshotEveryMs: p.snapshotEveryMs,
              segmentMaxOps: p.segmentMaxOps,
              segmentMaxAgeMs: 0,
            },
            tickEvery: p.tickEvery,
            gapMs: () => 1 + (Math.abs((g = (g * 1103515245 + 12345) | 0)) % p.maxGapMs),
          });

          // After a forced tick the hot tail must be empty: every op is durable.
          expect(await oplog.readAfter(board, 0)).toEqual([]);

          for (const kRaw of [...p.ks, 0, ops.length]) {
            const k = ops.length === 0 ? 0 : kRaw % (ops.length + 1);
            const viaSnapshot = await replay.reconstruct(board, k);
            const viaFullReplay = await replay.reconstruct(board, k, { useSnapshots: false });
            const truth = replayAll(ops, k);
            expect(viaSnapshot.seq).toBe(k);
            expect(fingerprint(viaSnapshot.doc)).toEqual(fingerprint(truth));
            expect(fingerprint(viaFullReplay.doc)).toEqual(fingerprint(truth));
            // and the snapshot path never applies more ops than one snapshot interval
            expect(viaSnapshot.opsApplied).toBeLessThanOrEqual(p.snapshotEveryOps);
            viaSnapshot.doc.destroy();
            viaFullReplay.doc.destroy();
            truth.destroy();
          }
        },
      ),
      { numRuns: 60 },
    );
  }, 120_000);

  it("also holds when part of the log is still only in the hot tail (not yet flushed)", async () => {
    const ops = generateSession({ ops: 300, seed: 42 });
    const r = await recordBoard(ops.slice(0, 200), { cfg: { snapshotEveryOps: 40, segmentMaxOps: 25 } });
    for (const op of ops.slice(200)) r.oplog.appendSync(r.board, op); // appended, recorder hasn't run
    for (const k of [150, 199, 200, 201, 260, 300]) {
      const got = await r.replay.reconstruct(r.board, k);
      expect(fingerprint(got.doc)).toEqual(fingerprint(replayAll(ops, k)));
    }
  });
});
