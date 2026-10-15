# OpenAI Decisions (replaces Jev)
All former Jev advisory workflows now call POST https://api.openai.com/v1/decisions.
The compatibility filenames and function names remain to avoid breaking imports; no Jev Gateway requests are made.

## Configuration
- OPENAI_API_KEY: an OpenAI project key with access and billing for the Decisions beta.
- OPENAI_DECISIONS_ENABLED=false disables these advisory calls.
- OPENAI_DECISIONS_MODEL defaults to gpt-6-luna.
- AI_GATEWAY_API_KEY and VERCEL_OIDC_TOKEN are never sent to OpenAI and do not authenticate this API.
- Admin Settings → Test Decisions connection verifies the configured provider. Missing authentication, refusals, malformed results, timeout or access failures preserve existing rules/visual-AI fallback.

## Safeguards
Input and questions are bounded, cached for one hour, and results are strictly validated.
Questions use predicate probabilities or supplied choice values; refusals never mean approval.
Five-second text advisory timeouts (twelve seconds for image verification or diagnostics) and a one-minute failure cooldown bound unnecessary calls.
No customer/account data is supplied. Error-classification input is sanitized.
Title decisions only reject strong explicit conflicts; all plausible or uncertain pairs continue through existing image-aware verification.
Saved high-confidence admin candidates are checked by visual AI (MATCH ≥95%) and an independent Decisions review using both product images (same-product score ≥95%, explicit-conflict score ≤5%). Missing title words alone are not contradictions; actual identity conflicts and uncertain decisive facts still require review. Missing/refused/malformed Decisions responses never approve a candidate. Hold messages distinguish unavailable verification from low match/high conflict scores, and saved approval confidence is capped by both verifiers rather than retaining a prior 100% score.
Queue prioritization never adds, drops or publishes rows. Error guidance cannot perform mutations.
Generated-copy checks cannot change price locks, fees, source availability or shipping policy.

## Bulk equivalent research
Product Intelligence → Research all pending or Research selected.
One product at a time; progress, stop-after-current-product, and collapsed activity details.
Uses eBay Browse application authentication, not a seller login, and stored Amazon catalog data.
No Rainforest or Countdown calls for this workflow.
Requires a saved Amazon title. Admin matching is identity-only; stock, shipping, price freshness and profitability remain informational, not approval gates. Seller-side listing safeguards remain unchanged.
Searches up to 50 fixed-price candidates, verifies up to three plausible pairs and saves comparison/market fields.
Candidates are always held for administrator review; this button never publishes to users.
All-pending targets the full catalog, not the visible table page, and skips successful records on the next run.
Selected research can retry Needs review records; published/archived records are skipped.
eBay connection/rate-limit/provider errors pause a run to avoid repeated failed API calls.
Keep the page open while the bulk run is active; completed results are saved independently.
The existing opt-in daily safe-approval queue also uses eBay Browse and Decisions, with its existing stricter publication rules.

Official API reference: https://developers.openai.com/api/reference/resources/decisions/methods/create
