import { createServer, type IncomingMessage } from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { Persistence } from "./persistence.js";
import { RedisAdapter } from "./redis-adapter.js";
import { RoomManager } from "./room-manager.js";
import { setupConnection } from "./ws-handler.js";

const PORT = Number(process.env.PORT ?? 1234);
const REDIS_URL = process.env.REDIS_URL; // e.g. redis://localhost:6379
const MONGO_URL = process.env.MONGO_URL; // e.g. mongodb://localhost:27017

async function main() {
  const redis = new RedisAdapter(REDIS_URL);
  const persistence = new Persistence(MONGO_URL);
  await persistence.connect();
  const roomManager = new RoomManager(redis, persistence);

  const app = express();
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      rooms: roomManager.roomCount,
      redis: redis.isEnabled,
      persistence: persistence.isEnabled,
    });
  });
  app.get("/rooms", (_req, res) => {
    res.json(roomManager.listRooms());
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    // Path convention (matches y-websocket client default): /<room-name>
    const roomName = decodeURIComponent(url.pathname.replace(/^\//, "")) || "default";

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, request, roomName);
    });
  });

  wss.on("connection", async (ws: WebSocket, _req: IncomingMessage, roomName: string) => {
    try {
      const room = await roomManager.getOrCreate(roomName);
      setupConnection(ws, room, roomManager);
    } catch (err) {
      console.error(`[ws] failed to join room "${roomName}":`, err);
      ws.close(1011, "internal error");
    }
  });

  httpServer.listen(PORT, () => {
    console.log(`[whiteboard-server] listening on :${PORT}`);
    console.log(`[whiteboard-server] redis pub/sub: ${redis.isEnabled ? "enabled" : "disabled (single-instance mode)"}`);
    console.log(`[whiteboard-server] mongo persistence: ${persistence.isEnabled ? "enabled" : "disabled (in-memory only)"}`);
  });

  const shutdown = async () => {
    console.log("[whiteboard-server] shutting down...");
    wss.clients.forEach((ws) => ws.close(1001, "server shutting down"));
    httpServer.close();
    await redis.close();
    await persistence.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
