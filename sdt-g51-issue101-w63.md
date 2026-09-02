# SDT-G51-ISSUE101-W63 — BLOCKED

## Outcome

No ready-for-review PR was opened because AC5 remains unsatisfied. The final
deployment, `8ef93194-ad94-4a3e-8a5f-545b7845647e` from
`69ccc19654c078c3e856c17c1c827fdd6959c630`, completed a fresh app-surface
cohort of one discarded warm-up plus ten sequential accepted
`POST /api/commands/create-room` requests. Its bounded 600,000 ms retained
trace poll ended at **0/10** cohort traces.

No fourth cohort was started. The two earlier isolated 1 + 10 diagnostic
cohorts also ended at 0/10 and are explicitly not stitched into the final
window.

## Delivered implementation

- Added native-only `sdt.row.id` projection for valid `sdt.commit/v1` S-rows,
  including S00 and S16, without changing the frozen trace snapshot or commit
  protocol.
- Added a fake-native-tracer G51 guard, pre-fix red proof, root-omission
  mutation proof, and CI wiring in the existing G30 lane.
- Added bounded cohort-ingestion polling to G37/G50 exporter paths and focused
  settled/shortfall guards.
- Added an observation-only ingress CF-Ray relay for the app-to-runtime
  in-isolate request and selected the documented module-form tracer at the
  active commit callback.
- Preserved the G41 zero-Journal fixture and contract unchanged.

## Evidence and checks

- [Detailed evidence](docs/SDT-G51-evidence.md)
- [.artifacts/sdt-g51-w63-live-shortfall.json](.artifacts/sdt-g51-w63-live-shortfall.json)
- `npm run test:g51` — passed (including current-main red/bisect evidence,
  root omission mutant, relay test, and bounded poll guards)
- `npm run typecheck` and `node scripts/commit-trace-contract.mjs --check` — passed
- `node scripts/g41-journal-contract-check.mjs` and focused
  `test/g41-journal-removal.spec.ts` — passed unchanged

The final redacted retained-data tally saw three `actor.handle` / S16 events,
but no S00 or other mapped Worker rows. That is not AC5 proof; R-1 remains
open. See the evidence document for the exact regression mechanism, deployment
versions, shortfalls, and the required follow-up boundary.
