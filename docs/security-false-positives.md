# Security false positives (accepted)

Adversarial audit (K2.7 PR / K3 repo) findings that are **accepted** rather than code-changed.
Each entry names the finding, why it is not a defect, and when to reopen it.

## Concurrent prepaid overshoot (chat + non-chat)

- **Audit titles:** "Insufficient balance check allows one-after-exhaust spend" (non-chat);
  same pattern exists on `POST /v1/chat/completions`.
- **Why accepted:** Documented product bound in `docs/CONTRACT.md` and `src/balance.ts`: cost is
  unknown until the model answers, so the gate checks **already-recorded** balance. An account can
  overshoot by **at most one concurrent request** (bounded by plan `max_output_tokens` / unit
  rate). There is no postpaid invoice for the overshoot; further spend is refused until top-up or
  period roll. Pessimistic reservation would require holding a provisional charge and refunding on
  failure, which is a larger product change.
- **Reopen when:** Commercial policy requires hard multi-request reservation, or abuse shows
  systematic multi-flight overshoot beyond one request.

## Gateway metadata is not a cryptographic fence

- **Audit title:** "Non-chat gateway metadata lacks spend attribution fence"
- **Why accepted:** `cf-aig-metadata` is Cloudflare log labels for reconcile join on `request_id`.
  Authority for money is the **D1 ledger** written after the call; metadata cannot authorize spend.
  Shared `CF_AIG_TOKEN` blast radius is accepted under the 500-token account ceiling product rule.
- **Reopen when:** Per-user upstream credentials return (they will not under current CF limits).

## STT wall-clock vs upstream duration

- **Audit title:** "STT session durations billed without source validation"
- **Mitigation shipped:** 15-minute hard session cap (`FLUX_MAX_SESSION_MS`); unit rate from catalog
  at finalize (not client headers). Upstream Flux does not expose a reliable billable-minute
  counter on the websocket path we use.
- **Residual:** Client can hold the socket idle until the cap; that is charged as wall-clock audio
  minutes (same as many live-STT meters). Cap bounds the loss.
- **Reopen when:** Deepgram/CF expose verified session duration we can read without storing audio.

## Audit redaction misread as "secret leak / invalid TypeScript" (critical FP)

- **Audit title:** "Pseudocode/hidden secret expression leaked into source" citing
  `[REDACTED]` placeholders in the model payload.
- **Why FP:** The security-audit harness redacts secret access patterns before the model sees them.
  Real source is `env.CF_AIG_TOKEN` and typechecks. Related empty-secret concern is fail-closed via
  `requireHandoffSecret` (never HMAC with `""`).
- **Reopen when:** Redaction leaves a valid AST, or a real empty-string sign path reappears.

## Empty-string HMAC (high FP after requireHandoffSecret)

- Worker and DO both call `requireHandoffSecret()` and **503 before** any `sign`/`verify` if missing
  or shorter than 16 chars. The audit's "sign with empty" path does not exist in source.

## Global ADMIN_TOKEN for model prices (high FP)

- Single operator bearer for all `/admin/*` is product design (admin.ts). Non-chat unit pricing
  expands blast radius of a leaked token but does not change the trust model. Rotate on suspicion.

## User prompt as provider payload (high FP)

- This plane is a **user AI proxy**; the user's prompt is the product input. We forward only
  **whitelisted primitives** from `build*Params` with length caps, not raw client JSON spreads.

## Chat AI binding for Fable / Grok 4.5 (high FP)

- **Audit title:** "Binding path bypasses cf-aig-authorization and gateway URL pinning"
- **Why accepted (with hardening):** Same class as non-chat Unified Billing via `env.AI.run`. CF's
  legacy `/compat` allowlist does **not** inject UB credentials for `anthropic/claude-fable-5` or
  `xai/grok-4.5` (measured 401 / "No credentials presented"). The binding path is the only
  working door. Mitigations already in code:
  - `bindingModel` is set only from catalog `id` when `entry.binding === true` (chat route).
  - `isAllowedBindingChatModel` re-checks the catalog in the runner (refuse arbitrary ids).
  - `gateway: { id: AI_GATEWAY_ID }` still attributes logs for reconcile.
  - Money authority is the **D1 ledger** after the call, not the gateway header shape.
- **Reopen when:** CF documents a working keyless `/compat` path for these ids, or the binding
  path can take an explicit `cf-aig-authorization` equivalent.

## /compat never sets plain Authorization (high FP)

- **Audit title:** "Credentials in cf-aig-authorization may be forwarded as BYOK Authorization"
- **Why FP:** `upstreamHeaders` sets **only** `cf-aig-authorization: Bearer <CF_AIG_TOKEN>` and
  deliberately omits `authorization` / `x-api-key`. On `/compat`, a plain `Authorization` value
  would be the **provider** key slot; we never put the Cloudflare token there. Client `pcp_` keys
  never leave the Worker on the upstream hop.
- **Reopen when:** a code path copies client or CF tokens into `authorization` on the gateway host.

## Sec-WebSocket-Protocol residual (fixed, not FP)

- **Was:** long-lived `pcp_…` client keys accepted in `Sec-WebSocket-Protocol` for browser WS
  (browsers cannot set Authorization on upgrade).
- **Fix:** `POST /v1/stt/sessions` mints a single-use `stt_…` ticket (60s, hashed in D1);
  protocol list accepts only `prism.v1, stt_…`. Native clients still use `Authorization: Bearer pcp_…`.
- **Reopen when:** a browser can set custom upgrade headers, or we move auth fully off the protocol
  list (e.g. first-message ticket after connect).
