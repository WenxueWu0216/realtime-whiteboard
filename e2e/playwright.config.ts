import { defineConfig } from "@playwright/test";

/**
 * Two ways to run the suite:
 *
 * 1. Default (`npm test`): starts the real server and the real Vite dev
 *    server locally (see `webServer` below) and drives two independent
 *    browser contexts (= two "different people") against the same room.
 *
 * 2. Against an already-running deployment, e.g. the docker compose stack
 *    (`npm run test:docker`, or `npm run test:stack` if it is already up):
 *    set E2E_BASE_URL (e.g. http://localhost:8080). No local servers are
 *    started; the page and its WebSocket both come from that origin.
 */
const externalBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: externalBaseUrl ?? "http://localhost:5173",
    trace: "retain-on-failure",
    // Optional override for environments that ship a pinned Chromium
    // outside Playwright's managed-browser cache. Not needed after
    // `npx playwright install chromium` (which is what CI does).
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : undefined,
  },
  webServer: externalBaseUrl
    ? undefined
    : [
        {
          command: "npm run dev",
          cwd: "../server",
          port: 1234,
          reuseExistingServer: true,
          timeout: 20_000,
        },
        {
          command: "npm run dev",
          cwd: "../client",
          port: 5173,
          reuseExistingServer: true,
          timeout: 20_000,
        },
      ],
});
