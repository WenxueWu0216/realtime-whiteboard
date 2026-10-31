import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { createApi } from "./http-api.js";
import { Persistence } from "./persistence.js";
import { RedisAdapter } from "./redis-adapter.js";
import { Recording } from "./recording/recording.js";
import { RoomManager } from "./room-manager.js";
import { setupConnection } from "./ws-handler.js";

const SHUTDOWN_DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 5_000);

async function main() {
  const cfg = loadConfig();
  const redis = new RedisAdapter(cfg.redisUrl);
  const persistence = new Persistence(cfg.mongoUrl);
  await persistence.connect();
  const recording = await Recording.create(cfg, { redis: redis.publisher, db: persistence.database });
  const roomManager = new RoomManager(redis, persistence, recording);

  let shuttingDown = false;
  const app = createApi({
    roomManager,
    redis,
    persistence,
    recording,
    corsOrigin: cfg.corsOrigin,
    isShuttingDown: () => shuttingDown,
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  httpServer.on("upgrade", (request, socket, head) => {
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    // Path convention (matches y-websocket client default): /<room-name>
    const roomName = decodeURIComponent(url.pathname.replace(/^\//, "")) || "default";

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, request, roomName);
    });
  });

  wss.on("connection", async (ws: WebSocket, _req: IncomingMessage, roomName: string) => {
    // The y-websocket client sends its sync step 1 the moment the socket
    // opens. Room init is async (Mongo load, Redis subscribe), so buffer
    // anything that arrives before the real handler is attached instead of
    // silently dropping it (which would leave the client never "synced").
    const early: Buffer[] = [];
    const bufferEarly = (data: Buffer) => early.push(data);
    ws.on("message", bufferEarly);
    try {
      const room = await roomManager.getOrCreate(roomName);
      ws.off("message", bufferEarly);
      if (ws.readyState !== ws.OPEN) {
        roomManager.notifyMaybeEmpty(roomName);
        return;
      }
      setupConnection(ws, room, roomManager);
      for (const data of early) ws.emit("message", data, true);
    } catch (err) {
      console.error(`[ws] failed to join room "${roomName}":`, err);
      ws.close(1011, "internal error");
    }
  });

  httpServer.listen(cfg.port, () => {
    console.log(`[whiteboard-server] ${cfg.instanceId} listening on :${cfg.port}`);
    console.log(`[whiteboard-server] redis: ${redis.isEnabled ? "enabled" : "disabled (single-instance mode)"}`);
    console.log(`[whiteboard-server] mongo: ${persistence.isEnabled ? "enabled" : "disabled (in-memory only)"}`);
    console.log(
      `[whiteboard-server] recording: ${recording.enabled ? `on, object store=${recording.store.kind}` : "off"}`,
    );
  });

  /**
   * Graceful shutdown (Kubernetes sends SIGTERM, then SIGKILL after
   * terminationGracePeriodSeconds):
   *   1. fail /readyz so the Service/LB stops routing new connections here
   *   2. wait a moment for endpoints to propagate, refuse new upgrades
   *   3. close client sockets with 1001 "going away" (y-websocket clients
   *      reconnect to another pod and resync via state vectors - no data loss)
   *   4. persist live docs and flush every recorder's pending op batch to S3
   */
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[whiteboard-server] ${signal}: draining for ${SHUTDOWN_DRAIN_MS}ms...`);
    await new Promise((r) => setTimeout(r, SHUTDOWN_DRAIN_MS));
    wss.clients.forEach((ws) => ws.close(1001, "server shutting down"));
    httpServer.close();
    try {
      await roomManager.closeAll();
      await recording.shutdown();
    } catch (err) {
      console.error("[whiteboard-server] error while flushing on shutdown", err);
    }
    await redis.close();
    await persistence.close();
    console.log("[whiteboard-server] bye");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
