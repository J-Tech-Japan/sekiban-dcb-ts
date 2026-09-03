# SDT-G55 G16 pagination repair — W85

Issue: [#106](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/106)

## Bounded repair

The deployed list was not reset or redeployed. `MaterializedViewStore` orders
the list by `row_key COLLATE BINARY`; with 22 rows, the unmodified G16 oracle
only read `pageNumber=1&pageSize=20` and could not see the two newest rows on
page 2. W85 pages through all pages derived from page 1's `totalCount`.

The first page's `readHead` remains the captured list head, the item-presence
oracle remains unchanged, and the published 120,000-ms safe-window bound is
unchanged. The focused self-test uses the exact 20+2 shape and requires a
target that exists only on page 2.

## Deployed G16 evidence

One repaired G16 run, `ebf08be0261c4682a2d761b2d1ef876f`, passed against
existing version `22b5ba16-b8aa-4927-a5f1-eeaa1769a48b`; no Wrangler command
or deployment occurred.

- First list poll: page 1 had 20 items; page 2 had 2; page 1 reported
  `totalCount: 22` and populated `readHead`
  `063923995692002000000693137501`.
- Second list poll found the fresh reservation on page 2 in 3,333.082 ms.
  It recorded page 1 = 20 and page 2 = 3 after a concurrent row arrival;
  each page response is retained separately in the raw evidence.
- Create/reserve/cancel returned HTTP 200; raw V1 endpoints returned HTTP 404;
  invalid command input returned typed HTTP 400; the 120,000-ms visibility
  oracle remained green.

Raw receipt: `.artifacts/sdt-g55-w85-g16.json`.

## Preserved G55 evidence

The W84 warm-up remains separately recorded (HTTP 200 in 130.870 ms) and its
G15 run passed. The earlier W84 `ECONNRESET` is retained as a poll interruption,
not hidden or retried.

The sole W81/W83 G55 cohort retains unsafe visibility of 4,407 / 3,003 / 2,512
ms and safe timings of 38,356 / 268,852 / 1,006,099 ms. Its before D1 state was
133 unsafe receipts / 0 unsafe rows. AC3 remains: normal delivery scheduled a
safe-follow drain that garbage-collected unsafe rows while receipts remained;
the G55 delivery-path change retains them for the explicit unsafe reader.

The 1,006,099-ms third timing is a measured residual for a separate safe-lane
convergence unit. W85 does not change lag estimates, safe-window behavior,
cron catch-up, commit semantics, trace schema, G49, G51, G52, or the G54/G56
known-divergence contract.

## Validation

- `python3 scripts/deploy/g15-e2e.py --self-test` — passed.
- `npm run test:g15` — passed (9 tests plus pagination self-test).
- `npm run test:g16` — passed (6 tests and static UI contract).
- `npm run test:g55` — passed (12 tests and mutation guard).
- `npm run lint -- --quiet` — passed.
