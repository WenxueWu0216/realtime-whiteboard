const WS_URL: string = import.meta.env.VITE_WS_URL ?? "ws://localhost:1234";
export const API_URL: string = import.meta.env.VITE_API_URL ?? WS_URL.replace(/^ws/, "http");

export interface OpRecord {
  seq: number;
  ts: number;
  op: Uint8Array;
}

export interface Timeline {
  board: string;
  startTs: number | null;
  headSeq: number;
  headTs: number | null;
  flushedSeq: number;
  snapshots: { seq: number; ts: number }[];
}

interface ObjRef {
  key: string;
  url: string | null;
}

export interface ReplayPlan {
  board: string;
  targetSeq: number;
  targetTs: number | null;
  startTs: number | null;
  headSeq: number;
  snapshot: (ObjRef & { seq: number; ts: number }) | null;
  segments: (ObjRef & { startSeq: number; endSeq: number; startTs: number; endTs: number })[];
  tail: { seq: number; ts: number; op: string }[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(API_URL + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const b = (board: string) => encodeURIComponent(board);

export const api = {
  timeline: (board: string) => getJson<Timeline>(`/boards/${b(board)}/timeline`),
  /** target: {seq} or {atMs} (offset from session start) */
  plan: (board: string, target: { seq?: number; atMs?: number }) =>
    getJson<ReplayPlan>(
      `/boards/${b(board)}/replay?mode=plan&` +
        (target.seq !== undefined ? `seq=${Math.round(target.seq)}` : `at=${Math.round(target.atMs ?? 0)}`),
    ),
  opsAfter: (board: string, after: number, to: number) =>
    getJson<ReplayPlan>(`/boards/${b(board)}/ops?after=${after}&to=${to}`),
};

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Snapshots and segments are fetched straight from S3 via presigned URLs
 * (the Node server never proxies those bytes) and gunzipped in the browser.
 */
async function fetchGunzipText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`GET object failed: HTTP ${res.status}`);
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

export async function fetchSnapshot(url: string): Promise<{ seq: number; ts: number; state: Uint8Array }> {
  const j = JSON.parse(await fetchGunzipText(url)) as { seq: number; ts: number; state: string };
  return { seq: j.seq, ts: j.ts, state: b64ToBytes(j.state) };
}

export async function fetchSegment(url: string): Promise<OpRecord[]> {
  const text = await fetchGunzipText(url);
  const ops: OpRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const j = JSON.parse(line) as { seq: number; ts: number; op: string };
    ops.push({ seq: j.seq, ts: j.ts, op: b64ToBytes(j.op) });
  }
  return ops;
}
