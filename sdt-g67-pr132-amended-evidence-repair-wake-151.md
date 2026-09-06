# SDT-G67 PR #132 amended evidence repair — W151

Status: **blocked only on the missing exact-source same-window response
baseline**. This is a documentation/evidence repair from retained W150
receipts. No cohort, deployment, reset, Wrangler, Cloudflare, source, or
resource operation was performed in W151.

## Exact source and deployed identities

- PR source measured by W150: `766f5d328a6615582338ce52965f5017702182eb`.
- Evidence branch: `claude/sdt-g67-local-wake-w142`.
- W150 evidence checkpoint before this repair: `40e7ab44543b3f97271e2af01e5135bbf3d3229f`.
- W155-C: `sekiban-dcb-g60-w155-c`, final candidate version
  `3a71bc18-7c3f-4bda-abc1-be7d4aa1cee4`, deployment
  `9748f8ae-53d7-4e1a-af8a-4a33a1b75b9d`, 100% traffic.
- Production sample: `sekiban-dcb-meeting-room-cloudflare-only`, final candidate
  version `2d127e8b-d0ba-4fc9-9a78-4126bdef1b42`, deployment
  `6f971634-7bbc-4e75-bbff-e89613358515`, 100% traffic.
- W155-C configuration: `DIRECT_DOORBELL=true`, self receiver and binding
  `sekiban-dcb-g60-w155-c#MeetingRoomDownstreamDoorbell`.
- Production configuration: `DIRECT_DOORBELL=false`, receiver mode `separate`,
  and no `DOWNSTREAM_DOORBELL` service binding. Production therefore has no
  direct-ring population; this is a configuration fact, not an inferred pass.

## Amended response comparison and evidence gap

The final amended AC4/AC5 disposition makes response p50 relative to the
same-window baseline a gate, requires p95 to be reported and within 10%,
requires 10/10 safe observations below 180 seconds, and requires a deployed
fence-expiry row or a supported moving-deadline explanation. Scheduling wait,
pass latency, fence wait, ring arrival, Queue arrival, and safe p95 are
reported attribution, not gates. The old W146 `1608 ms` invocation-delay
claim and the W150 blocked classification based on scheduling/pass/unsafe
tails are superseded.

W150 contains only candidate cohorts for the exact source. The retained files
`.artifacts/sdt-g67-w150-w155-cohort.json` and
`.artifacts/sdt-g67-w150-production-cohort.json` each contain ten candidate
reservations; no W150 pre-change baseline receipt exists. The W150 preflight
deployment list shows the prior W145 candidate version, but it contains no
baseline cohort. Therefore the exact-source `766f5d3` response p50 delta and
p95 percentage cannot be honestly computed from W150 receipts.

The valid same-window comparison that is retained is historical W145, not a
current-PR acceptance comparison:

| same-window historical pair | source | n | response p50 | response p95 | p50 delta vs parent | p95 delta vs parent | p95 percentage |
|---|---|---:|---:|---:|---:|---:|---:|
| parent baseline | `91c36df5434895cccbbe03beeb5d7f8b5639857f` | 10 | 2979 ms | 4359 ms | — | — | — |
| candidate | `d596192f3b0ddb0ab6b70d10ed8b8c04cd5489ae` | 10 | 2829 ms | 3535 ms | -150 ms | -824 ms | -18.9% |

That W145 pair is preserved as historical context only: neither source is the
W150 exact source `766f5d3`, and the windows are different. It is not used to
claim the current PR response gate. W150 candidate response distributions are
still fully reported:

| W150 candidate cohort | n | response p50 | response p95 | safe p50 | safe p95 | safe <180 s |
|---|---:|---:|---:|---:|---:|---:|
| W155-C self arm | 10 | 2809 ms | 3626 ms | 61657 ms | 120646 ms | 10/10 |
| production sample | 10 | 2428 ms | 2789 ms | 73009 ms | 121185 ms | 10/10 |

No current-source p50 delta, p95 percentage, or current-source response-gate
pass is claimed. A new same-window baseline would be required to close that
single evidence gap, but W151 has no authorization to rerun a cohort.

## Sanitized per-event W150 attribution

Epoch values are observed durable/receiver clocks in milliseconds. `lastArrivedAt`
and `fenceEligibleAt` are from the pass that actually contains the sampled
SUID in `appliedEventDetails`. `updates` is the number of retained
`lastArrivalUpdates` for that applying-pass join; `maxUpdateAt` and
`maxUpdateDeadline` are the maximum observed update values for that join. A
blank stop deadline means the applying pass advanced/caught up rather than
stopping at a fence. The full event IDs, SUIDs, actual pass IDs, trigger
labels, safe heads, and observed clocks below are sanitized and committed in
this artifact; credential values are absent.

### W155-C self arm

