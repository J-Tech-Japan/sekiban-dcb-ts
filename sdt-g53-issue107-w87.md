# SDT-G53-ISSUE107-W87 report

Status: **blocked**.

The dedicated branch `claude/sdt-g53-scope-identity-w87` contains the complete
local implementation at deployment source commit
`357153794b830cce45fbcf54f33eb49191976f75`. It deployed once through the
normal config as Cloudflare version `c23306bf-70a5-4d81-a871-3a3b0a6ffe81`.

G15 passed and its raw receipt is preserved. G16 was invoked exactly once but
did not persist a terminal report, so it was not retried. The required deployed
scope-mismatch probe also cannot be run because no authorized conformance-token
file is available; the observability credential was not used as a substitute.
No secret was printed, copied, committed, rotated, or guessed. No PR or worker
completion was created because AC5 is therefore incomplete.

See `docs/SDT-G53-evidence.md` for deployment identity, local guard results,
the G15 timings, and the exact honest-stop conditions.
