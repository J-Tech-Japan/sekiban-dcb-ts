# SDT-G53-DOWNSTREAM-REGRESSION-REPAIR-W89 report

Status: **blocked** at the single authenticated scope-mismatch verifier.

W89 reproduced the downstream break: a new scoped Tag accepted the diagnostic
reservation, registered source-outbox partitions, and reached the Queue
consumer, but global D1 rejected its delivery as `LINEAGE_MISMATCH` against
the pre-G53 allocator binding. The repair adds a canonical Queue-to-global-D1
regression guard plus a one-time C-0/C-13 scoped-state reset procedure.

Commit `002e33ef1fbc071632f5ba3118f1018aae7a2652` deployed as Cloudflare code
version `6b24a78a-c09b-48bd-bf26-751b22a63384`. The reset wrote 358 authorized
registry/health rows, retained audit records, rebound the scoped allocator to
`11a7b3b1-dd35-49dc-b459-c51f9588520d`, and restored `HEALTHY` scanner state.
All six fresh G15/G16 command SUIDs are now present in global D1. G15 and the
one warm-up plus G16 both passed.

The required fresh private conformance secret upload succeeded, creating
secret-only active version `0c3818e7-8d6c-47f8-8a03-bb66d25391ec`. The one
authorized authenticated probe then failed in `verifyScopeMismatch` with:
`Error: G53 mismatch probe did not return typed scope.mismatch`. It was not
retried, and its non-passing body was intentionally not persisted by the
fail-closed harness. Consequently no PR or worker-complete outcome was
created.

Evidence: `docs/SDT-G53-evidence.md`,
`.artifacts/sdt-g53-w89-pre-repair-hop.json`,
`.artifacts/sdt-g53-w89-cutover-reset.json`,
`.artifacts/sdt-g53-w89-g15.json`,
`.artifacts/sdt-g53-w89-warmup.json`,
`.artifacts/sdt-g53-w89-g16.json`, and
`.artifacts/sdt-g53-w89-scope-mismatch-failure.json`.
