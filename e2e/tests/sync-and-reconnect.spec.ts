import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";

/**
 * Two real browser contexts (separate storage, separate WebSocket
 * connections) on the same board. Assertions read the actual Konva scene
 * graph of each page, not just a counter, so "the other side sees it" means
 * the same shape ids at the same coordinates on both canvases.
 */

interface CanvasShape {
  id: string;
  type: string;
  x: number;
  y: number;
}

async function canvasShapes(page: Page): Promise<CanvasShape[]> {
  return page.evaluate(() => {
    // Konva registers itself on window and keeps a list of live stages.
    const Konva = (window as unknown as { Konva?: any }).Konva;
    const stage = Konva?.stages?.[0];
    if (!stage) return [];
    return stage
      .find(".shape")
      .map((n: any) => ({
        id: n.id(),
        type: n.getClassName(),
        x: Math.round(n.x()),
        y: Math.round(n.y()),
      }))
      .sort((a: CanvasShape, b: CanvasShape) => a.id.localeCompare(b.id));
  });
}

/** Centre of a shape in page (viewport) coordinates, for mouse dragging. */
async function shapeCenter(page: Page, id: string): Promise<{ x: number; y: number }> {
  const local = await page.evaluate((shapeId) => {
    const Konva = (window as unknown as { Konva?: any }).Konva;
    const node = Konva?.stages?.[0]?.findOne(`#${shapeId}`);
    if (!node) return null;
    const r = node.getClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  if (!local) throw new Error(`shape ${id} not on canvas`);
  const box = await page.locator(".konva-stage").boundingBox();
  if (!box) throw new Error("stage not found");
  return { x: box.x + local.x, y: box.y + local.y };
}

async function dragShape(page: Page, id: string, dx: number, dy: number) {
  const from = await shapeCenter(page, id);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 });
  await page.mouse.up();
}

async function waitForConnected(page: Page) {
  await expect(page.locator(".status-badge")).toHaveClass(/status-connected/, { timeout: 15_000 });
  // "已连接" (connected) is only shown once the initial Yjs sync finished;
  // "同步中…" means connected but not yet synced.
  await expect(page.locator(".status-badge")).toContainText("已连接", { timeout: 15_000 });
}

