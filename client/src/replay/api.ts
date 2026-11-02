import { API_URL } from "../endpoints";

/** Effect of one op on the visible board, recorded server-side in seq order. */
export interface ShapeDiff {
  s?: Record<string, unknown>;
  d?: string[];
}

/** A recorded op as the viewer needs it (the raw Yjs update is not decoded). */
export interface ViewOp {
  seq: number;
  ts: number;
  diff?: ShapeDiff;
}

export interface Timeline {
  board: string;
  startTs: number | null;
  headSeq: number;
  headTs: number | null;
  flushedSeq: number;
  flushedTs: number | null;
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

/** Visible-state snapshot: plain shapes JSON, no CRDT history to load. */
export async function fetchSnapshot(url: string): Promise<{ seq: number; ts: number; shapes: Record<string, unknown> }> {
  return JSON.parse(await fetchGunzipText(url));
}

export async function fetchSegment(url: string): Promise<ViewOp[]> {
  const text = await fetchGunzipText(url);
  const ops: ViewOp[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const j = JSON.parse(line) as { seq: number; ts: number; diff?: ShapeDiff };
    ops.push({ seq: j.seq, ts: j.ts, diff: j.diff });
  }
  return ops;
}

export function applyDiff(shapes: Record<string, unknown>, diff: ShapeDiff | undefined): void {
  if (!diff) return;
  if (diff.d) for (const k of diff.d) delete shapes[k];
  if (diff.s) for (const [k, v] of Object.entries(diff.s)) shapes[k] = v;
}
