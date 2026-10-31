import type Redis from "ioredis";
import type { OpRecord } from "./types.js";

export interface PublishSpec {
  channel: string;
  payload: Uint8Array;
}

/**
 * The hot tail of the append-only op log, plus the per-board recorder lease.
 *
 * Ordering guarantee: `append` assigns `seq` and `ts` *on the Redis server*
 * inside one Lua script (INCR + TIME + XADD run atomically), so seq is
 * gap-free and strictly increasing per board no matter how many pods are
 * appending concurrently, and the stream order equals seq order (the stream
 * entry ID is literally `<seq>-0`). The timestamp is clamped so it never goes
 * backwards even if the Redis clock is adjusted.
 */
export interface OpLog {
  /**
   * Append an op. If `publish` is given, the pub/sub broadcast of the same
   * update is sent from inside the same atomic script, so no pod can ever
   * see an update over pub/sub before it has a seq in the log.
   */
  append(board: string, op: Uint8Array, publish?: PublishSpec): Promise<{ seq: number; ts: number }>;
  /** Ops with afterSeq < seq <= toSeq (toSeq defaults to +inf), in seq order. */
  readAfter(board: string, afterSeq: number, toSeq?: number, limit?: number): Promise<OpRecord[]>;
  /** Drop ops with seq <= seq from the hot tail (they are durable in S3 now). */
  trimThrough(board: string, seq: number): Promise<void>;
  head(board: string): Promise<{ lastSeq: number; lastTs: number | null }>;

  acquireLease(board: string, owner: string, ttlMs: number): Promise<boolean>;
  renewLease(board: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(board: string, owner: string): Promise<void>;
}

// Hash-tagged keys so every key of one board lands in the same slot (works
// unchanged on ElastiCache in cluster mode).
const k = {
  meta: (b: string) => `wb:{${b}}:meta`,
  ops: (b: string) => `wb:{${b}}:ops`,
  lease: (b: string) => `wb:{${b}}:recorder`,
};

const APPEND_LUA = `
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
local t = redis.call('TIME')
local ts = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local last = tonumber(redis.call('HGET', KEYS[1], 'lastTs') or '0')
if ts < last then ts = last end
redis.call('HSET', KEYS[1], 'lastTs', ts)
redis.call('XADD', KEYS[2], seq .. '-0', 'ts', ts, 'op', ARGV[1])
if ARGV[2] ~= '' then redis.call('PUBLISH', ARGV[2], ARGV[3]) end
return {seq, ts}
`;

const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

type RedisWithCommands = Redis & {
  wbAppend(metaKey: string, opsKey: string, op: Buffer, channel: string, payload: Buffer): Promise<[number, number]>;
  wbRenew(leaseKey: string, owner: string, ttl: number): Promise<number>;
  wbRelease(leaseKey: string, owner: string): Promise<number>;
};

export class RedisOpLog implements OpLog {
  private readonly r: RedisWithCommands;

  /**
   * Ordering across pods: the op is XADDed and PUBLISHed by one atomic Lua
   * script, so another pod can only receive (and build on) an update after
   * it already has a seq. Any causally-later op therefore gets a higher seq.
   */
  constructor(redis: Redis) {
    if (!("wbAppend" in redis)) {
      redis.defineCommand("wbAppend", { numberOfKeys: 2, lua: APPEND_LUA });
      redis.defineCommand("wbRenew", { numberOfKeys: 1, lua: RENEW_LUA });
      redis.defineCommand("wbRelease", { numberOfKeys: 1, lua: RELEASE_LUA });
    }
    this.r = redis as RedisWithCommands;
  }

  async append(board: string, op: Uint8Array, publish?: PublishSpec): Promise<{ seq: number; ts: number }> {
    const [seq, ts] = await this.r.wbAppend(
      k.meta(board),
      k.ops(board),
      Buffer.from(op),
      publish?.channel ?? "",
      publish ? Buffer.from(publish.payload) : Buffer.alloc(0),
    );
    return { seq: Number(seq), ts: Number(ts) };
  }

