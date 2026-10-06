# Jev fast product screening

Sellfinity uses `typesafe-ai/jev` through Vercel AI Gateway's decision endpoint,
`POST https://ai-gateway.vercel.sh/v1/evaluate`. Jev is a text decision model,
not a replacement for image-aware product verification or profit calculations.

## Configuration

- Prefer the deployment-provided `VERCEL_OIDC_TOKEN` on Vercel, or set
  `AI_GATEWAY_API_KEY` in the project's environment settings.
- Service access and Gateway balance must be available on the Vercel account.
  Go to **Admin Settings → Test Jev connection** to verify access. Seeing
  authentication available does not by itself confirm successful access.
- Set `JEV_ENABLED=false` to disable screening without changing matching rules.
- No database migration or new package is required.

## Behavior and safety

Hard identity rules run first, without an AI request. Other pairs receive a
title-only screen (no buyer/order information). Only a REJECT route with conflict
probability at least 0.995 and same-product probability at most 0.005 skips the
existing visual verifier. These are conservative routing thresholds, not a claim
of calibrated accuracy or guaranteed correctness. Manually review false negatives.

All other results continue through existing verification. Jev cannot approve or
publish items, override manual decisions, change prices, or bypass availability,
shipping, fee, price-lock or automatic-review requirements. The existing manual
review and publication workflow is unchanged.

Identical title pairs are cached in memory for one hour (up to 250 pairs per
server process). Requests time out after 2.5 seconds. Invalid responses, provider
errors and missing authentication fall back to existing verification; failures
start a one-minute per-process cooldown. Connection tests bypass the cache and
cooldown. Screening consumes Gateway credits, not Rainforest credits.

Official API reference: https://vercel.com/docs/ai-gateway/modalities/decision

## Additional integrated workflows

- Automatic catalog review: one batched request prioritizes the existing bounded
  oldest-first queue. No candidates are dropped or added; a tie or service failure
  keeps original ordering. All availability and publication gates remain unchanged.
- Smart Sync: familiar errors use local rules first. Unfamiliar errors receive a
  sanitized text evaluation with a fixed category and fixed advice. Advice appears
  only in expanded item activity and is retained in activity-history error text.
  The model never triggers retries, reconnects, edits or delisting.
- AI-generated listing copy: a local shipping-claim check runs first; Jev then
  checks source facts against generated claims. Identity conflicts or unsupported
  claims at probability 0.99 or higher discard the generated improvement so callers
  preserve original copy. Seller-authored listings are not bulk rewritten. Missing
  service access preserves the previous improvement workflow.

Named decisions share a bounded one-hour in-memory cache and one-minute failure
cooldown with product screening. Requests time out after 2.5 seconds and are limited
to 25 questions and 40,000 serialized characters. Pricing and stock changes remain
deterministic, never controlled by model classification.

## Further evaluation

Evaluate against manually reviewed examples before widening routing thresholds.
Keep retry policies, pricing arithmetic, stock decisions
and external account mutations governed by deterministic rules and confirmations.
