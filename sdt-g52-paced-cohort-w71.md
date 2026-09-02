# SDT-G52 paced-cohort W71 checkpoint

Status: **blocked checkpoint** — the single allowed explicit retained-trace resume query failed before returning a result set. No PR was opened.

## Deployed identity

- Branch start: `claude/sdt-g52-commit-breakdown-w68` at `9941ae7d77204c948b5d65befdc1e4a859113eaa`.
- Pinned Wrangler 4.125.0 `versions list` included `38921aad-9faf-4ac5-bdfd-1348d7214422`; the accompanying read-only deployment listing showed that version at 100%.
- Canonical deployed source: `6db728122fefc410e7d9639d62302bb107df13be`. Its `feat: retain commit snapshots for G52 breakdowns` commit includes `packages/dcb-runtime/src/trace/CommitTraceConsoleSink.ts`, the required snapshot sink.
- No deployment or configuration change was made.

## One paced cohort

The delivered `start-paced` mode ran exactly once against the existing Worker. It atomically wrote `.artifacts/sdt-g52-w69-paced-resume.json` before the warm-up, after the accepted warm-up, and after every accepted sample before the following request could start.

| Property | Evidence |
| --- | --- |
| Discarded warm-up | HTTP 200, CF-Ray `a34bd227bab8d829-LAX` |
| Accepted measured commits | 50 / 50, all HTTP 200 |
| Immutable exact-ray set | 51 / 51 (warm-up + samples) |
| Cohort interval | 2026-09-02T10:27:13.077Z–2026-09-02T10:36:33.731Z |
| Minimum completed-to-next-start interval | 10,001 ms (satisfies ≥10,000 ms) |
| Client latency | nearest-rank p50 1,308 ms; p95 2,113 ms |
| Caller colo distribution | LAX 50 |

No rejected request, retry, replacement request, deployment, or third cohort occurred.

## First retained-trace observation

The sampler's built-in read-only query after capture returned the following exact stderr:

```
g30-trace-export:api:Cloudflare telemetry query failed: HTTP 400
```

After a 21m07s bounded settling interval from the final paced commit, W71 ran `--mode resume` exactly once. That operation was restricted by code to the saved 51 CF-Ray values and sent no application request. It returned the same exact stderr and atomically recorded `attempt: 1`, `queryScope: exact-persisted-cf-rays`, and `errorClass: telemetry-query-failed` in the state.

**Roots retained / 51: unavailable / 51.** The HTTP 400 occurred before the provider returned a result set, so `0` is not inferred. Likewise, **first-seen lag for every exact CF-Ray is unavailable**: `firstSeenAtMsByRequestId` is empty and none of the following 51 persisted rays has an observed first-seen timestamp. The per-ray raw disposition is also recorded in `.artifacts/sdt-g52-w71-paced-first-resume.json`.

| Ray group | CF-Ray values | First-seen lag |
| --- | --- | --- |
| warm-up | `a34bd227bab8d829-LAX` | unavailable — telemetry HTTP 400 |
| samples 1–10 | `a34bd2314cc0d829-LAX`, `a34bd276ff0d1360-LAX`, `a34bd2c4d940b152-LAX`, `a34bd30d3d312f32-LAX`, `a34bd3556e7d83d9-LAX`, `a34bd39afeaec321-LAX`, `a34bd3e2cb157b5d-LAX`, `a34bd428cc0c88bd-LAX`, `a34bd471297a7db7-LAX`, `a34bd4b7fdf8b589-LAX` | unavailable for each — telemetry HTTP 400 |
| samples 11–20 | `a34bd4ff7fbd2360-LAX`, `a34bd5470ad908fa-LAX`, `a34bd58f6ef301d9-LAX`, `a34bd5d79c0e3dc4-LAX`, `a34bd61c999cb786-LAX`, `a34bd6633b61cb96-LAX`, `a34bd6a8fcf0453c-LAX`, `a34bd6ee0ae61418-LAX`, `a34bd7336a285bf3-LAX`, `a34bd77aee85e9df-LAX` | unavailable for each — telemetry HTTP 400 |
| samples 21–30 | `a34bd7bf6c4acc9f-LAX`, `a34bd8056eea142d-LAX`, `a34bd851afd8a0c6-LAX`, `a34bd8985b9dfda5-LAX`, `a34bd8e019552ef0-LAX`, `a34bd926afb52bab-LAX`, `a34bd9754aa7afef-LAX`, `a34bd9bc197ffb84-LAX`, `a34bda021f5c2ea8-LAX`, `a34bda488e985c0d-LAX` | unavailable for each — telemetry HTTP 400 |
| samples 31–40 | `a34bda9169c7e1ee-LAX`, `a34bdad79bd612ad-LAX`, `a34bdb1c7a996a9f-LAX`, `a34bdb65883013aa-LAX`, `a34bdbac4f7808e0-LAX`, `a34bdbf498c3cb9c-LAX`, `a34bdc3ad96303c4-LAX`, `a34bdc7ffc92dcf7-LAX`, `a34bdcc70dec4fd6-LAX`, `a34bdd0bebbed7a4-LAX` | unavailable for each — telemetry HTTP 400 |
| samples 41–50 | `a34bdd522a3ce538-LAX`, `a34bdd999da11e0f-LAX`, `a34bdde229dcff4b-LAX`, `a34bde297b73196e-LAX`, `a34bde7008399898-LAX`, `a34bdeb528b790fe-LAX`, `a34bdefb0d9df7e5-LAX`, `a34bdf418f181557-LAX`, `a34bdf883d832ad5-LAX`, `a34bdfcedde51ae2-LAX` | unavailable for each — telemetry HTTP 400 |

## Follow-up schedule and stop condition

The checkpoint state is capped at the authoritative W71 bound `2026-09-03T10:19:00Z`, not the sampler's default warm-up-relative later bound. It sets the next candidate resume to 2026-09-02T11:57:41.115Z. Design may schedule read-only `--mode resume` wakes at approximately +1h (11:57:41Z), +3h (13:57:41Z), and +6h (16:57:41Z), always using the same saved state and no new app requests. No resume may run after the stated 24-hour bound.

Because no successful retained-trace result has established the required ≥40 schema-complete roots, this checkpoint cannot produce AC4/AC5 evidence and must not open PR #103. It preserves the cohort for the designated later-resume decisions without stitching it to any other window.