  async readAfter(board: string, afterSeq: number, toSeq?: number, limit?: number): Promise<OpRecord[]> {
    const start = `(${afterSeq}-0`;
    const end = toSeq === undefined ? "+" : `${toSeq}-0`;
    const rows =
      limit === undefined
        ? await this.r.xrangeBuffer(k.ops(board), start, end)
        : await this.r.xrangeBuffer(k.ops(board), start, end, "COUNT", limit);
    return rows.map(([id, fields]) => {
      let ts = 0;
      let op: Uint8Array = new Uint8Array();
      for (let i = 0; i < fields.length; i += 2) {
        const name = fields[i].toString();
        if (name === "ts") ts = Number(fields[i + 1].toString());
        else if (name === "op") op = new Uint8Array(fields[i + 1]);
      }
      return { seq: Number(id.toString().split("-")[0]), ts, op };
    });
  }

  async trimThrough(board: string, seq: number): Promise<void> {
    await this.r.xtrim(k.ops(board), "MINID", `${seq + 1}-0`);
  }

  async head(board: string): Promise<{ lastSeq: number; lastTs: number | null }> {
    const [seq, lastTs] = await this.r.hmget(k.meta(board), "seq", "lastTs");
    return { lastSeq: Number(seq ?? 0), lastTs: lastTs ? Number(lastTs) : null };
  }

  async acquireLease(board: string, owner: string, ttlMs: number): Promise<boolean> {
    const ok = await this.r.set(k.lease(board), owner, "PX", ttlMs, "NX");
    if (ok === "OK") return true;
    return (await this.r.get(k.lease(board))) === owner;
  }

  async renewLease(board: string, owner: string, ttlMs: number): Promise<boolean> {
    return (await this.r.wbRenew(k.lease(board), owner, ttlMs)) === 1;
  }

  async releaseLease(board: string, owner: string): Promise<void> {
    await this.r.wbRelease(k.lease(board), owner);
  }
}

/** Single-process op log for REDIS_URL-less dev mode and unit tests. */
export class MemoryOpLog implements OpLog {
  private readonly boards = new Map<string, { seq: number; lastTs: number; ops: OpRecord[] }>();
  private readonly leases = new Map<string, string>();
  /** Injectable clock so tests/benchmarks can generate long sessions instantly. */
  constructor(private readonly now: () => number = Date.now) {}

  private board(b: string) {
    let s = this.boards.get(b);
    if (!s) {
      s = { seq: 0, lastTs: 0, ops: [] };
      this.boards.set(b, s);
    }
    return s;
  }

  async append(board: string, op: Uint8Array): Promise<{ seq: number; ts: number }> {
    return this.appendSync(board, op);
  }

  appendSync(board: string, op: Uint8Array): { seq: number; ts: number } {
    const s = this.board(board);
    const seq = ++s.seq;
    const ts = Math.max(this.now(), s.lastTs);
    s.lastTs = ts;
    s.ops.push({ seq, ts, op });
    return { seq, ts };
  }

  async readAfter(board: string, afterSeq: number, toSeq = Infinity, limit = Infinity): Promise<OpRecord[]> {
    const out: OpRecord[] = [];
    for (const o of this.board(board).ops) {
      if (o.seq <= afterSeq) continue;
      if (o.seq > toSeq || out.length >= limit) break;
      out.push(o);
    }
    return out;
  }

  async trimThrough(board: string, seq: number): Promise<void> {
    const s = this.board(board);
    s.ops = s.ops.filter((o) => o.seq > seq);
  }

  async head(board: string): Promise<{ lastSeq: number; lastTs: number | null }> {
    const s = this.board(board);
    return { lastSeq: s.seq, lastTs: s.seq ? s.lastTs : null };
  }

  async acquireLease(board: string, owner: string): Promise<boolean> {
    const cur = this.leases.get(board);
    if (cur && cur !== owner) return false;
    this.leases.set(board, owner);
    return true;
  }

  async renewLease(board: string, owner: string): Promise<boolean> {
    return this.leases.get(board) === owner;
  }

  async releaseLease(board: string, owner: string): Promise<void> {
    if (this.leases.get(board) === owner) this.leases.delete(board);
  }
}
