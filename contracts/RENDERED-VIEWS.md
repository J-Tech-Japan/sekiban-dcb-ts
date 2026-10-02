# RENDERED VIEWS (generated — do not edit)

Generated from the commit-trace manifest and epoch allowlist by scripts/commit-trace-generate.mjs.
The normative documents define the public scan scope.

## sdt.commit/v1

| rowId | span | emitter | start | end | parent | coverage | kind | success cardinality |
|---|---|---|---|---|---|---|---|---|
| S00 | sdt.commit | root-worker | handler entry (before validation) | just before Response return | null | true | root | 1 |
| S01 | request.decode_validate | root-worker | before request.json | validation outcome fixed | S00 | true | direct | 1 |
| S02 | bootstrap.admit | caller-worker | before stub call | body consume / typed failure | S00 | true | direct | 1 |
| S03 | bootstrap.release | caller-worker | before stub call | body consume / typed failure | S00 | true | direct | 1 |
| S04 | journal.admit | caller-worker | before stub call | body consume / typed failure | S00 | true | direct | 1 |
| S05a | journal.transition | caller-worker | before RESERVED call | body consume | S00 | true | direct | 1 |
| S05b | journal.transition | caller-worker | before ALLOCATED call | body consume | S00 | true | direct | 1 |
| S05c | journal.transition | caller-worker | before WRITING call | body consume | S00 | true | direct | 1 |
| S05d | journal.transition | caller-worker | before COMPLETE call | body consume | S00 | true | direct | 1 |
| S05e | journal.transition | caller-worker | before terminal call | body consume | S00 | true | direct | terminal only |
| S06 | tag.acquire.stage | caller-worker | before allSettled construction | all members settled | S00 | true | fanout-stage | 1 |
| S07 | tag.acquire.member | caller-worker | before TAG stub call | settle | S06 | false | fanout-member | consistencyTags.length |
| S08 | allocator.allocate | caller-worker | before stub call | body consume / typed failure | S00 | true | direct | 1 |
| S09 | allocator.bootstrap.finalize | allocator-do | before BOOTSTRAP call | body consume | S08 | false | nested | 1 (v1 only) |
| S10 | bootstrap.append_finalize | caller-worker | before validation call | body consume | S00 | true | direct | 1 (v1 only) |
| S11 | tag.append.stage | caller-worker | before allSettled construction | all members settled | S00 | true | fanout-stage | 1 |
| S12 | tag.append.member | caller-worker | before TAG stub call | settle | S11 | false | fanout-member | allTags.length |
| S13 | tag.state.stage | caller-worker | before allSettled construction | all members settled | S00 | true | fanout-stage | 1 (v1 only) |
| S14 | tag.state.member | caller-worker | before TAG stub call | settle | S13 | false | fanout-member | allTags.length (v1 only) |
| S15 | response.build | root-worker | result assembly start | Response object complete | S00 | true | direct | 1 |
| S17 | journal.reservation_failure | caller-worker | before /reservation-failure call | body consume | S00 | true | direct | failure only |
| S18 | tag.cancel.stage | caller-worker | before allSettled construction | all members settled | S00 | true | fanout-stage | failure only |
| S19 | tag.cancel.member | caller-worker | before TAG /cancel call | settle | S18 | false | fanout-member | consistencyTags.length |
| S20 | journal.seal_reconcile | caller-worker | before /reconcile call | body consume | S00 | true | direct | handoff only |
| S16 | actor.handle | callee-do | callee handler entry | response / throw | provider-subrequest | false | callee | per remote invocation |

### boundary: success

- required: S00, S01, S02, S03, S04, S05a, S05b, S05c, S05d, S06, S07, S08, S09, S10, S11, S12, S13, S14, S15
- conditional: (none)
- forbidden: S05e, S17, S18, S19, S20
- state: full write; COMPLETE before response

### boundary: validation-reject

- required: S00, S01, S15
- conditional: (none)
- forbidden: S02, S03, S04, S05a, S05b, S05c, S05d, S05e, S06, S07, S08, S09, S10, S11, S12, S13, S14, S17, S18, S19, S20
- state: no attempt identity yet; zero downstream calls

### boundary: bootstrap-reject

- required: S00, S01, S02, S15
- conditional: (none)
- forbidden: S03, S04, S05a, S05b, S05c, S05d, S05e, S06, S07, S08, S09, S10, S11, S12, S13, S14, S17, S18, S19, S20
- state: zero journal/tag writes

