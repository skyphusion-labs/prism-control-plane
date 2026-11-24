# prism-control-plane

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

This is the metering and policy plane for commercial Prism.
It holds accounts, plan entitlements, a usage ledger, and a metered proxy.
The proxy calls Cloudflare AI Gateway and Workers AI.
The price covers Cloudflare and inference cost.
It is not an extractive margin.
The license is AGPL-3.0-only.
A self-hoster can run the same code on their own Cloudflare account.

This plane decides who may call what, and how much.
Inference routing and the multimodal surface stay in [prism](https://github.com/skyphusion-labs/prism).

The public instance is `play-proxy.skyphusion.org`.
The version is root `package.json` and `src/version.ts`.
Do not copy a version into this file.
See the latest `v*` tag.

There is no overage billing.
The plane is prepaid only.
It answers `402` when the balance is gone.

Clients are [prism-ios](https://github.com/skyphusion-labs/prism-ios) and [prism-android](https://github.com/skyphusion-labs/prism-android).
Read those repos for their versions.

## The contract

[docs/CONTRACT.md](docs/CONTRACT.md) is the normative client surface.
[docs/openapi.yaml](docs/openapi.yaml) is the same contract in machine form.
Update both in the same commit as a route, error code, status, or published header.
`tests/contract.test.ts` fails when the router drifts from the docs.
Do not silence that test.
Fix the drift.
Inside `/v1`, changes must be additive.
A breaking change gets `/v2`.

## Non-negotiables

No prompt text and no completion text is stored.
Do not add such a column to `migrations/`.
`tests/schema-privacy.test.ts` enforces that.
The scanner has a positive control.
`cf-aig-collect-log-payload: false` is hard-wired in `src/upstream.ts`.
There is no env switch.
Metadata logs (tokens, model, cost, duration) stay on.
That is how a cost figure can be checked against the ledger.

Money is integer micro-USD.
Do not use a float on the money path.
Put the unit in the field name.

Unmetered is a real outcome.
It is not a zero charge.
See `src/meter.ts`.
Do not collapse the two.

Fail closed.
No gateway means the inference route answers 503.
It does not call a model directly.
An unset `ADMIN_TOKEN` means there is no operator surface.
A malformed plan is refused.
An unusable usage counter answers 503, never 402.

The catalog in `src/catalog.ts` is a closed allowlist.
A model with no price cannot be called (`model_unpriced`).
Unpriced is normal for many third-party models.
Cloudflare publishes no public per-token rate for them.
The refusal is per model, at the door.
Rates are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Spend path

`src/upstream.ts` calls the AI Gateway host.
It does not call the AI REST API on `api.cloudflare.com`.
The gateway host returns `cf-aig-log-id`.
The REST host does not.
Reconciliation joins on `cf-aig-metadata.request_id`.
That choice is not a security fix.
Do not re-file it as one.
`tests/upstream.test.ts` pins the host and the keyless credential posture.
The full reason is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

The default credential is one shared `CF_AIG_TOKEN`.
Per-account attribution is `cf-aig-metadata` plus the D1 ledger.
`UPSTREAM_CREDENTIAL_MODE=per-user` is retired.
If it is set, the inference door stays closed.

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Worker entry and route table |
| `src/env.ts` | Hand-authored `Env`. Do not commit generated types. |
| `src/catalog.ts` | Allowlist and rate table |
| `src/upstream.ts` | The only model call, and the privacy headers |
| `src/aig-logs.ts` | Gateway log reads. It refuses stored-payload endpoints. |
| `src/reconcile.ts` | What one gateway row means for one ledger row |
| `src/routes/chat.ts` | Metered door. The file documents gate order. |
| `src/stt-session.ts` | Live-voice Durable Object |

Pure modules run in Node Vitest.
Keep new decision code behind an interface so it can do the same.
The STT Durable Object cannot.
Its harness is `vitest.workers.config.ts`.
The stub `env.AI.run` never calls a live model.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the wiring picture.
Read it before you change the spend path.
[README.md](README.md) is the local walkthrough.

## How to work

```bash
npm ci
npm run typecheck
npm test
npm run test:node
npm run test:workers
npm run bootstrap
npm run db:migrate:local
npm run dev
```

`npm run typecheck` covers `src` and tests.
It is the CI gate.
[.github/workflows/ci.yml](.github/workflows/ci.yml) runs typecheck and tests.
Only the last inference call in the README walkthrough spends money.

`npm run bootstrap` copies `wrangler.example.toml` to `wrangler.toml`.
The example is a template.
Fill in your own database id.
`wrangler.toml` is gitignored.

## Deploy

Production ships from a `v*` tag that is already on `main`.
See [.github/workflows/deploy.yml](.github/workflows/deploy.yml).
A merge to `main` runs CI only.
`workflow_dispatch` runs the gate and stops.
It is not a deploy path.

Set Worker secrets with `npx wrangler secret put`.
Never put a bearer token in the Wrangler config.
CI writes that config to disk.
A secret in the file would be on the runner in the clear.
Worker secrets persist across deploys.
Vars change only on a full deploy.

`GET /health/deep` is the readiness probe.
It spends nothing.
It reads D1 and reports whether the gateway credential is wired.
It does not call a model.
It answers 503 when it cannot serve.
`GET /v1/models` also spends nothing.
A chat completion costs prepaid balance.
Do not send one only to confirm a deploy.

Do not change the live Worker from the Cloudflare dashboard.
Change the config in git and deploy from a tag.
A settings patch can desync the settings API from the running deployment.

Code scanning uses GitHub default setup.
There is no `codeql.yml` in this repo.
`ls .github/workflows/` does not show that setup.

## Versions

A version changes only in a release pull request.
Feature and fix pull requests do not bump it.
Put the tag on that pull request's merge commit.
The version of record is `package.json` and `src/version.ts`.
The tag shape is `v*`.
If that version already has a tag, the cycle is closed.
The next release pull request bumps.
If the manifest version has no tag, stop.
Find why before you bump again.

Post-1.0 SemVer uses MINOR for features and PATCH for fixes.

## Docs

Write Simplified Technical English.
Use short sentences.
Use one idea per sentence.
Use the active present tense.
Use plain words.
Use the same word every time.

Do not use an em dash (U+2014) or an en dash (U+2013).
Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability.
Do not turn a measured result into a promise.
Do not describe a binding or a plan tier that is not in the tree.
Comments should say what decision breaks if you remove them.

Use Conventional Commits.
The body says why.
Open a pull request and wait for review.

## Safety

Do not put a secret in a tracked file.
Do not put a secret in a log.
Do not put a secret in an issue.
Do not weaken a fail-closed path into a fallback.
Do not add a prompt or completion column.
Do not silence `tests/schema-privacy.test.ts` or `tests/contract.test.ts`.
