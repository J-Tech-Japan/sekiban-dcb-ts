# SDT-G35 evidence — DO scope contract closure (means/18)

Status: closure unit for SekibanCloud CF-CODE-1 / CF-ISOLATION-1 upstream
gate. Naming and control-route enforcement landed in SDT-G53; this unit closes
the formal means/18 contract, residual confused-deputy surfaces, and
Cloud-facing evidence. It does **not** discharge CF-CODE-1 WAIT from dcb-ts
alone.

## means/18 → landed surfaces

| means/18 requirement | Landed surface | Proof |
| --- | --- | --- |
| **means/18 requirement 1** — unify ALLOCATOR/BOOTSTRAP/TAG/JOURNAL naming; every DO name structurally includes `serviceId` | `buildScopeName` / `scopeIdFor` (`${serviceId}/${doClass}/${identity}`); G53 C-0 rename; residual JOURNAL probe/repair/control routes use the same grammar | G53 evidence + G35 census below |
| **means/18 requirement 2** — typed inability to assemble another service's journal reference | `DurableObjectScope` requires `serviceId`; sole `idFromName` call lives in `ScopeName.ts`; runtime/sample call sites must use `scopeIdFor` | G35 census guard |
| **means/18 requirement 3** — transition-time request vs `commitContext.serviceId` check | Commit path no longer addresses peers through JOURNAL (G41). Residual repair uses deployment/`ServiceIdentityProvider` authority (`this.serviceId`), not body/`commitContext` | G41 + G35 Commit/Repair source oracles |
| **means/18 requirement 4** — `commitContext.serviceId` / body `serviceId` must not be naming authority for ALLOCATOR/TAG | CommitWorker/RepairWorker address with `this.serviceId`. Outbox drain rejects body `serviceId` ≠ caller authority before TAG resolution | G35 confused-deputy fixtures + mutant |
| **means/18 requirement 5** — `GET /state` / `/result` scope | Journal control route resolves `scopeIdFor(..., { serviceId: requestServiceId, doClass: "journal", identity: attemptId })`; attemptId alone cannot reach a foreign service namespace | G35 journal control-route fixture |

## AC1 — census

```
node scripts/g35-do-scope-contract-check.mjs --self-test
node scripts/g35-do-scope-contract-check.mjs
```

Paste:

```
{"selfTest":"g35-do-scope-contract-mutations-red"}
{"result":"g35-do-scope-contract-passed","census":{"runtimeFiles":75,"sampleFiles":18,"directIdFromNameOutsideScopeName":0,"legacyGrammarsAbsent":true}}
```

Legacy grammars forbidden outside `ScopeName.ts`: `service-allocator:`,
`allocatorNameForService`, bare `idFromName(serviceId)`, `${serviceId}|…`.

## AC2 — confused-deputy fail-closed

```
npx vitest run --config vitest.config.ts test/g35-do-scope.spec.ts
node scripts/g35-confused-deputy-mutation-runner.mjs --self-test
node scripts/g35-confused-deputy-mutation-runner.mjs
```

Paste:

```
Test Files  1 passed (1)
Tests  4 passed (4)
{"result":"g35-confused-deputy-mutation-anchors-unique"}
{"result":"g35-confused-deputy-mutants-red","mutants":["drain-body-authority"]}
```

Oracles:

- control-route path `serviceId` ≠ authority → `scope.mismatch`, zero TAG stubs
- outbox-drain body `serviceId` ≠ authority → `scope.mismatch`, zero TAG stubs
- CommitWorker/RepairWorker source oracles require `this.serviceId` in the G35 contract guard
- journal control route physical name = `{authority}/journal/{attemptId}`

## AC3 — control routes

G53 fixtures remain authoritative for typed `scope.mismatch` /
`scope.identity_missing` before DO resolution. G35 re-asserts the path
mismatch oracle in `test/g35-do-scope.spec.ts` and keeps G53 green:

```
npm run test:g53
```

## AC4 — Cloud handoff

This document is the Cloud-readable map. After host closeout, means/18 +
dispatch/progress must stop claiming G35 未起草 and point here.

## AC5 — scope fence

- **CF-CODE-1 WAIT** is not discharged by this repository alone. Cloud still
  runs CF-ISOLATION-1 against real DO naming after G35 close.
- No `CloudflarePlacementDisabled` (D2) change.
- No `@sekiban/cloud-client` edits.
- No SafeWindow / G67 budget edits.
- PR closes the linked implementation issue only.

## Related baseline

- G53 scope record — deployed scoped naming + control-route e2e
- `docs/SDT-G41-evidence.md` (if present) — JOURNAL removed from commit path
- Design record: the retained domain-authoring and scope-contract records in
  this repository.
