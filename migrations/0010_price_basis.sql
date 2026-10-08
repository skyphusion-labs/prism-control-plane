-- prism-control-plane 0010: how a ledger row's price was arrived at (issue #99).
--
-- WHY A STORED COLUMN AND NOT AN INFERENCE. Until now a reader could answer "did we price this?" from
-- `metered` alone, because there were only two ways a row could exist: the upstream reported token
-- counts, or it did not. Issue #99 adds a third way. A stream the client cancels before the trailing
-- usage frame arrives is now priced from an ESTIMATE of what was received, so `metered = 1` no longer
-- implies "we measured this". A reader must be able to tell a measured charge from an estimated one
-- with a single column read, and not by joining two other columns and remembering a rule.
--
-- THREE VALUES, AND EACH ONE IS A DIFFERENT FACT ABOUT OUR KNOWLEDGE:
--
--   measured          the upstream reported usable token counts, or the units were observed. The
--                     charge is defensible with a measurement.
--   estimated_output  the INPUT came from the request text, which we hold in full, and the OUTPUT was
--                     estimated from the bytes we actually received before the stream was cut. Only
--                     the output side is a guess. Rounded DOWN, so this charge can be low but never
--                     invented high. Reconcile trues it up against the biller's own cost.
--   unpriced          we could not price the request at all. Pairs with `metered = 0` and a reason.
--
-- THE DEFAULT IS THE CONSERVATIVE ONE ON PURPOSE. SQLite needs a default to add a NOT NULL column to a
-- non-empty table, and a writer that forgets this field must never land a row that CLAIMS a
-- measurement it does not have. So the default is `unpriced` and the backfill below promotes the rows
-- that really were measured.
--
-- Privacy invariant from 0001 is unchanged: this column holds one of three fixed words. It cannot
-- carry prompt or completion text.

ALTER TABLE usage_events ADD COLUMN price_basis TEXT NOT NULL DEFAULT 'unpriced';

-- Backfill. Every row written before this migration was priced the old way, so `metered` is an exact
-- description of its basis: there was no estimate path to confuse it with.
UPDATE usage_events SET price_basis = 'measured' WHERE metered = 1;
