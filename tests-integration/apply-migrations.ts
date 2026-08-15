import { applyD1Migrations, env } from "cloudflare:test";

// Per-isolate. Isolated storage means each test sees a fresh D1; applying
// here is what makes that copy have the production schema rather than empty
// tables. Same pattern Cloudflare's own D1 workers-test docs use.

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
