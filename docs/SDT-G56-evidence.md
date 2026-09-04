# SDT-G56 deployed evidence — W146

Task: `SDT-G56-DEPLOYED-COMPLETION-W146`
Issue: [J-Tech-Japan/sekiban-dcb-ts#109](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/109)
Branch: `claude/sdt-g56-local-ac1-ac5-w133`
Rebase base: `a808bfa5d8eae481271b6d675109e9e5ac3fb758`
Deployed source: `3936a18c0f0183ba292f52fdd30623ef4d83935b`

This is the AC6–AC8 continuation of the banked local AC1–AC5 work. The
rebase changed only the parent lineage and commit IDs; the explicit empty-head
contract and all W133 red receipts remain intact. No new product behavior was
added in W146.

## Deployment target and credential boundary

The deployment used the existing normal configuration
`samples/meeting-room/wrangler.cloudflare-only.jsonc` and the existing
resources only:

| Resource | Existing identity |
| --- | --- |
| Worker | `sekiban-dcb-meeting-room-cloudflare-only` |
| URL | `https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev` |
| Pipeline D1 | `sekiban-dcb-meeting-room-cloudflare-pipeline` / `f26d1299-82d9-4a64-8647-bc2ec86326ac` |
| Materialized-view D1 | `sekiban-dcb-meeting-room-cloudflare-mv` / `b416b212-4d09-413c-9b8d-7660e475772f` |
| Queue / DLQ | `sekiban-dcb-meeting-room-cloudflare-outbox` / `sekiban-dcb-meeting-room-cloudflare-outbox-dlq` |

The five Wrangler credential names were all `UNSET` in the seat environment:
`CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`,
and `WRANGLER_API_TOKEN`. Every Wrangler invocation used `env -u` for all five,
used no `--keep-vars`, and was sequential in the single implementation seat.
No resource creation, migration, queue mutation, or database reset was run.

An unauthenticated read of `/conformance/v1/g32-config` returned HTTP 403 with
the application body:

```json
{"error":"Conformance authentication required","code":"unauthorized"}
```

This is the Worker’s conformance handler, not a Cloudflare API authorization
failure. `wrangler secret list` showed metadata for `CONFORMANCE_TOKEN`,
`G32_CUTOVER_FENCE_TOKEN`, and `G32_FREEZE_TOKEN` without reading values. A
fresh token was generated into a private file and supplied only through
`G53_CONFORMANCE_TOKEN_FILE` / stdin to one `wrangler secret put`; its value was
never printed, logged, or committed.

The first exact-source deployment produced version
`686b893e-3658-43be-8dd6-63f0e17d9290`, deployment
`9009fe5c-0360-4eac-b826-a3be78538974`, at 100%, annotated:
`SDT-G56 W146 exact 3936a18 rebased AC1-AC5`. Secret publication then produced
secret-only version `8d7a873e-f54b-4ecb-b712-aaac82065a47` (deployment
`78b48f47-60d2-4aa2-a2f0-9e0f43bdd2c3`), which had no source message. One
unchanged exact-source redeploy was therefore used, producing final version
`46176718-ef7b-4d90-b349-03ad26a9ea2e`, deployment
`ae7861e0-616a-4875-92ed-f27e385139d5`, at 100%, annotated:
`SDT-G56 W146 exact 3936a18 rebased AC1-AC5 after conformance secret`.
The final verification was the active deployment/version pair, not the
secret-only version.

## AC6 assert-empty deployed e2e

The complete raw request/response receipt is
[`.artifacts/sdt-g56-w146-assert-empty-e2e.json`](../.artifacts/sdt-g56-w146-assert-empty-e2e.json).
It records the endpoint, fresh `room:` tag, request payloads, response bodies,
status, and elapsed time after each response. The protocol sequence was run
once against the final exact-source deployment:

| Step | Request assertion | Response | Elapsed |
| --- | --- | --- | ---: |
| first-empty-head | `lastSortableUniqueId: ""` | HTTP 200; `writtenEvents[0].sortableUniqueIdValue = 063924107374785000001662020209`; tag version 1 | 2,531.914 ms |
| repeated-empty-head | same tag and `lastSortableUniqueId: ""` | HTTP 400; `code: consistency_conflict`; `error: serialized commit was refused by a consistency reservation` | 399.979 ms |
| exact-returned-head | same tag and the exact first returned SUID | HTTP 200; new SUID `063924107376858000002092497585`; tag version 3 | 990.447 ms |

The first request body was:

```json
{
  "version": 1,
  "eventCandidates": [{
    "payload": "eyJyb29tSWQiOiJnNTYtdzE0Ni1lMjE5MWY4Ni0xYzA1LTRjODAtYjdlMi00ZWU1NjcxOGFiZTMiLCJuYW1lIjoiVzE0NiBmaXJzdCJ9",
    "eventPayloadName": "RoomCreated",
    "tags": ["room:g56-w146-9e8d207a-cf75-4ff4-8052-63f2f921cec6"]
  }],
  "consistencyTags": [{
    "tag": "room:g56-w146-9e8d207a-cf75-4ff4-8052-63f2f921cec6",
    "lastSortableUniqueId": ""
  }]
}
```

Its response body included the committed `RoomCreated` event with the SUID
above and:

```json
{"tagWriteResults":[{"tag":"room:g56-w146-9e8d207a-cf75-4ff4-8052-63f2f921cec6","version":1}]}
```

The repeated request body was identical except for its payload’s `name`
(`W146 repeated empty`), and its exact response body was:

```json
{"error":"serialized commit was refused by a consistency reservation","code":"consistency_conflict"}
```

The final request used the exact first SUID
`063924107374785000001662020209` in its consistency entry. It returned HTTP
200 and a new event. Its reported tag version was 3, not 2: the non-empty
exact-head reservation increments the Tag control version before the ordinary
append increments it again. This is the existing reservation/version
semantics; the first assert-empty write still starts at version 1 and no
synthetic pre-event was created. The raw receipt contains the full third
request and response body.

## G15/G16 deployed checks

The unmodified public harnesses were each run once after the first exact-source
deployment and before the conformance secret rotation. Both remained green;
their raw reports are preserved in the branch:

- [G15 receipt](../.artifacts/sdt-g56-w146-g15.json): run
  `7a950307c7174943bfe66830cf945440`; create, reserve, and cancel were HTTP
  200; invalid input was typed HTTP 400; create/reservation/cancel visibility
  was 153.519/458.304/149.423 ms. The unchanged 120,000 ms oracle passed.
- [G16 receipt](../.artifacts/sdt-g56-w146-g16.json): run
  `1f2e8d5a08ae417d8dddad063a653bba`; create, reserve, and cancel were HTTP
  200; fully paged reservation-list visibility found the fresh reservation in
  44,493.814 ms across 32 rows and two pages; room query was HTTP 200. The
  unchanged 120,000 ms oracle passed.

## AC1–AC5 preservation and local gates

The W133 receipts remain unchanged:

- [red-before-green](../.artifacts/g56-red-before-green-w133.txt)
- [empty-head omission mutant red](../.artifacts/g56-omission-mutant-red-w133.txt)
- [first-write/race green](../.artifacts/g56-race-winner-green-w133.txt)

The rebased focused suite and existing boundary gates were rerun without
weakening or timeout changes:

| Gate | Result |
| --- | --- |
| `npm run test:g56` | PASS; 3 focused tests, green guard, omission mutant red |
| `npm run test:g54` | PASS; 18 tests, four accepted positives, required-envelope and accepted-positive mutants red |
| `npm run test:g44` | PASS; 8 tests and all four production mutants red |
| `npm run test:g41` | PASS; 8 tests and three production mutants red; existing teardown diagnostics were emitted but exit code was 0 |
| `npm run test:g49` | PASS; binding, migration, and lineage mutants red |
| `npm run test:g51` | PASS; selected trace tests, reference/bisect checks, native-span mutant, ingestion/probe guards |
| `npm run test:g52` | PASS; typecheck plus 18 tests and snapshot-sink guard |
| `npm run test:g53` | PASS; 10 tests and scope/downstream mutation guards red |
| `npm run test:g55` | PASS; 12 tests and read-visibility guard |
| `npm run test:g15` | PASS; 9 local tests and pagination self-test |
| `npm run test:g16` | PASS; 6 local tests and static UI contract |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with `--max-warnings=0` |
| `git diff --check` | PASS |

The G54 runner output recorded `sourceFiles: 17`, `manifestFixtures: 15`, and
`acceptedPositiveCount: 4`, with all four accepted-positive fixtures resolving
to SDT-G56. The copied fixture bytes and the 17-file SHA pins remain unchanged;
the accepted-positive and required-envelope omission mutation checks were red
as required.

## Scope and status

The 5,000 ms unsafe-visibility contract, omitted-entry meaning, V2 envelopes,
wire member names, ordering, fences, frozen trace schema, SafeWindow bounds,
outbox/Queue/global admission, projector advancement, G53 naming, G55 reads,
and G58 behavior were not changed. No Cloudflare resource was created. G60
remains the next unit and G56’s later units are not being started here.

The final PR head, CI classification, and canonical worker transition are
recorded in the W146 completion artifact after PR creation.
