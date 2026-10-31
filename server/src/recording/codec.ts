import { gunzipSync, gzipSync } from "node:zlib";
import type { OpRecord, ShapeDiff } from "./types.js";

/**
 * Segment format: gzip'd JSON Lines, one op per line:
 *   {"seq":42,"ts":1730000000000,"op":"<base64 Yjs update>","diff":{"s":{"id":{...}},"d":["id2"]}}
 * Snapshot (visible state) format: gzip'd JSON:
 *   {"board":"demo","seq":1000,"ts":...,"shapes":{...}}
 * Snapshot CRDT state: gzip'd raw Y.encodeStateAsUpdate bytes.
 *
 * Both are plain, self-describing and readable with `zcat | jq`, and the
 * browser can decode them with DecompressionStream("gzip") after fetching a
 * presigned URL, so the server never proxies these bytes.
 */
export function encodeSegment(ops: OpRecord[]): Buffer {
  const lines = ops.map((o) =>
    JSON.stringify({ seq: o.seq, ts: o.ts, op: Buffer.from(o.op).toString("base64"), diff: o.diff }),
  );
  return gzipSync(lines.join("\n") + "\n");
}

export function decodeSegment(body: Uint8Array): OpRecord[] {
  const text = gunzipSync(body).toString("utf8");
  const out: OpRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const j = JSON.parse(line) as { seq: number; ts: number; op: string; diff?: ShapeDiff };
    const rec: OpRecord = { seq: j.seq, ts: j.ts, op: new Uint8Array(Buffer.from(j.op, "base64")) };
    if (j.diff) rec.diff = j.diff;
    out.push(rec);
  }
  return out;
}

export interface SnapshotBody {
  board: string;
  seq: number;
  ts: number;
  shapes: Record<string, unknown>;
}

export function encodeSnapshot(s: SnapshotBody): Buffer {
  return gzipSync(JSON.stringify({ board: s.board, seq: s.seq, ts: s.ts, shapes: s.shapes }));
}

export function decodeSnapshot(body: Uint8Array): SnapshotBody {
  return JSON.parse(gunzipSync(body).toString("utf8")) as SnapshotBody;
}

export function encodeState(state: Uint8Array): Buffer {
  return gzipSync(state);
}

export function decodeState(body: Uint8Array): Uint8Array {
  return new Uint8Array(gunzipSync(body));
}

/** Apply a recorded visible-state diff to a plain shapes object (mutates it). */
export function applyDiff(shapes: Record<string, unknown>, diff: ShapeDiff | undefined): void {
  if (!diff) return;
  if (diff.d) for (const k of diff.d) delete shapes[k];
  if (diff.s) for (const [k, v] of Object.entries(diff.s)) shapes[k] = v;
}
