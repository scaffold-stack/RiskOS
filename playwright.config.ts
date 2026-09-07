import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5273", trace: "retain-on-failure" },
  webServer: [
    {
      command: "NODE_ENV=test DATA_MODE=fixture PORT=3101 WEB_ORIGIN=http://127.0.0.1:5273 node dist/apps/api/src/server.js",
      url: "http://127.0.0.1:3101/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "VITE_API_URL=http://127.0.0.1:3101 npm run dev:web -- --host 127.0.0.1 --port 5273",
      url: "http://127.0.0.1:5273",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