### boundary: reservation-failure

- required: S00, S01, S02, S03, S04, S05a, S06, S07, S17, S18, S19, S05e, S15
- conditional: (none)
- forbidden: S05b, S05c, S05d, S08, S09, S10, S11, S12, S13, S14, S20
- state: cancel fan-out covers every consistency tag (forceTombstone)

### boundary: allocator-failure

- required: S00, S01, S02, S03, S04, S05a, S06, S07, S08, S17, S18, S19, S05e, S15
- conditional: S09 [allocator reached its bootstrap finalize before failing]
- forbidden: S05b, S05c, S05d, S10, S11, S12, S13, S14, S20
- state: S09 only when the allocator reached its finalize

### boundary: partial-handoff-to-alarm

- required: S00, S01, S02, S03, S04, S05a, S05b, S05c, S06, S07, S08, S09, S10, S11, S12, S20, S15
- conditional: (none)
- forbidden: S05d, S05e, S13, S14, S17, S18, S19
- state: alarm side lives in sdt.commit.reconcile/v1

## sdt.commit/v2

| rowId | span | emitter | start | end | parent | coverage | kind | success cardinality |
|---|---|---|---|---|---|---|---|---|
| S00 | sdt.commit | root-worker | handler entry (before validation) | just before Response return | null | true | root | 1 |
| S01 | request.decode_validate | root-worker | before request.json | validation outcome fixed | S00 | true | direct | 1 |
| S02 | bootstrap.admit | caller-worker | before stub call | body consume / typed failure | S00 | true | direct | 1 |
| S03 | bootstrap.release | caller-worker | before stub call | body consume / typed failure | S00 | true | direct | 1 |
| S04 | journal.admit | caller-worker | before stub call | body consume / typed failure | S00 | true | direct | 1 |
| S05a | journal.transition | caller-worker | before RESERVED call | body consume | S00 | true | direct | 1 |
| S05b | journal.transition | caller-worker | before ALLOCATED call | body consume | S00 | true | direct | 1 |
| S05c | journal.transition | caller-worker | before WRITING call | body consume | S00 | true | direct | 1 |
| S05d | journal.transition | caller-worker | before COMPLETE call | body consume | S00 | true | direct | 1 |
| S05e | journal.transition | caller-worker | before terminal call | body consume | S00 | true | direct | terminal only |
| S06 | tag.acquire.stage | caller-worker | before allSettled construction | all members settled | S00 | true | fanout-stage | 1 |
| S07 | tag.acquire.member | caller-worker | before TAG stub call | settle | S06 | false | fanout-member | consistencyTags.length |
| S08 | allocator.allocate | caller-worker | before stub call | body consume / typed failure | S00 | true | direct | 1 |
| S11 | tag.append.stage | caller-worker | before allSettled construction | all members settled | S00 | true | fanout-stage | 1 |
| S12 | tag.append.member | caller-worker | before TAG stub call | settle | S11 | false | fanout-member | allTags.length |
| S15 | response.build | root-worker | result assembly start | Response object complete | S00 | true | direct | 1 |
| S17 | journal.reservation_failure | caller-worker | before /reservation-failure call | body consume | S00 | true | direct | failure only |
| S18 | tag.cancel.stage | caller-worker | before allSettled construction | all members settled | S00 | true | fanout-stage | failure only |
| S19 | tag.cancel.member | caller-worker | before TAG /cancel call | settle | S18 | false | fanout-member | consistencyTags.length |
| S20 | journal.seal_reconcile | caller-worker | before /reconcile call | body consume | S00 | true | direct | handoff only |
| P01 | bootstrap.permit_acquire | caller-worker | before acquire call | body consume | S00 | true | direct | 1 (v2 only) |
| P02a | allocator.permit_prepare | allocator-do | before Bootstrap validation call (pre-transaction) | body consume | S08 | false | nested | 1 (v2 only) |
| P02b | allocator.permit_handoff | allocator-do | after allocator transaction commit, before handoff call | body consume | S08 | false | nested | 1 (v2 only) |
| P03 | bootstrap.permit_validate_append | caller-worker | before append validation call | body consume | S00 | true | direct | 1 (v2 only) |
| P04 | bootstrap.permit_resolve | caller-worker | before resolution evidence call | body consume | S00 | true | direct | 1 (v2 only) |
| P05 | bootstrap.permit_release | caller-worker | before release call | body consume | S00 | true | direct | 1 (v2 only) |
| S16 | actor.handle | callee-do | callee handler entry | response / throw | provider-subrequest | false | callee | per remote invocation |

