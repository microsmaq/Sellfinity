# Decisions credit fallback

OpenAI Decisions remains primary. When it returns HTTP 429 with exhausted-credit
evidence (`credit_balance_exhausted`, legacy `insufficient_quota`, or the explicit
no-credits message), the shared decision adapter retries the same questions and
input via Vercel AI Gateway's OpenAI-compatible `/v1/decisions` endpoint using
`typesafe-ai/jev` for text and the explicit image-capable `typesafe-ai/jev-1.14.0`
for image requests. Image parts are retained, not converted to plain URL text.

Gateway authentication uses the existing `AI_GATEWAY_API_KEY`, falling back to
`VERCEL_OIDC_TOKEN`. These credentials are never sent to OpenAI. Set `JEV_ENABLED=false`
to disable the fallback. The global `OPENAI_DECISIONS_ENABLED=false` switch still
disables the entire adapter. Jev uses Vercel AI Gateway credits, not OpenAI or
Rainforest credits. Configured credentials do not establish provider access or balance.

Credit failures suppress new primary calls for five minutes in each warm worker.
Jev failures have a separate one-minute cooldown; checking another product during
that wait does not extend it. Automatic approval notes retain the sanitized provider
failure and remaining wait rather than hiding every error behind a generic message.
Cache entries are provider/model
specific. The admin connection test bypasses cooldown/cache to test current access
and reports the successful provider. A later successful primary request restores
normal primary routing. These cooldowns are process-local, not a global quota manager.

Rate limiting, malformed requests, authentication failures, refusals, ambiguous or
negative product decisions do not trigger fallback. No fallback result can bypass
the existing image-aware assessment, match policy, admin rejections, ban checks,
95% identity / 5% conflict thresholds, or database concurrency guard. Failed or
unusable Jev responses leave items unapproved. Approval notes identify Jev when used.

Reference: https://vercel.com/i/jev-integrations

Tests use mocked provider responses; no real credits are spent. After deployment,
use Admin Settings → Test Decisions connection to verify the actual configured route.
