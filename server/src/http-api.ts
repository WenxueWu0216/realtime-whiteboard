import express, { type Request, type Response, type NextFunction } from "express";
import * as Y from "yjs";
import type { Persistence } from "./persistence.js";
import type { RedisAdapter } from "./redis-adapter.js";
import type { Recording } from "./recording/recording.js";
import type { ReplayPlan } from "./recording/replay.js";
import type { RoomManager } from "./room-manager.js";

export interface ApiDeps {
  roomManager: RoomManager;
  redis: RedisAdapter;
  persistence: Persistence;
  recording: Recording;
  corsOrigin: string;
  isShuttingDown: () => boolean;
}

/**
 * Parses the replay target. Accepted forms:
 *   ?seq=1234          a sequence number
 *   ?at=90000          ms offset from the start of the session
 *   ?at=seq:1234       same as ?seq=1234
 *   (none)             the live head
 */
export function parseTarget(q: Request["query"]): { seq?: number; atMs?: number } {
  const seqRaw = typeof q.seq === "string" ? q.seq : undefined;
  const atRaw = typeof q.at === "string" ? q.at : undefined;
  if (seqRaw !== undefined) return { seq: mustNum(seqRaw, "seq") };
  if (atRaw !== undefined) {
    if (atRaw.startsWith("seq:")) return { seq: mustNum(atRaw.slice(4), "at") };
    return { atMs: mustNum(atRaw.replace(/ms$/, ""), "at") };
  }
  return {};
}

function mustNum(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative number`);
  return n;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function createApi(d: ApiDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", d.corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Liveness: the process is up and the event loop is responsive. Must not
  // depend on Redis/Mongo, or a Redis blip would restart every pod.
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      rooms: d.roomManager.roomCount,
      connections: d.roomManager.connectionCount,
      redis: d.redis.isEnabled,
      persistence: d.persistence.isEnabled,
      objectStore: d.recording.store.kind,
    });
  });

  // Readiness: only take traffic when dependencies are reachable, and stop
  // taking new traffic as soon as shutdown begins.
  app.get(
    "/readyz",
    wrap(async (_req, res) => {
      if (d.isShuttingDown()) {
        res.status(503).json({ ready: false, reason: "shutting down" });
        return;
      }
      const [redisOk, mongoOk] = await Promise.all([d.redis.ping(), d.persistence.ping()]);
      res.status(redisOk && mongoOk ? 200 : 503).json({ ready: redisOk && mongoOk, redis: redisOk, mongo: mongoOk });
    }),
  );

  app.get("/metrics", (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      connections: d.roomManager.connectionCount,
      rooms: d.roomManager.roomCount,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      recorders: d.recording.recorderStatus(),
    });
  });

  app.get("/rooms", (_req, res) => {
    res.json(d.roomManager.listRooms());
  });

  const replay = d.recording.replay;

  const withProxyUrls = (req: Request, plan: ReplayPlan): ReplayPlan => {
    if (d.recording.store.kind !== "memory") return plan;
    // Dev/test only: no S3 configured, so there is nothing to presign.
    const base = `${req.protocol}://${req.get("host")}/boards/${encodeURIComponent(plan.board)}/objects?key=`;
    const fill = <T extends { key: string; url: string | null }>(o: T): T => ({
      ...o,
      url: o.url ?? base + encodeURIComponent(o.key),
    });
    return { ...plan, snapshot: plan.snapshot && fill(plan.snapshot), segments: plan.segments.map(fill) };
  };

  app.get(
    "/boards/:id/timeline",
    wrap(async (req, res) => {
      res.json(await replay.timeline(req.params.id));
    }),
  );

  /**
   * GET /boards/:id/replay?at=<ms offset>|seq=<n>[&mode=state|plan]
   *   mode=state (default): the server rebuilds the board at the target
   *     (nearest snapshot + ops since) and returns it.
   *   mode=plan: returns presigned URLs for the snapshot and segments plus
   *     the unflushed tail; the client downloads straight from S3 and
   *     applies the ops itself (what the replay UI uses).
   */
  app.get(
    "/boards/:id/replay",
    wrap(async (req, res) => {
      const board = req.params.id;
      const target = await replay.resolveTarget(board, parseTarget(req.query));
      const startTs = await replay.startTs(board);
      if (req.query.mode === "plan") {
        res.json(withProxyUrls(req, await replay.plan(board, null, target.seq)));
        return;
      }
      const r = await replay.reconstruct(board, target.seq);
      const state = Buffer.from(Y.encodeStateAsUpdate(r.doc)).toString("base64");
      res.json({
        board,
        seq: r.seq,
        ts: r.ts,
        startTs,
        offsetMs: r.ts !== null && startTs !== null ? r.ts - startTs : null,
        snapshot: r.snapshot ? { seq: r.snapshot.seq, key: r.snapshot.key } : null,
        opsApplied: r.opsApplied,
        segmentsFetched: r.segmentsFetched,
        serverMs: Number(r.ms.toFixed(2)),
        state,
        shapes: r.doc.getMap("shapes").toJSON(),
      });
      r.doc.destroy();
    }),
  );

  /** Ops with after < seq <= to, as presigned segment URLs + inline tail (playback buffering). */
  app.get(
    "/boards/:id/ops",
    wrap(async (req, res) => {
      const after = mustNum(String(req.query.after ?? "0"), "after");
      const to = mustNum(String(req.query.to ?? Number.MAX_SAFE_INTEGER), "to");
      res.json(withProxyUrls(req, await replay.plan(req.params.id, after, to)));
    }),
  );

  // Dev/test fallback when there is no S3: serve objects from the in-memory store.
  app.get(
    "/boards/:id/objects",
    wrap(async (req, res) => {
      if (d.recording.store.kind !== "memory") throw new HttpError(404, "use presigned URLs");
      const key = String(req.query.key ?? "");
      if (!key.startsWith(`boards/${encodeURIComponent(req.params.id)}/`)) throw new HttpError(400, "bad key");
      res.type("application/gzip").send(Buffer.from(await d.recording.store.get(key)));
    }),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error("[http]", err);
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });

  return app;
}
