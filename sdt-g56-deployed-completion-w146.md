# SDT-G56 deployed completion — W146

Task ID: `SDT-G56-DEPLOYED-COMPLETION-W146`
Issue: [J-Tech-Japan/sekiban-dcb-ts#109](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/109)
Branch: `claude/sdt-g56-local-ac1-ac5-w133`
Rebased base: `a808bfa5d8eae481271b6d675109e9e5ac3fb758`
Current evidence commit before PR: `3936a18c0f0183ba292f52fdd30623ef4d83935b`

## Result

Deployed AC6 evidence is complete on the existing normal-config Worker. The
exact-source deployed code version was `46176718-ef7b-4d90-b349-03ad26a9ea2e`
at 100% traffic, with deployment
`ae7861e0-616a-4875-92ed-f27e385139d5` and annotation
`SDT-G56 W146 exact 3936a18 rebased AC1-AC5 after conformance secret`.

The assert-empty sequence passed once:

1. fresh `RoomCreated` commit with `lastSortableUniqueId: ""` → HTTP 200,
   tag version 1, returned SUID `063924107374785000001662020209`;
2. same tag with `lastSortableUniqueId: ""` → HTTP 400,
   `code: consistency_conflict`;
3. same tag with the exact first returned SUID → HTTP 200, new SUID
   `063924107376858000002092497585`.

The final tag version was 3 because the existing non-empty exact-head
reservation increments the Tag control version before the ordinary append; the
assert-empty first write still starts at version 1. Full request/response
bodies are in
[`.artifacts/sdt-g56-w146-assert-empty-e2e.json`](.artifacts/sdt-g56-w146-assert-empty-e2e.json).

The unmodified deployed G15 and G16 checks both passed once. Their raw reports
are [G15](.artifacts/sdt-g56-w146-g15.json) and
[G16](.artifacts/sdt-g56-w146-g16.json). The consolidated evidence, including
the request/response bodies, red/green/mutant receipts, G54 golden output,
deployment identity, and frozen boundaries, is
[`docs/SDT-G56-evidence.md`](docs/SDT-G56-evidence.md).

## Gate summary

`npm run test:g56`, `test:g54`, `test:g44`, `test:g41`, `test:g49`, `test:g51`,
`test:g52`, `test:g53`, `test:g55`, `test:g15`, `test:g16`, `typecheck`, `lint`,
and `git diff --check` passed on the rebased branch. The required W133
red-before-green, omission-mutant, race, and G54 accepted-positive evidence
remain preserved and unchanged.

## Cloudflare and scope boundary

All five Wrangler API-token variable names were unset and were stripped from
every Wrangler invocation. No `--keep-vars` was used. The conformance token was
generated and supplied only by protected file path; its value was never
printed, logged, or committed. No Cloudflare resource was created, and only
the existing Worker, D1 databases, Queue, and DLQ were used. The 5,000 ms
contract, SafeWindow, outbox/Queue/global admission, ordering, fences, G53,
G55, G58, and projector behavior were not changed.

PR number, final pushed head, exact-head CI state, and canonical worker
transition are appended after PR creation and CI settlement.
