import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Node-env suite: the request path, pure decision modules, and contract scanners.
//
// These stay in Node on purpose. The store and runner seams exist so the gates
// (auth, entitlement, quota, metering) run without workerd. The Durable Object
// path cannot: it lives in tests-integration / vitest.workers.config.ts.

export default defineConfig({
  resolve: {
    alias: {
      // Durable Object base class is only available in workerd; node tests use a stub.
      "cloudflare:workers": resolve(import.meta.dirname, "tests/mocks/cloudflare-workers.ts"),
    },
  },
  test: {
    name: "node",
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
