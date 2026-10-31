import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config.js";

/**
 * Durable blob storage for op-log segments and snapshots. Objects are
 * write-once: keys embed the seq range, and nothing is ever overwritten or
 * mutated after it is written.
 */
export interface ObjectStore {
  readonly kind: "s3" | "memory";
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /**
   * A URL the browser can GET directly. For S3 this is a presigned URL, so
   * large snapshots/segments never stream through Node. The memory store
   * returns null and callers fall back to the server's /objects proxy route
   * (dev/tests only).
   */
  presignGet(key: string): Promise<string | null>;
}

export class MemoryObjectStore implements ObjectStore {
  readonly kind = "memory" as const;
  readonly objects = new Map<string, Uint8Array>();
  /** Artificial per-GET latency, used by the seek benchmark to model a network hop. */
  constructor(private readonly getLatencyMs = 0) {}

  async put(key: string, body: Uint8Array): Promise<void> {
    const existing = this.objects.get(key);
    if (existing) {
      // Re-writing identical bytes is fine (a recorder that crashed between
      // the PUT and the index write will redo it); changing them is not.
      if (Buffer.compare(Buffer.from(existing), Buffer.from(body)) !== 0) {
        throw new Error(`object ${key} already exists with different content (objects are immutable)`);
      }
      return;
    }
    this.objects.set(key, body);
  }

  async get(key: string): Promise<Uint8Array> {
    if (this.getLatencyMs) await new Promise((r) => setTimeout(r, this.getLatencyMs));
    const body = this.objects.get(key);
    if (!body) throw new Error(`object ${key} not found`);
    return body;
  }

  async presignGet(): Promise<string | null> {
    return null;
  }
}

export class S3ObjectStore implements ObjectStore {
  readonly kind = "s3" as const;
  private readonly client: S3Client;
  /** Separate client whose endpoint is reachable from browsers (MinIO/LocalStack behind docker networking). */
  private readonly presignClient: S3Client;
  private readonly bucket: string;
  private readonly ttl: number;

  constructor(cfg: Config["s3"]) {
    if (!cfg.bucket) throw new Error("S3_BUCKET is required for S3ObjectStore");
    this.bucket = cfg.bucket;
    this.ttl = cfg.presignTtlSeconds;
    // Credentials are never configured here: the SDK's default provider chain
    // picks up env vars locally and the IRSA web-identity token on EKS.
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
    });
    this.presignClient = cfg.publicEndpoint
      ? new S3Client({ region: cfg.region, endpoint: cfg.publicEndpoint, forcePathStyle: cfg.forcePathStyle })
      : this.client;
  }

  /**
   * Dev convenience for MinIO/LocalStack: create the bucket and allow
   * browser GETs of presigned URLs. On AWS, Terraform owns both.
   */
  async ensureBucket(corsOrigin = "*"): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    try {
      await this.client.send(
        new PutBucketCorsCommand({
          Bucket: this.bucket,
          CORSConfiguration: {
            CORSRules: [{ AllowedMethods: ["GET", "HEAD"], AllowedOrigins: [corsOrigin], AllowedHeaders: ["*"], MaxAgeSeconds: 3600 }],
          },
        }),
      );
    } catch (err) {
      console.warn("[s3] could not set bucket CORS (browser replay may fail):", (err as Error).message);
    }
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Immutable, content-addressed-by-seq objects: safe to cache forever.
        CacheControl: "private, max-age=31536000, immutable",
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`empty body for ${key}`);
    return await res.Body.transformToByteArray();
  }

  async presignGet(key: string): Promise<string> {
    return await getSignedUrl(this.presignClient, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: this.ttl,
    });
  }
}
