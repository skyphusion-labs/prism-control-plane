-- prism-control-plane 0008: raise provisional dev plan max_output_tokens.
--
-- Seeded at 1024 in 0001 as a tight local-dev bound. That is not a normal chat
-- ceiling: extended-thinking models (Opus 5, Sonnet 5 on hard prompts) burn the
-- entire budget on invisible reasoning and return empty content with
-- finish_reason=length. Measured 2026-08-05 against play-proxy with the Cauchy
-- prompt: completion_tokens=1024, content="".
--
-- 8192 is a normal single-turn chat ceiling (CONTRACT examples use 4096 for small
-- models; reasoning-class needs headroom). Commercial product tiers still land
-- via POST /admin/plans (open decision 2); this only unblocks the provisional
-- `dev` plan used for play smoke and early clients.

UPDATE plans SET max_output_tokens = 8192 WHERE id = 'dev';
