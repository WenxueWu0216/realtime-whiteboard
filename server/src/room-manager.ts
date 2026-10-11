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
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly redis: RedisAdapter,
    private readonly persistence: Persistence,
  ) {}

  async getOrCreate(name: string): Promise<Room> {
    const existing = this.rooms.get(name);
    if (existing) {
      this.cancelCleanup(name);
      return existing;
    }
    const room = new Room(name, this.redis, this.persistence);
    this.rooms.set(name, room);
    await room.init();
    return room;
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
