# SDT-G33 evidence — live Postgres crossing

Status: a real C# process and the TS provider store cross one CI Postgres, one writer at a time. Cosmos, a live `derive-dcb-tags` apply, a `provenance.origin = g32` stamp, and an operator-authorized membership correction are not done.

## What passed

| check | result |
| --- | --- |
| C# write uses `SortableUniqueId.GenerateNew` | `process-shared` |
| read-back process | different pid from the writer |
| imported rows | 1, DDL fields only |
| allocator probes | `seed-required`, `seed-below-max`, `seed-rejected` |
| next TS row | SUID returned by `AllocatorDurableObject` `/allocate` |
| reverse read | `PostgresEventStore.ReadAllEventsAsync`, not a second row query |
| semantic generation | `post-SDT-G36` |

`seed-required` is `/allocate` with `requiresImportSeed` before any seed. Ordinary `/allocate` does not send that flag and is unchanged. `seed-below-max` is `/seed-after` when `storeMaximum` is the imported row and the watermark is lower. `seed-rejected` is a second seed with a different import id. The C# `Event` type has no timestamp, so the reverse comparison uses the fields `ReadAllEventsAsync` returns.

The lane is `g33` in `ci/lanes.json`. It is local, with the postgres service and the pinned Sekiban checkout. It is not on the cheap lane. `scripts/g32-cutover-check.mjs` stays the deploy authority.

## Command

```
SEKIBAN_SOURCE_DIR=/tmp/sekiban-g33-pin POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:54329/serialized_dcb node scripts/g33-live-cross.mjs --self-test
SEKIBAN_SOURCE_DIR=/tmp/sekiban-g33-pin POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:54329/serialized_dcb node scripts/g33-live-cross.mjs --check
```

Paste from 2026-09-18:

```
{"result":"g33-live-cross-self-test-passed","semanticGeneration":"post-SDT-G36","ddlDigest":"8a123ad4e2fd64a4071088c54352be6e9045f35cac0ca47f38ee820740e0dae0"}
{"result":"g33-live-cross-passed","semanticGeneration":"post-SDT-G36","ddlDigest":"8a123ad4e2fd64a4071088c54352be6e9045f35cac0ca47f38ee820740e0dae0","generator":"process-shared","writePid":29700,"readPid":29779,"imported":1,"probes":["seed-required","seed-below-max","seed-rejected"]}
```

`writePid` and `readPid` differ. The provider read does not add `provenance` or `allocatorLineageId`.
