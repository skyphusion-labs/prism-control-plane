-- prism-control-plane 0005: unlock all chat tiers on the provisional dev plan.
--
-- The catalog has 45 priced chat models: 21 standard + 24 premium. Until this migration the seeded
-- `dev` plan only entitled `standard`, so a correct client on the only seeded plan could not call
-- half the catalog even though every chat model is spendable and /health/deep reports 45 priced.
--
-- `dev` remains provisional (not a product tier). Expanding its tiers is an ops enablement so
-- end-to-end testing and early clients can exercise the full chat surface without inventing
-- commercial plan numbers (those stay open decision 2 in docs/CONTRACT.md).
--
-- Product plans with real allowance/rpm numbers land via POST /admin/plans (or a later seed).

UPDATE plans SET allowed_tiers = 'standard,premium' WHERE id = 'dev';
