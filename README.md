# prism-control-plane

**License:** AGPL-3.0-only  
**Sibling:** [prism](https://github.com/skyphusion-labs/prism) (playground + inference Worker)  
**Clients:** [prism-ios](https://github.com/skyphusion-labs/prism-ios), [prism-android](https://github.com/skyphusion-labs/prism-android)

## What this is

Control plane for **commercial Prism**: multi-tenant accounts, subscription
plans, usage quotas, overage metering, and host-billed access to a curated
model set. Cost-recovery product economics (cover CF/inference expense, not
extractive margins). Full stack stays AGPL; self-hosters can run the same
machinery on their own Cloudflare account.

## What lives here (target)

- Tenant / account provisioning
- Plan entitlements (which models, included units, rate limits)
- Usage ledger and overage hooks (e.g. Stripe metered billing)
- Gates used by the Prism inference Worker before expensive `run*` paths
- Admin / operator APIs for the hosted service

Inference routing, catalog, and modalities stay in **prism**. Mobile clients
talk to the inference API; this plane owns **who may call what and how much**.

## Status

Skeleton. Aviation-grade `main` (PR + `ci` + `coverage` + CodeQL). Build next:
entitlement schema, host-billed mode, Stripe webhooks.

## Related

- Live playground: https://play.skyphusion.org  
- Pattern peer: [vivijure-control-plane](https://github.com/skyphusion-labs/vivijure-control-plane)
