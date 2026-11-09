import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import WS, { WebSocketServer } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { Persistence } from "../src/persistence.js";
import { RedisAdapter } from "../src/redis-adapter.js";
import { RoomManager } from "../src/room-manager.js";
import { acceptConnection } from "../src/ws-handler.js";

const WebSocketPolyfill = WS as unknown as typeof WebSocket;

/**
 * Regression tests for a race seen in CI: room creation is async (Mongo
 * snapshot load + Redis subscribe), and a client sends its first sync
 * message (SyncStep1) as soon as the socket opens. If that message arrives
 * before the server has attached its message handler it is dropped, the
 * server never answers with SyncStep2, and the client stays "connecting /
 * syncing" forever. The delays below make room creation slow on purpose so
 * the race happens every time instead of occasionally.
 */

/** Persistence stand-in whose snapshot load is slow (and optionally returns a doc). */
class SlowPersistence extends Persistence {
  constructor(
    private readonly delayMs: number,
    private readonly snapshot: Uint8Array | null = null,
  ) {
    super(undefined); // disabled: no Mongo, no snapshot writes
  }

  override async loadSnapshot(): Promise<Uint8Array | null> {
    await sleep(this.delayMs);
    return this.snapshot;
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer(roomManager: RoomManager): Promise<string> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    const roomName = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname.slice(1));
    wss.handleUpgrade(request, socket, head, (ws) => acceptConnection(ws, roomName, roomManager));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((c) => c.terminate());
        wss.close();
        httpServer.close(() => resolve());
      }),
  );
  return `ws://localhost:${(httpServer.address() as AddressInfo).port}`;
}

function connect(url: string, room: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(url, room, doc, { WebSocketPolyfill });
  cleanups.push(() => {
    provider.destroy();
    doc.destroy();
  });
  return { doc, provider };
}

function synced(provider: WebsocketProvider, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (provider.synced) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    provider.once("sync", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe("initial sync when room creation is slow", () => {
  it("does not drop the client's first sync message while the room is being created", async () => {
    const roomManager = new RoomManager(new RedisAdapter(undefined), new SlowPersistence(300));
    const url = await startServer(roomManager);

    const { provider } = connect(url, `slow-${Date.now()}`);

    // Before the fix this never resolved: SyncStep1 was lost during the
    // 300 ms room creation and the client waited forever.
    expect(await synced(provider, 3_000)).toBe(true);
  });

  it("gives concurrent joiners the room only after its snapshot is loaded", async () => {
    // A stored snapshot containing one shape.
    const stored = new Y.Doc();
    stored.getMap("shapes").set("from-snapshot", { type: "rect" });
    const snapshot = Y.encodeStateAsUpdate(stored);

    const roomManager = new RoomManager(new RedisAdapter(undefined), new SlowPersistence(300, snapshot));
    const room = `concurrent-${Date.now()}`;

    // Two joins racing for the same not-yet-existing room. Record what the
    // second caller sees at the exact moment it is handed the room.
    const first = roomManager.getOrCreate(room);
    const second = roomManager.getOrCreate(room).then((r) => ({
      room: r,
      hadSnapshot: r.doc.getMap("shapes").has("from-snapshot"),
    }));
    const [a, b] = await Promise.all([first, second]);

    expect(b.room).toBe(a);
    // Before the fix the second caller got the room immediately, before
    // the snapshot had been applied (an empty document).
    expect(b.hadSnapshot).toBe(true);
    await a.destroy();
  });

  it("clients that join during room creation still see the snapshot and each other", async () => {
    const stored = new Y.Doc();
    stored.getMap("shapes").set("from-snapshot", { type: "rect" });
    const roomManager = new RoomManager(
      new RedisAdapter(undefined),
      new SlowPersistence(300, Y.encodeStateAsUpdate(stored)),
    );
    const url = await startServer(roomManager);
    const room = `two-${Date.now()}`;

    const alice = connect(url, room);
    const bob = connect(url, room);
    expect(await synced(alice.provider, 3_000)).toBe(true);
    expect(await synced(bob.provider, 3_000)).toBe(true);

    alice.doc.getMap("shapes").set("from-alice", { type: "sticky" });
    const deadline = Date.now() + 3_000;
    while (!bob.doc.getMap("shapes").has("from-alice") && Date.now() < deadline) await sleep(20);

    expect(Object.keys(bob.doc.getMap("shapes").toJSON()).sort()).toEqual(["from-alice", "from-snapshot"]);
    expect(alice.doc.getMap("shapes").toJSON()).toEqual(bob.doc.getMap("shapes").toJSON());
  });
});
