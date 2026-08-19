# SDT-G17 staged rollout evidence

The rollout is intentionally ordered by `scripts/g17-staged-rollout.sh`:

1. `dry-run` records the exact service target and duplicate pairs.
2. `cleanup` is refused unless the recorded dry-run exists and
   `G17_CLEANUP_CONFIRM=YES`; it quarantines only the recorded target rows.
3. `constraint` is refused until cleanup is recorded and all remaining
   duplicate pairs are zero, then deploys the PostgreSQL unique index.
4. `resume` records a fresh service id for post-remediation traffic.

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
