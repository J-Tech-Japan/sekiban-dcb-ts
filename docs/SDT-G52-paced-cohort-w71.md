# SDT-G52 paced-cohort checkpoint (W71)

The sole paced fallback cohort was sent to the already deployed snapshot-sink Worker (`38921aad-9faf-4ac5-bdfd-1348d7214422`, source `6db728122fefc410e7d9639d62302bb107df13be`). It contains one discarded accepted warm-up and 50 accepted `POST /api/commands/create-room` samples. The persisted ledger proves a 10,001 ms minimum completed-to-next-start gap; no replacement request or third cohort was sent.

Both the start-paced command's immediate exact-ray observation and the single W71 explicit resume returned `g30-trace-export:api:Cloudflare telemetry query failed: HTTP 400`. Consequently this is a checkpoint, not AC4/AC5 evidence: retained roots and first-seen lags are unavailable rather than inferred as zero. The immutable 51-ray ledger and the sanitized first-resume result are committed in `.artifacts/sdt-g52-w69-paced-resume.json` and `.artifacts/sdt-g52-w71-paced-first-resume.json`.

Do not open a PR from this checkpoint. If design schedules later resume wakes, each must invoke only `--mode resume` against that saved state and may not send app traffic. Suggested checkpoints are approximately 2026-09-02T11:57:41Z, 2026-09-02T13:57:41Z, and 2026-09-02T16:57:41Z; do not query after the authoritative W71 bound of 2026-09-03T10:19:00Z.
