# SDT-G55 issue #106 capacity-resume — W81

Status: **blocked**

The resumed implementation preserved the existing red-capable fixture and
completed the scoped local implementation on
`claude/sdt-g55-read-visibility-w81` at
`be2f0ee1688e92208876f3d713f3d4563b2f00f4`.

OAuth-only pinned Wrangler verification and normal-config deployment succeeded
at version `a49d2a7e-0dd4-470d-b9ee-7854170075d9`. The one permitted deployed
cohort created one room and exactly three reservations; all three became
unsafe-list-visible in 3964 ms, 2355 ms, and 2207 ms respectively.

The cohort cannot satisfy AC5: its app-list responses all had `readHead: null`
and the safe head did not advance during the bounded observation. Read-only
inspection found the worktree inherited a parent-checkout workspace
`node_modules` symlink, so Wrangler bundled a stale runtime distribution even
though it annotated the version with the candidate SHA. The deployed sample
source retained three unsafe rows (remote D1 changed from 132 receipts / 0
rows to 136 receipts / 3 rows), but the stale runtime could not execute the
new `readListPage` contract.

No redeploy, replacement cohort, evidence stitch, PR, or worker-complete call
was performed after that bounded e2e failure. The full code/D1/e2e evidence
and required remediation boundary are in
[`docs/SDT-G55-evidence.md`](docs/SDT-G55-evidence.md).
