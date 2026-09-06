# SDT-G65 RING/APPLY deployed W139

Status: **blocked** (evidence preserved; no PR/review/merge action).

The exact candidate `075ea6c955302e034ef18eeb97c1b0493f838e61` deployed to
existing W155-C as version `b7a28e51-684d-4f9d-877e-f75e2fb92ba3`, deployment
`e5aa831d-d331-4bd4-bfea-c025264b4b0a`, at 100%, with annotation
`SDT-G65 W139 exact 075ea6c955302e034ef18eeb97c1b0493f838e61 RING APPLY`.
The version view proved `DIRECT_DOORBELL=true`, a real
`DOWNSTREAM_DOORBELL` service binding to `sekiban-dcb-meeting-room-doorbell`
(`MeetingRoomDownstreamDoorbell`), the expected W155-C D1 bindings, and the
W155-C Queue consumer/DLQ. Existing migration `0010_g65_direct_rings.sql` was
applied once; no resource was created or deleted.

The first pre-change attempt is preserved as a failed partial receipt (five
rows, then HTTP 504 `unknown_outcome`). A fresh replacement baseline and the
candidate post cohort were both cold-first, paced, non-stitched n=10 runs:

| Cohort | Response p50/p95 | Unsafe p50/p95 | >5000 ms | Safe p50/p95 | >180 s |
| --- | ---: | ---: | ---: | ---: | ---: |
| replacement baseline | 3154 / 3602 ms | 4547 / 19307 ms | 1/10 | 110375 / 175945 ms | 0/10 |
| candidate post | 2786 / 3633 ms | 4521 / 124148 ms | 3/10 | 152367 / 218138 ms | 4/10 |

Post rows, in order, were response/unsafe/safe milliseconds:

```text
2871/124148/218138, 3241/111145/204895, 2399/4485/192495,
2326/4446/180034, 3585/72438/165770, 3400/4521/152367,
3633/4577/138732, 2469/4462/125627, 2786/4486/112522,
2656/4666/99761
```

The post cohort is failed AC0/AC5 evidence: all admission headers were
`unknown`, 3/10 unsafe observations exceeded 5000 ms, and 4/10 safe samples
missed 180 seconds. Both projectors eventually reached the final SUID and all
ten cohort tag reads returned committed version 1, but that does not satisfy
the bound.

The durable ledger query found zero rows in
`serialized_dcb_g65_direct_rings`; all 20 admission rows were
`unknown`/300 ms, and all unsafe-writer rows were `transport=queue`,
`writer_path=inline-delivery`. Thus this is not a valid RING/APPLY candidate
cohort. Queue-path duplicate/no-change rows cannot prove direct receiver
idempotence.

The read-only receiver identity check explains why. The active separately
deployed receiver was old G30/G32 version
`c82e5be1-25b6-4d46-92fa-bf94401059e3`, with old D1 IDs
`eccf6048-7fc8-4412-a157-9fa180353f6d` and
`c733dfb2-013a-4a5d-a72c-47931a63bac4`, not the W155-C D1 pair
`ac751211-fde8-4587-9d56-1e9fd8051bc3` /
`2b60dbcf-0912-4bb2-93aa-77c26cd260e1`. Existing repository receiver configs
are either the old G32 pair or production pair; no W155-C-specific receiver
config exists. The requested receiver deployment is therefore ambiguous and
was not attempted. This is the exact blocker; no guess or alternate resource
was used.

The configured-store outage smoke/typed-refusal proof was not attempted in
this window. The local AC1 proof remains unchanged. The path-only conformance
token was refreshed once after the old path returned application-level
unauthorized; no token value was printed, logged, or committed.

Raw receipts are preserved under `.artifacts/sdt-g65-w139-*`, including:

```text
pre replacement JSON  ddc0a8103fad9ceca4646894c4241abaa6fe009eb72648dd03f9d77eb291d39e
post cohort JSON      af2ee13069a17e695bdff5eae8a729985ddb2643fa41a13d942f0b1a8d30c15c
post ledger raw       a232ba05aec6e2ca7b4a2f26b084a43edd4bd7c7125fc8fd3ae5e446f6ff3b35
receiver deployments  0221e8669f9a349fe91c328c77f2b2c36b3860a2427fb40543fb0aafeb3df3b6
receiver version      07e7baf3884ae70df0933e65828e125c306b407bc2b4202bcf1684a8b252d907
```

No local source or test changes were made. The next continuation must resolve
the receiver identity from an existing configuration before any redeploy or
replacement cohort.
