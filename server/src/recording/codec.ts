import { gunzipSync, gzipSync } from "node:zlib";
import type { OpRecord } from "./types.js";

/**
 * Segment format: gzip'd JSON Lines, one op per line:
 *   {"seq":42,"ts":1730000000000,"op":"<base64 Yjs update>"}
 * Snapshot format: gzip'd JSON:
 *   {"board":"demo","seq":1000,"ts":...,"state":"<base64 Y.encodeStateAsUpdate>","shapes":{...}}
 *
 * Both are plain, self-describing and readable with `zcat | jq`, and the
 * browser can decode them with DecompressionStream("gzip") after fetching a
 * presigned URL, so the server never proxies these bytes.
 */
export function encodeSegment(ops: OpRecord[]): Buffer {
  const lines = ops.map((o) =>
    JSON.stringify({ seq: o.seq, ts: o.ts, op: Buffer.from(o.op).toString("base64") }),
  );
  return gzipSync(lines.join("\n") + "\n");
}

export function decodeSegment(body: Uint8Array): OpRecord[] {
  const text = gunzipSync(body).toString("utf8");
  const out: OpRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const j = JSON.parse(line) as { seq: number; ts: number; op: string };
    out.push({ seq: j.seq, ts: j.ts, op: new Uint8Array(Buffer.from(j.op, "base64")) });
  }
  return out;
}

export interface SnapshotBody {
  board: string;
  seq: number;
  ts: number;
  state: Uint8Array;
  shapes?: unknown;
}

export function encodeSnapshot(s: SnapshotBody): Buffer {
  return gzipSync(
    JSON.stringify({
      board: s.board,
      seq: s.seq,
      ts: s.ts,
      state: Buffer.from(s.state).toString("base64"),
      shapes: s.shapes,
    }),
  );
}

export function decodeSnapshot(body: Uint8Array): SnapshotBody {
  const j = JSON.parse(gunzipSync(body).toString("utf8")) as {
    board: string;
    seq: number;
    ts: number;
    state: string;
    shapes?: unknown;
  };
  return { ...j, state: new Uint8Array(Buffer.from(j.state, "base64")) };
}
