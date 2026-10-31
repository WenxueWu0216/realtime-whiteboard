import { Binary, MongoClient, type Db } from "mongodb";

interface SnapshotDoc {
  room: string;
  state: Binary;
  updatedAt: Date;
}

/**
 * Periodic snapshot persistence for room documents.
 *
 * We don't persist every single update (that would be a lot of tiny writes
 * and Yjs updates are meant to be merged, not replayed one by one). Instead
 * each Room debounces a full `Y.encodeStateAsUpdate(doc)` snapshot a few
 * seconds after the last change and upserts it by room name. On server
 * restart / room re-creation we load that single snapshot and
 * `Y.applyUpdate` it into a fresh doc, which restores full history state
 * (not just the latest values) because Yjs updates are themselves
 * CRDT-mergeable blobs.
 *
 * Degrades gracefully: with no MONGO_URL configured this is a no-op and
 * rooms simply live in memory for the lifetime of the process.
 */
export class Persistence {
  private readonly enabled: boolean;
  private client: MongoClient | null = null;
  private db: Db | null = null;

  constructor(private readonly mongoUrl?: string) {
    this.enabled = Boolean(mongoUrl);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) return;
    this.client = new MongoClient(this.mongoUrl as string);
    await this.client.connect();
    this.db = this.client.db(process.env.MONGO_DB ?? "whiteboard");
    await this.db
      .collection<SnapshotDoc>("room_snapshots")
      .createIndex({ room: 1 }, { unique: true });
  }

  /** Shared with the recording index (same database, separate collections). */
  get database(): Db | null {
    return this.db;
  }

  async ping(): Promise<boolean> {
    if (!this.enabled || !this.db) return true;
    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async loadSnapshot(room: string): Promise<Uint8Array | null> {
    if (!this.enabled || !this.db) return null;
    const doc = await this.db
      .collection<SnapshotDoc>("room_snapshots")
      .findOne({ room });
    if (!doc) return null;
    return new Uint8Array(doc.state.buffer);
  }

  async saveSnapshot(room: string, state: Uint8Array): Promise<void> {
    if (!this.enabled || !this.db) return;
    await this.db.collection<SnapshotDoc>("room_snapshots").updateOne(
      { room },
      {
        $set: {
          room,
          state: new Binary(Buffer.from(state)),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async close(): Promise<void> {
    if (!this.enabled) return;
    await this.client?.close();
  }
}