async function openBoard(context: BrowserContext, room: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?room=${encodeURIComponent(room)}`);
  await waitForConnected(page);
  return page;
}

/**
 * Network switch for one browser context. Every WebSocket the page opens is
 * proxied through Playwright to the real server; "going offline" puts the
 * context in offline mode, cuts every live proxied socket and refuses new
 * ones until we come back online. From the app's point of view this is a
 * dropped network: y-websocket sees the socket close, keeps retrying with
 * backoff, and the UI shows the offline badge.
 */
async function installNetworkSwitch(context: BrowserContext) {
  let online = true;
  const live = new Set<{ page: WebSocketRoute; server: WebSocketRoute }>();

  await context.routeWebSocket(/.*/, (ws) => {
    if (!online) {
      void ws.close({ code: 1006, reason: "offline (e2e)" }).catch(() => {});
      return;
    }
    const server = ws.connectToServer();
    const pair = { page: ws, server };
    live.add(pair);
    ws.onClose(() => live.delete(pair));
    server.onClose(() => live.delete(pair));
  });

  return {
    async goOffline() {
      online = false;
      await context.setOffline(true);
      for (const pair of [...live]) {
        live.delete(pair);
        await pair.server.close().catch(() => {});
        await pair.page.close({ code: 4000, reason: "offline (e2e)" }).catch(() => {});
      }
    },
    async goOnline() {
      online = true;
      await context.setOffline(false);
    },
  };
}

async function newContext(browser: Browser) {
  return browser.newContext({ viewport: { width: 1500, height: 1000 } });
}

test("drawing in one browser shows up on the other", async ({ browser }) => {
  const room = `e2e-draw-${Date.now()}`;
  const aliceCtx = await newContext(browser);
  const bobCtx = await newContext(browser);
  const alice = await openBoard(aliceCtx, room);
  const bob = await openBoard(bobCtx, room);

  // Alice draws a rectangle...
  await alice.getByRole("button", { name: "+ 矩形" }).click();
  await expect.poll(async () => (await canvasShapes(alice)).length).toBe(1);
  const [rect] = await canvasShapes(alice);
  expect(rect.type).toBe("Rect");

  // ...and Bob's canvas has the very same shape, without a reload.
  await expect.poll(() => canvasShapes(bob), { timeout: 5_000 }).toEqual([rect]);
  await expect(bob.locator(".toolbar .hint")).toContainText("1 个图形");

  // Alice drags it; Bob sees it land at the same coordinates.
  await dragShape(alice, rect.id, 200, 120);
  await expect.poll(async () => (await canvasShapes(alice))[0].x).not.toBe(rect.x);
  const moved = await canvasShapes(alice);
  await expect.poll(() => canvasShapes(bob), { timeout: 5_000 }).toEqual(moved);

  // And the other direction: Bob draws a sticky note, Alice sees it.
  await bob.getByRole("button", { name: "+ 便签" }).click();
  await expect.poll(async () => (await canvasShapes(bob)).length).toBe(2);
  const bobView = await canvasShapes(bob);
  await expect.poll(() => canvasShapes(alice), { timeout: 5_000 }).toEqual(bobView);

  await aliceCtx.close();
  await bobCtx.close();
});

test("a client that goes offline, edits, and reconnects converges with its peer", async ({ browser }) => {
  const room = `e2e-reconnect-${Date.now()}`;
  const aliceCtx = await newContext(browser);
  const bobCtx = await newContext(browser);
  const bobNetwork = await installNetworkSwitch(bobCtx);

  const alice = await openBoard(aliceCtx, room);
  const bob = await openBoard(bobCtx, room);

  // Shared starting point: one rectangle both sides agree on.
  await alice.getByRole("button", { name: "+ 矩形" }).click();
  await expect.poll(async () => (await canvasShapes(bob)).length, { timeout: 5_000 }).toBe(1);
  const [shared] = await canvasShapes(alice);
  expect(await canvasShapes(bob)).toEqual([shared]);

  // Bob loses the network.
  await bobNetwork.goOffline();
  await expect(bob.locator(".status-badge")).toHaveClass(/status-disconnected/, { timeout: 15_000 });

  // While Bob is offline, both keep editing:
  //  - Alice moves the shared rectangle,
  await dragShape(alice, shared.id, 220, 140);
  await expect.poll(async () => (await canvasShapes(alice))[0].x).not.toBe(shared.x);
  //  - Bob adds a sticky note locally (it must survive the reconnect).
  await bob.getByRole("button", { name: "+ 便签" }).click();
  await expect.poll(async () => (await canvasShapes(bob)).length).toBe(2);

  // The two replicas have genuinely diverged at this point.
  const aliceOffline = await canvasShapes(alice);
  const bobOffline = await canvasShapes(bob);
  expect(aliceOffline).toHaveLength(1);
  expect(bobOffline).toHaveLength(2);
  const bobsSticky = bobOffline.find((s) => s.id !== shared.id)!;
  expect(bobOffline.find((s) => s.id === shared.id)).toEqual(shared); // Bob still has the old position

  // Bob comes back.
  await bobNetwork.goOnline();
  await waitForConnected(bob);

  // Both converge to the same state: Alice's move AND Bob's offline note.
  await expect.poll(async () => (await canvasShapes(alice)).length, { timeout: 15_000 }).toBe(2);
  await expect
    .poll(async () => JSON.stringify(await canvasShapes(bob)), { timeout: 15_000 })
    .toBe(JSON.stringify(await canvasShapes(alice)));

  const final = await canvasShapes(alice);
  expect(final.find((s) => s.id === shared.id)).toEqual(aliceOffline[0]);
  expect(final.find((s) => s.id === bobsSticky.id)).toEqual(bobsSticky);
  await expect(alice.locator(".toolbar .hint")).toContainText("2 个图形");
  await expect(bob.locator(".toolbar .hint")).toContainText("2 个图形");

  await aliceCtx.close();
  await bobCtx.close();
});
