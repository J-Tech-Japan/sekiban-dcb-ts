# SDT-G58 AC1/AC5 checkpoint (W94)

Status: completed checkpoint; not a PR-ready completion.

The preserved G58 branch now contains AC1 health-surface wiring, AC5
live-projection wiring, red-capable guards, and deployed proof. Source commit
`98b4534980e9886f7c7127ce99fae0bb0e01a7af` deployed as Cloudflare version
`07c3d85f-9bdf-4cf4-b342-6493ef32ef20`.

`GET /conformance/v1/read-health` was bearer-authenticated and returned the
two materialized-view rows, scheduled coverage, lag diagnostics, two live
projector rows, and the global SUID. Both projector heads equalled the global
head `063924008135922000000562824059`. Read-only per-tag projection-lag and
tag-state proof passed with `behindEvents=0` and the correct tag-local heads.

The remote migration ledger was empty despite verified G32/G44 schema; only
the matching ledger entries were restored, then the additive G58 migration
applied normally. No application data reset occurred.

Raw evidence:

- `.artifacts/sdt-g58-w94-ac1-ac5-readproof-repaired.json` — passing receipt.
- `.artifacts/sdt-g58-w94-ac1-ac5-readproof.json` and
  `.artifacts/sdt-g58-w94-ac1-ac5-readproof-final.json` — preserved bounded
  failures from the repaired own-tag-vs-global-head harness defect.

No app commands, cohort requests, `poll=1` requests, G15/G16 runs, AC2 timing
claims, or new AC3 continuation work occurred under W94. The next wake must
start the authorized fresh paced cohort; its safe target is <=180 seconds.
