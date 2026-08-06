# prism-control-plane

**License:** AGPL-3.0-only  
**Sibling:** [prism](https://github.com/skyphusion-labs/prism) (playground + inference Worker)  
**Native clients:** [prism-ios](https://github.com/skyphusion-labs/prism-ios), [prism-android](https://github.com/skyphusion-labs/prism-android) (build against this plane's contract)

## What this is

The metering and policy plane for **commercial Prism**: accounts, plan entitlements, a usage ledger,
and a **metered proxy** to Cloudflare AI Gateway / Workers AI. Cost-recovery economics (cover CF and
inference expense, not extractive margins). Full stack stays AGPL, so a self-hoster can run the same
machinery on their own Cloudflare account.

This plane owns **who may call what, and how much**. Conversation history, RAG, artifacts, and the
multimodal surface stay in [prism](https://github.com/skyphusion-labs/prism).

```
mobile client --(bearer client key)--> prism-control-plane --(gateway.ai.cloudflare.com)--> AI Gateway --> model
                                              |
                                              +-- D1: entitlements, prepaid credit, usage ledger
```

Live at `play-proxy.skyphusion.org`, AI Gateway `prism-proxy`. Full production wiring, the credential
model, and the mermaid flowchart are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## The client contract comes first

Native clients ([prism-ios](https://github.com/skyphusion-labs/prism-ios),
[prism-android](https://github.com/skyphusion-labs/prism-android)) and any future SDK are written
against a contract defined here, not against whatever the Worker happens to return today:

- **[`docs/CONTRACT.md`](docs/CONTRACT.md)** -- the normative contract. Auth, enrollment, error codes
  and their retry semantics, quota behaviour, limits, and the open decisions still owed.
- **[`docs/openapi.yaml`](docs/openapi.yaml)** -- the same surface, machine-readable.

`tests/contract.test.ts` fails the build if the router and the contract drift apart.

Conversation history and compact live on the **playground** Worker ([prism](https://github.com/skyphusion-labs/prism)),
not here. This plane never stores prompts or completions.

## Privacy invariant

**Prompt and completion text is never persisted by this plane.** The ledger stores counts (tokens,
micro-USD, model id, status); there is no column that can hold message content, and
`tests/schema-privacy.test.ts` enforces that against `migrations/`. AI Gateway request logging is off
by default, so the gateway retains nothing either. Any change to that is a contract change.

The consequence, stated plainly: this plane cannot replay or audit a conversation. Clients hold the
only copy of what they sent.

## Endpoints

The table below is the **core client surface only** (health, enroll, me, models, usage, chat). The full
non-chat surface (images, speech, transcriptions, videos, music, STT sessions) and every error code is
normative in [`docs/CONTRACT.md`](docs/CONTRACT.md) and [`docs/openapi.yaml`](docs/openapi.yaml). Prefer
those files when wiring a client.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness. Touches no binding. |
| GET | `/health/deep` | Readiness: D1 schema applied, catalog priced, gateway configured. |
| POST | `/v1/clients` | Enroll a device against a one-time token, receive a client key. |
| GET | `/v1/me` | Account, plan, entitlements, current usage. |
| GET | `/v1/models` | Entitlement-filtered model list with published prices. |
| GET | `/v1/usage` | Current-period usage, including the unmetered count. |
| POST | `/v1/chat/completions` | Metered inference, OpenAI-compatible. |

Operator routes (`/admin/*`, single bearer, **503 when `ADMIN_TOKEN` is unset**) create accounts, mint
enrollment tokens, and revoke client keys. They are not part of the client contract.

## How metering works

- Money is **integer micro-USD** everywhere (1 USD = 1,000,000 micro-USD). No floats in the money path.
- **Prepaid only.** An account spends a credit balance; there is no overage and no postpaid invoice,
  ever. The pre-flight balance gate runs **before** the model does, against spend already recorded, so
  an account can overshoot by at most one request, bounded by the plan's `max_output_tokens`. The bound
  is documented rather than hidden; a pre-flight gate on a post-hoc cost cannot be exact. `402` when the
  balance is gone.
- The reporting period is a **UTC calendar month**, keyed `YYYY-MM`. It groups usage for display; it
  does not reset the balance and it grants nothing.
- **The plane's own meter is what actually charges an account, in real time**, pricing each request from
  token counts against a per-model rate pinned in `src/catalog.ts`. Cloudflare's own per-request cost
  figure is read back later, by `POST /admin/reconcile`, and used only to **true up** the estimate as an
  auditable adjustment; it never gates or delays a response. See `docs/ARCHITECTURE.md#pricing-and-why-it-needs-reconciliation`.
- **Monthly allowance then prepaid credit.** `plans.monthly_included_micro_usd` is spent first each
  UTC month; unused expires (never becomes a cash grant). Zero means pure prepaid. Credit is lifetime.
- **Unmetered is a first-class outcome.** A model that answers without usable token counts, or a
  request we stopped waiting for, records a ledger row with `metered = 0` and a reason, charges
  nothing, and increments a separate `unmetered_requests` counter that `GET /v1/usage` publishes.
  "Nothing was owed" and "we could not tell what was owed" are different facts, and collapsing them
  would turn every gap in the meter into a silent free ride.

## Local development

```bash
npm ci
npm run typecheck        # tsc on src and tests -- CI gate
npm test                 # vitest run, no workerd and no network needed

npm run bootstrap        # wrangler.example.toml -> wrangler.toml (gitignored)
npx wrangler d1 create prism-control-plane   # paste the id into wrangler.toml
npm run db:migrate:local
npm run dev
```

Then drive it end to end. `ADMIN_TOKEN` and any other secrets go in `.dev.vars` (gitignored):

```bash
# 1. an account on the seeded provisional plan
curl -sX POST localhost:8787/admin/accounts \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"plan_id":"dev"}'

# 2. a one-time enrollment token for it
curl -sX POST localhost:8787/admin/enrollments \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"account_id":"acct_..."}'

# 3. trade it for a client key (shown once)
curl -sX POST localhost:8787/v1/clients \
  -H 'content-type: application/json' \
  -d '{"enrollment_token":"...","platform":"other"}'

# 4. call a model (needs AI_GATEWAY_ID set, or this answers 503 by design)
curl -si localhost:8787/v1/chat/completions \
  -H "authorization: Bearer pcp_..." -H 'content-type: application/json' \
  -d '{"model":"@cf/meta/llama-3.2-3b-instruct","messages":[{"role":"user","content":"hi"}]}'
```

Step 4 spends real Workers AI inference. Steps 1 to 3 do not.

The whole request path is testable without workerd: persistence sits behind `ControlPlaneStore` and
the upstream behind `InferenceRunner`, so `tests/router.test.ts` drives every gate with an in-memory
store and a fake runner.

## Status

**Deployed and live** at `play-proxy.skyphusion.org`. Built: the client contract, dual-pool metering
(monthly allowance then prepaid credit), shared-token AI Gateway proxy with `cf-aig-metadata`
attribution, priced catalog (**45/44 chat**), SSE metering, operator reconciliation
(`POST /admin/reconcile`), and operator plan upsert (`POST /admin/plans`). Provisional `dev` plan
covers standard+premium chat. Non-chat unit-metered doors and Flux live STT are built. **Catalog rate
refresh:** `POST /admin/catalog/refresh` (operator; dry-run default) pulls chat rates from AI Gateway
`compat/models` into `model_prices`. **Reconcile cron:** hourly scheduled dry-run (live only with
`RECONCILE_CRON_LIVE=true`). **Not built:** store-receipt enrollment, commercial plan pricing. No
overage billing, ever.

Full production wiring, the mermaid flowchart, and the reconciliation design are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Agent-facing guidance, non-negotiables, and deploy /
secret procedure are in [`CLAUDE.md`](CLAUDE.md).

Plan pricing, the model set, and enrollment source of truth are **open decisions** listed at the end of
[`docs/CONTRACT.md`](docs/CONTRACT.md). The seeded `dev` plan is a provisional
placeholder for local work, not a product tier.

## Related

- This plane, live: `play-proxy.skyphusion.org`
- Sibling playground + inference Worker: [prism](https://github.com/skyphusion-labs/prism), live at
  https://play.skyphusion.org
- Pattern peer: [vivijure-control-plane](https://github.com/skyphusion-labs/vivijure-control-plane)
