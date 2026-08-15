import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Workers-runtime suite: the live-voice Durable Object.
//
// Precedent is prism's vitest.workers.config.ts (strummer-fc1611). The STT
// session is a Durable Object that uses ctx.storage.sql; a JSON stub binding
// made that path structurally untestable. Binding STT_SESSION as the real
// SQLite-backed class, matching wrangler.example.toml, is what makes
// finalize() and the gateway metadata call site reachable from a test.
//
// AI is an empty object the tests mutate. That is how the gateway call site
// is observed without a live Flux / OpenAI / CF upstream: the test installs
// a run() that records its arguments and does not open a network socket.
//
// Coverage is node-only (`npm run test:coverage --project node`). v8 coverage
// loads node:inspector/promises, which workerd does not have.

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(resolve(import.meta.dirname, "migrations"));
      return {
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-05-01",
          d1Databases: ["DB"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            CF_AIG_TOKEN: "test-cf-aig-token-not-real",
            CF_ACCOUNT_ID: "fabcb25d9c7eb087110ec474a03e50d2",
            AI_GATEWAY_ID: "prism-proxy",
            // Mutable JSON stub. Tests assign .run so the DO's call site is
            // observable. A live Workers AI binding would spend.
            AI: {},
          },
          // Mirrors [[durable_objects.bindings]] + new_sqlite_classes in
          // wrangler.example.toml. useSQLite is required: SttSession uses
          // ctx.storage.sql, and a KV-backed DO rejects that.
          durableObjects: {
            STT_SESSION: { className: "SttSession", useSQLite: true },
          },
        },
      };
    }),
  ],
  test: {
    name: "workers",
    include: ["tests-integration/**/*.test.ts"],
    setupFiles: ["./tests-integration/apply-migrations.ts"],
  },
});
