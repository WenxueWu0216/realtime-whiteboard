import { defineConfig } from "@playwright/test";

/**
 * Starts the real server and the real Vite dev server, then drives two
 * independent browser contexts (= two "different people") against the same
 * room. This is the demo referenced in the README: recording this test run
 * is the "two browsers editing at once" clip for an interview walkthrough.
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    // This repo's sandbox ships a pinned Chromium outside Playwright's
    // usual managed-browser cache; point at it directly instead of
    // downloading. Safe to delete this override in a normal dev environment
    // where `npx playwright install` has been run.
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : undefined,
  },
  webServer: [
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
