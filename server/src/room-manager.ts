import { Persistence } from "./persistence.js";
import { RedisAdapter } from "./redis-adapter.js";
import { Room } from "./room.js";

const EMPTY_ROOM_TTL_MS = 30_000;

/**
 * Owns the in-memory map of active rooms. A room is created lazily on first
 * connection and torn down a short while after the last client leaves
 * (rather than instantly, so a page refresh doesn't cause a pointless
 * snapshot-reload churn).
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly initializing = new Map<string, Promise<Room>>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly redis: RedisAdapter,
    private readonly persistence: Persistence,
  ) {}

  /**
   * Returns the room once it is fully initialised (snapshot applied, Redis
   * subscribed). Concurrent callers for a room that is still initialising
   * share the same in-flight promise instead of receiving a half-loaded
   * room, and a room whose init fails is not left behind in the map.
   */
  getOrCreate(name: string): Promise<Room> {
    this.cancelCleanup(name);
    const existing = this.rooms.get(name);
    if (existing) return Promise.resolve(existing);
    const pending = this.initializing.get(name);
    if (pending) return pending;

    const room = new Room(name, this.redis, this.persistence);
    const ready = room.init().then(
      () => {
        this.initializing.delete(name);
        this.rooms.set(name, room);
        return room;
      },
      async (err: unknown) => {
        this.initializing.delete(name);
        await room.destroy().catch(() => {});
        throw err;
      },
    );
    this.initializing.set(name, ready);
    return ready;
  }

  notifyMaybeEmpty(name: string): void {
    const room = this.rooms.get(name);
    if (!room || room.connectionCount > 0) return;
    this.cancelCleanup(name);
    const timer = setTimeout(() => {
      const current = this.rooms.get(name);
      if (current && current.connectionCount === 0) {
        this.rooms.delete(name);
        void current.destroy();
      }
      this.cleanupTimers.delete(name);
    }, EMPTY_ROOM_TTL_MS);
    this.cleanupTimers.set(name, timer);
  }

  private cancelCleanup(name: string): void {
    const timer = this.cleanupTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(name);
    }
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  listRooms(): { name: string; connections: number }[] {
    return Array.from(this.rooms.values()).map((r) => ({
      name: r.name,
      connections: r.connectionCount,
    }));
  }
}
