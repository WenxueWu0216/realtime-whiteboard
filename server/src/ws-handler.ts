import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type WebSocket from "ws";
import { applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { messageAwareness, messageSync, type Room } from "./room.js";
import type { RoomManager } from "./room-manager.js";

const PING_INTERVAL_MS = 30_000;

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

  ws.on("message", (data: ArrayBuffer | Buffer) => {
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
  });

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
