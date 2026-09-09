# SDT-G73 CI determinism evidence

Task: `SDT-G73-CI-DETERMINISM-W193`
Issue: [#149](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/149)
Base: `origin/main` at `aca03b74d5677cffc42df105668235801f5a2580`
Branch: `claude/sdt-g73-ci-determinism-w193`

## Contract and process

The issue body was read as the standalone contract before code work. The child
preflight classified issue #149 as `ready-to-implement` under
`execution-unit:SDT-G73`, and the canonical worker claim was applied with
`intent-cli worker claim --kind issue --number 149 --repo J-Tech-Japan/sekiban-dcb-ts --github-only --write`.
The branch was cut from the fetched `origin/main` SHA above. No product
behavior, package version, release, credential, skip, retry, or real guard was
changed.

## Recorded main-red baselines

| Run | Main head | Red lane and characterization |
| --- | --- | --- |
| [34328164091](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34328164091) | `3769ccd1c0c853f52c88e684734f3a920fdf0686` | `ci-foundation` failed `test/g67-safe-lane.spec.ts` AC3 at the inherited 5,000 ms timeout and `test/g69-ordering.spec.ts` held-tag append returned 503 `partition_registration_unavailable`; 794 passed, 2 failed, 1 skipped. |
| [34302437259](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34302437259) | `82501b8c649b674a3c36db30122363fe2e9c1cca` | `ci-g21-g25` failed the G54 empty-V1-array comparison: expected `duration: PT0S`, received `duration: PT0.001S`. |
| [34287701420](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34287701420) | `4e5da819260027b3c4c96eb75b31cf939c0b5131` | `ci-foundation` repeated the G54 timing comparison failure; `ci-g64` independently failed its pre-existing dry-run publish gate because `@sekiban/dcb-core@0.1.0` was already published. Neither release gate nor credentials was changed. |

The hosted green comparison used for calibration was
[34348593490](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34348593490)
at head `487f5c...`: G67 AC3 took 3,907 ms, commit AC7 864 ms, the exact-key
tag G5 case 928 ms, the repair checkpoint 1,546 ms, and the repair six-boundary
case (already explicitly 15,000 ms) 3,499 ms. The tag file total was 2,663 ms.

## Characterization and changes

### G43 AC6: coordination, not retiming

The failure was a test-fixture interleaving: response headers/body completion
for the nested append did not prove that the nested `tag_event` row was visible
before the outer alarm resumed its source scan. This is not a production
ordering defect. The fixture now disables the unrelated automatic drain,
consumes the nested response body, and performs a same-Durable-Object SQL read
that asserts the nested event row is durable before the outer scan continues.
The finding assertion remains an `arrayContaining` assertion over the inserted
event; no sleep, retry, or weaker expectation was added.

The new temporary production mutant changes the source scanner from
`status <> 'acknowledged'` to `status = 'acknowledged'`. Its focused AC6 oracle
turns red, proving that removing the finding cannot pass. The existing five G43
fact mutants remain red as well.

### Inherited five-second budgets

| Case | Before | Measurement | Change and reason |
| --- | --- | --- | --- |
| `test/g67-safe-lane.spec.ts` AC3 | inherited 5,000 ms; red at 5,000 ms in run 34328164091 | hosted green full-suite test body 3,907 ms; 10 isolated repeats passed | explicit 10,000 ms. This retains a 6,093 ms margin over the hosted measurement while keeping a bounded test that still rejects a run exceeding 10 seconds; the G67 functional assertions and existing mutants remain unchanged. |
| `test/commit.spec.ts` AC7 | inherited 5,000 ms | hosted green 864 ms; 10 repeats passed at the tighter 2,000 ms probe | explicit 3,000 ms to remain tight while covering the loaded local observation just over 2 seconds. |
| `test/tag.spec.ts` exact-key G5 | inherited 5,000 ms | hosted green 928 ms; 10 repeats passed at the tighter 2,000 ms probe | explicit 3,000 ms. |
| `test/tag.spec.ts` concurrent G5 | inherited 5,000 ms | included in the hosted tag file total of 2,663 ms; 10 repeats passed at the tighter 2,000 ms probe | explicit 3,000 ms. |
| `test/repair.spec.ts` bounded scan checkpoint | inherited 5,000 ms; reached the default under a loaded local full-suite run | hosted green 1,546 ms; 10 repeats passed | explicit 10,000 ms. This is the unidentified inherited case from the issue; the existing six-boundary test at line 410 already has its explicit 15,000 ms budget and was not retuned. |

The local full-suite run is not claimed green: the default parallel worker run
also saturated unrelated G43 backlog, repair six-boundary, and the newly
explicit cases. The focused and loaded affected-suite runs are green, and the
hosted measurements above are the calibration source. No global timeout or
parallelism setting was changed to hide that local stress behavior.

### Driver-timing equality search

The repository search covered `test/**/*.ts`, `test/**/*.tsx`, and
`test/**/*.mjs` equality assertions and manually classified timing-related
numeric contract checks in tests and scripts.

Changed:

- `test/g54-envelope-boundary.spec.ts`: empty-V1 response compares semantic
  `writtenEvents`/`tagWriteResults` and only checks that public `duration` is a
  string.
- `test/g45-head-facts.spec.ts`: serialized success response compares every
  semantic field after removing only driver-reported `duration`, then checks
  that the public field remains present as a string.

Already safe or intentionally retained:

- `test/g22-bootstrap-d1.spec.ts` uses `semanticD1Result` and its explicit
  `D1_DRIVER_ONLY_META_KEYS` set for `duration`, routing, timing, and retry
  metadata.
- `test/g13-wire-invariance.spec.ts` compares the public key list, not a
  driver value; `duration` remains required by the wire-shape contract.
- `test/g54-interop.spec.ts` and `test/g54-accepted-positive.spec.ts` use
  fixed mocked transport responses, not equality against a live driver value.
- `test/g69-ordering.spec.ts` records diagnostic duration/cost evidence and
  checks non-negativity or bounded cost, not equality to a driver timestamp.
- G30/G65 elapsed and duration checks are deliberate product budget or trace
  contract guards, not Miniflare metadata equality.

`npm run test:g73:guard` runs a source scanner over 101 test files and 2,053
equality assertions. It reported zero violations. Its self-test is red for
both `{ duration: ... }` deep equality and serialized `"duration": ...`
equality, while allowing a public key-list assertion.

## G69 characterization boundary

The held-tag append in the hosted baseline returned:

```text
503 {"error":"Source partition registration is unavailable; retry the commit.","code":"partition_registration_unavailable","retryable":true}
```

This is a real SDT-G69 product-path failure signature, not a five-second test
timeout and not evidence for a retry or budget calibration. The unchanged
isolated `test/g69-ordering.spec.ts` run passed 8/8 locally and emitted the
expected `G69_ORDERING_PROOF`; the discrepancy is reported for the G69 owner.
No G69 test, product path, retry, or timeout was changed in this PR.

## Repeat-run measurement

The affected probes were run ten times each, with no Vitest retry option:

```text
G43 AC6 finding:                 10/10 passed
G67 AC3 (10,000 ms):             10/10 passed
commit AC7:                     10/10 passed
tag G5 (both cases):            10/10 passed
repair six-boundary:            10/10 passed
G45 duration sibling:           10/10 passed
G54 duration sibling:           10/10 passed
```

The loaded affected-suite run after the durable barrier was 7 files, 65/65
tests passed. The complete local default-parallel `npm test` was intentionally
recorded as red under host saturation rather than relabeled green; its
failures were the unrelated G43 backlog and worker-contention timeouts, while
the hosted CI result is the terminal acceptance check.
