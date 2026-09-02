# SDT-G52 interim evidence W72 — blocked checkpoint

The branch began at the required remote head `3f9952386306e1e07d9fd2ffd3a05a011d118912`. W72 repaired the resume query shape from the rejected multi-step exact-ray route to the persisted-window, standard script/type-filter route with client-side intersection against the saved 51 CF-Rays. Focused tests and `npm run test:g52` passed.

W72 then ran `--mode resume` exactly once against `.artifacts/sdt-g52-w69-paced-resume.json`. It issued no application request and did not deploy. The HTTP 400 did not recur. Instead, the returned snapshot failed the exporter integrity gate with:

```
g30-trace-export:snapshot-log:snapshot S00 does not agree with its top-level identity
```

The state records this as resume attempt 2 with query scope `persisted-cohort-window-standard-script-type-filters-client-side-exact-ray-intersection`; no retry was made. Because the response was rejected before a valid normalized trace/observation bundle existed, W72 cannot honestly publish snapshot per-hop medians, whole-cohort `do.handler` medians, or a residual ranking. The client-only W71 S00 evidence remains p50 1,308 ms, p95 2,113 ms, n=50, LAX=50.

R-3 is recorded from the authoritative third AC4 amendment: burst retention 2/51 with 870 retained spans; paced retention 1/51 with 451 retained spans. The amendment's observed behaviour makes the 40-root threshold unreachable and supports the hypothesis that Worker fetch invocations with long `ctx.waitUntil` autoDrain work are dropped while Durable Object invocations are retained.

No PR was opened and no worker completion was run: the requested interim AC4/AC5 evidence remains blocked on the newly observed snapshot identity mismatch. The corrected tooling, resume state, sanitized failure artifact, and blocked evidence are committed as the durable hand-off.
