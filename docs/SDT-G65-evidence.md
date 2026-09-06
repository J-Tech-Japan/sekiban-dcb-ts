# SDT-G65 deployed acceptance evidence — W138-2 / W141

Task: `SDT-G65-PR127-DEPLOYED-ACCEPTANCE-2-WAKE-138`
PR: `J-Tech-Japan/sekiban-dcb-ts#127`
Requested exact head: `5edfd6413b1ff446e6f7475eef18c947b0ca93fe`
Branch: `claude/sdt-g65-local-wake-w128`
Arm: `sekiban-dcb-g60-w155-c`

## Disposition

**Evidence published; code acceptance is unchanged.** The W138-2 receipt
records one observation beyond the 180-second safe reporting line and one
unsafe observation over the unchanged 5,000 ms contract. The safe value is
measured and reported by AC5; 180 seconds is not a G65 pass/fail target. The
deployed version view proved the actual `DOWNSTREAM_DOORBELL` service binding
and `DIRECT_DOORBELL=true`; nevertheless all post-cohort unsafe-writer rows
were `transport=queue`, so direct transport and healthy direct admission were
not proven. The configured-store first-write typed refusal remains unproven
because the safe existing-resource failure shapes were classified as
explicitly unconfigured and committed the new event.

W136 is historical/superseded evidence. Its incomplete post cohort and
unconfigured D1 observations are retained as history and are not reused as
current proof or described as a current AC5 blocker.

No source, fixture, workflow, gate, PR state, issue claim, resource, migration,
or production worker outside the authorized W155-C arm was changed. The final
arm state was restored to the normal exact-head configuration.

## Hygiene and resource boundary

