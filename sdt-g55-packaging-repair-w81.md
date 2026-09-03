# SDT-G55 packaging repair — W81

Status: **blocked**

The branch's packaging repair is at
`bb7afec95dbe2c3749f25216885a962bc6cfa20c` on
`claude/sdt-g55-read-visibility-w81`. A worktree-local `npm ci` now resolves
`@sekiban/dcb-runtime` to `.g55-w81/packages/dcb-runtime`. The new
`scripts/g55-deployment-bundle-preflight.mjs` rejects a parent-worktree
runtime, an absent runtime input, or missing `readListPage` / `readHead` /
`unsafe` bundle markers; its forced-red self-test and normal-config dry-run
passed.

OAuth-only repository-pinned Wrangler 4.125.0 deployed version
`22b5ba16-b8aa-4927-a5f1-eeaa1769a48b` with message
`SDT-G55 bb7afec95dbe2c3749f25216885a962bc6cfa20c`. The post-upload bundle
also passed the preflight, and the live list preflight returned a populated
`readHead`, proving the current runtime was deployed.

The one permitted fresh cohort created room `g55-room-3fecda14-172` and three
reservations. Unsafe visibility was 4407 ms, 3003 ms, and 2512 ms; captured
safe-head timings were 38356 ms and 268852 ms for the first two. The next
remote D1 safe-head query failed once with Cloudflare API authentication code
10000 (captured stdout in `.artifacts/sdt-g55-packaging-repair-e2e.json`,
captured stderr empty). The third safe timing and D1-after receipt are therefore
unavailable. No retry, extra app request, redeploy, G15/G16 deployed e2e, PR,
or worker completion was performed.

The prior `a49d2a7e` cohort remains historical invalid evidence only and is not
stitched into this fresh cohort. Full evidence is in
`docs/SDT-G55-evidence.md` and the committed raw artifact.
