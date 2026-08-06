# Changelog

## [Unreleased]

## [0.4.26] - 2026-08-06

### Fixed

- **Music/video 3-minute cutoffs:** non-chat upstream default timeout raised **180s → 300s**,
  and the hard max for non-chat is now **360s** (chat remains max 180s). MiniMax full songs
  were hitting the plane Promise.race at exactly ~3 min → client "Generation timed out".

## [0.4.25] - 2026-08-06

### Fixed

- **Music audio rehost (Grok-video pattern):** after MiniMax returns a short-lived Aliyun HTTPS
  URL, the plane fetches the bytes into MEDIA R2 under `music/…` and returns a signed
  `GET /v1/media/{token}` on play-proxy (24h). iOS can open/play/save without fighting OSS
  URLs. Falls back to the provider URL if MEDIA/signing is missing or fetch fails.
- **Aura-2 TTS missing voice:** `buildTtsParams` now always sends `speaker` + `voice`
  (default `luna`) and `encoding: mp3`. Runtime was rejecting with "Must provide a voice
  parameter when using Aura-2 models" when only `{ text }` was forwarded.

## [0.4.24] - 2026-08-06

### Fixed

- **Music 7003 User Input Error:** `POST /v1/music/generations` now sends MiniMax Music 2.6
  required fields `is_instrumental` + `lyrics_optimizer` (+ `format: mp3`). Style-only prompts
  default to instrumental; with `lyrics` → vocal + optimizer off. Optional body overrides
  `is_instrumental` / `lyrics_optimizer`. Omitting the booleans made CF reject every mobile
  music call (iOS More → Music) while the door looked healthy.

## [0.4.23] - 2026-08-06

### Added

- **Vision multiparty chat content:** `messages[].content` may be a string or an OpenAI-style
  array of `{type:text|image_url}` parts. Images become Anthropic image blocks on the binding
  path and `image_url` parts on OpenAI-compatible upstreams. Caps: data-URL images ≤ 4 MiB;
  image parts only on user turns.

## [0.4.22] - 2026-08-06

### Fixed

- **Fable Empty stream on device (buffered path first-byte):** non-stream AI.run no longer
  blocks the HTTP Response. Plane returns SSE immediately (open chunk + keepalives), runs
  the binding call inside the stream, then emits text + usage + `[DONE]`. Holding the
  Worker until completion left mobile clients with no first byte for the whole think
  window → Empty stream completion while curl succeeded.

## [0.4.21] - 2026-08-06

### Fixed

- **Anthropic binding consecutive roles:** after clients drop failed assistant shells
  (prism-ios `(error)` / `(cancelled)`), the request can contain back-to-back `user`
  turns. Anthropic rejects that → 502 "model or gateway failed". Plane now merges
  same-role neighbors and drops a leading assistant when building Messages bodies.

## [0.4.20] - 2026-08-06

### Fixed

- **Fable stream (device Empty stream completion), take 2:** Anthropic `binding` +
  client `stream:true` no longer uses native Messages SSE. Non-stream `env.AI.run`
  (the path that already works) buffers the full answer, then the plane synthesizes
  OpenAI `chat.completion.chunk` frames + usage + `[DONE]`. True token streaming was
  losing iOS clients during Fable thinking despite keepalives; buffered synthetic SSE
  is reliable. Anthropic binding timeout raised to 180s for long thinks.

## [0.4.19] - 2026-08-06

### Fixed

- **Fable Empty stream completion (idle timeout):** Anthropic binding streams emit long
  stretches of `thinking_delta` before any `text_delta`. The plane dropped those frames
  with **zero wire bytes**, so URLSession's 60s idle timeout killed the connection and
  prism-ios reported Empty stream completion. Now: SSE comment keepalives on thinking /
  block lifecycle frames, plus a 15s timer keepalive while blocked on the binding reader.
  Clients ignore `:` comments; text deltas are unchanged.

## [0.4.18] - 2026-08-06

### Fixed

- **Anthropic binding stream close:** always emit finish + usage + `[DONE]` when the
  binding stream ends or aborts (edge/idle cut without `message_stop`), so clients
  do not hang after partial text deltas. Accept string chunks if the runtime yields them.

## [0.4.17] - 2026-08-06

### Fixed

