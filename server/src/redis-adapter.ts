import Redis from "ioredis";

const CHANNEL_PREFIX = "whiteboard:room:";

export type RedisMessageHandler = (roomName: string, payload: Buffer) => void;

/**
 * Cross-instance broadcast for horizontal scaling.
 *
 * Problem it solves: a single Node process can only push WebSocket frames to
 * clients connected to *that* process. Once you run more than one server
 * instance behind a load balancer, two people in the same room can land on
 * different instances and never see each other's edits unless the instances
 * relay messages to one another. Redis pub/sub is the relay: whichever
 * instance receives an update from its own clients re-publishes it on a
 * room-scoped channel, and every instance (including itself, harmlessly)
 * receives it and forwards to its locally-connected clients.
 *
 * Degrades gracefully: with no REDIS_URL configured, this becomes a no-op
 * and the server behaves exactly like a single-instance deployment - so the
 * minimal "get it running" path doesn't require standing up Redis first.
 */
export class RedisAdapter {
  private readonly enabled: boolean;
  private pub: Redis | null = null;
  private sub: Redis | null = null;
  private readonly handlers = new Set<RedisMessageHandler>();

  constructor(redisUrl?: string) {
    this.enabled = Boolean(redisUrl);
    if (!this.enabled) return;

    this.pub = new Redis(redisUrl as string);
    this.sub = new Redis(redisUrl as string);

    this.sub.on("messageBuffer", (channel: Buffer, message: Buffer) => {
      const roomName = channel.toString("utf8").slice(CHANNEL_PREFIX.length);
      for (const handler of this.handlers) handler(roomName, message);
    });
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  onMessage(handler: RedisMessageHandler): void {
    this.handlers.add(handler);
  }

  async subscribeRoom(roomName: string): Promise<void> {
    if (!this.enabled || !this.sub) return;
    await this.sub.subscribe(CHANNEL_PREFIX + roomName);
  }

  async unsubscribeRoom(roomName: string): Promise<void> {
    if (!this.enabled || !this.sub) return;
    await this.sub.unsubscribe(CHANNEL_PREFIX + roomName);
  }

  publish(roomName: string, payload: Buffer): void {
    if (!this.enabled || !this.pub) return;
    void this.pub.publish(CHANNEL_PREFIX + roomName, payload);
  }

  async close(): Promise<void> {
    if (!this.enabled) return;
    await Promise.all([this.pub?.quit(), this.sub?.quit()]);
  }
}
