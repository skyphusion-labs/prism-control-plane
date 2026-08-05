-- prism-control-plane 0004: monthly included allowance (issue #11).
--
-- THE COMMERCIAL MODEL is a flat plan with included spend per UTC calendar month; once that
-- allowance is used, further usage burns prepaid credit. No postpaid, no overage invoice, ever.
--
-- Until this migration, only the prepaid half existed: signup credit + top-ups + spent. Period keys
-- counted usage for display and granted nothing. This migration adds a second pool that:
--
--   1. Is plan-level (monthly_included_micro_usd), integer micro-USD.
--   2. Is spent BEFORE prepaid credit (src/balance.ts allocateCharge).
--   3. Resets by period_key, not by rewriting the credit balance. Unused allowance EXPIRES; it does
--      not roll into credit. That is the failure plans.ts named: a monthly reset must not become a
--      cash grant.
--
-- ZERO IS A REAL DECISION. A plan with monthly_included_micro_usd = 0 is pure prepaid (previous
-- behaviour). No default invents an allowance at runtime.
--
-- Ledger rows record the split (from_allowance / from_credit) so the two pools stay auditable.
-- accounts.spent_micro_usd continues to mean LIFETIME prepaid spend only; allowance burn lives on
-- the period row. The money gate reads both.
--
-- Privacy invariant from 0001 is unchanged: nothing here can hold prompt or completion text.

ALTER TABLE plans ADD COLUMN monthly_included_micro_usd INTEGER NOT NULL DEFAULT 0;

ALTER TABLE usage_periods ADD COLUMN allowance_spent_micro_usd INTEGER NOT NULL DEFAULT 0;

ALTER TABLE usage_events ADD COLUMN from_allowance_micro_usd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN from_credit_micro_usd INTEGER NOT NULL DEFAULT 0;

-- Dev plan stays pure prepaid until product numbers land. Zero is explicit, not "unset".
UPDATE plans SET monthly_included_micro_usd = 0 WHERE id = 'dev';
