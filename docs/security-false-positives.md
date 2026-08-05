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
