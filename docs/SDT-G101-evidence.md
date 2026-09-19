# SDT-G101 evidence — seal D1 shards and enforce last(D1-1) < first(D1-2)

Status: the rotation module seals D1-1, keeps an ordered sealed column, routes late arrivals only to a side ledger, and refuses any active D1-2 write that is not strictly after `last(D1-1)`. A witnessed production deploy, O-G41-7 incident lifecycle, ALLOCATOR/BOOTSTRAP removal, Cloudflare placement, and silent ledger merge are not done.

## Command

```
npm run test:g101
```

Paste from 2026-09-19:

```
{"result":"g101-shard-rotation-self-test-passed","lastD1_1":"062135596800001000000000000001","firstD1_2":"062135596800002000000000000001","probes":{"seal-max-missing":"seal-max-missing","active-already-sealed":"active-already-sealed","identity-swap":"identity-swap:d1-1-rewritten","order-green":"last(D1-1)<first(D1-2)","order-red":"order-invariant","order-equal":"order-invariant","sealed-write":"sealed-write","late-ledger":1,"silent-merge-fixture":"silent-merge","silent-merge":"silent-merge","safewindow-seal":"safewindow-seal","unit-a-second-shard":"second-shard"}}
```

Green crossing: `lastD1_1 < firstD1_2`. Red: `order-red` and `order-equal` are `order-invariant` before any D1-2 write. Seal derives max from shard contents (`seal-max-missing` when empty). Unit A still reports `second-shard`.
