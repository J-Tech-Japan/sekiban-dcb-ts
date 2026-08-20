# SDT-G21 bootstrap-import core

The bootstrap core is provider-neutral. A provider adapter must first export a
complete `sekiban-dcb-bootstrap` version 1 dump and establish the fresh-target
evidence; those adapter and operator surfaces belong to SDT-G22.

`parseBootstrapDump` is the all-or-nothing preflight boundary. It rejects
unknown or missing fields, bad canonical digest, duplicate EventIds, non-ascending
SUIDs, count/tag-count mismatch, and a high-watermark mismatch before a target
coordinator is contacted.

`BootstrapCoordinatorDurableObject` is named by target service ID. Its durable
control record linearizes normal command admission with `EMPTY -> PLANNED` and
persists the import ID, digest, fencing epoch, lease, manifest, and progress.
The separate Tag DO `/bootstrap/admit` operation never writes an outbox row and
is permanently closed by READY. `AllocatorDurableObject` exposes `seed-after`,
which is idempotent only for the same import and rejects any allocator already
seeded or allocating.

The G21 CI lane is `npm run test:g21`. The deterministic routing proof is
`npm run test:g21:forced-red`; it intentionally exits non-zero only when the
explicit environment flag is set, demonstrating that the new lane reaches the
workflow test source without changing normal CI behavior.
