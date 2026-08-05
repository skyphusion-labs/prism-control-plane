-- prism-control-plane 0006: operator unit rates for non-chat doors.
--
-- Chat meters tokens (input_micro_usd_per_mtok / output_micro_usd_per_mtok).
-- Image / TTS / STT / video / music meter discrete units (request, audio minute,
-- k-characters). `unit_micro_usd` is the integer micro-USD charge per unit; the
-- unit kind lives in the catalog entry (not duplicated here).
--
-- NULL means "this row is a token override only". Non-chat doors ignore token
-- columns and read unit_micro_usd (or fall back to the catalog unitPrice).

ALTER TABLE model_prices ADD COLUMN unit_micro_usd INTEGER;
