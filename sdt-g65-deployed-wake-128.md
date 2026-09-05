# SDT-G65 deployed W128 result

Task: `SDT-G65-DEPLOYED-WAKE-128`
Issue: [J-Tech-Japan/sekiban-dcb-ts#126](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/126)
Branch: `claude/sdt-g65-local-wake-w128`
Head: `4184882c2d8779420e1778b95ea91d72676d4439`

Status: **blocked**. The existing W155-C arm was reused without resource
creation or migrations. The exact G65 version was deployed at 100% as
`ee161e62-528f-4caa-98a6-943134b2d26c`, deployment
`710638c8-84a2-4696-bc51-254b0c365570`, annotation
`SDT-G65 W128 exact 4184882c2d8779420e1778b95ea91d72676d4439`.

The post-change public cohort was n=10, cold-first and paced. Client response
was p50/p95 `2,413/2,545 ms`; the pre-change same-arm client baseline was
`2,145/2,417 ms`, so the p95 delta was 128 ms and passed that AC5 comparison.
Durable receipts showed all ten global admissions before response, with
command-to-`dcb_events` visibility p50/p95 `0/0 ms`; unsafe first visibility
was `2,262/4,518 ms` with 0/10 over 5,000 ms; safe/projector proof was
`114,982/176,719 ms` with 10/10 within 180 seconds. Completeness remained
`BLOCK/UNSETTLED` while the independent unsafe writer ran, preserving the safe
fence.

The C-0 runtime-D1-unavailable cohort committed all three events but missed
public RYOW at the actual 5-second bound. After restoring the normal binding,
Queue admitted each pending reservation once; visibility was 110,803,
98,858, and 87,014 ms. Full tables, per-sample rows, durable hop/sub-hop
results, red/green/mutant receipts, and gate outputs are in
[`docs/SDT-G65-evidence.md`](docs/SDT-G65-evidence.md) and the raw files under
`.artifacts/`.

The strict AC0 requirement is not proven: client-observed baseline p50 was
2,145 ms, outside the allowed 1,158–1,458 ms interval around 1,308 ms. The
internal response-body duration p50 was 1,179 ms, but that is not the named
client metric and is not used to claim AC0. Therefore AC8 was not entered: no
PR and no worker completion transition were performed. The branch and raw
receipts are preserved; SDT-G57 was not touched.
