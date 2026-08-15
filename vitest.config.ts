import { defineConfig } from "vitest/config";

// Root Vitest config: aggregates two projects so a single `npm test` runs both.
//
//   - "node"    -> vitest.node.config.ts      existing suite (FakeStore, no workerd)
//   - "workers" -> vitest.workers.config.ts   STT Durable Object harness (workerd)
//
// Split exists because the live-voice path is a SQLite-backed Durable Object
// and cannot be constructed under the node alias of cloudflare:workers.

export default defineConfig({
  test: {
    projects: ["./vitest.node.config.ts", "./vitest.workers.config.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
    },
  },
});
