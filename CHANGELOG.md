# Changelog

## [Unreleased]

### Fixed

- **Dev plan `max_output_tokens` 1024 → 8192** (migration `0008`). 1024 was a provisional seed, not a normal chat ceiling; Opus/Sonnet on hard prompts burned the budget on invisible reasoning and returned empty content with `finish_reason=length`. Live D1 already applied; this lands the migration in git for deploy parity.

## [0.4.0] - 2026-08-05

Ship the commercial metering surface past the v0.3.0 voice/non-chat cut: rate refresh, reconcile cron, DO sqlite migration fix, and product decision parking.

### Added

- **`POST /admin/catalog/refresh`** -- pull chat token rates from AI Gateway `compat/models` into `model_prices` (dry-run default; does not rewrite `catalog.ts`).
- **Hourly reconcile cron** (`scheduled()`, `[triggers] crons = ["0 * * * *"]`) -- same `runReconcile` as admin POST; dry-run unless `RECONCILE_CRON_LIVE=true`.
- D1 migration path for STT tickets and unit prices already on main from the 0.3.x line; this tag ensures deploy carries wrangler DO + cron config.

### Fixed

- **SttSession Durable Object** registered as `new_sqlite_classes` (CF error 10099; KV-backed classes rejected).

### Docs / product

- Open decisions: enrollment, commercial plan numbers, and UB non-chat unit rates **deferred** until further development + hosted web client testing.
- Deployment identity **settled:** `play-proxy.skyphusion.org` (separate from play).

### Deploy notes

- Applies any pending D1 migrations on deploy.
- Cron is dry-run only until `RECONCILE_CRON_LIVE=true` is set on the Worker vars.
- After deploy: dry-run `POST /admin/catalog/refresh` and confirm `scheduled.reconcile_start` in logs.

## [0.3.0] - 2026-08-05

Unit-metered non-chat doors, Flux live STT, STT session tickets. See git history for PR #22.