### boundary: success

- required: S00, S01, S02, S03, S04, S05a, S05b, S05c, S05d, S06, S07, S08, P01, P02a, P02b, P03, P04, P05, S11, S12, S15
- conditional: (none)
- forbidden: S05e, S17, S18, S19, S20
- state: permit released once after full write

### boundary: permit-acquire-reject

- required: S00, S01, S02, S03, S04, S05a, S06, S07, P01, S17, S18, S19, S05e, S15
- conditional: (none)
- forbidden: S05b, S05c, S05d, S08, P02a, P02b, P03, P04, P05, S11, S12, S20
- state: no permit created; zero event/tag writes

### boundary: permit-prepare-reject

- required: S00, S01, S02, S03, S04, S05a, S06, S07, S08, P01, P02a, S17, S18, S19, S05e, S15
- conditional: (none)
- forbidden: S05b, S05c, S05d, P02b, P03, P04, P05, S11, S12, S20
- state: proven no-write: allocator vector absent

### boundary: permit-prepare-response-loss

- required: S00, S01, S02, S03, S04, S05a, S05b, S05c, S05d, S06, S07, S08, P01, P02a, P02b, P03, P04, P05, S11, S12, S15
- conditional: (none)
- forbidden: S05e, S17, S18, S19, S20
- state: P02a idempotent retry (retry.index>=1); allocation 0-call until success confirmed; then normal continuation

### boundary: permit-handoff-requery-active-allocate-retry

- required: S00, S01, S02, S03, S04, S05a, S05b, S05c, S05d, S06, S07, S08, P01, P02a, P02b, P03, P04, P05, S11, S12, S15
- conditional: (none)
- forbidden: S05e, S17, S18, S19, S20
- state: requeried permit == ACTIVE_ALLOCATE: P02b same-tuple retry required (retry.index>=1); append 0-call before success

### boundary: permit-handoff-requery-active-append-continue

- required: S00, S01, S02, S03, S04, S05a, S05b, S05c, S05d, S06, S07, S08, P01, P02a, P02b, P03, P04, P05, S11, S12, S15
- conditional: (none)
- forbidden: S05e, S17, S18, S19, S20
- state: requeried permit == ACTIVE_APPEND: P02b cardinality exactly 1 (double CAS forbidden); continuation

### boundary: permit-handoff-requery-alarm-handoff

- required: S00, S01, S02, S03, S04, S05a, S05b, S05c, S06, S07, S08, P01, P02a, P02b, S20, S15
- conditional: (none)
- forbidden: S05d, S05e, P03, P04, P05, S11, S12, S17, S18, S19
- state: either permit state may hand off; P02b retry.index recorded so the retry decision is derivable from row evidence

### boundary: permit-handoff-requery-mismatch-failclosed

- required: S00, S01, S02, S03, S04, S05a, S05b, S05c, S06, S07, S08, P01, P02a, P02b, S20, S15
- conditional: (none)
- forbidden: S05d, S05e, P03, P04, P05, S11, S12, S17, S18, S19
- state: owner/digest mismatch, missing, or unexpected terminal: typed fail-closed, event/tag write 0-call

### boundary: permit-append-validation-reject

- required: S00, S01, S02, S03, S04, S05a, S05b, S05c, S06, S07, S08, P01, P02a, P02b, P03, S20, S15
- conditional: (none)
- forbidden: S05d, S05e, S17, S18, S19, S11, S12, P04, P05
- state: TAG append 0-call; no direct terminal; active permit handed to alarm

### boundary: permit-resolve-failure

- required: S00, S01, S02, S03, S04, S05a, S05b, S05c, S06, S07, S08, P01, P02a, P02b, P03, S11, S12, P04, S20, S15
- conditional: (none)
- forbidden: S05d, S05e, P05, S17, S18, S19
- state: must not release; stays RESOLVING for alarm/repair

### boundary: permit-release-response-loss

- required: S00, S01, S02, S03, S04, S05a, S05b, S05c, S05d, S06, S07, S08, P01, P02a, P02b, P03, P04, P05, S11, S12, S15
- conditional: (none)
- forbidden: S05e, S17, S18, S19, S20
- state: P05 retry.index 0..n; converges to one released tombstone with the same evidence digest

