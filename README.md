# 实时协作白板 (Real-Time Collaborative Whiteboard)

多人实时协作画板：CRDT 冲突消解 + WebSocket 多实例横向扩展 + 离线自动合并。

## 核心设计

| 问题 | 方案 |
|---|---|
| 并发编辑冲突 | [Yjs](https://github.com/yjs/yjs)（CRDT）—— 每个客户端本地可写，无需锁/中心排序，收敛到同一状态 |
| WebSocket 横向扩展 | `y-redis` 风格的 Redis pub/sub：每个服务器实例把本地收到的 update 广播到 Redis channel，其他实例订阅后转发给自己的客户端 |
| 离线重连合并 | Yjs 的 state vector diff：重连时客户端与服务器交换 state vector，只传输缺失的 update，自动合并，不丢不重 |
| 持久化 | 房间的 Yjs 文档定期 snapshot 到 MongoDB（`Y.encodeStateAsUpdate`），服务器重启后可恢复 |
| 渲染性能 | react-konva 只重绘 dirty layer；光标广播用 `requestAnimationFrame` 节流到 ~20fps；awareness 用 Yjs Awareness protocol（不进 CRDT 历史） |

## 目录结构

```
realtime-whiteboard/
├── server/            # Node + Express + ws (y-websocket 协议) + Redis pub/sub + Mongo 持久化
│   └── src/
│       ├── index.ts           # HTTP + WebSocket 入口
│       ├── ws-handler.ts       # y-protocols/sync + awareness 处理
│       ├── redis-adapter.ts    # 跨实例广播
│       └── persistence.ts      # MongoDB 房间快照
├── client/            # React + TS + Vite + react-konva + yjs
│   └── src/
│       ├── Whiteboard.tsx      # 画布：矩形、便签、拖拽
│       ├── useYjsRoom.ts       # Yjs 文档 + WebsocketProvider 绑定
│       ├── Cursors.tsx         # 其他人的光标（awareness）
│       └── ConnectionStatus.tsx
├── Dockerfile         # 生产镜像：一个 Node 进程同时提供前端静态文件 + WebSocket
├── docker-compose.yml # app + Redis + MongoDB 一键起（配置见 .env.example）
├── .github/workflows/ # CI（lint/单测/构建/Playwright）+ Cloud Run 部署
└── e2e/                # Playwright：两个浏览器同时编辑、断网重连收敛
```

## 快速开始（最小可跑版本：单房间、多人同步画图）

```bash
# 1. 起 Redis + Mongo（横向扩展 & 持久化在最小版本里是可选的，不起也能跑）
cp .env.example .env            # 首次：compose 的配置（本地假值）
docker compose up -d redis mongo

# 2. 服务端
cd server && npm install && npm run dev   # ws://localhost:1234

# 3. 客户端（新开一个终端）
cd client && npm install && npm run dev   # http://localhost:5173

# 4. 打开两个浏览器标签页访问同一个房间 URL，同时画图，观察实时同步
#    http://localhost:5173/?room=demo
```

## 验证 Redis 横向扩展（多实例广播）

```bash
cp .env.example .env   # 首次
docker compose -f docker-compose.yml -f docker-compose.scale.yml \
  up --build --scale app=3
```

这会起 3 个互不共享内存的 `app` 容器，前面挂一个纯轮询（无 sticky session）的 nginx（`docker/nginx-lb.conf`），监听 `:8080`。直接打开 `http://localhost:8080/?room=demo` 的两个标签页（页面和 WebSocket 都经过 LB），大概率会被轮询分到不同的容器上 —— 如果这时两边编辑还能实时同步，就证明是 Redis pub/sub 在把"实例 A 收到的 update"广播给"实例 B 上的客户端"，而不是侥幸两个连接落在了同一进程。

> ⚠️ 已知问题：多实例下，一个**新打开该房间**的实例只会收到之后的增量 update，拿不到其他实例已有的历史状态（Redis 只转发增量，Mongo 快照有 3 秒防抖）。客户端断网重连到另一个实例时可能无法收敛 —— 见下文 "Known limitations"。

## 测试

```bash
cd server && npm test   # vitest：真实起服务器 + 真实 y-websocket 客户端，验证并发编辑收敛 & 离线重连合并
cd e2e && npx playwright install chromium && npm test   # 两个真实浏览器 context 同时编辑同一房间、断网重连
cd e2e && npm run test:docker   # 同上，但跑在 docker compose 栈（app + Redis + Mongo）上
```

## 已知的下一步（骨架已预留接口，未完全实现）

1. **鉴权 / 房间权限**：目前任意 room id 即可加入，生产版本应加 JWT + 房间成员校验。
2. **渲染性能进阶**：当前 react-konva 默认整层重绘，图形数量上千后应改为脏区域重绘或分层（静态图形一层、正在拖拽的图形单独一层）。
3. **快照压缩**：`Y.encodeStateAsUpdate` 全量快照会随历史增长而变大，生产环境应定期用 `Y.encodeStateAsUpdate(doc)` 替换旧快照（相当于 GC/compaction），而不是无限累积 update 日志。

## 面试要点速记

- **为什么用 CRDT 不用 OT**：OT 需要中心化的 transform 服务器维护操作顺序，扩展和实现都更复杂；CRDT（如 Yjs 的 YATA 算法）保证任意到达顺序的 update 都能无冲突地合并到同一最终状态，天然适合去中心化/多服务器场景。Figma、Linear 等新一代协作工具转向 CRDT 类机制也是这个原因。
- **单机 WebSocket 的扩展瓶颈**：一个 Node 进程内的 WS 连接只能广播给自己进程里的客户端；用户量上来后要多开进程/机器，这时候同一房间的两个人可能连在不同实例上，必须靠 Redis pub/sub 把"实例 A 收到的 update"广播给"实例 B 上的客户端"。
- **一致性模型**：最终一致（eventual consistency）——不保证任意时刻所有副本状态相同，但保证网络分区恢复、所有 update 送达后所有副本收敛到同一状态。

## Deployment and Testing

### Architecture

```
                 ┌──────────────────────── one container (root Dockerfile) ───────────────────────┐
 browser ──HTTP──▶  Node server (server/dist)                                                       │
   │             │   • GET /, /assets/*  → built React app (client/dist, served via STATIC_DIR)     │
   └───WS /<room>▶   • WS  /<room>       → y-websocket protocol, one Y.Doc per room               │
                 │   • GET /healthz      → {"ok":true,"redis":…,"persistence":…}                    │
                 └───────────┬─────────────────────────────────────┬────────────────────────────────┘
                             │ REDIS_URL (optional)                │ MONGO_URL (optional)
                     Redis pub/sub: relays updates          MongoDB: debounced room
                     between server instances               snapshots (restart recovery)
```

- **One image** (`Dockerfile`, multi-stage): stage 1 builds the React client, stage 2 compiles the TypeScript server, stage 3 installs production-only dependencies, and the final stage runs `node dist/index.js` as the non-root `node` user on `PORT` (default `8080`).
- The UI and the WebSocket share one origin. When `VITE_WS_URL` isn't set at build time, the production client connects to `ws(s)://<page host>`, so the same image works on localhost, behind docker compose, and on Cloud Run (`wss://`).
- Redis and MongoDB are optional at runtime. Without `REDIS_URL` the server runs in single-instance mode; without `MONGO_URL` rooms live only in memory.
- `server/Dockerfile` and `client/Dockerfile` (the earlier split images) are still in the repo but are no longer used by compose or CI.

### Run locally with docker compose

```bash
cp .env.example .env              # fake local-only values; .env is git-ignored
docker compose up --build --wait  # app + Redis + MongoDB, waits for healthchecks
open http://localhost:8080/?room=demo
curl http://localhost:8080/healthz  # → {"ok":true,"rooms":0,"redis":true,"persistence":true}
docker compose down -v            # stop and delete the Mongo volume
```

All configuration comes from environment variables (`.env` or your shell):

| Variable | Used by | Meaning |
|---|---|---|
| `APP_HOST_PORT` | compose | host port for the app (default `8080`) |
| `REDIS_HOST_PORT`, `MONGO_HOST_PORT` | compose | host ports for Redis/Mongo, bound to `127.0.0.1` only |
| `MONGO_ROOT_USERNAME`, `MONGO_ROOT_PASSWORD` | compose | Mongo root user; compose builds the app's `MONGO_URL` from these |
| `PORT`, `REDIS_URL`, `MONGO_URL`, `STATIC_DIR` | server | read by `server/src/index.ts` (compose and the image set them) |

### Playwright end-to-end tests

The specs live in `e2e/tests/`. Each one opens **two separate browser contexts** (separate storage and WebSocket connections) on the same room:

- `sync-and-reconnect.spec.ts`
  - *drawing in one browser shows up on the other*: Alice draws a rectangle and then drags it; Bob draws a sticky note. After each step the test compares the two pages' actual Konva scene graphs (shape ids, types and coordinates), not just a counter.
  - *a client that goes offline, edits, and reconnects converges with its peer*: Bob goes offline (context offline mode, plus every WebSocket of his context is cut and new ones are refused through Playwright's `routeWebSocket`). While offline, Alice moves a shared rectangle and Bob adds a sticky note. The test asserts that the two canvases have really diverged and that Bob shows the offline badge. Then Bob comes back online, and the test asserts that both canvases end up identical, with Alice's move and Bob's note.
- `two-clients.spec.ts` (pre-existing): shapes and live cursors (awareness) propagate.

```bash
cd e2e
npm ci
npx playwright install chromium

npm test              # starts server + Vite dev servers locally (no Docker needed)
npm run test:docker   # docker compose up --build --wait → tests → docker compose down -v
# or step by step:
npm run stack:up && npm run test:stack && npm run stack:down
E2E_BASE_URL=https://some-host npm run test:stack   # any running deployment
```

`npm run test:docker` needs a `.env` in the repo root (`cp .env.example .env`).

### CI/CD pipeline

`.github/workflows/ci.yml` runs on every push and pull request:

1. **checks** (matrix: `server`, `client`): `npm ci` → `npm run lint` (ESLint) → `npm run typecheck` → `npm test` (server only: the vitest suite, which starts the real server and checks concurrent-edit convergence and offline merge with real y-websocket clients; the client has no unit tests yet) → `npm run build`.
2. **e2e** (after checks pass): installs Chromium, copies `.env.example` to `.env`, runs `npm run stack:up` (builds the production image and starts app + Redis + MongoDB), then `npm run test:stack`. The Playwright report is uploaded as an artifact; container logs are printed on failure. The stack is always torn down.

`.github/workflows/deploy.yml` deploys to **Google Cloud Run**:

- Trigger: `workflow_run` of CI, and only when that run **succeeded** for a **push to `main`** in this repository. It checks out exactly the commit CI tested.
- Auth: **Workload Identity Federation** via `google-github-actions/auth` (no service-account key files). It builds the image, pushes it to Artifact Registry (`<region>-docker.pkg.dev/<project>/<repo>/<service>:<sha>`) and deploys it with `google-github-actions/deploy-cloudrun` using `--port=8080 --timeout=3600 --session-affinity`. The long timeout is there because each open WebSocket counts as a request.
- Required repository **secrets** (referenced by name only): `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`.
- Optional repository **variables**: `CLOUD_RUN_SERVICE` (default `realtime-whiteboard`), `GCP_ARTIFACT_REPO` (default `whiteboard`), `CLOUD_RUN_SECRETS` (Secret Manager references for `REDIS_URL` / `MONGO_URL`, e.g. `REDIS_URL=whiteboard-redis-url:latest,MONGO_URL=whiteboard-mongo-url:latest`), `CLOUD_RUN_EXTRA_FLAGS` (e.g. `--max-instances=1`), and `CLOUD_RUN_ALLOW_UNAUTHENTICATED` (`true` makes the service public and enables a `/healthz` smoke test).
- One-time GCP setup (not automated here): an Artifact Registry Docker repository, a Workload Identity pool/provider trusting this GitHub repository, and a deployer service account with `roles/run.admin`, `roles/artifactregistry.writer` and `roles/iam.serviceAccountUser` (plus `roles/secretmanager.secretAccessor` for the runtime service account if you use `CLOUD_RUN_SECRETS`). The job uses the GitHub environment `production`, where you can add required reviewers.

### What was verified, and what was not

Verified while building this change, in a cloud dev container:

- `docker compose up --wait` brought app, Redis and MongoDB (with auth) to healthy, and `/healthz` reported `redis: true, persistence: true`. In that sandbox the image had to be built with an extra CA certificate injected for the sandbox's HTTPS proxy. The committed `Dockerfile` itself was otherwise unchanged.
- Against that stack, all 4 Playwright tests passed, including 5 repeated runs (20/20). They also passed in the default local dev-server mode. As a negative control, the reconnect test fails when the "come back online" step is removed.
- Server lint, type-check, vitest (2 tests) and build all passed; the client's lint, type-check and build passed.

Not verified:

- **The GitHub Actions workflows have not run yet.** They were checked as valid YAML, but not executed on GitHub or with `actionlint`.
- **The Cloud Run deployment has never been run.** No GCP project was available, so no live URL exists.
- `npm run test:docker` was not run verbatim in the sandbox (its `--build` step needs the CA workaround above). The equivalent steps were run separately.

### Known limitations

- **Multi-instance state sync gap (pre-existing).** Redis relays only *new* updates. When an instance opens a room for the first time, it loads the (3-second-debounced) Mongo snapshot but doesn't ask the other instances for their current state. Behind the 3-replica scale overlay, the reconnect test above **fails consistently**: the reconnecting client lands on a different instance and never receives the edit its peer made while it was offline (its own offline edit does reach the peer). The live-sync tests pass there. Until this is fixed in `server/src/room.ts`, run a single instance in production (`CLOUD_RUN_EXTRA_FLAGS=--max-instances=1`).
- Rooms have no authentication. Anyone who can reach the service can join any room id, so think before setting `CLOUD_RUN_ALLOW_UNAUTHENTICATED=true`.
