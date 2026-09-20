import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/data-foundation/src/postgres-store.integration.test.ts",
      "packages/workflows/src/postgres-store.integration.test.ts",
      "packages/commercial/src/postgres-store.integration.test.ts",
    ],
    fileParallelism: false,
  },
});
