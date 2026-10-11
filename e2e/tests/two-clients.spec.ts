import { test, expect, type Browser } from "@playwright/test";

async function openRoom(browser: Browser, room: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/?room=${room}`);
  await expect(page.locator(".status-badge")).toContainText(/已连接|同步中/, { timeout: 10_000 });
  return { context, page };
}

test("two browsers see each other's shapes in real time", async ({ browser }) => {
  const room = `e2e-${Date.now()}`;

  const alice = await openRoom(browser, room);
  const bob = await openRoom(browser, room);

  // Alice draws a rectangle.
  await alice.page.getByRole("button", { name: "+ 矩形" }).click();
  // Bob draws a sticky note.
  await bob.page.getByRole("button", { name: "+ 便签" }).click();

  // Each should see both shapes without reloading - that's the "no refresh
  // needed, it's just synced" behavior a CRUD app with polling wouldn't give
  // you for free.
  await expect(alice.page.locator(".toolbar .hint")).toContainText("2 个图形", { timeout: 5_000 });
  await expect(bob.page.locator(".toolbar .hint")).toContainText("2 个图形", { timeout: 5_000 });

  await alice.context.close();
  await bob.context.close();
});

test("a peer's live cursor (awareness) shows up on the other browser", async ({ browser }) => {
  const room = `e2e-cursor-${Date.now()}`;
  const alice = await openRoom(browser, room);
  const bob = await openRoom(browser, room);

  // Awareness state (cursors) is separate from the CRDT doc (shapes) - it's
  // ephemeral and never persisted, but should still propagate in real time.
  const bobStage = bob.page.locator(".konva-stage");
  const box = await bobStage.boundingBox();
  if (!box) throw new Error("stage not found");
  await bob.page.mouse.move(box.x + 200, box.y + 150);
  await bob.page.mouse.move(box.x + 250, box.y + 200); // second move to flush the rAF-throttled broadcast

  await expect(alice.page.locator(".cursor")).toHaveCount(1, { timeout: 5_000 });
  await expect(alice.page.locator(".cursor-label")).toContainText(/访客\d+/);

  await alice.context.close();
  await bob.context.close();
});
