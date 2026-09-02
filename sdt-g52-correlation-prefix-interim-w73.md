# SDT-G52 correlation-prefix interim W73

W73 began from the required clean branch head `ddee7fc15008b44bd97040d4a63b4af8383bfec5`. It made no deployment and no application request.

The exporter now treats `platformRequestId` as the primary client-ledger join. It accepts a retained top-level `correlationId` only when it exactly matches the full S00 row value or is a prefix of at least 32 characters of it; the full S00 value remains the canonical correlation used to join observations. The focused fixture covers the permitted truncated prefix, an absent envelope ray, a nested retained S00 identity representation, and rejection of short or divergent prefixes. Root bounds, service identity, provider-ray agreement, and manifest checks remain strict.

`npm run test:g52` passed: typecheck, 17 focused G52 tests, and both existing omission mutants red in the guard self-test.

W73 then ran `g52-resume-query.mjs --mode resume` exactly once against the persisted paced state. It issued only the two bounded read-only Observability queries over the existing cohort window; it did not deploy or send an app request. The query stopped at:

```
g30-trace-export:snapshot-log:snapshot S00 correlation.id must be a non-empty string
```

The persisted state records attempt 3 as `resume-query-error`, with no retry. Because the provider candidate failed before a validated root/observation bundle could form, the checkpoint does not fabricate per-hop medians, DO medians, or a residual ranking. The only valid timing remains LAX client S00 n=50, p50=1,308 ms, p95=2,113 ms.

The full interim evidence is in `docs/SDT-G52-commit-breakdown.md`; the sanitized raw checkpoint is `.artifacts/sdt-g52-w73-resume-failure.json`. R-3 records burst 2/51, paced 1/51, and waitUntil-free public GET 0/10, supporting the broadened platform finding that public Worker fetch invocations for this script are not retained regardless of waitUntil while scanner invocations are retained.

The local nested/serialized-row representation adapter was added after the single allowed read in response to this exact error and is not claimed as live-validated. A future explicitly authorized same-cohort resume may update the same PR only; no third cohort is permitted.
