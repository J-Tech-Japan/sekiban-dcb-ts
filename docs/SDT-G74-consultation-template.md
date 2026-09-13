# SDT-G74 AC10 consultation — W283

This is a byte-consistent consultation request for the SDT-G74 contract
freeze. It is not an acknowledgement by the recipient and silence is not
agreement.

## Contract identity

- Contract label: `executor-facade-v1`.
- Operator-selected carrying version: `0.2.0` for `@sekiban/dcb-core`,
  `@sekiban/dcb-domain`, and `@sekiban/dcb-client`.
- Immutable public-surface hash:
  `ebc3da21f00d3a2bcbde5a55548b5226d93e4e6c6ea623142699f94e499e668a`.
- Release-shaped candidate: package graph `0.2.0`; this consultation does not
  claim npm publication, downstream runtime conformance, or release work.

## Bounded compatibility policy

- Additive exports, optional fields, and non-breaking overloads require review
  of declaration shape, runtime namespace, inference, reachable types and
  exports-map resolution; they must not make an adapter method operationally
  required or change a documented result/refusal/abort/unknown outcome.
- Removing or renaming exports, changing parameter requiredness or overload
  order/generic constraints, narrowing inputs, widening result discriminants,
  changing return/member/brand shape, requiring an adapter operation, or
  changing module/export resolution is breaking and requires a new reviewed
  surface baseline and migration note.
- Backend choice, pooling/fetch internals, scheduling, private runtime APIs,
  undocumented topology, opaque internal SUID arithmetic, allocator
  lineage/attempt encoding and latency percentiles are bounded exclusions;
  they do not waive exposed head round-tripping, empty/null meaning,
  validation/refusal, service isolation, secret non-disclosure, caller
  budget/cancellation/wait semantics or shipped HTTP interoperability.

## Dated risks

- Allocator-to-source ordering gap: SDT-G69 W169/W168 evidence recorded
  2026-09-08 says the first-arrival fence is not implemented and G69 AC4/AC5
  remain open; this contract adds no ordering guarantee.
- Safe-lane latency: SDT-G66 W164 corrected production window recorded
  2026-09-08 has paced 10,000 ms, actual spacing 11,965–12,959 ms, and safe
  response-relative p50/p95 45,355/55,942 ms for 10/10 within unchanged
  180,000 ms; this is observed context, not an SLA.
- Package comparison: the 2026-09-10 registry record has the matched `0.1.0`
  packages installable, no published `0.1.1`, and a private runtime; the
  selected candidate graph is `0.2.0`.

## Requested response

Please have a named owner respond by `2026-09-14T08:11:06Z` with either:

1. `No interface blocker`, explicitly acknowledging the contract label,
   carrying version, exact hash, compatibility policy and dated risks; or
2. A concrete interface objection naming the affected package/entry point,
   declaration or wire fact, and the requested resolution.

The deadline is exactly 24 hours after the latest successful consultation
post, in UTC. A missing response is not relabelled as agreement or a waiver.
