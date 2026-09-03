# SDT-G58 conformance resume — W108

Status: **blocked** at post-secret deployment identity verification.

This continuation began at exact pushed head
`617da2cfebfcf39985b0d6996f2e22b0defa8efc` on
`claude/sdt-g58-safe-lane-w93`; the required product head is
`700c0cb4bf7c896a8b676d4613bfae53fca58519`.

## Initial authentication classification

Before any credential or product change, exactly one protected
`GET /conformance/v1/read-health` request was made using the existing G53
token-file path. It returned HTTP 403 in 292 ms with the safe response body:

```json
{"code":"unauthorized","error":"Conformance authentication required"}
```

This is classified as `unauthorized` (bearer mismatch or unavailable
`CONFORMANCE_TOKEN`), not `scope.mismatch`. The redacted receipt is
`.artifacts/sdt-g58-w108-auth-classification.json`; no credential value is in
that artifact.

## One authorized Wrangler credential window

The repository-pinned Wrangler is `4.125.0`. The metadata-only secret list
confirmed `CONFORMANCE_TOKEN` by name, and the one OAuth `whoami` check
succeeded at `2026-09-03T11:40:07Z`–`11:40:10Z`; API-token fallback variables
were unset. The Wrangler credential mtime remained
`2026-09-03T04:26:29Z`.

Following the G53 procedure after the observed `unauthorized`, one fresh token
was generated directly into the ignored private path
`.artifacts/.sdt-g58-w108-conformance-token` and installed once with pinned
Wrangler `secret put CONFORMANCE_TOKEN`. The token value was never printed,
logged, inspected, copied into an artifact, or committed. No Observability
token was read or used.

## Required exact-head identity check

Secret installation created a new active Worker version, so the prescribed
readback was run before any further proof request. It found:

- previous W107 code version `9e5586ad-0cb1-4d00-9c05-89306e04520f` (192),
  annotated for source `700c0cb4`;
- active version `1cb7a506-f9ea-4c55-8e25-a6c7c2eaa3b8` (193), deployment
  `4e57f59c-3dec-4b9b-9d32-00a137fa5b28`, at 100%;
- active annotations contain only `workers/triggered_by=secret` and no source
  annotation.

The raw identity receipt is
`.artifacts/sdt-g58-w108-post-secret-identity.json`. Because the active
version does not carry the required source annotation equal to full product
head `700c0cb4bf7c896a8b676d4613bfae53fca58519`, this continuation cannot
reuse version 192 or treat version 193 as exact-head proof. No second
authenticated request, redeploy, cohort, G15/G16 run, PR, or worker
completion was attempted.

The W107 local G58/G44/typecheck/lint results remain preserved; no product
code or SafeWindow/unsafe/fence/order semantics changed in W108. This is a
durable blocked checkpoint awaiting an authorized exact-source deployment
identity path.
