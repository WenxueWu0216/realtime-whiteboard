/**
 * All runtime configuration, read once from the environment.
 *
 * Every external dependency is optional so the minimal dev path
 * (`npm run dev` with nothing else running) still works:
 *   - no REDIS_URL    -> single-instance mode, in-memory op log
 *   - no MONGO_URL    -> in-memory live-doc snapshots and recording index
 *   - no S3_BUCKET    -> in-memory object store (recordings lost on restart)
 */
export interface Config {
  port: number;
  instanceId: string;
  redisUrl?: string;
  mongoUrl?: string;
  s3: {
    bucket?: string;
    region: string;
    /** Custom endpoint for MinIO / LocalStack. Leave unset on real AWS S3. */
    endpoint?: string;
    /** Endpoint used when presigning URLs handed to browsers (e.g. http://localhost:4566). */
    publicEndpoint?: string;
    forcePathStyle: boolean;
    presignTtlSeconds: number;
  };
  recording: {
    enabled: boolean;
    /** Write a snapshot every N ops ... */
    snapshotEveryOps: number;
    /** ... or every T ms (whichever comes first, only if there are new ops). */
    snapshotEveryMs: number;
    /** Flush the hot tail to an S3 segment once it holds this many ops ... */
    segmentMaxOps: number;
    /** ... or once the oldest unflushed op is this old. */
    segmentMaxAgeMs: number;
    /** How often the recorder polls the hot tail. */
    tickMs: number;
    /** Recorder lease TTL (only one pod records a given board at a time). */
    leaseMs: number;
  };
  corsOrigin: string;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function loadConfig(): Config {
  return {
    port: num("PORT", 1234),
    instanceId:
      process.env.INSTANCE_ID ?? process.env.HOSTNAME ?? `inst-${Math.random().toString(36).slice(2, 8)}`,
    redisUrl: process.env.REDIS_URL || undefined,
    mongoUrl: process.env.MONGO_URL || undefined,
    s3: {
      bucket: process.env.S3_BUCKET || undefined,
      region: process.env.AWS_REGION ?? process.env.S3_REGION ?? "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || undefined,
      forcePathStyle: bool("S3_FORCE_PATH_STYLE", Boolean(process.env.S3_ENDPOINT)),
      presignTtlSeconds: num("S3_PRESIGN_TTL_SECONDS", 300),
    },
    recording: {
      enabled: bool("RECORDING_ENABLED", true),
      snapshotEveryOps: num("SNAPSHOT_EVERY_OPS", 1000),
      snapshotEveryMs: num("SNAPSHOT_EVERY_MS", 60_000),
      segmentMaxOps: num("SEGMENT_MAX_OPS", 500),
      segmentMaxAgeMs: num("SEGMENT_MAX_AGE_MS", 5_000),
      tickMs: num("RECORDER_TICK_MS", 500),
      leaseMs: num("RECORDER_LEASE_MS", 15_000),
    },
    corsOrigin: process.env.CORS_ORIGIN ?? "*",
  };
}
