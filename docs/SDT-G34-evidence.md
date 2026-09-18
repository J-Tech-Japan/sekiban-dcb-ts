# SDT-G34 evidence — Unit A provider composition

Status: offline manifest, generated accessors, and dual-run bridge for the G32 cutover profile. Deploy cutover stays with `scripts/g32-cutover-check.mjs`. Shard rotation is not implemented.

## Cardinality

| owner | kind | count |
| --- | --- | --- |
| primary | producer-binding, consumer-attachment, dlq-target, service-binding, target-entrypoint | 1 each |
| receiver | those queue and service-binding kinds | 0. A `queues` key fails |
| profile | pipeline D1 | 1 shared resource |
| profile | MV D1 | 1 different resource |
| each component | Durable Object | own worker when `script_name` is omitted. Class-name equality is not same-resource |

## Out of scope

Unit B deploy-gate switch, thin-wrapper replacement of the G32 checker, a second pipeline shard, the seal ledger, and the ordered shard-sequence digest.

## Command

```
npm run test:g34
```

Paste from 2026-09-18, after the implementation-review fixes:

```
{"result":"g34-provider-composition-self-test-passed","digest":"b1779add2dddf3a5e30a3c4e8f1368414afa2f061db158d1a93e06d9e1d174ab","mutations":["legacy-fail-new-pass:legacy-fail-new-pass","new-fail-legacy-pass:new-fail-legacy-pass","missing-row:missing-row","duplicate-row:duplicate-row","second-producer:cardinality","receiver-queues:queues-forbidden","second-shard:second-shard","second-manifest:second-manifest","json-only:generated-drift","generated-only:generated-drift","accessor-only:generated-drift","migration-swap:migration-swap","migration-order:migration-order","do-owner:do-migration-owner","kept-var:unresolved-kept-var","deep-merge:deep-merge-forbidden","no-tenant:scope-proof-unavailable","missing-map:scope-proof-unavailable","inflated-cardinality:cardinality","identity-stale:resource-identity-mismatch","dropped-component:cardinality"]}
```

The same command also runs `scripts/g32-cutover-check.mjs` and requires it to exit 0. The published manifest digest does not contain the pipeline `database_id`.
