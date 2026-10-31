import type Redis from "ioredis";
import type { Db } from "mongodb";
import type { Config } from "../config.js";
import { MemoryRecordingIndex, MongoRecordingIndex, type RecordingIndex } from "./index-store.js";
import { MemoryObjectStore, S3ObjectStore, type ObjectStore } from "./object-store.js";
import { MemoryOpLog, RedisOpLog, type OpLog, type PublishSpec } from "./op-log.js";
import { Recorder } from "./recorder.js";
import { ReplayService } from "./replay.js";

/**
 * Facade the rest of the server talks to: append ops, keep one Recorder per
 * locally-open board, and serve replay queries.
 */
export class Recording {
  readonly replay: ReplayService;
  private readonly recorders = new Map<string, Recorder>();

  constructor(
    readonly oplog: OpLog,
    readonly store: ObjectStore,
    readonly index: RecordingIndex,
    private readonly cfg: Config["recording"],
    private readonly owner: string,
  ) {
    this.replay = new ReplayService(store, index, oplog);
  }

  static async create(cfg: Config, deps: { redis: Redis | null; db: Db | null }): Promise<Recording> {
    const oplog: OpLog = deps.redis ? new RedisOpLog(deps.redis) : new MemoryOpLog();
    let store: ObjectStore;
    if (cfg.s3.bucket) {
      const s3 = new S3ObjectStore(cfg.s3);
      if (cfg.s3.endpoint) await s3.ensureBucket(); // MinIO/LocalStack only
      store = s3;
    } else {
      store = new MemoryObjectStore();
    }
    let index: RecordingIndex;
    if (deps.db) {
      const mongoIndex = new MongoRecordingIndex(deps.db);
      await mongoIndex.ensureIndexes();
      index = mongoIndex;
    } else {
      index = new MemoryRecordingIndex();
    }
    return new Recording(oplog, store, index, cfg.recording, cfg.instanceId);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  append(board: string, op: Uint8Array, publish?: PublishSpec): Promise<{ seq: number; ts: number }> {
    return this.oplog.append(board, op, publish);
  }

  /** Called when a board becomes active on this pod. */
  attach(board: string): void {
    if (!this.cfg.enabled || this.recorders.has(board)) return;
    const r = new Recorder(board, {
      oplog: this.oplog,
      store: this.store,
      index: this.index,
      replay: this.replay,
      cfg: this.cfg,
      owner: this.owner,
    });
    this.recorders.set(board, r);
    r.start();
    void r.tick().catch((e) => console.error(`[recorder ${board}]`, e));
  }

  /** Called when a board is no longer open on this pod: flush and release the lease. */
  async detach(board: string): Promise<void> {
    const r = this.recorders.get(board);
    if (!r) return;
    this.recorders.delete(board);
    await r.stop();
  }

  async shutdown(): Promise<void> {
    await Promise.all(Array.from(this.recorders.keys()).map((b) => this.detach(b)));
  }

  recorderStatus(): { board: string; holding: boolean; segments: number; snapshots: number; takeovers: number }[] {
    return Array.from(this.recorders.values()).map((r) => ({ board: r.board, holding: r.isHolding, ...r.stats }));
  }
}
