# SDT-G53 conformance-auth resume — W90

Status: completed pending PR publication.

Starting checkpoint: `dc4a270cae7ed2d36b00ae7e9f236ed8821b05fa` on
`claude/sdt-g53-scope-identity-w87`.

## Outcome

- The metadata-only secret list confirmed that `CONFORMANCE_TOKEN` exists;
  no value was read. Its protected file reference was nonempty, so no secret
  was generated or rotated in W90.
- Active deployment check: secret-only version
  `0c3818e7-8d6c-47f8-8a03-bb66d25391ec` at 100%, following the deployed
  downstream-repair code version
  `6b24a78a-c09b-48bd-bf26-751b22a63384` for commit
  `002e33ef1fbc071632f5ba3118f1018aae7a2652`.
- `2f9a419` adds safe persistence for a non-passing conformance response.
  `node scripts/deploy/g53-scope-mismatch-e2e.mjs --self-test` and
  `npm run test:g53` passed.
- The one authorized fresh authenticated probe returned HTTP 403
  `scope.mismatch` in 956.122 ms. Its safe raw receipt is
  `.artifacts/sdt-g53-w90-scope-mismatch.json`.
- One conservative post-secret G15 run passed with fresh IDs; its raw receipt
  is `.artifacts/sdt-g53-w90-post-secret-g15.json`.

No deployment, configuration change, token value, or token-file path is part
of this artifact. The full command/timestamp ledger and preserved W89 G15/G16
and downstream-lineage evidence are in `docs/SDT-G53-evidence.md`.
