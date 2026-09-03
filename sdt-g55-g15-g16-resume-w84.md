# SDT-G55 G15/G16 resume — W84

Issue: [#106](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/106)
Status: **blocked** — G15 passed after the one authorized warm-up, but the one
unmodified G16 run reset its reservation-list connection and was not retried.

## Continuity and no-deploy boundary

- Branch checkpoint: `5ad7159dd64fc1c1a42a05fbe3f5ec5b9f7dc885`.
- Deployment remains version `22b5ba16-b8aa-4927-a5f1-eeaa1769a48b`, the
  authorized `bb7afec95dbe2c3749f25216885a962bc6cfa20c` packaging-gate build.
- No Wrangler command, deployment, replacement G55 cohort, or safe-lane
  convergence change was made in this wake.

## Separate warm-up and G15 retry

The sole warm-up was a `GET /` with a 30-second bound, recorded separately in
`.artifacts/sdt-g55-w84-warmup.json`. It returned HTTP 200 in 130.870 ms at
`2026-09-03T01:53:53Z`; it is not a G15 command.

The unmodified G15 harness then passed once. Its report,
`.artifacts/sdt-g55-w84-g15.json`, records run
`117001331abf4a62b1839fa95a783a67`, raw serialized endpoints all rejected with
HTTP 404, valid create/reserve/cancel commands with HTTP 200, invalid command
rejection with HTTP 400, and the unchanged 120,000-ms safe-window oracle.

The honest W83 G15 root-read timeout remains preserved in
`.artifacts/sdt-g55-w83-g15-failure.json`; W84 is the single explicitly
authorized transient-cold-start retry, not a hidden loop.

## G16 stop

The one unmodified G16 harness run failed after 79,252 ms in its reservation
list visibility poll, at `GET /api/read/reservations?pageNumber=1&pageSize=20`:
`ConnectionResetError: [Errno 54] Connection reset by peer`. It wrote no G16
report. The exact invocation and result are preserved in
`.artifacts/sdt-g55-w84-g16-failure.json`.

No retry followed. A passing G16 gate is therefore unavailable, so this wake
does not open a PR or invoke `worker complete --outcome pr-created`.

## Preserved AC3/AC5 evidence

The W81/W83 cohort remains the sole G55 cohort: its original D1 before state
was 133 unsafe receipts / 0 unsafe rows; its unsafe visibility was 4,407 /
3,003 / 2,512 ms; and its safe timings were 38,356 / 268,852 / 1,006,099 ms.
The AC3 code-plus-deployed-D1 determination remains that normal delivery had
scheduled an unsafe-kick drain, which advanced safe follow and garbage-collected
the unsafe rows while receipts remained; the G55 delivery-path change preserves
the rows until the reader can use the explicit unsafe overlay.

The 1,006,099-ms third safe observation is a measured residual for a separate
safe-lane convergence unit. G55 does not tune safe-window, lag-estimate, cron,
or other convergence behavior.
