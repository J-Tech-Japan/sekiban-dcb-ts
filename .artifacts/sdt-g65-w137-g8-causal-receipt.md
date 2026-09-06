# W137 G8 causal receipt

The local reproduction used a fresh disposable Postgres container on
`127.0.0.1:55432` (`g65-w137-postgres`). Before the reproduction, the
allocator binding was deliberately set to the other fixed fixture lineage:

```text
DELETE FROM serialized_dcb_allocator_bindings WHERE service_id='local-test-runtime';
INSERT INTO serialized_dcb_allocator_bindings (service_id, allocator_lineage_id, bound_at)
VALUES ('local-test-runtime','read-test-lineage',1);
```

The pre-fix G8 command was:

```text
POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:55432/serialized_dcb \
  npm exec -- vitest run --config vitest.config.ts test/projection.spec.ts --reporter=verbose
```

It exited `1` (`7 passed, 1 failed`). The G8 response was:

```text
Expected: behindEvents=1, headSuid=<event SUID>
Received: behindEvents=0, headSuid=""
test/projection.spec.ts:337:35
```

The database contained `local-test-runtime|read-test-lineage`, while the G8
message uses `test-projection-lineage`. `PostgresEventStore.recordDelivery`
therefore returned `lineage-mismatch`, and the delivery adapter acknowledged
the non-stored result without creating `dcb_events`; the lag endpoint then
correctly reported an empty head for that failed fixture.

After isolating the projection fixture to `projection-test-runtime` and
passing that service identity explicitly to the existing lag endpoint, the
same command exited `0` with `8 passed, 0 failed` against the same database.
The G8 expectation was not changed.