|#|eventId|SUID|response|safe|safeHead|lastArrivedAt|fenceEligibleAt|actual applying pass|trigger|appliedAt|stopDeadlineAt|stopReason|updates|maxUpdateAt|maxUpdateDeadline|
|---:|---|---|---:|---:|---|---:|---:|---|---|---:|---:|---|---:|---:|---:|
|1|`01a07882-1b74-7f3c-bf92-ebedf1c1b08f`|`063924324988440000001041685361`|3352|120646|`063924325053570000000144395544`|1788728214260|1788728234260|`delivery:1788728232621:e57ce47b-16ef-44b1-839e-df139766760f`|delivery|1788728237749|1788728245529|safe_window_fence|22|1788728214260|1788728234260|
|2|`01a07882-504b-77d6-89cc-89c1a68a40b2`|`063924325002491000000522510130`|3512|107132|`063924325053570000000144395544`|1788728225529|1788728245529|`delivery:1788728238927:6ec91a28-e3dc-4699-a5b6-e3aac546205f`|delivery|1788728247091|1788728246897|safe_window_fence|6|1788728225529|1788728245529|
|3|`01a07882-84af-7c82-a086-086e161e7269`|`063924325015429000001832279219`|3075|94055|`063924325053570000000144395544`|1788728226897|1788728246897|`delivery:1788728247885:d15fa7e8-3610-40f6-ab8e-f04dd42911d9`|delivery|1788728250634|1788728257652|safe_window_fence|2|1788728226897|1788728246897|
|4|`01a07882-b6fa-759f-931b-0ed14f98d2b0`|`063924325028310000001361936111`|2712|81342|`063924325053570000000144395544`|1788728256877|1788728276877|`delivery:1788728276040:3fa287f5-4e40-4559-9c3c-700ea6280030`|delivery|1788728279718|1788728289553|safe_window_fence|18|1788728256877|1788728276877|
|5|`01a07882-e894-7ce7-b8fc-68380b6e2612`|`063924325040941000000145805155`|2582|68758|`063924325053570000000144395544`|1788728258702|1788728278702|`delivery:1788728276040:3fa287f5-4e40-4559-9c3c-700ea6280030`|delivery|1788728279828|1788728289553|safe_window_fence|0|—|—|
|6|`01a07883-1984-7c82-b973-4cd418f48312`|`063924325053570000000144395544`|2586|56172|`063924325053570000000144395544`|1788728269553|1788728289553|`delivery:1788728287842:593a1550-5f15-432b-9c04-f23b5bd68d08`|delivery|1788728292714|1788728295821|safe_window_fence|8|1788728269553|1788728289553|
|7|`01a07883-4b19-712c-a45b-859d6d509075`|`063924325066798000000328411432`|3626|57551|`063924325066798000000328411432`|1788728302505|1788728322505|`delivery:1788728318170:225cc0f2-b93b-4d97-90d0-e05a81459596`|delivery|1788728323252|1788728322505|safe_window_fence|23|1788728302505|1788728322505|
|8|`01a07883-802b-7956-b125-a9f923cf0687`|`063924325079863000000389715198`|2585|52957|`063924325079863000000389715198`|1788728304474|1788728328159|`delivery:1788728327600:ce34bf6e-124e-4b40-a531-3d70ff931dd2`|delivery|1788728332241|1788728338574|safe_window_fence|1|1788728304474|1788728324474|
|9|`01a07883-b196-72db-988c-de7f99efce1d`|`063924325092487000001163035396`|2809|47812|`063924325092487000001163035396`|1788728314889|1788728338688|`delivery:1788728334062:0c682bb7-b0d9-4720-819a-7acebd4b58cf`|delivery|1788728339397|1788728339191|safe_window_fence|5|1788728314889|1788728342974|
|10|`01a07883-e437-75d5-8363-c3007df2f4f8`|`063924325105572000001455364113`|3114|61657|`063924325105572000001455364113`|1788728334252|1788728354252|`fence-expiry:1788728349761:68ee4fb2-9fda-4564-997a-d0b2849a7f61`|fence-expiry|1788728367146|—|advanced_or_caught_up|5|1788728334252|1788728358051|

### Production sample

