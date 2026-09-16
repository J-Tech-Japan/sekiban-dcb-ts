# SDT-G95 — fail-closed on signalled npm dry-run with collision text

Issue: [#194](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/194)
Branch: `claude/sdt-g95-signal-collision-fail-closed-w901`

## Baseline and scope

- **Pre-change baseline (main):** `6fbe048` (includes SDT-G93)
- **G92 review finding:** independent review noted that G90/G92 PASS branches keyed only on `failure.kind === "version-collision"`, so a signal-killed npm whose stderr already held the collision line would still exit 0 — violating G90/G92 AC2 (signals must stay fail-closed).
- **This slice:** require `result.signal == null` in addition to version-collision kind for PASS / `version-already-published` in both domain and matched-set dry-run scripts. Classifier unchanged.

## AC1 — signal blocks PASS

When `result.signal` is non-null, dry-run evaluation returns FAIL even if classifier kind is `version-collision`.

Fixture: `{ status: 1, signal: "SIGTERM", stderr: "<collision line>" }` → exit nonzero, `status: FAIL`.

## AC2 — collision-without-signal still PASS

Version-collision with `signal: null` and nonzero status still PASSes as `version-already-published` (G90/G92 preserved).

## AC3 — local self-test fixtures

`node scripts/dcb-domain-publish-dry-run.mjs --self-test`:

```json
{
  "status": "PASS",
  "guard": "dcb-domain-publish-dry-run",
  "fixtures": {
    "versionCollision": { "result": "pass", "outcome": "version-already-published" },
    "signalCollision": { "result": "fail", "kind": "version-collision", "signal": "SIGTERM" },
    "invalidPackaging": { "result": "fail", "kind": "invalid-packaging" },
    "genericFailure": { "result": "fail", "kind": "publish-or-environment-failure" }
  }
}
```

`node scripts/dcb-matched-set-publish-dry-run.mjs --self-test`:

```json
{
  "status": "PASS",
  "guard": "dcb-matched-set-publish-dry-run",
  "fixtures": {
    "versionCollision": { "result": "pass", "outcome": "version-already-published" },
    "signalCollision": { "result": "fail", "kind": "version-collision", "signal": "SIGTERM" },
    "invalidPackaging": { "result": "fail", "kind": "invalid-packaging" },
    "genericFailure": { "result": "fail", "kind": "publish-or-environment-failure" }
  }
}
```

Classifier red mutant (`broken-manifest-as-version-collision`) remains correct via `npm-publish-dry-run-classifier.mjs --self-test`.

## AC4 — both scripts share the gate

- `scripts/dcb-domain-publish-dry-run.mjs` → `evaluateFailedDryRun`
- `scripts/dcb-matched-set-publish-dry-run.mjs` → `evaluateMatchedSetDryRunFailure`

Both gate: `failure.kind === "version-collision" && result.signal == null`.

## AC5 — scope fence

No classifier, workflow, Action, version, tag, publish, or auth changes.
