# CLAUDE.md -- prism-control-plane

Guidance for agents working in this repository.

## What this is

Control plane for **commercial Prism**: multi-tenant accounts, subscription plans, usage quotas,
overage metering, and host-billed access to a curated model set. Cost-recovery economics (cover
CF / inference expense, not extractive margins). Full stack stays AGPL; self-hosters can run the
same machinery on their own Cloudflare account.

**Status: skeleton only.** Honest status matches `README.md`. Aviation-grade `main` (PR + `ci` +
`coverage` + CodeQL). Build next: entitlement schema, host-billed mode, Stripe webhooks.

Inference routing, catalog, and modalities stay in **[prism](https://github.com/skyphusion-labs/prism)**.
Mobile clients talk to the inference API; this plane owns **who may call what and how much**.

## Related

| Repo | Role |
| --- | --- |
| [prism](https://github.com/skyphusion-labs/prism) | Playground + inference Worker (`play.skyphusion.org`) |
| [prism-ios](https://github.com/skyphusion-labs/prism-ios) | iOS kit (skeleton) |
| [prism-android](https://github.com/skyphusion-labs/prism-android) | Android kit (skeleton) |
| [vivijure-control-plane](https://github.com/skyphusion-labs/vivijure-control-plane) | Pattern peer (vivijure multi-tenant plane) |

## Target surface (not built yet)

- Tenant / account provisioning
- Plan entitlements (which models, included units, rate limits)
- Usage ledger and overage hooks (e.g. Stripe metered billing)
- Gates used by the Prism inference Worker before expensive `run*` paths
- Admin / operator APIs for the hosted service

## Commands

```bash
npm ci
npm run typecheck   # tsc --noEmit -- CI gate
npm test            # vitest run
npm run test:coverage
```

Version is root `package.json` (currently skeleton `0.0.1`; trust the pin).

## CI

- `.github/workflows/ci.yml` -- push/PR to `main`: typecheck + tests on GitHub-hosted `ubuntu-latest`
  (public, fork-safe; never fleet self-hosted)
- Coverage + CodeQL workflows present

## Conventions

- No em-dashes (U+2014) or en-dashes (U+2013) in source or docs; use commas, semicolons, or `--`.
- Handle / username default: `skyphusion`.
- Conventional Commits. License: AGPL-3.0-only.
- `npm run typecheck` before push (not part of vitest).
- Do not invent live deploy or wrangler bindings that are not in the tree yet; keep skeleton status
  honest.

## Crew + identity

Crew work as their own identity (`sudo -u <member> bash -lc '...'`). Conrad laptop commits:
`Conrad Rockenhaus <conrad@skyphusion.org>`.
