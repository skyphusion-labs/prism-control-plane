# CLAUDE.md -- prism-control-plane

Guidance for agents working in this repository.

## What this is

The metering and policy plane for **commercial Prism**: accounts, plan entitlements, a usage ledger,
and a metered proxy to Cloudflare AI Gateway / Workers AI. Cost-recovery economics (cover CF and
inference expense, not extractive margins). Full stack stays AGPL; self-hosters can run the same
machinery on their own Cloudflare account.

This plane owns **who may call what and how much**. Inference routing, catalog breadth, and the
multimodal surface stay in **[prism](https://github.com/skyphusion-labs/prism)**.

**Status: deployed and live at `play-proxy.skyphusion.org`.** Built: the client contract, the Worker
and its route table, the D1 schema, client-key auth with one-time enrollment, entitlement and rate
gates, the prepaid balance gate, the priced usage ledger, SSE streaming with trailing-usage capture, and
the AI Gateway cost reconciliation job
([#12](https://github.com/skyphusion-labs/prism-control-plane/issues/12): `POST /admin/reconcile`,
operator-triggered, dry run by default). **Not built:** the flat plan's monthly included-token allowance
(only the prepaid balance half exists,
[#11](https://github.com/skyphusion-labs/prism-control-plane/issues/11)), a refresh of `src/catalog.ts`
from `compat/models`, and a receipt-validated enrollment source. No paid traffic has been served through
it yet. Aviation-grade `main` (PR + `ci` + `coverage` + CodeQL).

**KNOWN BLOCKER on reconciliation in production.** Measured 2026-08-05: `src/upstream.ts` calls the AI
REST API with a `cf-aig-gateway-id` header exactly as Cloudflare documents, and on this account that does
**not** route through `prism-proxy` -- it answers `200` even with a deliberately invalid
`cf-aig-authorization`, emits no `cf-aig-*` response headers, and writes no log row. So the gateway feed
is empty and there is nothing to reconcile. The reconciliation code and its live read are verified; the
traffic is not reaching the gateway. Evidence table and the working canonical URL form are in
`docs/ARCHITECTURE.md`. Do not "fix" it by weakening a privacy or fail-closed path.

**There is no overage billing and there never will be.** Prepaid only; the plane answers `402` when
the money is gone.

## The contract is the authority

`docs/CONTRACT.md` (normative prose) and `docs/openapi.yaml` (machine-readable) define the client
surface. They were written **before** any client existed, and `prism-ios` / `prism-android` will be
built against them.

- A change to a route, an error code, a status mapping, or a published header is a **contract change**.
  Update both files in the same commit as the code.
- `tests/contract.test.ts` fails the build when the router, the error-code table, or the published
  `prism-*` headers drift from the docs. Do not silence it; fix the drift.
- Within `/v1` changes must be **additive**. Breaking changes get `/v2`.

## Non-negotiables

1. **Privacy invariant.** No prompt or completion text is ever persisted. No such column may be added
   to `migrations/`; `tests/schema-privacy.test.ts` enforces it, including a positive control that the
   scanner still catches a planted violation. `cf-aig-collect-log-payload: false` is hard-wired in
   `src/upstream.ts` with **no env override**: an invariant that config can switch off is a default.
   The separate `cf-aig-collect-log` (metadata only: tokens, model, cost, duration) defaults **on**,
   which is what makes the biller's cost figure available to check our ledger against.
2. **Money is integer micro-USD.** No floats in the money path. The unit belongs in the name of every
   field that carries it.
3. **Unmetered is a first-class outcome**, distinct from a zero charge. See `src/meter.ts`. Do not
   collapse them, and do not "simplify" an unmetered row into nothing.
4. **Fail closed.** No gateway means the inference route answers 503, not a direct model call. An unset
   `ADMIN_TOKEN` means there is no operator surface. A malformed plan refuses rather than getting a
   default. An unusable usage counter answers 503, never 402.
5. **No passthrough.** The catalog in `src/catalog.ts` is a closed allowlist. A model that cannot be
   priced cannot be called (`model_unpriced`), but unpriced is the **expected** state for much of the
   catalog: Cloudflare publishes no public per-token rate for third-party Unified Billing models. So
   the refusal is per-model at the door, not a readiness failure. Rates: `docs/ARCHITECTURE.md` and
   [#10](https://github.com/skyphusion-labs/prism-control-plane/issues/10).

## Architecture

**Full picture, with the production wiring and a mermaid flowchart: `docs/ARCHITECTURE.md`.** Read it
before changing the spend path.

| File | Role |
| --- | --- |
| `src/index.ts` | Worker entry plus the whole route table. `handleRequest` takes its dependencies, which is what makes the tests hermetic. |
| `src/env.ts` | Hand-authored `Env`, mirroring `wrangler.example.toml`. Never commit a generated `worker-configuration.d.ts`. |
| `src/http.ts` | Error codes, the code-to-status table, JSON helpers, body cap. |
| `src/catalog.ts` | Model allowlist and rate table, in one table on purpose. |
| `src/plans.ts` | Plan validation, tier entitlement, output-token clamping. Pure. |
| `src/balance.ts` | The pre-flight prepaid decision. Pure. |
| `src/meter.ts` | Pricing one request, or declining to. Pure. |
| `src/period.ts` | UTC calendar-month period keys and bounds. Pure. Counts usage; grants nothing. |
| `src/auth.ts` | Client-key format, minting, and the one identity resolution path. |
| `src/store.ts` / `src/store-d1.ts` | Persistence interface and its only D1 implementation. |
| `src/inference.ts` | `InferenceRunner` interface. The seam a model is reached through. |
| `src/upstream.ts` | The only place Cloudflare's AI REST API is called, and the only place the privacy headers are set. |
| `src/aig-logs.ts` | The only place the gateway LOG API is read. `GatewayLogSource` is the seam. GET only, and it REFUSES the stored-payload endpoints by throwing. |
| `src/reconcile.ts` | What one gateway row means for one ledger row. Pure: no clock, no I/O. |
| `src/reconcile-run.ts` | One reconciliation run: paging, applying, the watermark, the reverse check, structured logs. |
| `src/token-minter.ts` | `UpstreamCredentialSource`: `SharedTokenSource` (default) and the opt-in `CfUserTokenProvider`. |
| `src/stream.ts` | Byte-for-byte SSE relay plus trailing-usage capture. |
| `src/routes/*.ts` | Handlers. `chat.ts` is the metered door and documents its gate order. |

Pure decision modules plus two injected seams (`ControlPlaneStore`, `InferenceRunner`) mean the entire
request path runs in plain Node vitest: no workerd, no Miniflare, no network. Keep it that way. If a new
behaviour needs a binding, put it behind an interface rather than reaching for the binding in a handler.

## Related

| Repo | Role |
| --- | --- |
| [prism](https://github.com/skyphusion-labs/prism) | Playground + inference Worker (`play.skyphusion.org`) |
| [prism-ios](https://github.com/skyphusion-labs/prism-ios) | iOS client (not started; will implement `docs/CONTRACT.md`) |
| [prism-android](https://github.com/skyphusion-labs/prism-android) | Android client (not started; will implement `docs/CONTRACT.md`) |
| [vivijure-control-plane](https://github.com/skyphusion-labs/vivijure-control-plane) | Pattern peer; the `unbillable` / third-outcome doctrine comes from its settlement path |

## Commands

```bash
npm ci
npm run typecheck   # tsc on src AND tests -- CI gate
npm test            # vitest run
npm run test:coverage

npm run bootstrap   # wrangler.example.toml -> wrangler.toml (gitignored)
npm run db:migrate:local
npm run dev
```

`README.md` has the end-to-end local walkthrough (create account, mint enrollment token, enroll, call).
Only the final inference call spends anything.

## Docs index

| Doc | What it is for |
| --- | --- |
| `docs/CONTRACT.md` | **Normative** client surface. The mobile build target. |
| `docs/openapi.yaml` | The same contract, machine-readable. Changes in the same commit as the prose. |
| `docs/ARCHITECTURE.md` | Production wiring, mermaid flowchart, credential model, money model and its gap, pricing findings. |
| `README.md` | End-to-end local walkthrough. |
| [#10](https://github.com/skyphusion-labs/prism-control-plane/issues/10) | Measured model rates and pricing methodology. |

## Deployment and secrets

Live: Worker **`prism-control-plane`** at **`play-proxy.skyphusion.org`** (custom domain, wrangler-owned
DNS), AI Gateway **`prism-proxy`**, D1 **`prism-control-plane`**, prod account
`fabcb25d9c7eb087110ec474a03e50d2`. No `workers.dev`. Only binding is `DB`; no KV, R2, or Queues.

**Credential posture: `shared`.** One account-scoped `CF_AIG_TOKEN` (AI Gateway Run + Workers AI Read +
**AI Gateway Read**, widened 2026-08-05 for reconciliation) reaches models; per-user attribution rides on
`cf-aig-metadata` plus the D1 ledger. Editing a Cloudflare token's policies does not change its value, so
that widening required no re-escrow of the ciphertext and no `wrangler secret put`. Per-user token
minting is implemented, bounded, and **off**; do not turn it on without reading the 500-token ceiling
note in `docs/ARCHITECTURE.md`.

### Where the config and credentials live

The committed `wrangler.example.toml` is a **template** with a placeholder database id. The live config
is the repo secret `PRISM_CONTROL_PLANE_WRANGLER`, and because a GitHub Actions secret cannot be read
back, the canonical copy is escrowed. **Change one, change all three** (working copy, escrow, repo
secret).

| Escrow (`skyphusion-labs/crew-secrets`, `swarm-secrets/`) | Holds |
| --- | --- |
| `prism-control-plane-wrangler/wrangler.toml.age` | The live wrangler config. Resource ids and routes, **never a Worker secret**. |
| `prism-control-plane-aig/env.age` | `CF_AIG_TOKEN` (runtime shared credential). |
| `prism-control-plane-deploy/env.age` | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (CI deploy). |
| `prism-control-plane-worker-secrets/env.age` | `ADMIN_TOKEN`. |

All four are armored age to exactly three recipients: mackaye, strummer, conrad.

**Never put a bearer in the wrangler config.** CI writes that config to disk on a runner, so a secret
placed there is materialized in the clear, and it would not take effect anyway: Worker secrets are read
from the secret store, not the deploy config. `wrangler secret put` takes effect immediately and
persists across deploys; `vars` only change on a full `wrangler deploy`.

```bash
# Materialize the working copy (gitignored).
age -d -i ~/.config/chezmoi/key.txt \
  ~/Documents/GitHub/crew-secrets/swarm-secrets/prism-control-plane-wrangler/wrangler.toml.age \
  > wrangler.toml
```

### Deploying

Prod ships from a **tag that is already on `main`** via `.github/workflows/deploy.yml`. A
`workflow_dispatch` runs the gate and stops; it can never quietly become a deploy path that skipped
review. The workflow writes the config secret to `wrangler.ci.toml`, refuses a config still holding a
placeholder, applies D1 migrations, deploys, then smoke tests readiness.

`GET /health/deep` is the readiness probe and the **only** smoke test that spends nothing: it reads
D1 and reports whether the gateway and upstream credential are wired, without calling a model. It
answers `503` when it cannot serve, so a monitor watching status codes can see it fail.

## CI

- `.github/workflows/ci.yml` -- push/PR to `main`: typecheck + tests on GitHub-hosted `ubuntu-latest`
  (public, fork-safe; never fleet self-hosted)
- `.github/workflows/deploy.yml` -- tag `v*` only, gated on typecheck + tests and on the tag being an
  ancestor of `origin/main`
- Coverage + CodeQL workflows present

## Hands off

- **Never self-merge.** Open the PR and wait for review. A prior grant on another PR does not carry.
- **Do not spend to verify.** `/health/deep` and `/v1/models` cost nothing; a chat completion costs
  real money against a prepaid balance. Never fire inference "just to confirm" a deploy.
- **Do not weaken a fail-closed path** into a fallback. No gateway, no credential, or an unusable plan
  must keep answering `503`/refusal, never a direct model call or a guessed default.
- **Do not add a prompt or completion column** to `migrations/`, and do not silence
  `tests/schema-privacy.test.ts` or `tests/contract.test.ts`.
- **Do not change the live Worker via the Cloudflare dashboard or the settings API.** IaC only: edit
  the config, re-escrow, re-set the repo secret, deploy. A settings PATCH can desync `GET /settings`
  from the runtime deployment.
- Inference breadth and the multimodal surface belong to `prism`, not here.

## Conventions

- No em-dashes (U+2014) or en-dashes (U+2013) in source or docs; use commas, semicolons, or `--`.
- Comments explain the DECISION and what breaks without it, not what the next line does. Several
  modules carry long headers for exactly that reason; do not sand them down.
- Handle / username default: `skyphusion`.
- Conventional Commits. License: AGPL-3.0-only. Pre-1.0 SemVer: PATCH for fixes, MINOR for features.
- Keep status honest. Do not describe a deploy, a binding, or a plan tier that is not in the tree.

## Crew + identity

Crew work as their own identity (`sudo -u <member> bash -lc '...'`). Conrad laptop commits:
`Conrad Rockenhaus <conrad@skyphusion.org>`.
