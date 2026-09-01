# SDT-G48 Journal cleanup evidence

Issue #94 implements the classifications already sealed by SDT-G41. It does
not change the serialized commit path, remove the `JournalDurableObject`
class or binding, alter the G38 tombstone assertion, create a migration or
compatibility fence, or require a deployment.

## Implemented Journal route contract

The runtime `JournalDurableObject.fetch` route set is exactly:

| Retained route | Purpose |
| --- | --- |
| `POST <G42_JOURNAL_PROBE_INTERNAL_PREFIX>/*` | Authenticated, fenced G42 first-touch probe |
| `GET /state` | Direct legacy-Journal diagnostic |
| `GET /repair/workset` | RepairWorker's legacy partial-workset read |
| `GET /repair/observations` | Repair audit read |
| `POST /repair/observation` | Repair audit write |

The removed paths all return the normal `404 journal_route_not_found` response
instead of dispatching a legacy handler:

| Removed route |
| --- |
| `GET /result` |
| `POST /admit` |
| `POST /transition` |
| `POST /reservation-failure` |
| `POST /reconcile` |
| `POST /takeover` |
| `POST /fault` |
| `POST /debug/alarm` |

This deliberately retains `GET /state` while deleting adjacent
`GET /result`.

## Contract checker and forced-red proof

`scripts/g41-journal-contract-check.mjs` now keeps the SDT-G41 historical
inventory as a sealed record and separately derives the actual route table
from `JournalDurableObject.fetch`. It requires exact count/set equality with
the five retained routes, and performs an explicit source-absence assertion
for each removed `path === "..."` dispatch. The parser is closed over the
route conditional grammar, so an unclassified conditional fails the check.

The self-test passed and reported all of these independently rejected
mutations:

```json
{
  "selfTest": "g48-exact-retained-routes-and-removed-route-absence",
  "forcedRed": [
    "historical route classification omission",
    "public response wire preservation disappearance",
    "unclassified Journal route",
    "tag prepare removal",
    "partial write deletion claim",
    "repair caller disappearance",
    "historical durable-field omission",
    "historical caller omission",
    "surviving historical surface disposition omission",
    "stale epoch fixture disappearance",
    "re-adding a removed route",
    "removing a retained route",
    "post-cleanup durable-field omission",
    "post-cleanup caller omission"
  ]
}
```

In particular, the required re-added-removed-route and
removed-retained-route mutant classes are independent forced-red probes, not
mere entries in an unexecuted list.

## Sealed universes

The original pre-change-main `7cc38a4` G41 seal remains unchanged in the
top-level historical fields and is duplicated explicitly as
`historicalG41Universe`. The new `postCleanupExpectedUniverse` is separately
sealed and compared against source-derived implementation facts.

| Universe | Durable fields |
| --- | --- |
| Historical G41 | `__sdt_g42_p1_alarm`, `__sdt_g42_p1_index`, `__sdt_g42_p1_record__:*`, `journal`, `journal.alarm`, `journal.allocatorVector`, `journal.attemptId`, `journal.candidates`, `journal.consistencyTags`, `journal.failureCause`, `journal.missingTags`, `journal.ownerEpoch`, `journal.repairObservations`, `journal.state`, `journal.terminalResponse`, `journal.testFaults` |
| Post-cleanup | `__sdt_g42_p1_alarm`, `__sdt_g42_p1_index`, `__sdt_g42_p1_record__:*`, `journal`, `journal.candidates`, `journal.missingTags`, `journal.repairObservations` |

| Universe | Callers |
| --- | --- |
| Historical G41 | `CommitWorker.handleUntraced (pre-G41 only)`; `JournalDurableObject.alarm (inert after commit removal)`; `OperatorRepairCli -> RepairWorker`; Cloudflare `/journals/:attemptId/result`; Cloudflare `/journals/:attemptId/state`; index `/journals/:attemptId/result`; index `/journals/:attemptId/state`; `RepairWorker.enumerate`; `RepairWorker.recordClearedObservations`; G42 meeting-room probe; direct Journal-only fault fixture |
| Post-cleanup | `OperatorRepairCli -> RepairWorker`; Cloudflare `/journals/:attemptId/state`; index `/journals/:attemptId/state`; `RepairWorker.enumerate`; `RepairWorker.recordClearedObservations`; G42 meeting-room probe |

The checker has an omission mutant for each post-cleanup universe, both of
which are included in the forced-red output above.

## Alarm disposition

The `alarm()` method is retained. G42 legitimately schedules its fenced probe
alarm, so removing the handler could leave that live non-commit path without
its cleanup behavior. The handler clears a valid G42 marker and its alarm;
a non-probe scheduled alarm is only a pre-cleanup legacy remnant and is
cleared without reviving any retired recovery state machine. No remaining
production path schedules a legacy Journal alarm. Under C-0, this needs no
migration or compatibility behavior.

## Test changes required by the deleted handlers

- `test/journal.spec.ts` replaces the direct legacy state-machine and
  `POST /fault` fixture with a seeded legacy record, a retained `GET /state`
  assertion, and an assertion that every eight removed routes returns 404.
- `test/repair.spec.ts` previously used removed `POST /admit`,
  `POST /transition`, `POST /reconcile`, and `POST /debug/alarm` handlers to
  manufacture a legacy `PARTIAL` workset. It now writes the explicitly
  historical `JournalRecord` fixture directly to test Durable Object storage
  after observing the real Tag-owned partial result. It explicitly seeds the
  removed-handler outcome fields `state: "PARTIAL"`,
  `reconciliation.allocatorVector`, and `reconciliation.missingTags`. This is
  unavoidable once creation/recovery controls are removed; it is test setup
  only and does not add a production compatibility path. The retained
  RepairWorker workset and observation API behavior remains exercised.
- `test/allocator.spec.ts` removes its Journal-admit/reconcile portion and
  retains the allocator durable-watermark restart/replay assertion.
- `test/commit.spec.ts` removes direct legacy Journal alarm/recovery route
  tests. The G41 serialized-commit tests and their zero-JOURNAL fixture are
  retained; no commit-path source changed.
- `test/g30-trace.spec.ts` removes its direct legacy Journal alarm trace
  fixture. The frozen G30 trace schema itself is unchanged, as required by
  the issue's out-of-scope boundary. Its production mutation matrix replaces
  the two deleted terminal-recovery mutations with two independently-red
  mutations of the retained live G42 alarm-marker cleanup, using the existing
  G42 alarm test as the named oracle. This preserves an executable production
  guard without retaining a dead R00/R08 handler solely for test coverage.

No unrelated test was skipped, timeout-inflated, or assertion-reduced to
compensate for this cleanup.

## Verification

The issue-relevant verification passed:

```text
node scripts/g41-journal-contract-check.mjs --self-test && node scripts/g41-journal-contract-check.mjs
npm run test:g41
npm run test:g38:tombstone
npm run test:g42
npm run test:g30
npm run typecheck
npm run lint
```

`npm run test:g41` includes the unchanged G41 zero-JOURNAL commit fixture and
the unchanged production mutation runner. Its mutation result remains
`all-g41-production-mutants-red`.

The full `npm test` suite was also attempted both normally and with
`--maxWorkers=1`. It cannot complete in this sandbox because unrelated
Postgres/Hyperdrive-dependent suites fail with `Network connection lost` and
`proxy request failed, cannot connect to the specified address` (for example
the bootstrap, downstream, projection, materialized-view, read, and query
suites). No failing suite uses the removed Journal handlers, no gate was
changed, and all Journal-affected tests above pass. No deployment was required
or performed.
