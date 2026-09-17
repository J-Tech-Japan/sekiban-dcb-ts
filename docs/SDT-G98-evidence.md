# SDT-G98 evidence

## AC1 — budget split

In `packages/dcb-runtime/src/tag/TagDurableObject.ts`:

- `G65_DERIVED_WRITE_BUDGET_MS = 300` — doorbell / global-admission before-response (unchanged)
- `G65_SOURCE_REGISTRATION_BUDGET_MS = 1_500` — first-append / recovery `registerSourcePartition` only
- `boundedDerivedWrite(operation, budgetMs = G65_DERIVED_WRITE_BUDGET_MS)` accepts an explicit budget
- `ensureSourcePartitionBeforeFirstAppend` and `retrySourcePartitionRegistration` pass `G65_SOURCE_REGISTRATION_BUDGET_MS`

## AC2 — measurement justification

Live cold create→reserve loop against
`https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev`
(pre-fix tip, shared 300 ms registration budget), 2026-09-17:

| n | reserveKind | reserveMs (e2e) |
|---|-------------|-----------------|
| 1–8 | committed ×8 | 2120–3299 (p50 2475, mean 2565) |

Historical flake (same environment, earlier same day): cold reserve returned
`partial_write` with `writtenTags=[room:…]`, `missingTags=[reservation:…]`
when registration competed for the **300 ms** shared derived-write budget
(documented in SDT-G97). Registration is on the commit path and can exceed
300 ms under cold D1; e2e reserve is ~2–3 s and includes more than
registration.

Chosen ceiling: **1500 ms** registration-only budget (≥5× the previous shared
cap, below typical e2e reserve latency, with margin for cold D1).

## AC3 — cold multi-tag loop

Pre-fix baseline: **8/8 committed**, 0 partials (same day; flake is
intermittent under the shared 300 ms budget).

Post-deploy tip (`Version ID: be056765-0718-4be3-86a6-5294e74a351a`) cold loop
2026-09-17:

| n | createKind | reserveKind | reserveMs |
|---|------------|-------------|-----------|
| 1–8 | committed ×8 | committed ×8 | 2452–3697 |

**Result: 8/8 without `partial_write`.**

## AC4 / AC5

- Guard: `scripts/g65-admission-guard.mjs` requires dedicated registration budget (self-test + post-change green).
- Hang tests updated to `G65_SOURCE_REGISTRATION_BUDGET_MS` bounds.
- Scope: no SafeWindow / G67 AC3 / runtime npm publish / async-after-append registration.
