# prism-control-plane

**License:** AGPL-3.0-only  
**Sibling:** [prism](https://github.com/skyphusion-labs/prism) (playground + inference Worker)  
**Future clients:** [prism-ios](https://github.com/skyphusion-labs/prism-ios), [prism-android](https://github.com/skyphusion-labs/prism-android)

## What this is

The metering and policy plane for **commercial Prism**: accounts, plan entitlements, a usage ledger,
and a **metered proxy** to Cloudflare AI Gateway / Workers AI. Cost-recovery economics (cover CF and
inference expense, not extractive margins). Full stack stays AGPL, so a self-hoster can run the same
machinery on their own Cloudflare account.

This plane owns **who may call what, and how much**. Conversation history, RAG, artifacts, and the
multimodal surface stay in [prism](https://github.com/skyphusion-labs/prism).

```
mobile client --(bearer client key)--> prism-control-plane --(AI binding)--> AI Gateway / Workers AI
                                              |
                                              +-- D1: entitlements, per-period usage ledger
```

## The client contract comes first

The mobile apps do not exist yet, and they will be written against a contract defined here rather
than against whatever this Worker happens to return:

- **[`docs/CONTRACT.md`](docs/CONTRACT.md)** -- the normative contract. Auth, enrollment, error codes
  and their retry semantics, quota behaviour, limits, and the open decisions still owed.
- **[`docs/openapi.yaml`](docs/openapi.yaml)** -- the same surface, machine-readable.

`tests/contract.test.ts` fails the build if the router and the contract drift apart.

## Privacy invariant

**Prompt and completion text is never persisted by this plane.** The ledger stores counts (tokens,
micro-USD, model id, status); there is no column that can hold message content, and
`tests/schema-privacy.test.ts` enforces that against `migrations/`. AI Gateway request logging is off
by default, so the gateway retains nothing either. Any change to that is a contract change.

The consequence, stated plainly: this plane cannot replay or audit a conversation. Clients hold the
only copy of what they sent.

## Endpoints

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
- The period is a **UTC calendar month**, keyed `YYYY-MM`.
- The allowance gate runs **before** the model does, against usage already recorded, so an account can
  overshoot by at most one request. That overshoot is bounded by the plan's `max_output_tokens`. The
  bound is documented rather than hidden; a pre-flight gate on a post-hoc cost cannot be exact.
- Requests are priced from token counts against a per-model rate pinned in `src/catalog.ts` (read off
  Cloudflare's published pricing, with the date recorded).
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

Foundation built, not deployed. What exists: the client contract, the Worker, the D1 schema, client-key
auth with one-time enrollment, entitlement and rate gates, the allowance gate, the priced usage ledger,
and 128 unit tests. What does not: streaming (`stream: true` answers `501`), overage billing, a
receipt-validated enrollment source, and any deployment.

Plan pricing, the model set, streaming, overage, and the gateway logging posture are **open decisions**
listed at the end of [`docs/CONTRACT.md`](docs/CONTRACT.md). The seeded `dev` plan is a provisional
placeholder for local work, not a product tier.

## Related

- Live playground: https://play.skyphusion.org  
- Pattern peer: [vivijure-control-plane](https://github.com/skyphusion-labs/vivijure-control-plane)
