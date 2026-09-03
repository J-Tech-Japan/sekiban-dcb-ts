Closes #112

## Summary

- Adds append-only scheduled-tick coverage history to the existing G58 health surface.
- Persists coverage kind, reason, partition tag, observedAt, stable `scheduled:<observedAt>` tick identity, and the proven completeness frontier for every scheduled tick, including BLOCK/UNSETTLED ticks.
- Preserves the W119 red receipt and adds a red-capable history guard; it never substitutes an MV safe head for the G44 proven frontier.
- Finalizes the last G58 classification cohort under HOST-LOOP-WAKE-104 Outcome A: the proven frontier stayed put across both persisted BLOCK ticks.

## Evidence

- Report: `sdt-g58-frontier-history-classification-w120.md`
- Consolidated evidence: `docs/SDT-G58-evidence.md`
- Raw cohort: `.artifacts/sdt-g58-w120-final-classification-cohort.json`
- Classification guard: `.artifacts/sdt-g58-w120-frontier-history-guard.json`
- Deployment identity: `.artifacts/sdt-g58-w120-deploy-identity.json`
- Deployed source: `9637e1f6c4e2b4b4c604763239abc4d214249118`
- Wrangler version: `29fa773f-bceb-40f1-bd06-53f6b887f2da` at 100%, annotation `SDT-G58 W120 frontier history 9637e1f`

The final fresh cohort accepted 10 reservations with minimum 12,159 ms
pacing. Persisted ticks `scheduled:1788459748077` and
`scheduled:1788459809755` were both BLOCK/UNSETTLED with frontier
`063924053488305000000669856102`; RoomProjector and ReservationProjector MV
safe heads were exactly that value on both ticks. No frontier advanced while an
MV head stayed behind. The cohort itself had zero safe samples by the
unchanged 180,000 ms line; WAKE-104 Outcome A accepts the preserved non-starved
95,629 ms and 42,492 ms safe samples while attributing the source-partition
starvation separately. Unsafe timing is evidence-only for G60: raw over-or-
missing count was 8/10.

## Validation

```text
npm run test:g15       PASS (9 tests)
npm run test:g16       PASS (6 tests)
npm run test:g41       PASS (8 tests; production mutations red)
npm run test:g44       PASS (8 tests; production mutations red)
npm run test:g49       PASS
npm run test:g51       PASS
npm run test:g52       PASS (18 tests)
npm run test:g53       PASS (10 tests)
npm run test:g54       PASS (18 tests)
npm run test:g55       PASS (12 tests)
npm run test:g58       PASS (14 tests; preserved and W120 guards)
npm run typecheck      PASS
npm run lint           PASS (zero warnings)
```

## Scope

SafeWindow `20,000/120,000 ms` bounds, the `5,000 ms` unsafe constant, G44
fencing, Tag outbox, Queue producer/consumer/configuration, and global-D1
admission are unchanged. Projector-head/tag-state convergence remains G61;
unsafe delivery remains G60. G56 remains held and G60/G61 remain queued and
undispatched.
