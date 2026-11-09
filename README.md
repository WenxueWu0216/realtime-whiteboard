# Real-Time Collaborative Whiteboard

A multi-user real-time whiteboard: CRDT conflict resolution, horizontally scalable WebSocket servers, and automatic merging of offline edits.

## Core design

| Problem | Approach |
|---|---|
| Concurrent edit conflicts | [Yjs](https://github.com/yjs/yjs) (CRDT): every client can write locally with no locks or central ordering, and all replicas converge to the same state |
| Scaling WebSockets horizontally | `y-redis`-style Redis pub/sub: each server instance publishes the updates it receives from its own clients to a Redis channel; the other instances subscribe and forward them to their clients |
| Merging after an offline period | Yjs state-vector diffs: on reconnect the client and server exchange state vectors and send only the missing updates, which merge automatically with nothing lost or duplicated |
| Persistence | Each room's Yjs document is snapshotted to MongoDB (`Y.encodeStateAsUpdate`, debounced after changes) and restored when the server restarts |
| Rendering performance | Shapes are drawn with react-konva; cursor broadcasts are throttled with `requestAnimationFrame` (at most one awareness update per frame); cursors use the Yjs Awareness protocol, so they never enter the CRDT history |

## Project layout

```
realtime-whiteboard/
├── server/            # Node + Express + ws (y-websocket protocol) + Redis pub/sub + Mongo persistence
│   └── src/
│       ├── index.ts           # HTTP + WebSocket entry point
│       ├── ws-handler.ts       # y-protocols sync + awareness handling
│       ├── redis-adapter.ts    # cross-instance broadcast
│       └── persistence.ts      # MongoDB room snapshots
├── client/            # React + TS + Vite + react-konva + yjs
│   └── src/
│       ├── Whiteboard.tsx      # canvas: rectangles, ellipses, sticky notes, dragging
│       ├── useYjsRoom.ts       # Yjs document + WebsocketProvider binding
│       ├── Cursors.tsx         # other participants' cursors (awareness)
│       └── ConnectionStatus.tsx
├── Dockerfile         # production image: one Node process serves the static UI + WebSocket
├── docker-compose.yml # app + Redis + MongoDB in one command (config in .env.example)
├── .github/workflows/ # CI (lint / unit tests / build / Playwright) + Cloud Run deploy
└── e2e/               # Playwright: two browsers editing at once, offline reconnect convergence
```

## Quick start (minimal setup: one room, several people drawing in sync)

```bash
# 1. Start Redis + Mongo (optional for the minimal setup: the server runs without them)
cp .env.example .env            # first time only: compose config (fake local values)
docker compose up -d redis mongo

# 2. Server
cd server && npm install && npm run dev   # ws://localhost:1234

# 3. Client (in a new terminal)
cd client && npm install && npm run dev   # http://localhost:5173

# 4. Open the same room URL in two browser tabs and draw in both to watch them sync
#    http://localhost:5173/?room=demo
```

## Checking Redis horizontal scaling (multi-instance broadcast)

```bash
cp .env.example .env   # first time only
docker compose -f docker-compose.yml -f docker-compose.scale.yml \
  up --build --scale app=3
```

This starts 3 `app` containers that share no memory, behind a plain round-robin nginx with no sticky sessions (`docker/nginx-lb.conf`) listening on `:8080`. Open `http://localhost:8080/?room=demo` in two tabs; both the page and the WebSocket go through the load balancer. The tabs will very likely land on different containers. If edits still sync in real time, Redis pub/sub is relaying the updates that instance A receives to the clients on instance B. Without it, sync would only work when both connections happened to hit the same process.

> ⚠️ Known issue: with several instances, an instance that opens a room for the first time only receives later updates. It doesn't get the state the other instances already hold, because Redis relays only new updates and Mongo snapshots are debounced by 3 seconds. A client that reconnects to a different instance after being offline may not converge. See "Known limitations" below.

## Tests

```bash
cd server && npm test   # vitest: starts the real server and real y-websocket clients; checks concurrent-edit convergence and offline merge
cd e2e && npx playwright install chromium && npm test   # two real browser contexts editing the same room, plus offline reconnect
cd e2e && npm run test:docker   # same suite, run against the docker compose stack (app + Redis + Mongo)
```

## Planned next steps (hooks exist in the code, not fully implemented)

1. **Authentication / room permissions**: right now any room id can be joined. A production version should add JWT and room-membership checks.
2. **Further rendering work**: react-konva currently redraws the whole layer. Once there are thousands of shapes, this should move to dirty-region redraws or separate layers (static shapes on one layer, the shape being dragged on its own layer).
3. **Snapshot compaction**: full `Y.encodeStateAsUpdate` snapshots grow with the document's history. A production setup should periodically replace the old snapshot with a fresh `Y.encodeStateAsUpdate(doc)` (a form of GC/compaction) instead of accumulating an ever-growing update log.

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
- Opt-in: the job is **skipped** until the repository variable `DEPLOY_ENABLED` is set to `true`. It is not set yet: no GCP project is connected, so nothing is deployed and there is no live URL.
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