## sdt.commit.reconcile/v1

| rowId | span | emitter | start | end | parent | coverage | kind | success cardinality |
|---|---|---|---|---|---|---|---|---|
| R00 | sdt.commit.reconcile | journal-do | alarm handler entry | handler return | null | true | root | 1 |
| R01 | journal.alarm_rearm | journal-do | durable re-arm start | complete | R00 | true | direct | non-terminal entry only |
| R02 | journal.takeover_cas | journal-do | journalOwnerEpoch+1 CAS start | complete | R00 | true | direct | pre-takeover only |
| R03 | tag.seal.stage | journal-do | before the SEQUENTIAL seal loop over allTags | loop complete (members are ordered, not parallel) | R00 | true | sequential-stage | post-allocation recovery only |
| R04 | tag.seal.member | journal-do | before TAG /seal call | response | R03 | false | sequential-member | unsealed members only |
| R09 | tag.cancel.stage | journal-do | before the parallel cancel barrier over consistencyTags | all members settled | R00 | true | fanout-stage | pre-allocation vector-absent recovery only |
| R10 | tag.cancel.member | journal-do | before TAG /cancel (forceTombstone) call | settle | R09 | false | fanout-member | consistencyTags.length |
| R11 | journal.reconcile_apply | journal-do | before the applyReconciliation CAS | CAS complete | R00 | true | direct | reconciliation-terminated recovery only |
| R05 | bootstrap.permit_transfer | journal-do | before transfer call | body consume | R00 | true | direct | v2 + active permit only |
| R06 | journal.terminal_cas | journal-do | terminal CAS start | complete | R00 | true | direct | reached-terminal only |
| R08 | journal.alarm_clear | journal-do | deleteAlarm() start | complete | R00 | true | direct | terminal-at-entry only |

## sdt.commit.repair/v1

| rowId | span | emitter | start | end | parent | coverage | kind | success cardinality |
|---|---|---|---|---|---|---|---|---|
| X00 | sdt.commit.repair | repair-runner | handler entry | completion / throw | null | true | root | 1 |
| X02 | tag.repair_lease | repair-runner | before ensureLease acquire/renew call | acquire/renew call response (there is no release call; LeaseContext lifetime is execution-local) | X00 | true | fanout-member | distinct tags that actually reach ensureLease (dry-run: 0; all-items-resume-skip: 0; several items on one tag: 1) |
| X03e | tag.repair_item.execute_mutating | repair-runner | item branch decision start | branch-specific terminal durable evidence (ROLLED_FORWARD/EXCLUDED_AUDITED: resolution+audit; FAILED_CLOSED: resolution only, audit forbidden) | X00 | false | fanout-member | mutating items only |
| X03r | tag.repair_item.resume_skip | repair-runner | durable-state read start | skip decision (no durable write) | X00 | false | fanout-member | already-resolved items (durable write 0-call) |
| X03p | tag.repair_item.dry_run_plan | repair-runner | workset read start | plan entry produced (no lease, no mutation) | X00 | false | fanout-member | dry-run items over the FULL workset distinct tags (maxItems bounds mutating execution only, not the dry-run plan read) |
| X01 | bootstrap.permit_resolved_safe | caller | before RESOLVED_SAFE CAS call | body consume | X00 | true | direct | per attempt reaching RESOLVED_SAFE |

### boundary: dry-run

- required: X00, X03p
- conditional: (none)
- forbidden: X02, X03e, X03r, X01
- state: lease and mutation 0-call; X03p counts distinct tags of the FULL workset

### boundary: all-items-resume-skip

- required: X00, X03r
- conditional: (none)
- forbidden: X02, X03e, X03p, X01
- state: ensureLease never reached, so X02 cardinality is 0; durable write 0-call

### boundary: execute-mutating-single-tag

- required: X00, X02, X03e
- conditional: X01 [the attempt reached RESOLVED_SAFE in this execution]
- forbidden: X03p, X03r
- state: several mutating items on one tag reuse one lease: X02 == 1, X03e == N

### boundary: execute-failed-closed

- required: X00, X02, X03e
- conditional: (none)
- forbidden: X03p, X03r, X01
- state: FAILED_CLOSED writes a resolution but NO audit; X03e ends at the resolution record; X01 forbidden

## epoch allowlist summary

- entries: 2
- exclusions: 0
- documents: contracts/commit-trace-normative.md, contracts/bootstrap-import-normative.md