- **Claude Fable 5 streaming (Empty stream completion):** Anthropic `binding: true` models
  return native Messages SSE (`content_block_delta` / `text_delta`). OpenAI-compatible clients
  (prism-ios, SDKs) only read `choices[].delta.content`, so stream-on looked empty. Plane now
  transforms Anthropic binding streams to OpenAI `chat.completion.chunk` frames + trailing usage
  + `[DONE]` before relay/meter (`src/anthropic-sse-to-openai.ts`). Non-Anthropic streams still
  pass through unmodified.
- **Anthropic non-stream extractText:** when the body has only `type:thinking` blocks (budget
  exhausted before text), fall back to thinking text instead of 502 "could not read as text".

## [0.4.16] - 2026-08-06

### Added

- **Google Play redeem** on `POST /v1/store/redeem` (`platform=google_play`,
  `purchase_token`, `product_id`). Verifies via Android Publisher when
  `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` is set; lab field path via `STORE_REDEEM_TRUST_DECODE`.


## [0.4.15] - 2026-08-06

### Added

- **App Store credit redeem:** `POST /v1/store/redeem` (device key). Accepts StoreKit 2
  `signed_transaction` JWS; maps `org.skyphusion.prism.credit.{5,20,50}` to prepaid micro-USD;
  idempotent on `appstore:<transactionId>`. Xcode StoreKit Configuration redeems without extra
  config; set `STORE_REDEEM_TRUST_DECODE=true` only for lab field-only tests.
- Unparks CONTRACT open decision #1 for **credit apply after purchase** (enrollment remains
  operator tokens; this is top-up, not enroll).

## [0.4.14] - 2026-08-05

### Fixed