Every Wrangler command stripped these five names, which were all `UNSET` in the
seat environment: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`,
`CLOUDFLARE_API_KEY`, `CF_API_KEY`, and `WRANGLER_API_TOKEN`. No
`--keep-vars` was used. Conformance was supplied only through the private
`G53_CONFORMANCE_TOKEN_FILE` path; no token value was recorded.

| Resource | Identity |
| --- | --- |
| Worker | `sekiban-dcb-g60-w155-c` |
| Pipeline D1 | `ac751211-fde8-4587-9d56-1e9fd8051bc3` |
| MV D1 | `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` |
| Queue / DLQ | `sekiban-dcb-g60-w155-c-outbox` / `sekiban-dcb-g60-w155-c-outbox-dlq` |

The only data mutation was the authorized schema-preserving DELETE reset before
the two matched cohorts. No migration, resource create, or resource delete was
performed. The C-0 variants reused the same existing resources.

## Version and binding proof

The baseline was deployed from the prior W138 pre-change source
`a8bb1bd493591081c24a52239c1b0e2dce2c42e1`:

| Role | Deployment | Version | Traffic | Annotation |
| --- | --- | --- | ---: | --- |
| Baseline | `2e8f0e2d-743e-4d91-8cf3-5ae2e498dc72` | `7c2a8b6e-1866-4f70-b611-0c892abf45b3` | 100% | `SDT-G65 W136 restore normal D1 exact a8bb1bd493591081c24a52239c1b0e2dce2c42e1 DIRECT_DOORBELL=true after C-0` |
| Post | `6fb3e84b-b73f-465e-b0eb-b09c1eadaa2d` | `1ce0c81b-61d0-4670-b85e-a02c06a62ab0` | 100% | `SDT-G65 W138-2 post-change exact 5edfd6413b1ff446e6f7475eef18c947b0ca93fe DIRECT_DOORBELL=true` |
| Final restore | `3077a46c-8e46-4c54-a2b1-8f33dfeaf418` | `f2964bb7-91eb-470d-ab7e-3bbb80fc52ea` | 100% | `SDT-G65 W138-2 final restore normal exact 5edfd6413b1ff446e6f7475eef18c947b0ca93fe DIRECT_DOORBELL=true` |

The exact post and final version views, not local configuration, contained:

```text
DIRECT_DOORBELL=true
DOWNSTREAM_DOORBELL=sekiban-dcb-meeting-room-doorbell#MeetingRoomDownstreamDoorbell
D1=ac751211-fde8-4587-9d56-1e9fd8051bc3
D1_MV=2b60dbcf-0912-4bb2-93aa-77c26cd260e1
```

## Cohorts

Both used `node .artifacts/g65-w128-cohort.mjs`, cold first sample, n=10,
at least 10 seconds after each preceding commit response, and fully paged
`GET /api/read/reservations`. Timing uses observed client fetch and durable
ledger `Date.now` epoch milliseconds only; authored `dcb_events.Timestamp` and
caller `received_at` are excluded.

| Metric | Baseline (`a8bb1bd`) | Post (`5edfd64`) |
| --- | ---: | ---: |
| Window | 21:56:27.674Z–22:01:39.051Z | 22:03:31.015Z–22:08:46.392Z |
| n | 10 | 10 |
| Response p50 / p95 | 2,579 / 2,992 ms | 2,824 / 3,610 ms |
| Response p95 delta | — | +618 ms, misses +150 ms |
| Response p50 delta | — | +245 ms, within 400 ms stated allowance |
| HTTP 504 | 0 | 0 |
| Unsafe p50 / p95 | 2,388 / 117,117 ms | 2,582 / 43,783 ms |
| Strict unsafe over 5,000 ms | 1/10 | 1/10 |
| Safe final-head p50 / p95 | 127,915 / 191,178 ms | 120,479 / 187,018 ms |
| Safe over 180,000 ms | 1/10 | 1/10 |
| Admission header | `unknown` 10/10 | `unknown` 10/10 |

All ten post samples eventually reached both final projector heads and all 11
cohort tag-state reads returned committed version 1. Sample 1 reached its
final head at 187,018 ms; the baseline sample 1 reached its final head at
191,178 ms. These are measured observations beyond the reporting line; AC5
requires publishing the safe timing and does not make 180 seconds a G65
pass/fail target.

| # | Baseline response / unsafe / safe (ms) | Post response / unsafe / safe (ms) |
| ---: | --- | --- |
| 1 | 2,579 / 117,117* / 191,178* | 3,030 / 4,764 / 187,018* |
| 2 | 2,537 / 4,362 / 178,535 | 3,479 / 2,405 / 173,184 |
| 3 | 2,518 / 2,323 / 166,016 | 3,495 / 2,424 / 159,687 |
| 4 | 2,478 / 2,290 / 153,536 | 2,773 / 2,482 / 146,913 |
| 5 | 2,992 / 4,314 / 140,543 | 2,714 / 4,565 / 134,196 |
| 6 | 2,626 / 4,460 / 127,915 | 3,610 / 2,519 / 120,479 |
| 7 | 2,563 / 2,380 / 115,351 | 2,824 / 43,783* / 107,654 |
| 8 | 2,773 / 2,290 / 102,577 | 2,950 / 2,582 / 94,703 |
| 9 | 2,763 / 4,332 / 89,812 | 2,654 / 4,761 / 82,046 |
| 10 | 2,750 / 2,388 / 77,060 | 2,619 / 4,569 / 69,205 |

`*` is a strict acceptance miss. The pre raw cohort is preserved, but its
durable rows were deleted by the required clean reset before the post cohort;
pre admission duration and pre durable sub-hop values are therefore **not
available** and are not inferred.

## Post durable hop table

The exact post ledger has 10/10 reservation admission attempts, all
`outcome=unknown`, duration p50/p95 `300/300 ms`, and no
`global_completion_observed_at`.

| Boundary | n / p50 / p95 (ms) |
| --- | ---: |
| Command receipt → Tag append | 10 / 1,050 / 1,350 |
| Tag append → outbox obligation | 10 / 0 / 0 |
| Outbox obligation → Queue send | 10 / 664 / 792 |
| Queue send → consumer start | 10 / 2,823 / 4,924 |
| Consumer start → recordDelivery | 10 / 748 / 1,232 |
| recordDelivery → ledger unsafe read | 10 / -268 / 7,567 |
| recordDelivery → public unsafe read | 10 / -230 / 38,241 |
| Global receipt readback | 10 / 123 / 268 |
| Source Tag acknowledgement | 10 / 182 / 1,825 |
| Completeness coverage | 10 / 109 / 130 |
| Detector | 3 / 274 / 352 (three paired spans) |
| Room unsafe-view apply | 10 / 73 / 365 |
| Reservation unsafe-view apply | 10 / 69 / 351 |
| Unsafe-writer Room boundary | 10 / 57 / 137 |
| Unsafe-writer Reservation boundary | 10 / 61 / 71 |

All 20 post unsafe-writer rows were `transport=queue` and
`writer_path=inline-delivery`; no direct transport row was observed. The short
apply spans therefore do not prove a direct-doorbell contribution or healthy
direct admission. Samples 1–7 are dominated by the recordDelivery-to-public
read residual; the 43,783 ms unsafe sample is the clearest case.

## C-0 D1-unavailable proof

The corrected no-D1 variant was version
`a7b897a4-b52d-4e9b-8940-595acae4b9d3`, deployment
`ad9c3114-773a-4e1d-b1e4-4e0aaa07d94c`, 100%, with the real doorbell and only
`D1_MV` bound:

| Case | Public result and recovery |
| --- | --- |
| Existing `reservation:g65-reservation-bed4c234-69b-1` | HTTP 200 `committed`, `not-admitted`, event `01a073a0-8439-73c4-9d83-aebf8c2b6bd2`; after restore one receipt, obligation 2 |
| New `room:g65-w138-unconfigured-w138-2-new-c0u2` | HTTP 200 `committed`, no typed refusal, event `01a073a0-8faa-7964-a486-951f8930bf3e`; after restore one receipt, obligation 1 |

The bound-MV variant was version `51dfe001-d60e-4dde-bb1a-4f13564c35eb`,
deployment `111b8a59-f88e-490b-99b8-dac3391a6174`, with both D1 names bound to
the existing MV ID and the real doorbell. Existing reservation 2 returned
HTTP 200/not-admitted, event `01a073a1-c839-7671-b55d-afa697ca0c46`; its new
room returned HTTP 200, event `01a073a1-d202-7868-8089-08cc8d5ee356`. The
recovery query found exactly one global receipt for each of these four events.

The MV lacks the authoritative G44 completeness schema, so this is explicitly
unconfigured at runtime. The configured-store HTTP 503
`partition_registration_unavailable` with zero event writes remains
**unproven**, not passed or manufactured.

## Receipts

The raw JSON files are ignored and retained. Gzip SHA-256 values:

| Receipt | SHA-256 |
| --- | --- |
| `sdt-g65-w138-2-pre-change-cohort.json.gz` | `d780cca4020e724fce9b0554ab37d7bb23b9bb2425686d22abd56eeced5e0c91` |
| `sdt-g65-w138-2-post-change-cohort.json.gz` | `fae3a4bfd088aeb749a7a909b7bcd7801b7657b2b3e6a628389ef16c35956326` |
| `sdt-g65-w138-2-pre-change-ledger.json.gz` | `9ad61ab9271e00b53f796d708ac10d179a5fd58db64c6f533321ccc136383520` |
| `sdt-g65-w138-2-post-change-ledger.json.gz` | `507392e19220772f6a5deed0807c1ec479127b8dfbaedde492ed89d7885aa99e` |
| `sdt-g65-w138-2-c0-unconfigured-public.json.gz` | `86ae2e154a23354ff48419026e9ba1e007c16a085e71555d08412c0d070e7581` |
| `sdt-g65-w138-2-c0-configured-failure-public.json.gz` | `41088396b2131f1a9c7dcdc0bcbee4f2f1f5df5eada79d7137e118b4e58825c6` |
| `sdt-g65-w138-2-c0-recovery-ledger.json.gz` | `b6a3bae4eb0f91b9b1ebf7e121161a32a0b53b80fd5c0656db5d794928de26d2` |
| `sdt-g65-w138-2-analysis.json.gz` | `3deff5636d3f444f4b3aab1b68641603f65347fc10d9ba8376f60d68cdebea6c` |

Lossless verification:

```sh
gzip -dc .artifacts/sdt-g65-w138-2-post-change-cohort.json.gz > /tmp/sdt-g65-w138-2-post-change-cohort.json
cmp -s /tmp/sdt-g65-w138-2-post-change-cohort.json .artifacts/sdt-g65-w138-2-post-change-cohort.json
```

The complete deployment/version/reset/C-0/cohort/ledger receipts and compact
analysis are the corresponding `.artifacts/sdt-g65-w138-2-*` files.

## W139 RING/APPLY deployed continuation — blocked

This section records the one W139 evidence window. It does not replace the
earlier W138 receipts and does not claim AC0 or AC5 completion.

### Exact primary-worker identity

The exact candidate source was `075ea6c955302e034ef18eeb97c1b0493f838e61`.
The candidate deployment was version
`b7a28e51-684d-4f9d-877e-f75e2fb92ba3`, deployment
`e5aa831d-d331-4bd4-bfea-c025264b4b0a`, at 100%, annotated
`SDT-G65 W139 exact 075ea6c955302e034ef18eeb97c1b0493f838e61 RING APPLY`.
The deployed version view showed `DIRECT_DOORBELL=true` and a
`DOWNSTREAM_DOORBELL` service binding to
`sekiban-dcb-meeting-room-doorbell`, entrypoint
`MeetingRoomDownstreamDoorbell`, alongside the W155-C pipeline and MV D1
bindings. The W155-C Queue consumer was attached to
`sekiban-dcb-g60-w155-c`, with DLQ
`sekiban-dcb-g60-w155-c-outbox-dlq`, batch size 10, max wait 1000 ms, and
three retries. No resource was created or deleted. The existing `0010` schema
migration was applied once to the existing W155-C pipeline D1 before the
candidate deploy.

The conformance route initially rejected the prior path-only token. A fresh
path-only token was installed during this window before the later instruction
to avoid further credential mutation; its value was never printed, logged, or
committed. The resulting secret-only version was
`db692603-988a-4904-bfd9-baa04d2a6540`; the exact candidate version above was
then deployed and reverified. No credential value is included in this report.

### Receiver identity finding and stop rule

The read-only receiver inspection proves that the bound receiver is stale for
this candidate measurement. The latest active deployment of
`sekiban-dcb-meeting-room-doorbell` was version
`c82e5be1-25b6-4d46-92fa-bf94401059e3`, with the older G30/G32 annotation and
D1 bindings `eccf6048-7fc8-4412-a157-9fa180353f6d` and
`c733dfb2-013a-4a5d-a72c-47931a63bac4`, not the W155-C pipeline/MV pair
`ac751211-fde8-4587-9d56-1e9fd8051bc3` /
`2b60dbcf-0912-4bb2-93aa-77c26cd260e1`.

The repository has an old-G32 receiver config
`samples/meeting-room/wrangler.g32-final-receiver.jsonc` and separate
production receiver configs
`wrangler.meeting-room-doorbell-production.jsonc`,
`wrangler.meeting-room-doorbell.jsonc`, and
`wrangler.cloudflare-only-doorbell.jsonc`. They point to different historical
resource pairs. There is no existing W155-C-specific receiver config that
unambiguously identifies the intended receiver resources and bindings.
Consequently the authorized receiver redeploy cannot be resolved without
guessing. It was not attempted, and no new resource or alternate binding was
used. This is the precise blocker for treating the post cohort as a valid
RING/APPLY candidate cohort.

### Cohorts

The first pre-change attempt is preserved as a failed partial receipt: five
reservations completed and sample 6 returned HTTP 504 `unknown_outcome`; it is
not counted as a cohort. After the path-only conformance correction, one fresh,
non-stitched replacement pre-change cohort completed on the old source
version `db692603-988a-4904-bfd9-baa04d2a6540` (the secret-only version of
source `5edfd6413b1ff446e6f7475eef18c947b0ca93fe`).

| Cohort | n | response p50/p95 | unsafe p50/p95 | unsafe >5000 ms | safe p50/p95 | safe >180 s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| replacement pre-change | 10 | 3154 / 3602 ms | 4547 / 19307 ms | 1/10 | 110375 / 175945 ms | 0/10 |
| exact candidate post | 10 | 2786 / 3633 ms | 4521 / 124148 ms | 3/10 | 152367 / 218138 ms | 4/10 |

The post cohort was cold-first and paced, and all ten commits returned
successfully with no 504. All global-admission headers were `unknown`. The
complete per-sample post table is:

| # | response ms | unsafe ms | safe ms | safe result |
| ---: | ---: | ---: | ---: | --- |
| 1 | 2871 | 124148 | 218138 | over 180 s |
| 2 | 3241 | 111145 | 204895 | over 180 s |
| 3 | 2399 | 4485 | 192495 | over 180 s |
| 4 | 2326 | 4446 | 180034 | over 180 s |
| 5 | 3585 | 72438 | 165770 | within |
| 6 | 3400 | 4521 | 152367 | within |
| 7 | 3633 | 4577 | 138732 | within |
| 8 | 2469 | 4462 | 125627 | within |
| 9 | 2786 | 4486 | 112522 | within |
| 10 | 2656 | 4666 | 99761 | within |

Both deployed projectors eventually reached the post cohort final SUID, and
all ten cohort tag-state reads returned committed version 1. Samples 1–4 were
observed beyond 180 seconds; this is a published AC5 measurement, not an AC5
pass/fail result or a G65 blocker.

### Durable RING/APPLY result

The raw post query contains counts `admission_attempts=20`,
`hop_measurements=122`, `hop_submeasurements=218`, and
`unsafe_writer_boundaries=44`, but **zero** rows in
`serialized_dcb_g65_direct_rings`. Every post unsafe-writer row was
`transport=queue`, `writer_path=inline-delivery`; there was no observed direct
RING or direct APPLY. The Queue consumer therefore remains the only observed
writer path in this receipt. Its later idempotent no-change rows do not prove
the candidate's direct receiver idempotence.

The admission rows were all `outcome=unknown`, each 300 ms, with no observed
global completion timestamp. The post boundary counts were: completeness
21 start/end pairs, global receipt readback 21, source acknowledgement 21,
detector 4, and unsafe-view apply 21 starts with 11 `applied` and 10
`duplicate-race` ends. These are durable Queue-path observations, not
RING/APPLY observations.

The response p95 change was `3633 - 3602 = +31 ms`, and the p50 change was
`2786 - 3154 = -368 ms`; those response comparisons alone satisfy the
same-window response deltas. AC0 remains unproven because the real direct ring
was never observed and unsafe visibility exceeded 5000 ms in 3/10; the post
unsafe p50 was 4521 ms rather than the 189 ms reference measurement. The 4/10
observations beyond 180 seconds are reported for AC5 and are not an AC5
failure criterion. No configured-store outage was attempted; the local
typed-refusal proof remains the only AC1 evidence.

### Raw receipts and boundaries

The ignored raw receipts remain lossless and are not staged:

| Receipt | SHA-256 |
| --- | --- |
| `.artifacts/sdt-g65-w139-pre-change-replacement.json` | `ddc0a8103fad9ceca4646894c4241abaa6fe009eb72648dd03f9d77eb291d39e` |
| `.artifacts/sdt-g65-w139-post-change-cohort.json` | `af2ee13069a17e695bdff5eae8a729985ddb2643fa41a13d942f0b1a8d30c15c` |
| `.artifacts/sdt-g65-w139-post-ledgers.raw` | `a232ba05aec6e2ca7b4a2f26b084a43edd4bd7c7125fc8fd3ae5e446f6ff3b35` |
| `.artifacts/sdt-g65-w139-receiver-deployments.raw` | `0221e8669f9a349fe91c328c77f2b2c36b3860a2427fb40543fb0aafeb3df3b6` |
| `.artifacts/sdt-g65-w139-receiver-version-view.raw` | `07e7baf3884ae70df0933e65828e125c306b407bc2b4202bcf1684a8b252d907` |

The failed initial partial receipt, deployment/version/Queue identity
receipts, migration receipt, conformance receipts, and post summary are also
retained under `.artifacts/sdt-g65-w139-*`. The W155-C primary configuration
was left on the exact candidate source; the stale shared receiver was left
untouched. No source, fixture, workflow, gate, PR, or review state was changed
in this evidence-only continuation.

## W140 W155-C self-binding local checkpoint

W140 is the deploy-free, local/self-binding configuration half of the
SDT-G65 continuation. No Wrangler, Cloudflare, deployment, resource, PR, or
review-state operation was performed. The child branch started at
`abecf9df201ce3bd845a11dbad9476b1cf770810`; all unrelated dirty files and
ignored receipts were preserved.

### Exact-head CI classification

The exact-head workflow was
[`34000676089`](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34000676089)
and the `ci-g21-g25` job was
[`101398855200`](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34000676089/job/101398855200).
The G21, G22, G23, G24, and G25 steps passed. The only failed step was the
existing G54 envelope-boundary assertion at
`test/g54-envelope-boundary.spec.ts:136`: it expected duration `PT0S` and
observed `PT0.001S`. This is the known 1 ms wall-clock timing flake and is
unrelated to the W155-C self-binding configuration; no CI gate, timeout, test,
or fixture was changed. The lossless hosted log is
`.artifacts/sdt-g65-w140-ci-g21-g25-job.log` (SHA-256
`5080f88af7db761e8884d8231a1087115dcfe8849f381f15dd2bd21c3433c555`). The
captured workflow-status receipt is
`.artifacts/sdt-g65-w140-ci-run-status.json` (SHA-256
`3c58245775775fadc49a7b1f1f92e9ab6bd1b9e3fa22ce3a17810e817117d17f`).

### Reproducible W155-C self configuration

The tracked local configuration is
`.artifacts/wrangler.g65-w155-c.jsonc`. Its exact self-binding values are:

| Setting | Value |
| --- | --- |
| `name` / `SDT_SERVICE_ID` | `sekiban-dcb-g60-w155-c` |
| `DIRECT_DOORBELL` | `true` |
| `DIRECT_DOORBELL_RECEIVER_MODE` | `self` |
| `DIRECT_DOORBELL_SELF_BINDING_PROOF` | `true` |
| `DIRECT_DOORBELL_DEGRADATION` | `queued-degraded` |
| `DIRECT_DOORBELL_MAX_INVOCATIONS` | `32` |
| `DOWNSTREAM_DOORBELL.service` | `sekiban-dcb-g60-w155-c` |
| `DOWNSTREAM_DOORBELL.entrypoint` | `MeetingRoomDownstreamDoorbell` |
| `D1` pipeline ID | `ac751211-fde8-4587-9d56-1e9fd8051bc3` |
| `D1_MV` ID | `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` |
| outbox Queue | `sekiban-dcb-g60-w155-c-outbox` |
| DLQ | `sekiban-dcb-g60-w155-c-outbox-dlq` |

`scripts/g65-w155-self-config-guard.mjs --self-test` passed the real
configuration and returned `red-as-expected` for the mutant that changed the
mode to `separate` and the service back to the stale shared receiver.
The existing `scripts/g65-admission-guard.mjs` was extended only to make this
exact self-binding/arm-resource shape an enforced expectation. Its omission,
unbounded-doorbell, response-gated-on-D1, reordered-durability,
idempotence-removal, omitted-direct, and awaited-apply mutants remained red;
`npm run test:g65:required` passed.

### Local lane record and exceptions

The full command receipt is `.artifacts/sdt-g65-w140-ci-equivalent.log`
(SHA-256
`243395de52a5c1416475c8548e02157ebfbab6a291baf0453ba8968769cca598`). The
affected G26/G27, G29, G31, G51, G53, G55, G58, G60, G61, G62, G65, G38,
G41--G49, G20, candidate/coverage, store/D1/MV/boundary/consumer/build,
typecheck, lint, diff-check, and forced-red probes completed as recorded.
The following are preserved exceptions, not weakened gates:

| Check | Result and receipt |
| --- | --- |
| `npm test` | 5 unrelated failures: G32 non-UTF8 status, G43 alarm wait, G54 R3 error kind, and repair vertical-slice timeout; 85 files passed and 1 skipped. |
| `npm run test:g32` | Same non-UTF8 400-versus-500 failure in `test/g32-payload-admission.spec.ts:140`. |
| `npm run test:g54` | Same local R3 `invalid_payload_utf8` versus `invalid_payload_json` mismatch; separate from the hosted 1 ms timing flake. |
| G28 package boundary checks | `npm pack` could not write `/Users/tomohisa/.npm/_logs`; source/negative probes passed. |
| `npm run test:g30` | `.artifacts/sdt-g65-w140-g30-core.log` (SHA-256 `da5079e3d71a74b6929dfdedc94f43d3a1440f4de23b16d907fcd6776dc34bef`) advanced through `all-production-config-mutants-red` and then stalled for 60 seconds; only that runner was terminated. G30 is not claimed green, while G30 candidate and G51 passed. |
| local e2e / emulator provisioning | Not run because W140 explicitly forbids Wrangler/Cloudflare/deployment/resource operations; `test:cosmos-wiring` passed. |

No source behavior outside the scoped guard/config, no fixture, workflow,
timeout, receiver, production resource, PR, or review state was changed. The
W141 is the later deployed window and publishes both fresh cold-first paced
W155-C cohorts with this self configuration; W139 separate-receiver receipts
remain failed stop evidence and are not substituted for that measurement.

## W141 exact self-mode RING/APPLY verification

W141 publishes the exact self-mode parent/candidate receipts from the existing
W155-C arm. W136 is historical/superseded evidence and is not substituted for
this current publication.

### Deployed identity

| Role | Source | Deployment | Version | Traffic | Annotation |
| --- | --- | --- | ---: | ---: | --- |
| Parent baseline | `4687efa5c49951d9966a3785be5fd7b2620c6e4f` | `5923305e-2b27-4341-85c2-98c9b92e7009` | `fb05d31e-d027-4d10-b179-383d1c242624` | 100% | `SDT-G65 W141 pre-G65 parent 4687efa5c49951d9966a3785be5fd7b2620c6e4f W155-C self mode after conformance secret` |
| Exact candidate | `5b59e372f70b0682315f2344e5baae30fdde94b8` | `961525ac-ec77-4c6d-a35b-1bec202144b7` | `fdf35a19-4b85-4a97-baa6-2ee019daef4f` | 100% | `SDT-G65 W141 candidate 5b59e372f70b0682315f2344e5baae30fdde94b8 W155-C self mode` |

The candidate version view proved `DIRECT_DOORBELL=true`,
`DIRECT_DOORBELL_RECEIVER_MODE=self`, `DIRECT_DOORBELL_SELF_BINDING_PROOF=true`,
`DIRECT_DOORBELL_DEGRADATION=queued-degraded`,
`DIRECT_DOORBELL_MAX_INVOCATIONS=32`, and
`DOWNSTREAM_DOORBELL=sekiban-dcb-g60-w155-c#MeetingRoomDownstreamDoorbell`.
It also proved pipeline D1 `ac751211-fde8-4587-9d56-1e9fd8051bc3`, MV D1
`2b60dbcf-0912-4bb2-93aa-77c26cd260e1`, and the W155-C Queue binding. The
read-only Queue consumer receipt proves the worker consumer is attached to
`sekiban-dcb-g60-w155-c-outbox` with DLQ
`sekiban-dcb-g60-w155-c-outbox-dlq`, batch size 10, max wait 1000 ms, and three
retries. All Wrangler receipts stripped the five standing credential variable
names; each was `UNSET`, and no `--keep-vars` was used.

