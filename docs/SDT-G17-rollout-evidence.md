# SDT-G17 staged rollout evidence

The rollout is intentionally ordered by `scripts/g17-staged-rollout.sh`:

1. `dry-run` records the exact service target and duplicate pairs.
2. `cleanup` is refused unless the recorded dry-run exists and
   `G17_CLEANUP_CONFIRM=YES`; it quarantines only the recorded target rows.
3. `constraint` is refused until cleanup is recorded and all remaining
   duplicate pairs are zero, then deploys the PostgreSQL unique index.
4. `resume` records a fresh service id for post-remediation traffic.

## Shared Hyperdrive-backed store run (2026-08-19)

The AC#8 run was repeated against the deployed Worker's prepared Hyperdrive
binding (`c236b7b51ed24bf4b312bc370c61a231`), whose caching setting was
verified as disabled. The protected PostgreSQL connection was never exported
to this checkout or written to an artifact: a short-lived remote-binding probe
invoked the same staged script with a `psql` transport, so only query counts
and phase outcomes crossed the local boundary.

Deployment facts for this run:

- Worker: `https://serialized-dcb-v1-runtime.ttakaoka.workers.dev`
- rollout deployment: `dc7ee4cd-39f2-426f-9ba0-baf134289d76`
- final verification deployment: `82e3e846-32cf-4ab8-8b47-4c5e6d259279`
- target service id: `serialized-dcb-v1`
- fresh resume service id: `g17-shared-fresh-20260819`

The four phases ran in the required order on the shared store. The read-only
dry-run observed `duplicatePairs=26` and `duplicateRowsToQuarantine=26` for
the exact target. Cleanup completed with `remainingDuplicatePairs=0`, the
unique index preflight/deployment completed with
`allRemainingDuplicatePairs=0`, and resume completed with the fresh service id
above. A direct post-run query returned `0` remaining duplicate pairs. The
final state file is preserved at
`.artifacts/g17-shared-deployed/rollout-state.json`.

The deployment cutover was recorded in
`.artifacts/g17-shared-deployed/deployments.txt`: the new version above is the
workers.dev deployment used for the probes, while the prior deployment is not
addressable through the public worker URL after cutover. This is the
reachability evidence available without exposing a Durable Object namespace or
credential; no old namespace is reused by the fresh service id.

The deployed negative oracles used fresh service-scoped data and the same
Hyperdrive-backed store:

- `g17-negative-collision-final-20260819`: two tag outboxes carried different
  EventIds with the same SUID; the store retained one event and recorded
  exactly one `SUID_COLLISION` incident.
- `g17-negative-lineage-final-20260819`: after the first delivery established the
  binding, a controlled wrong-lineage binding probe preceded a second delivery;
  the store recorded exactly one `LINEAGE_MISMATCH` incident before the binding
  was restored to its original value.

The complete probe outputs are retained under
`.artifacts/g17-shared-deployed/`. No passwords, connection strings, bearer
tokens, or other secret values are present in the evidence.

The pinned G11 HTTP conformance script was also attempted against the rollout
deployment and stopped honestly at its `single-tag-read` check (HTTP 200 with
`exists=false` before asynchronous delivery became visible). It is not claimed
as a passing conformance run; the AC#8 rollout and final-version
negative-oracle results above are the only deployed claims made by this repair.

The following run used the existing local PostgreSQL test container. The
connection string was supplied through the process environment and was not
printed or written here.

```text
phase=dry-run targetServiceId=serialized-dcb-v1 duplicatePairs=10 duplicateRowsToQuarantine=14
duplicateTargets:
suid-00000000000000000000000000000001  6
suid-00000000000000000000000000000002  2
suid-00000000000000000000000000000003  2
suid-00000000000000000000000000000004  2
suid-00000000000000000000000000000005  2
suid-00000000000000000000000000000006  2
suid-00000000000000000000000000000007  2
suid-00000000000000000000000000000008  2
suid-00000000000000000000000000000009  2
suid-00000000000000000000000000000010  2
BEGIN
DELETE 14
COMMIT
phase=cleanup targetServiceId=serialized-dcb-v1 remainingDuplicatePairs=0
phase=constraint targetServiceId=serialized-dcb-v1 allRemainingDuplicatePairs=0 uniqueIndex=deployed
phase=resume freshServiceId=g17-fresh-local-20260819 duplicatePairs=0
```

The old allocator DO lineage is not inferred from PostgreSQL rows. Its
unreachability is demonstrated by the fresh-service resume plus the PG and
Cosmos negative lineage-oracles in `test/g17-lineage.spec.ts`; no secret or
allocator credential is part of this evidence.

Operational invariant: a `serviceId` is permanently bound to one allocator
lineage. Recreating the allocator namespace against a retained store therefore
requires a new service id or this exact cleanup/constraint/resume procedure;
the runtime never silently rebinds an existing service to a new lineage.
