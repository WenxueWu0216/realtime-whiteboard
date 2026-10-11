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
├── docker-compose.yml # Redis + MongoDB + server + client 一键起
└── e2e/                # Playwright：两个浏览器同时编辑
```

## 快速开始（最小可跑版本：单房间、多人同步画图）

```bash
# 1. 起 Redis + Mongo（横向扩展 & 持久化在最小版本里是可选的，不起也能跑）
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
docker compose -f docker-compose.yml -f docker-compose.scale.yml \
  up --build --scale server=3
```

这会起 3 个互不共享内存的 `server` 容器，前面挂一个纯轮询（无 sticky session）的 nginx（`docker/nginx-lb.conf`），监听 `:8080`。把客户端的 `VITE_WS_URL` 指向 `ws://localhost:8080`，开两个浏览器标签页大概率会被轮询分到不同的容器上 —— 如果这时两边编辑还能实时同步，就证明是 Redis pub/sub 在把"实例 A 收到的 update"广播给"实例 B 上的客户端"，而不是侥幸两个连接落在了同一进程。

## 测试

```bash
cd server && npm test   # vitest：真实起服务器 + 真实 y-websocket 客户端，验证并发编辑收敛 & 离线重连合并
cd e2e && npx playwright install && npm test   # 两个真实浏览器 context 同时编辑同一房间
```

## 已知的下一步（骨架已预留接口，未完全实现）

1. **鉴权 / 房间权限**：目前任意 room id 即可加入，生产版本应加 JWT + 房间成员校验。
2. **渲染性能进阶**：当前 react-konva 默认整层重绘，图形数量上千后应改为脏区域重绘或分层（静态图形一层、正在拖拽的图形单独一层）。
3. **快照压缩**：`Y.encodeStateAsUpdate` 全量快照会随历史增长而变大，生产环境应定期用 `Y.encodeStateAsUpdate(doc)` 替换旧快照（相当于 GC/compaction），而不是无限累积 update 日志。

## 面试要点速记

- **为什么用 CRDT 不用 OT**：OT 需要中心化的 transform 服务器维护操作顺序，扩展和实现都更复杂；CRDT（如 Yjs 的 YATA 算法）保证任意到达顺序的 update 都能无冲突地合并到同一最终状态，天然适合去中心化/多服务器场景。Figma、Linear 等新一代协作工具转向 CRDT 类机制也是这个原因。
- **单机 WebSocket 的扩展瓶颈**：一个 Node 进程内的 WS 连接只能广播给自己进程里的客户端；用户量上来后要多开进程/机器，这时候同一房间的两个人可能连在不同实例上，必须靠 Redis pub/sub 把"实例 A 收到的 update"广播给"实例 B 上的客户端"。
- **一致性模型**：最终一致（eventual consistency）——不保证任意时刻所有副本状态相同，但保证网络分区恢复、所有 update 送达后所有副本收敛到同一状态。