- **Grok video (ZDR upload_url):** CF Unified Billing uses managed xAI credentials that are a
  **ZDR team**. xAI refuses video without `output.upload_url` ("Zero Data Retention teams must
  provide output.upload_url"). Plane now mints a short-lived HMAC ingress URL
  (`PUT /v1/media/ingress/{token}` → R2 `MEDIA`), passes it as `output.upload_url`, and returns a
  signed download URL (`GET /v1/media/{token}`) as `video`. Requires R2 binding `MEDIA` (bucket
  `prism-control-plane-media`). Other video models unchanged.

## [0.4.13] - 2026-08-05

### Added

- **Image reference input:** `POST /v1/images/generations` accepts optional `image` / `image_url`
  (https or data:) for i2i / edit. Provider field names mapped in `buildImageParams` (Google
  `image_input[]`, OpenAI `images[]`, xAI `image: { url }`, Flux 2 `input_image_0`).
  Many catalog image models are dual-mode (t2i + refs): Flux 2 multi-ref, nano-banana, gpt-image,
  Grok Imagine Image. Pure t2i (Flux-1 schnell, SDXL, Seedream, Recraft, Imagen, Leonardo) ignore refs.
- **`capabilities` on GET /v1/models:** `text-to-image`, `image-input` (optional ref / i2i),
  `text-to-video`, `image-input-required` (e.g. Hailuo). Client picker hints only.

## [0.4.12] - 2026-08-05

### Fixed

- **Image:** UB providers often return an **https URL**, not base64. That string was stuffed into
  `data[].b64_json`, so iOS clients failed to decode. URLs now go in `data[].url`; raw base64 stays
  in `b64_json`.
- **Video:** non-chat default upstream timeout **180s** (Seedance full/fast can exceed 120s).

## [0.4.11] - 2026-08-05

### Fixed

- **Video timeout:** non-chat doors no longer inherit `UPSTREAM_TIMEOUT_MS` (often 60s for chat).
  Only `NONCHAT_UPSTREAM_TIMEOUT_MS` or the **120s** default applies, so Seedance is not cut off
  after params succeed.

## [0.4.10] - 2026-08-05

### Fixed

- **Video:** Hailuo prompt-only returns clear `invalid_request` (i2v requires image). Non-chat doors
  use a **120s** default upstream timeout when `NONCHAT_UPSTREAM_TIMEOUT_MS` is unset (max 180s).

## [0.4.9] - 2026-08-05

### Fixed

- **Video t2v params (7003):** do not send Veo-only shape (`duration: "8s"`, `generate_audio`) to every model.
  CF schemas are `additionalProperties: false` and types differ: xAI Grok wants **integer** duration (1-15) and
  no `generate_audio`; Seedance/Hailuo/Runway/Alibaba get their own t2v fields. Veo keeps the string-duration
  shape. iOS clients posting only `{model,prompt}` were fine; the plane was rewriting the body wrong.

## [0.4.8] - 2026-08-05

### Fixed

- **Video t2v params:** match prism (`duration: "8s"`, `generate_audio`, full i2v shapes). Rebase xAI/Veo unit rates to 8s default.

## [0.4.7] - 2026-08-05

### Added

- **UB non-chat unit rates (unpark):** operator `unitPrice` for all catalog Unified Billing
  **image** (13), **video** (19), and **music** (1) models so `GET /v1/models` marks them
  `spendable: true` and `/v1/images|videos|music/generations` can meter. Per-request unit;
  video meters the door's default clip length (8s text-to-video). xAI image/video and several
  Google/OpenAI image rates track vendor docs; others are conservative operator estimates
  (refine via `POST /admin/model-prices` when gateway cost rows land). CONTRACT open decision 4
  updated.

### Removed

- **LLaVA 1.5** (`@cf/llava-hf/llava-1.5-7b-hf`): retired. Upstream hangs; vision covered by modern multimodal chat. Chat-door `image` field refused.

### Fixed

- **LLaVA:** use 120s upstream timeout (default 60s was cold-path 504).

### Fixed

- **Grok multi-agent:** xAI forbids chat completions (and binding chat body returns 400). Dispatch via
  **Responses API** on gateway `/grok/v1/responses` (`api: "responses"`, unprefixed model, no
  max_output_tokens, default `reasoning.effort: low`). See xAI multi-agent docs.

## [0.4.2] - 2026-08-05

### Fixed

- **Hard-fail chat models (smoke 2026-08-05):**
  - **Gemini 3.x:** `binding: true` (compat `google/*` = Invalid provider; several `google-ai-studio/*` fail keyless Authorization).
  - **gpt-5.5-pro:** `api: "responses"` → gateway `/openai/v1/responses` (chat completions 404 "not a chat model").
  - **Grok multi-agent:** first attempt used binding (still 400); fixed in follow-up.
  - **extractText:** reasoning_content / reasoning fallback, Responses `output_text`, Gemini candidates (fixes "unreadable" 502 for gpt-oss / qwen3 / glm reasoning bodies).
  - **llama-3.2-11b-vision:** on 403 model-agreement, REST `ai/run` with `{"prompt":"agree"}` then retry.

### Fixed (prior, shipped)

- **Grok + Fable chat on play-proxy.** Root causes measured against AI Gateway:
  - Public catalog ids `xai/grok-*` hit `/compat` as provider `xai` → **400 Invalid provider**. Compat expects **`grok/grok-*`**. Catalog `upstream` for Grok chat remapped; public `id` stays `xai/*` for clients.
  - **Grok 4.5** and **Claude Fable 5** still fail keyless `/compat` (no credentials / Invalid Anthropic API Key). Same as prism: dispatch via **`env.AI.run` binding** with `gateway: { id }` (catalog `binding: true`).
  - `outputTokenField` treats `grok/*` like OpenAI/xAI (`max_completion_tokens`).
  - `extractText` accepts Anthropic Messages `content[]` blocks from the binding path.
  - Runner re-allowlists `bindingModel` (`isAllowedBindingChatModel`); security FP notes for
    binding + `/compat` Authorization posture in `docs/security-false-positives.md`.

### Fixed (prior)

- **Dev plan `max_output_tokens` 1024 → 8192** (migration `0008`). 1024 was a provisional seed, not a normal chat ceiling; Opus/Sonnet on hard prompts burned the budget on invisible reasoning and returned empty content with `finish_reason=length`. Live D1 already applied; this lands the migration in git for deploy parity.

## [0.4.0] - 2026-08-05

Ship the commercial metering surface past the v0.3.0 voice/non-chat cut: rate refresh, reconcile cron, DO sqlite migration fix, and product decision parking.

### Added

- **`POST /admin/catalog/refresh`** -- pull chat token rates from AI Gateway `compat/models` into `model_prices` (dry-run default; does not rewrite `catalog.ts`).
- **Hourly reconcile cron** (`scheduled()`, `[triggers] crons = ["0 * * * *"]`) -- same `runReconcile` as admin POST; dry-run unless `RECONCILE_CRON_LIVE=true`.
- D1 migration path for STT tickets and unit prices already on main from the 0.3.x line; this tag ensures deploy carries wrangler DO + cron config.

### Fixed

- **SttSession Durable Object** registered as `new_sqlite_classes` (CF error 10099; KV-backed classes rejected).

### Docs / product

- Open decisions: enrollment, commercial plan numbers, and UB non-chat unit rates **deferred** until further development + hosted web client testing.
- Deployment identity **settled:** `play-proxy.skyphusion.org` (separate from play).

### Deploy notes

- Applies any pending D1 migrations on deploy.
- Cron is dry-run only until `RECONCILE_CRON_LIVE=true` is set on the Worker vars.
- After deploy: dry-run `POST /admin/catalog/refresh` and confirm `scheduled.reconcile_start` in logs.

## [0.3.0] - 2026-08-05

Unit-metered non-chat doors, Flux live STT, STT session tickets. See git history for PR #22.
### Fixed

- **Grok multi-agent:** xAI forbids chat completions (and binding chat body returns 400). Dispatch via
  **Responses API** on gateway `/grok/v1/responses` (`api: "responses"`, unprefixed model, no
  max_output_tokens, default `reasoning.effort: low`). See xAI multi-agent docs.

## [0.4.2] - 2026-08-05

### Fixed

- **Hard-fail chat models (smoke 2026-08-05):**
  - **Gemini 3.x:** `binding: true` (compat `google/*` = Invalid provider; several `google-ai-studio/*` fail keyless Authorization).
  - **gpt-5.5-pro:** `api: "responses"` → gateway `/openai/v1/responses` (chat completions 404 "not a chat model").
  - **Grok multi-agent:** first attempt used binding (still 400); fixed in follow-up.
  - **extractText:** reasoning_content / reasoning fallback, Responses `output_text`, Gemini candidates (fixes "unreadable" 502 for gpt-oss / qwen3 / glm reasoning bodies).
  - **llama-3.2-11b-vision:** on 403 model-agreement, REST `ai/run` with `{"prompt":"agree"}` then retry.

### Fixed (prior, shipped)

- **Grok + Fable chat on play-proxy.** Root causes measured against AI Gateway:
  - Public catalog ids `xai/grok-*` hit `/compat` as provider `xai` → **400 Invalid provider**. Compat expects **`grok/grok-*`**. Catalog `upstream` for Grok chat remapped; public `id` stays `xai/*` for clients.
  - **Grok 4.5** and **Claude Fable 5** still fail keyless `/compat` (no credentials / Invalid Anthropic API Key). Same as prism: dispatch via **`env.AI.run` binding** with `gateway: { id }` (catalog `binding: true`).
  - `outputTokenField` treats `grok/*` like OpenAI/xAI (`max_completion_tokens`).
  - `extractText` accepts Anthropic Messages `content[]` blocks from the binding path.
  - Runner re-allowlists `bindingModel` (`isAllowedBindingChatModel`); security FP notes for
    binding + `/compat` Authorization posture in `docs/security-false-positives.md`.

### Fixed (prior)

- **Dev plan `max_output_tokens` 1024 → 8192** (migration `0008`). 1024 was a provisional seed, not a normal chat ceiling; Opus/Sonnet on hard prompts burned the budget on invisible reasoning and returned empty content with `finish_reason=length`. Live D1 already applied; this lands the migration in git for deploy parity.

## [0.4.0] - 2026-08-05

Ship the commercial metering surface past the v0.3.0 voice/non-chat cut: rate refresh, reconcile cron, DO sqlite migration fix, and product decision parking.

### Added

- **`POST /admin/catalog/refresh`** -- pull chat token rates from AI Gateway `compat/models` into `model_prices` (dry-run default; does not rewrite `catalog.ts`).
- **Hourly reconcile cron** (`scheduled()`, `[triggers] crons = ["0 * * * *"]`) -- same `runReconcile` as admin POST; dry-run unless `RECONCILE_CRON_LIVE=true`.
- D1 migration path for STT tickets and unit prices already on main from the 0.3.x line; this tag ensures deploy carries wrangler DO + cron config.

### Fixed

- **SttSession Durable Object** registered as `new_sqlite_classes` (CF error 10099; KV-backed classes rejected).

### Docs / product

- Open decisions: enrollment, commercial plan numbers, and UB non-chat unit rates **deferred** until further development + hosted web client testing.
- Deployment identity **settled:** `play-proxy.skyphusion.org` (separate from play).

### Deploy notes

- Applies any pending D1 migrations on deploy.
- Cron is dry-run only until `RECONCILE_CRON_LIVE=true` is set on the Worker vars.
- After deploy: dry-run `POST /admin/catalog/refresh` and confirm `scheduled.reconcile_start` in logs.

## [0.3.0] - 2026-08-05

Unit-metered non-chat doors, Flux live STT, STT session tickets. See git history for PR #22.