### Matched cohorts

Both cohorts were fresh, cold-first, non-stitched, n=10, and paced at least ten
seconds after the preceding commit response. Unsafe visibility was recorded
only; all samples were observed and none exceeded 5,000 ms.

| Cohort | Run ID | Response p50/p95 (ms) | Unsafe p50/p95 (ms) | Unsafe >5000/censored | Safe p50/p95 (ms) | Observed >180s/censored |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Parent baseline | `3f7d7bad-ca9d-468a-812a-ef052f64d0ff` | 4108 / 4677 | 178 / 287 | 0 / 0 | 118035 / 190053 | 1 / 0 |
| Candidate | `ffa53bd9-f4c8-4958-a5c5-5bc5046c5425` | 2671 / 2971 | 2417 / 4551 | 0 / 0 | 129995 / 193834 | 2 / 0 |

The candidate response p95 was 2971 ms versus the parent 4677 ms, and unsafe
p95 was 4551 ms with every sample under 5,000 ms. The parent’s one and the
candidate’s two observations beyond 180 seconds are published measurements;
AC5 requires that safe timing be measured and reported, not that 180 seconds
be treated as a G65 target or blocker. Both cohorts eventually reached their
final projector heads and all 11 tag-state reads returned committed version 1.

### Candidate RING/APPLY and failure attribution

