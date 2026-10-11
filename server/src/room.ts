import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type WebSocket from "ws";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { Persistence } from "./persistence.js";
import type { RedisAdapter } from "./redis-adapter.js";

export const messageSync = 0;
export const messageAwareness = 1;

// Tags used only on the server-to-server Redis channel (never seen by
// browser clients) so a receiving instance knows how to re-apply a message
// without re-parsing the client-facing wire protocol.
const redisTagUpdate = 0;
const redisTagAwareness = 1;

const SNAPSHOT_DEBOUNCE_MS = 3_000;

/**
 * One collaborative room: a single Y.Doc shared by every connection in it,
 * plus the plumbing to keep it in sync across local WebSocket clients,
 * other server instances (via Redis), and MongoDB (for restarts).
 *
 * The three origins used when applying updates to `doc`/`awareness` --
 * a WebSocket, the string "redis", or the string "persistence" -- exist
 * purely to stop rebroadcast loops: a change that arrived from Redis must
 * not be published back to Redis, and a change loaded from a snapshot at
 * startup must not trigger a fresh snapshot write.
 */
export class Room {
  readonly name: string;
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  readonly conns = new Map<WebSocket, Set<number>>();

  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    name: string,
    private readonly redis: RedisAdapter,
    private readonly persistence: Persistence,
  ) {
    this.name = name;
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState(null); // the server itself has no cursor

    this.doc.on("update", this.handleDocUpdate);
    this.awareness.on("update", this.handleAwarenessUpdate);
  }

  async init(): Promise<void> {
    const snapshot = await this.persistence.loadSnapshot(this.name);
    if (snapshot) Y.applyUpdate(this.doc, snapshot, "persistence");

    await this.redis.subscribeRoom(this.name);
    this.redis.onMessage((roomName, payload) => {
      if (roomName === this.name) this.applyRedisMessage(payload);
    });
  }

  addConnection(ws: WebSocket): void {
    this.conns.set(ws, new Set());
  }

  removeConnection(ws: WebSocket): void {
    const controlledClientIds = this.conns.get(ws);
    this.conns.delete(ws);
    if (controlledClientIds && controlledClientIds.size > 0) {
      removeAwarenessStates(this.awareness, Array.from(controlledClientIds), ws);
    }
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  broadcastLocal(message: Uint8Array, exclude?: WebSocket): void {
    for (const ws of this.conns.keys()) {
      if (ws === exclude) continue;
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(message);
    }
  }

  async destroy(): Promise<void> {
    this.closed = true;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    await this.redis.unsubscribeRoom(this.name);
    this.doc.off("update", this.handleDocUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.awareness.destroy();
    this.doc.destroy();
  }

  // --- internal -----------------------------------------------------------

  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    encoding.writeVarUint(encoder, 2 /* messageYjsUpdate */);
    encoding.writeVarUint8Array(encoder, update);
    this.broadcastLocal(encoding.toUint8Array(encoder));

    if (origin !== "redis" && origin !== "persistence") {
      const redisEncoder = encoding.createEncoder();
      encoding.writeVarUint(redisEncoder, redisTagUpdate);
      encoding.writeVarUint8Array(redisEncoder, update);
      this.redis.publish(this.name, Buffer.from(encoding.toUint8Array(redisEncoder)));
    }
    if (origin !== "persistence") this.scheduleSnapshot();
  };

  private handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const changedClients = added.concat(updated, removed);

    if (origin instanceof Object && this.conns.has(origin as WebSocket)) {
      const ws = origin as WebSocket;
      const owned = this.conns.get(ws)!;
      for (const id of added) owned.add(id);
      for (const id of removed) owned.delete(id);
    }

    const update = encodeAwarenessUpdate(this.awareness, changedClients);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(encoder, update);
    this.broadcastLocal(encoding.toUint8Array(encoder));

    if (origin !== "redis") {
      const redisEncoder = encoding.createEncoder();
      encoding.writeVarUint(redisEncoder, redisTagAwareness);
      encoding.writeVarUint8Array(redisEncoder, update);
      this.redis.publish(this.name, Buffer.from(encoding.toUint8Array(redisEncoder)));
    }
  };

  private applyRedisMessage(payload: Buffer): void {
    if (this.closed) return;
    const decoder = decoding.createDecoder(new Uint8Array(payload));
    const tag = decoding.readVarUint(decoder);
    const body = decoding.readVarUint8Array(decoder);

    if (tag === redisTagUpdate) {
      Y.applyUpdate(this.doc, body, "redis"); // triggers handleDocUpdate, which will skip re-publishing
    } else if (tag === redisTagAwareness) {
      applyAwarenessUpdate(this.awareness, body, "redis");
    }
  }

  private scheduleSnapshot(): void {
    if (!this.persistence.isEnabled) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      if (this.closed) return;
      const state = Y.encodeStateAsUpdate(this.doc);
      void this.persistence.saveSnapshot(this.name, state);
    }, SNAPSHOT_DEBOUNCE_MS);
  }
}
