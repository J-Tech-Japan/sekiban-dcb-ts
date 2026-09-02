# SDT-G51-AC5-PROBE-LADDER-W64 — COMPLETED

## Outcome

The amended AC5 stop condition was satisfied in its first permitted deploy
window. P1, a direct one-attribute custom span in the public sample Worker
fetch handler, was retained for 0 of 10 exact accepted app requests after a
bounded 600,000 ms / 40-attempt poll. Per the amendment, P2–P4 were not
deployed and the second permitted window was intentionally unused.

This lands the accepted AC1–AC4 work as a ready-for-review issue #101 PR while
narrowing R-1 to the current public-Worker custom-span retention limitation;
it does not claim a fabricated live S00/S-row proof.

## Ready-for-review PR

https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/102

## P1 deployment and evidence

| Field | Value |
| --- | --- |
| Cloudflare version | 0e801aeb-086e-4c18-bc79-b61bf5e9e304 |
| Source commit | 9f3348a7d4ca693a54bb119c8d230f1015a663fc |
| Normal config | samples/meeting-room/wrangler.cloudflare-only.jsonc |
| Probe | sdt.g51.probe.p1 / one sdt.g51.probe=p1 attribute |
| App surface | POST /api/commands/create-room |
| Cohort | one accepted discarded warm-up, then exactly 10 sequential accepted commits |
| Caller colo | PDX: 10 |
| Client p50 / p95 | 1,590 / 1,960 ms |
| Query window | 2026-09-02T03:27:41.239Z–2026-09-02T03:39:58.234Z |
| Bounded poll | 40 attempts, 600,000 ms, 0/10 matching exact rays |
| Retained P1 spans | 0 (including 0 rayless/unjoinable spans) |

The compact artifact is .artifacts/sdt-g51-w64-p1-probe.json; it omits raw
request identities, trace IDs, request bodies, provider events, and all token
material. Retained trace access used only the path
G50_OBSERVABILITY_TOKEN_FILE=/Users/tomohisa/.config/sekiban-dcb/observability-token.

## Preserved accepted work

- AC1: deterministic check identifies G41 3707688 removing the Journal
  admission path that reached enterNativeActorHandleSpan for S16.
- AC2: native sdt.row.id projection remains on real S00/S-row spans without
  changing commit semantics.
- AC3: the fake-tracer guard is red on pre-fix and root-omission mutant paths,
  green after the fix, and remains wired into ci-g30-core.
- AC4: the retained exporter uses bounded exact-ray polling; the P1 shortfall
  is recorded honestly rather than converted into a success tally.

## Checks and process

npm run test:g51, npm run typecheck, and
node scripts/deploy/g51-probe-ladder-guards.mjs passed on the P1 source
commit. The repository-pinned Wrangler completed token-free OAuth whoami and
the normal-config deploy without an API-token fallback, --keep-vars, or
config/secret change. The issue was claimed with the GitHub-only worker
workflow before code changes.

## Narrowed R-1 follow-up

Investigate the current public-Worker custom-span retention limitation with a
Durable-Object-side probe and client-timing evidence. Use a new standalone
deployment/cohort; do not stitch W63 or W64 requests.