For the ten candidate reservation events, the durable ledger recorded 10/10
rings `rung`, with APPLY `applied=9` and idempotent `duplicate=1`; every
`apply_error` was null. Ring timestamps were 0 ms at millisecond resolution;
APPLY p50/p95 was 1655/2299 ms. Unsafe-writer rows included both fast and Queue
transport, and the Queue replay rows were duplicate/no-change or one applied
row rather than a second logical write. Admission attempts were all
`unknown` at 300 ms, while the independent completeness rows remained
`BLOCK/UNSETTLED`. No `DeliveryCoreResult.failures` ID/class is persisted by
the queried ring schema, so no failure class is invented here.

The parent cohort’s event-identity-scoped ledger contains the seven-hop and
unsafe-writer rows but no matching G65 admission/direct-ring rows; stale rows
for other event IDs were excluded. Parent RING/APPLY is therefore unproven,
not inferred from final MV state. The candidate raw receipts and filtered
ledger are retained at:

- `.artifacts/sdt-g65-wake141-parent-cohort.json`
- `.artifacts/sdt-g65-wake141-candidate-cohort.json`
- `.artifacts/sdt-g65-wake141-candidate-ledger-filtered.json`
- `.artifacts/sdt-g65-wake141-candidate-mv-ledger-corrected.json`
- `.artifacts/sdt-g65-wake141-analysis-filtered.json`

The W141 exact self-mode receipt is
`sdt-g65-w155-self-ring-apply-verify-wake-141.md`. The local public
configured-store typed-refusal proof and the C-0/unconfigured evidence remain
the applicable AC1 evidence; W141 did not manufacture a configured-store D1
outage.