|#|eventId|SUID|response|safe|safeHead|lastArrivedAt|fenceEligibleAt|actual applying pass|trigger|appliedAt|stopDeadlineAt|stopReason|updates|maxUpdateAt|maxUpdateDeadline|
|---:|---|---|---:|---:|---|---:|---:|---|---|---:|---:|---|---:|---:|---:|
|1|`01a0788b-a3df-7570-ab6a-b0b4f78e4c60`|`063924325613234000000216344999`|2428|121185|`063924325650952000001085479169`|1788728832818|1788728852818|`delivery:1788728852091:7b3bfa10-7769-42f6-aa82-6e738912e57d`|delivery|1788728855591|1788728873689|safe_window_fence|14|1788728832818|1788728852818|
|2|`01a0788b-d5bb-765f-86d3-dd4f7bc83537`|`063924325626005000000785249135`|2364|108445|`063924325650952000001085479169`|1788728859620|1788728879620|`delivery:1788728878970:47b6759a-3f72-4879-9c62-3be674b37ebe`|delivery|1788728882445|1788728887076|safe_window_fence|16|1788728859620|1788728879620|
|3|`01a0788c-05f1-7314-8728-f1eeb9d723ea`|`063924325638356000000971963151`|2410|96034|`063924325650952000001085479169`|1788728867076|1788728887076|`fence-expiry:1788728879620:b7408690-9bd3-47cd-8ade-d17b6068d7ab`|fence-expiry|1788728891102|1788728887076|safe_window_fence|5|1788728867076|1788728887076|
|4|`01a0788c-37c9-7802-8a1b-a996c948ebd3`|`063924325650952000001085479169`|2575|83458|`063924325650952000001085479169`|1788728907463|1788728927463|`delivery:1788728925896:71acce67-e935-488a-89cb-8184fd7d5f0a`|delivery|1788728930488|1788728931642|safe_window_fence|23|1788728907463|1788728927463|
|5|`01a0788c-697b-7d6c-89ff-c5f23f96946a`|`063924325663700000000274668691`|2789|73009|`063924325663700000000274668691`|1788728911642|1788728931642|`cron:1788728928644:bf91fb23-c406-4c57-9264-9d6ee308cc6c`|cron|1788728935556|1788728931642|safe_window_fence|5|1788728911642|1788728931642|
|6|`01a0788c-9a9c-7c23-b109-0bbf7b14c5bd`|`063924325676274000000119057069`|2436|63228|`063924325676274000000119057069`|1788728917042|1788728937042|`delivery:1788728932553:fa860d78-da79-4c46-a8cc-f643e51b1beb`|delivery|1788728937897|1788728937042|safe_window_fence|4|1788728917042|1788728937042|
|7|`01a0788c-c9ca-7a04-bbff-6cb832ea5481`|`063924325688458000001163742824`|2236|53355|`063924325688458000001163742824`|1788728918730|1788728938730|`delivery:1788728932241:e55b58d7-3b97-45ab-b53e-b0349804df6b`|delivery|1788728941616|1788728945386|safe_window_fence|1|1788728918730|1788728938730|
|8|`01a0788c-f9e2-7579-aa65-efbdc0902175`|`063924325700997000001454841064`|2517|83234|`063924325715044000000323154612`|1788728945570|1788728965570|`fence-expiry:1788728965570:299bd5c5-5845-4c81-85c9-20928a277f4a`|fence-expiry|1788728984200|—|advanced_or_caught_up|14|1788728945570|1788728965570|
|9|`01a0788d-320f-7a6e-80aa-f8fa166b56a4`|`063924325715044000000323154612`|2313|69206|`063924325715044000000323154612`|1788728943396|1788728963396|`fence-expiry:1788728965570:299bd5c5-5845-4c81-85c9-20928a277f4a`|fence-expiry|1788728984898|—|advanced_or_caught_up|0|—|—|
|10|`01a0788d-6141-7e75-bff6-0d45b32c7f31`|`063924325727836000000599386515`|2749|62389|`063924325727836000000599386515`|1788728949125|1788728969125|`fence-expiry:1788728965570:299bd5c5-5845-4c81-85c9-20928a277f4a`|fence-expiry|1788728985589|—|advanced_or_caught_up|0|—|—|

Rows 3 (production) and 10 (W155-C) are explicit fence-expiry applications.
The update counts and maximum deadlines show why a later deadline can move:
the durable arrival path keeps `lastArrivedAt = MAX(existing, arrival)` for
idempotent duplicates, so a duplicate/newer arrival can move the deadline to
`lastArrivedAt + SafeWindow`; the applying pass is then joined to the exact
event SUID rather than to the first scheduled row. This is the supported
moving-deadline explanation. It does not relabel delivery or cron rows as
fence-expiry.

## Final disposition

- All twenty W150 candidate rows are published with event identity, safe head,
  last-arrival/fence eligibility, actual applying pass, trigger, and observed
  safe time.
- Both cohorts have `n=10` and all safe reads are below 180 seconds. W155-C
  response is 2809/3626 ms p50/p95; production response is 2428/2789 ms.
- Production has zero direct-ring rows by its deployed configuration; Queue,
  delivery, fence-expiry, and cron provenance remain distinct. Production safe
  p95 `121185 ms` is reported, not used as a gate under the final amendment.
- The exact-source same-window response baseline is absent from retained W150
  evidence. W151 therefore does not claim AC4/AC5 completion or fabricate a
  p50 delta/p95 percentage for source `766f5d3`.
- The old `1608 ms` claim and W150 scheduling/pass/unsafe-tail blocked wording
  are superseded as acceptance conclusions; those values remain historical
  attribution only. No new cohort is authorized by W151.

## Retained evidence references

The source W150 raw receipts remain in the implementation worktree under the
`sdt-g67-w150-*` prefix. This committed sanitized table is the durable public
evidence surface; it does not depend on ignored raw `.artifacts` paths for the
per-sample facts. The W150 deployment/configuration and C-0 zero proofs remain
listed in `sdt-g67-pr132-f1-deployed-attribution-wake-150.md`.
