/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Test-only Env surface for the workers suite. Not the production Env
// (src/env.ts). TEST_MIGRATIONS is injected by vitest.workers.config.ts so
// apply-migrations.ts can apply the same SQL production applies.

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    STT_SESSION: DurableObjectNamespace;
    AI?: Ai | Record<string, unknown>;
    CF_AIG_TOKEN?: string;
    CF_ACCOUNT_ID?: string;
    AI_GATEWAY_ID?: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];
  }
}
