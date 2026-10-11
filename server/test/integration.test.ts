import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WS from "ws";

// y-websocket's default WebSocketPolyfill is the browser global `WebSocket`,
// which doesn't exist in plain Node - so we hand it the `ws` package.
const WebSocketPolyfill = WS as unknown as typeof WebSocket;

const PORT = 12345 + Math.floor(Math.random() * 1000);
const WS_URL = `ws://localhost:${PORT}`;

let serverProcess: ChildProcess;

async function waitForServerReady(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error("server did not become ready in time");
}

beforeAll(async () => {
  serverProcess = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "pipe",
  });
  await waitForServerReady();
}, 20_000);

afterAll(() => {
  serverProcess.kill();
});

describe("two clients editing the same room", () => {
  it("converges to the same shapes map after concurrent edits (CRDT merge)", async () => {
    const room = `test-room-${Date.now()}`;

    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const provider1 = new WebsocketProvider(WS_URL, room, doc1, { WebSocketPolyfill });
    const provider2 = new WebsocketProvider(WS_URL, room, doc2, { WebSocketPolyfill });

    await Promise.all([waitForSynced(provider1), waitForSynced(provider2)]);

    const shapes1 = doc1.getMap("shapes");
    const shapes2 = doc2.getMap("shapes");

    // Concurrent, non-conflicting edits from two "different browsers".
    shapes1.set("rect-a", { type: "rect", x: 10, y: 10, color: "red" });
    shapes2.set("rect-b", { type: "rect", x: 50, y: 50, color: "blue" });

    await waitForCondition(() => shapes1.size === 2 && shapes2.size === 2);

    expect(shapes1.toJSON()).toEqual(shapes2.toJSON());
    expect(Object.keys(shapes1.toJSON()).sort()).toEqual(["rect-a", "rect-b"]);

    provider1.destroy();
    provider2.destroy();
    doc1.destroy();
    doc2.destroy();
  }, 15_000);

  it("merges edits made while offline once a client reconnects", async () => {
    const room = `test-room-offline-${Date.now()}`;

    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const provider1 = new WebsocketProvider(WS_URL, room, doc1, { WebSocketPolyfill });
    const provider2 = new WebsocketProvider(WS_URL, room, doc2, { WebSocketPolyfill });
    await Promise.all([waitForSynced(provider1), waitForSynced(provider2)]);

    // Simulate client 2 going offline.
    provider2.disconnect();

    const shapes1 = doc1.getMap("shapes");
    const shapes2 = doc2.getMap("shapes");

    // Client 1 keeps editing while client 2 is offline...
    shapes1.set("online-edit", { type: "sticky", text: "made while peer offline" });
    // ...and client 2 also edits locally while offline (this is the case a
    // naive "last write wins" approach would silently drop).
    shapes2.set("offline-edit", { type: "sticky", text: "made while I was offline" });

    await waitForCondition(() => shapes1.size === 2, 5000).catch(() => {
      // fine if it doesn't reach client1 yet - client2 is offline
    });

    provider2.connect();
    await waitForCondition(() => shapes1.size === 2 && shapes2.size === 2, 8000);

    expect(shapes1.toJSON()).toEqual(shapes2.toJSON());
    expect(Object.keys(shapes1.toJSON()).sort()).toEqual(["offline-edit", "online-edit"]);

    provider1.destroy();
    provider2.destroy();
    doc1.destroy();
    doc2.destroy();
  }, 20_000);
});

function waitForSynced(provider: WebsocketProvider): Promise<void> {
  return new Promise((resolve) => {
    if (provider.synced) {
      resolve();
      return;
    }
    provider.once("sync", () => resolve());
  });
}

async function waitForCondition(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await sleep(50);
  }
}
