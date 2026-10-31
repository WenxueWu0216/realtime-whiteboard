import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export const serverDir = new URL("../..", import.meta.url).pathname;

export function hasBinary(bin: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
}

export function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

export async function startRedis(port: number): Promise<ChildProcess> {
  const p = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    const r = spawnSync("redis-cli", ["-p", String(port), "ping"]);
    if (r.stdout?.toString().includes("PONG")) return p;
    await sleep(100);
  }
  throw new Error("redis did not start");
}

export async function startServer(port: number, env: Record<string, string>): Promise<ChildProcess> {
  const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), SHUTDOWN_DRAIN_MS: "0", ...env },
    stdio: process.env.DEBUG_SERVERS ? "inherit" : "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      if (res.ok) return p;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  p.kill();
  throw new Error(`server on :${port} did not become ready`);
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await sleep(25);
  }
}
