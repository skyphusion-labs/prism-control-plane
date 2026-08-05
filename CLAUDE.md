# CLAUDE.md -- prism-control-plane

Guidance for agents working in this repository.

## What this is

The metering and policy plane for **commercial Prism**: accounts, plan entitlements, a usage ledger,
and a metered proxy to Cloudflare AI Gateway / Workers AI. Cost-recovery economics (cover CF and
inference expense, not extractive margins). Full stack stays AGPL; self-hosters can run the same
machinery on their own Cloudflare account.

This plane owns **who may call what and how much**. Inference routing, catalog breadth, and the
multimodal surface stay in **[prism](https://github.com/skyphusion-labs/prism)**.

**Status: foundation built, not deployed.** Built: the client contract, the Worker and its route table,
the D1 schema, client-key auth with one-time enrollment, entitlement and rate gates, the pre-flight
allowance gate, and the priced usage ledger. Not built: streaming (`stream: true` answers `501`),
overage billing, a receipt-validated enrollment source, and any deployment. Aviation-grade `main`
(PR + `ci` + `coverage` + CodeQL).

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
   scanner still catches a planted violation. AI Gateway logging defaults off.
2. **Money is integer micro-USD.** No floats in the money path. The unit belongs in the name of every
   field that carries it.
3. **Unmetered is a first-class outcome**, distinct from a zero charge. See `src/meter.ts`. Do not
   collapse them, and do not "simplify" an unmetered row into nothing.
4. **Fail closed.** No gateway means the inference route answers 503, not a direct model call. An unset
   `ADMIN_TOKEN` means there is no operator surface. A malformed plan refuses rather than getting a
   default. An unusable usage counter answers 503, never 402.
5. **No passthrough.** The catalog in `src/catalog.ts` is a closed allowlist and every entry carries a
   price. A model that cannot be priced cannot be called.

## Architecture

| File | Role |
| --- | --- |
| `src/index.ts` | Worker entry plus the whole route table. `handleRequest` takes its dependencies, which is what makes the tests hermetic. |
| `src/env.ts` | Hand-authored `Env`, mirroring `wrangler.example.toml`. Never commit a generated `worker-configuration.d.ts`. |
| `src/http.ts` | Error codes, the code-to-status table, JSON helpers, body cap. |
| `src/catalog.ts` | Model allowlist and price list, in one table on purpose. |
| `src/plans.ts` | Plan validation, tier entitlement, output-token clamping. |
| `src/quota.ts` | The pre-flight allowance decision. Pure. |
| `src/meter.ts` | Pricing one request, or declining to. Pure. |
| `src/period.ts` | UTC calendar-month period keys and bounds. Pure. |
| `src/auth.ts` | Client-key format, minting, and the one identity resolution path. |
| `src/store.ts` / `src/store-d1.ts` | Persistence interface and its only D1 implementation. |
| `src/inference.ts` | `InferenceRunner` interface and the AI-binding implementation. The only place a model is reached. |
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

## CI

- `.github/workflows/ci.yml` -- push/PR to `main`: typecheck + tests on GitHub-hosted `ubuntu-latest`
  (public, fork-safe; never fleet self-hosted)
- Coverage + CodeQL workflows present

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
