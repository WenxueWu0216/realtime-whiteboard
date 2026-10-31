import type { Config } from "../../src/config.js";
import { MemoryRecordingIndex } from "../../src/recording/index-store.js";
import { MemoryObjectStore } from "../../src/recording/object-store.js";
import { MemoryOpLog } from "../../src/recording/op-log.js";
import { Recorder } from "../../src/recording/recorder.js";
import { ReplayService } from "../../src/recording/replay.js";

export const baseRecordingCfg: Config["recording"] = {
  enabled: true,
  snapshotEveryOps: 1000,
  snapshotEveryMs: 60_000,
  segmentMaxOps: 500,
  segmentMaxAgeMs: 5_000,
  tickMs: 1_000_000, // tests drive ticks manually
  leaseMs: 15_000,
};

/**
 * An in-memory recording pipeline with a fake clock: append ops, run the
 * recorder whenever you like (`tickEvery`), and query replay.
 */
export async function recordBoard(
  ops: Uint8Array[],
  opts: {
    cfg?: Partial<Config["recording"]>;
    /** gap in ms between consecutive ops (fake clock) */
    gapMs?: (i: number) => number;
    /** run a recorder tick after every N appends (0 = only at the end) */
    tickEvery?: number;
    store?: MemoryObjectStore;
    board?: string;
  } = {},
) {
  const board = opts.board ?? "board-1";
  let clock = 1_700_000_000_000;
  const oplog = new MemoryOpLog(() => clock);
  const store = opts.store ?? new MemoryObjectStore();
  const index = new MemoryRecordingIndex();
  const replay = new ReplayService(store, index, oplog);
  const cfg = { ...baseRecordingCfg, ...opts.cfg };
  const recorder = new Recorder(board, { oplog, store, index, replay, cfg, owner: "test", now: () => clock });
  const timestamps: number[] = [];

  for (let i = 0; i < ops.length; i++) {
    clock += opts.gapMs ? opts.gapMs(i) : 100;
    timestamps.push(oplog.appendSync(board, ops[i]).ts);
    if (opts.tickEvery && (i + 1) % opts.tickEvery === 0) await recorder.tick();
  }
  await recorder.tick(true);
  return { board, oplog, store, index, replay, recorder, timestamps, cfg };
}
