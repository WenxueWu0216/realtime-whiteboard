import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type WebSocket from "ws";
import { applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { messageAwareness, messageSync, type Room } from "./room.js";
import type { RoomManager } from "./room-manager.js";

const PING_INTERVAL_MS = 30_000;

type IncomingData = ArrayBuffer | Buffer;

/**
 * Entry point for a freshly upgraded WebSocket: find or create the room,
 * then wire the connection into it.
 *
 * Room creation is async (Mongo snapshot load + Redis subscribe), but the
 * y-websocket client sends its first sync message (SyncStep1) the moment
 * the socket opens. `ws` does not buffer messages for listeners attached
 * later - anything emitted while nobody is listening is gone. A lost
 * SyncStep1 means the server never replies with SyncStep2 and the client
 * stays "syncing" forever. So a listener is attached *synchronously* here
 * and queues everything until the room is ready; setupConnection then
 * replays the queue in arrival order.
 */
export function acceptConnection(ws: WebSocket, roomName: string, roomManager: RoomManager): void {
  ws.binaryType = "arraybuffer";
  const queued: IncomingData[] = [];
  const enqueue = (data: IncomingData) => queued.push(data);
  ws.on("message", enqueue);

  roomManager.getOrCreate(roomName).then(
    (room) => {
      ws.off("message", enqueue);
      if (ws.readyState !== ws.OPEN) {
        // The client left while the room was being created; let the room
        // manager schedule cleanup of the (possibly empty) room.
        roomManager.notifyMaybeEmpty(room.name);
        return;
      }
      setupConnection(ws, room, roomManager, queued);
    },
    (err) => {
      ws.off("message", enqueue);
      console.error(`[ws] failed to join room "${roomName}":`, err);
      ws.close(1011, "internal error");
    },
  );
}

/**
 * Wires one client WebSocket connection into a Room, speaking the same wire
 * protocol as the `y-websocket` client library:
 *   [varUint messageType, ...payload]
 * messageType 0 = sync (nested Yjs sync-protocol messages: step1/step2/update)
 * messageType 1 = awareness (an encoded awareness update)
 *
 * This function only concerns itself with *this* connection's handshake and
 * message routing; propagation to other local connections, other server
 * instances (Redis) and Mongo persistence all live in Room, which every
 * connection in the same room shares.
 */
export function setupConnection(
  ws: WebSocket,
  room: Room,
  roomManager: RoomManager,
  queuedMessages: IncomingData[] = [],
): void {
  room.addConnection(ws);
  ws.binaryType = "arraybuffer";

  const send = (message: Uint8Array): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(message, (err) => {
      if (err) ws.close();
    });
  };

  // 1. Kick off sync: tell the client our state vector so it can compute
  //    and send back only the updates we're missing (this is what makes
  //    reconnect-after-offline merge "just work" -- no custom diffing).
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(encoding.toUint8Array(encoder));
  }

  // 2. Send current awareness state (other people's cursors/selections) so
  //    a newly-joined client sees who's already in the room immediately.
  {
    const states = room.awareness.getStates();
    if (states.size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        encodeAwarenessUpdate(room.awareness, Array.from(states.keys())),
      );
      send(encoding.toUint8Array(encoder));
    }
  }

  const handleMessage = (data: IncomingData): void => {
    const message = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case messageSync: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        // readSyncMessage mutates room.doc directly for step2/update messages,
        // and for a step1 message writes a step2 reply into `encoder`.
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
        if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));
        break;
      }
      case messageAwareness: {
        applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
        break;
      }
      default:
        break;
    }
  };

  ws.on("message", handleMessage);
  // Messages that arrived while the room was still being created
  // (see acceptConnection), in the order they were received.
  for (const data of queuedMessages) handleMessage(data);

  const pingInterval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(pingInterval);
      return;
    }
    ws.ping();
  }, PING_INTERVAL_MS);

  ws.on("close", () => {
    clearInterval(pingInterval);
    room.removeConnection(ws);
    roomManager.notifyMaybeEmpty(room.name);
  });

  ws.on("error", () => {
    ws.close();
  });
}
