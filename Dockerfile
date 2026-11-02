# syntax=docker/dockerfile:1
#
# Production image: one container serves the built React app AND the Yjs
# WebSocket endpoint on the same port/origin. Used by docker-compose.yml and
# by the Cloud Run deploy workflow.
#
#   docker build -t whiteboard .
#   docker run -p 8080:8080 whiteboard            # in-memory, single instance
#   docker run -p 8080:8080 -e REDIS_URL=... -e MONGO_URL=... whiteboard
#
# (server/Dockerfile and client/Dockerfile are the older split images and are
# not used by compose or CI any more.)

# ---- 1. build the React client -------------------------------------------
FROM node:22-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
# Leave empty to connect back to the page's own origin (recommended). Only
# set it if the WebSocket server lives on a different host.
ARG VITE_WS_URL=
ENV VITE_WS_URL=${VITE_WS_URL}
RUN npm run build

# ---- 2. compile the TypeScript server -------------------------------------
FROM node:22-slim AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ---- 3. production-only server dependencies -------------------------------
FROM node:22-slim AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- 4. runtime ------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/public
WORKDIR /app/server
COPY --from=server-deps --chown=node:node /app/server/node_modules ./node_modules
COPY --chown=node:node server/package.json ./
COPY --from=server-build --chown=node:node /app/server/dist ./dist
COPY --from=client-build --chown=node:node /app/client/dist /app/public
USER node
EXPOSE 8080
# Used by docker / docker compose. Cloud Run ignores HEALTHCHECK.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
