#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
export const PIN_REL = "contracts/commit-trace-pin.json";
export const BUNDLE_REL = "contracts/commit-trace-bundle.json";
export const MANIFEST_REL = "contracts/commit-trace-manifest.json";
export const RENDERED_REL = "contracts/RENDERED-VIEWS.md";
export const ALLOWLIST_REL = "contracts/epoch-namespace-allowlist.json";
const NORMATIVE_PATHS = Object.freeze([
  "contracts/commit-trace-normative.md",
  "contracts/bootstrap-import-normative.md",
]);
const CURATED_REL = "contracts/epoch-reasons.curated.json";
export const AUTHORITY_SPECS = Object.freeze([
  ["contracts/commit-trace-normative.md", "source"],
  ["contracts/bootstrap-import-normative.md", "source"],
  [CURATED_REL, "source"],
  ["scripts/commit-trace-generate.mjs", "generator"],
  [RENDERED_REL, "generated"],
  [MANIFEST_REL, "generated"],
  [ALLOWLIST_REL, "generated"],
  ["scripts/commit-trace-contract.mjs", "checker"],
  ["scripts/g30-ac5-structural-check.mjs", "checker"],
]);
const MANIFEST_LITERAL = {
  "schemaVersion": 2,
  "name": "commit-trace-manifest",
  "description": "Repository-owned authority for the sdt.commit span manifests. The generated views are kept in RENDERED-VIEWS.md; the manifest does not duplicate those tables.",
  "remoteInvocationUniverse": [
    "S16"
  ],
  "schemas": {
    "sdt.commit/v1": {
      "rows": [
        {
          "rowId": "S00",
          "span": "sdt.commit",
          "emitter": "root-worker",
          "start": "handler entry (before validation)",
          "end": "just before Response return",
          "logicalParent": null,
          "coverage": true,
          "kind": "root",
          "successCardinality": "1"
        },
        {
          "rowId": "S01",
          "span": "request.decode_validate",
          "emitter": "root-worker",
          "start": "before request.json",
          "end": "validation outcome fixed",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S02",
          "span": "bootstrap.admit",
          "emitter": "caller-worker",
          "start": "before stub call",
          "end": "body consume / typed failure",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S03",
          "span": "bootstrap.release",
          "emitter": "caller-worker",
          "start": "before stub call",
          "end": "body consume / typed failure",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S04",
          "span": "journal.admit",
          "emitter": "caller-worker",
          "start": "before stub call",
          "end": "body consume / typed failure",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S05a",
          "span": "journal.transition",
          "emitter": "caller-worker",
          "start": "before RESERVED call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S05b",
          "span": "journal.transition",
          "emitter": "caller-worker",
          "start": "before ALLOCATED call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S05c",
          "span": "journal.transition",
          "emitter": "caller-worker",
          "start": "before WRITING call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S05d",
          "span": "journal.transition",
          "emitter": "caller-worker",
          "start": "before COMPLETE call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S05e",
          "span": "journal.transition",
          "emitter": "caller-worker",
          "start": "before terminal call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "terminal only"
        },
        {
          "rowId": "S06",
          "span": "tag.acquire.stage",
          "emitter": "caller-worker",
          "start": "before allSettled construction",
          "end": "all members settled",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "fanout-stage",
          "successCardinality": "1"
        },
        {
          "rowId": "S07",
          "span": "tag.acquire.member",
          "emitter": "caller-worker",
          "start": "before TAG stub call",
          "end": "settle",
          "logicalParent": "S06",
          "coverage": false,
          "kind": "fanout-member",
          "successCardinality": "consistencyTags.length"
        },
        {
          "rowId": "S08",
          "span": "allocator.allocate",
          "emitter": "caller-worker",
          "start": "before stub call",
          "end": "body consume / typed failure",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S09",
          "span": "allocator.bootstrap.finalize",
          "emitter": "allocator-do",
          "start": "before BOOTSTRAP call",
          "end": "body consume",
          "logicalParent": "S08",
          "coverage": false,
          "kind": "nested",
          "successCardinality": "1 (v1 only)"
        },
        {
          "rowId": "S10",
          "span": "bootstrap.append_finalize",
          "emitter": "caller-worker",
          "start": "before validation call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1 (v1 only)"
        },
        {
          "rowId": "S11",
          "span": "tag.append.stage",
          "emitter": "caller-worker",
          "start": "before allSettled construction",
          "end": "all members settled",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "fanout-stage",
          "successCardinality": "1"
        },
        {
          "rowId": "S12",
          "span": "tag.append.member",
          "emitter": "caller-worker",
          "start": "before TAG stub call",
          "end": "settle",
          "logicalParent": "S11",
          "coverage": false,
          "kind": "fanout-member",
          "successCardinality": "allTags.length"
        },
        {
          "rowId": "S13",
          "span": "tag.state.stage",
          "emitter": "caller-worker",
          "start": "before allSettled construction",
          "end": "all members settled",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "fanout-stage",
          "successCardinality": "1 (v1 only)"
        },
        {
          "rowId": "S14",
          "span": "tag.state.member",
          "emitter": "caller-worker",
          "start": "before TAG stub call",
          "end": "settle",
          "logicalParent": "S13",
          "coverage": false,
          "kind": "fanout-member",
          "successCardinality": "allTags.length (v1 only)"
        },
        {
          "rowId": "S15",
          "span": "response.build",
          "emitter": "root-worker",
          "start": "result assembly start",
          "end": "Response object complete",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S17",
          "span": "journal.reservation_failure",
          "emitter": "caller-worker",
          "start": "before /reservation-failure call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "failure only"
        },
        {
          "rowId": "S18",
          "span": "tag.cancel.stage",
          "emitter": "caller-worker",
          "start": "before allSettled construction",
          "end": "all members settled",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "fanout-stage",
          "successCardinality": "failure only"
        },
        {
          "rowId": "S19",
          "span": "tag.cancel.member",
          "emitter": "caller-worker",
          "start": "before TAG /cancel call",
          "end": "settle",
          "logicalParent": "S18",
          "coverage": false,
          "kind": "fanout-member",
          "successCardinality": "consistencyTags.length"
        },
        {
          "rowId": "S20",
          "span": "journal.seal_reconcile",
          "emitter": "caller-worker",
          "start": "before /reconcile call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "handoff only"
        },
        {
          "rowId": "S16",
          "span": "actor.handle",
          "emitter": "callee-do",
          "start": "callee handler entry",
          "end": "response / throw",
          "logicalParent": "provider-subrequest",
          "coverage": false,
          "kind": "callee",
          "successCardinality": "per remote invocation"
        }
      ],
      "universe": [
        "S00",
        "S01",
        "S02",
        "S03",
        "S04",
        "S05a",
        "S05b",
        "S05c",
        "S05d",
        "S05e",
        "S06",
        "S07",
        "S08",
        "S09",
        "S10",
        "S11",
        "S12",
        "S13",
        "S14",
        "S15",
        "S17",
        "S18",
        "S19",
        "S20"
      ],
      "boundaries": [
        {
          "name": "success",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S05d",
            "S06",
            "S07",
            "S08",
            "S09",
            "S10",
            "S11",
            "S12",
            "S13",
            "S14",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05e",
            "S17",
            "S18",
            "S19",
            "S20"
          ],
          "stateAssertion": "full write; COMPLETE before response"
        },
        {
          "name": "validation-reject",
          "requiredRows": [
            "S00",
            "S01",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S05d",
            "S05e",
            "S06",
            "S07",
            "S08",
            "S09",
            "S10",
            "S11",
            "S12",
            "S13",
            "S14",
            "S17",
            "S18",
            "S19",
            "S20"
          ],
          "stateAssertion": "no attempt identity yet; zero downstream calls"
        },
        {
          "name": "bootstrap-reject",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S05d",
            "S05e",
            "S06",
            "S07",
            "S08",
            "S09",
            "S10",
            "S11",
            "S12",
            "S13",
            "S14",
            "S17",
            "S18",
            "S19",
            "S20"
          ],
          "stateAssertion": "zero journal/tag writes"
        },
        {
          "name": "reservation-failure",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S06",
            "S07",
            "S17",
            "S18",
            "S19",
            "S05e",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05b",
            "S05c",
            "S05d",
            "S08",
            "S09",
            "S10",
            "S11",
            "S12",
            "S13",
            "S14",
            "S20"
          ],
          "stateAssertion": "cancel fan-out covers every consistency tag (forceTombstone)"
        },
        {
          "name": "allocator-failure",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S06",
            "S07",
            "S08",
            "S17",
            "S18",
            "S19",
            "S05e",
            "S15"
          ],
          "conditionalRows": [
            {
              "rowId": "S09",
              "predicate": "allocator reached its bootstrap finalize before failing",
              "instanceCount": 1,
              "whenTrue": "required",
              "whenFalse": "forbidden"
            }
          ],
          "forbiddenRows": [
            "S05b",
            "S05c",
            "S05d",
            "S10",
            "S11",
            "S12",
            "S13",
            "S14",
            "S20"
          ],
          "stateAssertion": "S09 only when the allocator reached its finalize"
        },
        {
          "name": "partial-handoff-to-alarm",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S06",
            "S07",
            "S08",
            "S09",
            "S10",
            "S11",
            "S12",
            "S20",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05d",
            "S05e",
            "S13",
            "S14",
            "S17",
            "S18",
            "S19"
          ],
          "stateAssertion": "alarm side lives in sdt.commit.reconcile/v1"
        }
      ],
      "callerCoverageIntervals": [
        "S01",
        "S02",
        "S03",
        "S04",
        "S05a",
        "S05b",
        "S05c",
        "S05d",
        "S05e",
        "S06",
        "S08",
        "S10",
        "S11",
        "S13",
        "S15"
      ]
    },
    "sdt.commit/v2": {
      "rows": [
        {
          "rowId": "S00",
          "span": "sdt.commit",
          "emitter": "root-worker",
          "start": "handler entry (before validation)",
          "end": "just before Response return",
          "logicalParent": null,
          "coverage": true,
          "kind": "root",
          "successCardinality": "1"
        },
        {
          "rowId": "S01",
          "span": "request.decode_validate",
          "emitter": "root-worker",
          "start": "before request.json",
          "end": "validation outcome fixed",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S02",
          "span": "bootstrap.admit",
          "emitter": "caller-worker",
          "start": "before stub call",
          "end": "body consume / typed failure",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S03",
          "span": "bootstrap.release",
          "emitter": "caller-worker",
          "start": "before stub call",
          "end": "body consume / typed failure",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S04",
          "span": "journal.admit",
          "emitter": "caller-worker",
          "start": "before stub call",
          "end": "body consume / typed failure",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S05a",
          "span": "journal.transition",
          "emitter": "caller-worker",
          "start": "before RESERVED call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S05b",
          "span": "journal.transition",
          "emitter": "caller-worker",
          "start": "before ALLOCATED call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S05c",
          "span": "journal.transition",
          "emitter": "caller-worker",
          "start": "before WRITING call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S05d",
          "span": "journal.transition",
          "emitter": "caller-worker",
          "start": "before COMPLETE call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S05e",
          "span": "journal.transition",
          "emitter": "caller-worker",
          "start": "before terminal call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "terminal only"
        },
        {
          "rowId": "S06",
          "span": "tag.acquire.stage",
          "emitter": "caller-worker",
          "start": "before allSettled construction",
          "end": "all members settled",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "fanout-stage",
          "successCardinality": "1"
        },
        {
          "rowId": "S07",
          "span": "tag.acquire.member",
          "emitter": "caller-worker",
          "start": "before TAG stub call",
          "end": "settle",
          "logicalParent": "S06",
          "coverage": false,
          "kind": "fanout-member",
          "successCardinality": "consistencyTags.length"
        },
        {
          "rowId": "S08",
          "span": "allocator.allocate",
          "emitter": "caller-worker",
          "start": "before stub call",
          "end": "body consume / typed failure",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S11",
          "span": "tag.append.stage",
          "emitter": "caller-worker",
          "start": "before allSettled construction",
          "end": "all members settled",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "fanout-stage",
          "successCardinality": "1"
        },
        {
          "rowId": "S12",
          "span": "tag.append.member",
          "emitter": "caller-worker",
          "start": "before TAG stub call",
          "end": "settle",
          "logicalParent": "S11",
          "coverage": false,
          "kind": "fanout-member",
          "successCardinality": "allTags.length"
        },
        {
          "rowId": "S15",
          "span": "response.build",
          "emitter": "root-worker",
          "start": "result assembly start",
          "end": "Response object complete",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1"
        },
        {
          "rowId": "S17",
          "span": "journal.reservation_failure",
          "emitter": "caller-worker",
          "start": "before /reservation-failure call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "failure only"
        },
        {
          "rowId": "S18",
          "span": "tag.cancel.stage",
          "emitter": "caller-worker",
          "start": "before allSettled construction",
          "end": "all members settled",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "fanout-stage",
          "successCardinality": "failure only"
        },
        {
          "rowId": "S19",
          "span": "tag.cancel.member",
          "emitter": "caller-worker",
          "start": "before TAG /cancel call",
          "end": "settle",
          "logicalParent": "S18",
          "coverage": false,
          "kind": "fanout-member",
          "successCardinality": "consistencyTags.length"
        },
        {
          "rowId": "S20",
          "span": "journal.seal_reconcile",
          "emitter": "caller-worker",
          "start": "before /reconcile call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "handoff only"
        },
        {
          "rowId": "P01",
          "span": "bootstrap.permit_acquire",
          "emitter": "caller-worker",
          "start": "before acquire call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1 (v2 only)"
        },
        {
          "rowId": "P02a",
          "span": "allocator.permit_prepare",
          "emitter": "allocator-do",
          "start": "before Bootstrap validation call (pre-transaction)",
          "end": "body consume",
          "logicalParent": "S08",
          "coverage": false,
          "kind": "nested",
          "successCardinality": "1 (v2 only)"
        },
        {
          "rowId": "P02b",
          "span": "allocator.permit_handoff",
          "emitter": "allocator-do",
          "start": "after allocator transaction commit, before handoff call",
          "end": "body consume",
          "logicalParent": "S08",
          "coverage": false,
          "kind": "nested",
          "successCardinality": "1 (v2 only)"
        },
        {
          "rowId": "P03",
          "span": "bootstrap.permit_validate_append",
          "emitter": "caller-worker",
          "start": "before append validation call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1 (v2 only)"
        },
        {
          "rowId": "P04",
          "span": "bootstrap.permit_resolve",
          "emitter": "caller-worker",
          "start": "before resolution evidence call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1 (v2 only)"
        },
        {
          "rowId": "P05",
          "span": "bootstrap.permit_release",
          "emitter": "caller-worker",
          "start": "before release call",
          "end": "body consume",
          "logicalParent": "S00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "1 (v2 only)"
        },
        {
          "rowId": "S16",
          "span": "actor.handle",
          "emitter": "callee-do",
          "start": "callee handler entry",
          "end": "response / throw",
          "logicalParent": "provider-subrequest",
          "coverage": false,
          "kind": "callee",
          "successCardinality": "per remote invocation"
        }
      ],
      "universe": [
        "S00",
        "S01",
        "S02",
        "S03",
        "S04",
        "S05a",
        "S05b",
        "S05c",
        "S05d",
        "S05e",
        "S06",
        "S07",
        "S08",
        "P01",
        "P02a",
        "P02b",
        "P03",
        "P04",
        "P05",
        "S11",
        "S12",
        "S15",
        "S17",
        "S18",
        "S19",
        "S20"
      ],
      "boundaries": [
        {
          "name": "success",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S05d",
            "S06",
            "S07",
            "S08",
            "P01",
            "P02a",
            "P02b",
            "P03",
            "P04",
            "P05",
            "S11",
            "S12",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05e",
            "S17",
            "S18",
            "S19",
            "S20"
          ],
          "stateAssertion": "permit released once after full write"
        },
        {
          "name": "permit-acquire-reject",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S06",
            "S07",
            "P01",
            "S17",
            "S18",
            "S19",
            "S05e",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05b",
            "S05c",
            "S05d",
            "S08",
            "P02a",
            "P02b",
            "P03",
            "P04",
            "P05",
            "S11",
            "S12",
            "S20"
          ],
          "stateAssertion": "no permit created; zero event/tag writes"
        },
        {
          "name": "permit-prepare-reject",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S06",
            "S07",
            "S08",
            "P01",
            "P02a",
            "S17",
            "S18",
            "S19",
            "S05e",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05b",
            "S05c",
            "S05d",
            "P02b",
            "P03",
            "P04",
            "P05",
            "S11",
            "S12",
            "S20"
          ],
          "stateAssertion": "proven no-write: allocator vector absent"
        },
        {
          "name": "permit-prepare-response-loss",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S05d",
            "S06",
            "S07",
            "S08",
            "P01",
            "P02a",
            "P02b",
            "P03",
            "P04",
            "P05",
            "S11",
            "S12",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05e",
            "S17",
            "S18",
            "S19",
            "S20"
          ],
          "stateAssertion": "P02a idempotent retry (retry.index>=1); allocation 0-call until success confirmed; then normal continuation"
        },
        {
          "name": "permit-handoff-requery-active-allocate-retry",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S05d",
            "S06",
            "S07",
            "S08",
            "P01",
            "P02a",
            "P02b",
            "P03",
            "P04",
            "P05",
            "S11",
            "S12",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05e",
            "S17",
            "S18",
            "S19",
            "S20"
          ],
          "stateAssertion": "requeried permit == ACTIVE_ALLOCATE: P02b same-tuple retry required (retry.index>=1); append 0-call before success"
        },
        {
          "name": "permit-handoff-requery-active-append-continue",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S05d",
            "S06",
            "S07",
            "S08",
            "P01",
            "P02a",
            "P02b",
            "P03",
            "P04",
            "P05",
            "S11",
            "S12",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05e",
            "S17",
            "S18",
            "S19",
            "S20"
          ],
          "stateAssertion": "requeried permit == ACTIVE_APPEND: P02b cardinality exactly 1 (double CAS forbidden); continuation"
        },
        {
          "name": "permit-handoff-requery-alarm-handoff",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S06",
            "S07",
            "S08",
            "P01",
            "P02a",
            "P02b",
            "S20",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05d",
            "S05e",
            "P03",
            "P04",
            "P05",
            "S11",
            "S12",
            "S17",
            "S18",
            "S19"
          ],
          "stateAssertion": "either permit state may hand off; P02b retry.index recorded so the retry decision is derivable from row evidence"
        },
        {
          "name": "permit-handoff-requery-mismatch-failclosed",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S06",
            "S07",
            "S08",
            "P01",
            "P02a",
            "P02b",
            "S20",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05d",
            "S05e",
            "P03",
            "P04",
            "P05",
            "S11",
            "S12",
            "S17",
            "S18",
            "S19"
          ],
          "stateAssertion": "owner/digest mismatch, missing, or unexpected terminal: typed fail-closed, event/tag write 0-call",
          "outcome": "permit_state_mismatch"
        },
        {
          "name": "permit-append-validation-reject",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S06",
            "S07",
            "S08",
            "P01",
            "P02a",
            "P02b",
            "P03",
            "S20",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05d",
            "S05e",
            "S17",
            "S18",
            "S19",
            "S11",
            "S12",
            "P04",
            "P05"
          ],
          "stateAssertion": "TAG append 0-call; no direct terminal; active permit handed to alarm"
        },
        {
          "name": "permit-resolve-failure",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S06",
            "S07",
            "S08",
            "P01",
            "P02a",
            "P02b",
            "P03",
            "S11",
            "S12",
            "P04",
            "S20",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05d",
            "S05e",
            "P05",
            "S17",
            "S18",
            "S19"
          ],
          "stateAssertion": "must not release; stays RESOLVING for alarm/repair"
        },
        {
          "name": "permit-release-response-loss",
          "requiredRows": [
            "S00",
            "S01",
            "S02",
            "S03",
            "S04",
            "S05a",
            "S05b",
            "S05c",
            "S05d",
            "S06",
            "S07",
            "S08",
            "P01",
            "P02a",
            "P02b",
            "P03",
            "P04",
            "P05",
            "S11",
            "S12",
            "S15"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "S05e",
            "S17",
            "S18",
            "S19",
            "S20"
          ],
          "stateAssertion": "P05 retry.index 0..n; converges to one released tombstone with the same evidence digest"
        }
      ],
      "callerCoverageIntervals": [
        "S01",
        "S02",
        "S03",
        "S04",
        "S05a",
        "S05b",
        "S05c",
        "S05d",
        "S05e",
        "S06",
        "P01",
        "S08",
        "P03",
        "S11",
        "P04",
        "P05",
        "S15"
      ]
    },
    "sdt.commit.reconcile/v1": {
      "rows": [
        {
          "rowId": "R00",
          "span": "sdt.commit.reconcile",
          "emitter": "journal-do",
          "start": "alarm handler entry",
          "end": "handler return",
          "logicalParent": null,
          "coverage": true,
          "kind": "root",
          "successCardinality": "1"
        },
        {
          "rowId": "R01",
          "span": "journal.alarm_rearm",
          "emitter": "journal-do",
          "start": "durable re-arm start",
          "end": "complete",
          "logicalParent": "R00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "non-terminal entry only"
        },
        {
          "rowId": "R02",
          "span": "journal.takeover_cas",
          "emitter": "journal-do",
          "start": "journalOwnerEpoch+1 CAS start",
          "end": "complete",
          "logicalParent": "R00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "pre-takeover only"
        },
        {
          "rowId": "R03",
          "span": "tag.seal.stage",
          "emitter": "journal-do",
          "start": "before the SEQUENTIAL seal loop over allTags",
          "end": "loop complete (members are ordered, not parallel)",
          "logicalParent": "R00",
          "coverage": true,
          "kind": "sequential-stage",
          "successCardinality": "post-allocation recovery only"
        },
        {
          "rowId": "R04",
          "span": "tag.seal.member",
          "emitter": "journal-do",
          "start": "before TAG /seal call",
          "end": "response",
          "logicalParent": "R03",
          "coverage": false,
          "kind": "sequential-member",
          "successCardinality": "unsealed members only"
        },
        {
          "rowId": "R09",
          "span": "tag.cancel.stage",
          "emitter": "journal-do",
          "start": "before the parallel cancel barrier over consistencyTags",
          "end": "all members settled",
          "logicalParent": "R00",
          "coverage": true,
          "kind": "fanout-stage",
          "successCardinality": "pre-allocation vector-absent recovery only"
        },
        {
          "rowId": "R10",
          "span": "tag.cancel.member",
          "emitter": "journal-do",
          "start": "before TAG /cancel (forceTombstone) call",
          "end": "settle",
          "logicalParent": "R09",
          "coverage": false,
          "kind": "fanout-member",
          "successCardinality": "consistencyTags.length"
        },
        {
          "rowId": "R11",
          "span": "journal.reconcile_apply",
          "emitter": "journal-do",
          "start": "before the applyReconciliation CAS",
          "end": "CAS complete",
          "logicalParent": "R00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "reconciliation-terminated recovery only"
        },
        {
          "rowId": "R05",
          "span": "bootstrap.permit_transfer",
          "emitter": "journal-do",
          "start": "before transfer call",
          "end": "body consume",
          "logicalParent": "R00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "v2 + active permit only"
        },
        {
          "rowId": "R06",
          "span": "journal.terminal_cas",
          "emitter": "journal-do",
          "start": "terminal CAS start",
          "end": "complete",
          "logicalParent": "R00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "reached-terminal only"
        },
        {
          "rowId": "R08",
          "span": "journal.alarm_clear",
          "emitter": "journal-do",
          "start": "deleteAlarm() start",
          "end": "complete",
          "logicalParent": "R00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "terminal-at-entry only"
        }
      ],
      "universe": [
        "R00",
        "R01",
        "R02",
        "R03",
        "R04",
        "R05",
        "R06",
        "R08",
        "R09",
        "R10",
        "R11"
      ],
      "recoveryDag": {
        "pre-allocation-vector-absent": {
          "factPredicate": "Journal state is ADMITTED/RESERVED and readAllocatorVector returns undefined; recoverPreAllocationCommit cancels every consistency reservation and then terminates. It does NOT take over the owner epoch.",
          "transitions": [
            "pre-takeover",
            "takeover-done",
            "terminal"
          ],
          "requiredRows": [
            "R00",
            "R01",
            "R09",
            "R10"
          ],
          "conditionalRows": [
            {
              "rowId": "R06",
              "predicate": "the record was RESERVED with a reservationFailure, so the terminal transition is used",
              "instanceCount": 1,
              "whenTrue": "required",
              "whenFalse": "forbidden"
            },
            {
              "rowId": "R11",
              "predicate": "otherwise the attempt is abandoned through applyReconciliation",
              "instanceCount": 1,
              "whenTrue": "required",
              "whenFalse": "forbidden"
            }
          ],
          "forbiddenRows": [
            "R02",
            "R03",
            "R04",
            "R05",
            "R08"
          ],
          "tagMutationPortCount": "zero",
          "terminalOutcome": "no-write terminal (cancel barrier only)",
          "appliesToSchema": [
            "v1",
            "v2"
          ],
          "terminatesInvocation": true
        },
        "journal-pre-allocation-vector-present": {
          "factPredicate": "Journal is ADMITTED/RESERVED but readAllocatorVector returns a vector; applyReconciliation converges the record to ALLOCATED because the vector is the durable authority. This invocation does NOT terminate: a later alarm runs post-allocation recovery.",
          "transitions": [
            "pre-takeover",
            "takeover-done"
          ],
          "requiredRows": [
            "R00",
            "R01",
            "R11"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "R02",
            "R03",
            "R04",
            "R05",
            "R06",
            "R08",
            "R09",
            "R10"
          ],
          "tagMutationPortCount": "zero",
          "terminalOutcome": "NON-TERMINAL: converges to ALLOCATED and hands over to the post-allocation path",
          "appliesToSchema": [
            "v1",
            "v2"
          ],
          "terminatesInvocation": false
        },
        "post-allocation-full-write": {
          "factPredicate": "state is ALLOCATED/WRITING/SEALING and the batch requery finds EVERY candidate present, so reconciliation converges to COMPLETE",
          "transitions": [
            "pre-takeover",
            "takeover-done",
            "[v2:transfer-done]",
            "sealed",
            "terminal"
          ],
          "requiredRows": [
            "R00",
            "R01",
            "R02",
            "R03",
            "R04",
            "R06"
          ],
          "conditionalRows": [
            {
              "rowId": "R05",
              "predicate": "schemaVersion == v2 AND an active permit exists for this attempt",
              "instanceCount": 1,
              "whenTrue": "required",
              "whenFalse": "forbidden"
            }
          ],
          "forbiddenRows": [
            "R08",
            "R09",
            "R10",
            "R11"
          ],
          "tagMutationPortCount": "unsealed-members",
          "terminalOutcome": "COMPLETE terminal (full batch requery found every candidate)",
          "appliesToSchema": [
            "v1",
            "v2"
          ],
          "terminatesInvocation": true
        },
        "post-allocation-no-write": {
          "factPredicate": "state is ALLOCATED/WRITING/SEALING and every tag is proven un-written; beginAlarmTakeover raises the owner epoch, then the sequential seal loop runs",
          "transitions": [
            "pre-takeover",
            "takeover-done",
            "[v2:transfer-done]",
            "sealed",
            "terminal"
          ],
          "requiredRows": [
            "R00",
            "R01",
            "R02",
            "R03",
            "R04",
            "R06"
          ],
          "conditionalRows": [
            {
              "rowId": "R05",
              "predicate": "schemaVersion == v2 AND an active permit exists for this attempt",
              "instanceCount": 1,
              "whenTrue": "required",
              "whenFalse": "forbidden"
            }
          ],
          "forbiddenRows": [
            "R08",
            "R09",
            "R10",
            "R11"
          ],
          "tagMutationPortCount": "unsealed-members",
          "terminalOutcome": "no-write terminal",
          "appliesToSchema": [
            "v1",
            "v2"
          ],
          "terminatesInvocation": true
        },
        "post-allocation-partial-write": {
          "factPredicate": "state is ALLOCATED/WRITING/SEALING with at least one tag written and at least one not",
          "transitions": [
            "pre-takeover",
            "takeover-done",
            "[v2:transfer-done]",
            "sealed",
            "terminal"
          ],
          "requiredRows": [
            "R00",
            "R01",
            "R02",
            "R03",
            "R04",
            "R06"
          ],
          "conditionalRows": [
            {
              "rowId": "R05",
              "predicate": "schemaVersion == v2 AND an active permit exists for this attempt",
              "instanceCount": 1,
              "whenTrue": "required",
              "whenFalse": "forbidden"
            }
          ],
          "forbiddenRows": [
            "R08",
            "R09",
            "R10",
            "R11"
          ],
          "tagMutationPortCount": "unsealed-members",
          "terminalOutcome": "PARTIAL terminal; permit stays active for repair",
          "appliesToSchema": [
            "v1",
            "v2"
          ],
          "terminatesInvocation": true
        },
        "permit-release-won": {
          "factPredicate": "v2 only: the old owner release won the Bootstrap CAS before this transfer",
          "transitions": [
            "pre-takeover",
            "takeover-done",
            "terminal"
          ],
          "requiredRows": [
            "R00",
            "R01",
            "R02",
            "R06"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "R03",
            "R04",
            "R05",
            "R08",
            "R09",
            "R10",
            "R11"
          ],
          "tagMutationPortCount": "zero",
          "terminalOutcome": "stop after re-verifying RELEASED evidence (tag mutation 0-call)",
          "appliesToSchema": [
            "v2"
          ],
          "terminatesInvocation": true
        },
        "permit-transfer-won": {
          "factPredicate": "v2 only: this recovery won the Bootstrap permit transfer CAS",
          "transitions": [
            "pre-takeover",
            "takeover-done",
            "transfer-done",
            "sealed",
            "terminal"
          ],
          "requiredRows": [
            "R00",
            "R01",
            "R02",
            "R05",
            "R03",
            "R04",
            "R06"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "R08",
            "R09",
            "R10",
            "R11"
          ],
          "tagMutationPortCount": "unsealed-members",
          "terminalOutcome": "terminal as durable owner",
          "appliesToSchema": [
            "v2"
          ],
          "terminatesInvocation": true
        },
        "permit-corrupt-missing": {
          "factPredicate": "v2 only: permit record missing, or owner/digest mismatch",
          "transitions": [
            "pre-takeover",
            "takeover-done",
            "terminal"
          ],
          "requiredRows": [
            "R00",
            "R01",
            "R02",
            "R06"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "R03",
            "R04",
            "R05",
            "R08",
            "R09",
            "R10",
            "R11"
          ],
          "tagMutationPortCount": "zero",
          "terminalOutcome": "typed fail-closed (tag mutation 0-call)",
          "appliesToSchema": [
            "v2"
          ],
          "terminatesInvocation": true
        }
      },
      "terminalAtEntryBoundary": {
        "name": "terminal-at-entry",
        "factPredicate": "durable.prefix.at_entry == terminal: the alarm fired on an already-terminal record",
        "requiredRows": [
          "R00",
          "R08"
        ],
        "conditionalRows": [],
        "forbiddenRows": [
          "R01",
          "R02",
          "R03",
          "R04",
          "R05",
          "R06",
          "R09",
          "R10",
          "R11"
        ],
        "tagMutationPortCount": "zero",
        "terminalOutcome": "no work; deleteAlarm() and return",
        "appliesToSchema": [
          "v1",
          "v2"
        ]
      },
      "generationStateMachine": {
        "fields": {
          "firedGenerationId": "durable id of the alarm generation that started THIS handler; R00 records this one",
          "scheduledGenerationId": "durable id created by the R01 re-arm inside this handler (the NEXT generation)"
        },
        "rules": [
          {
            "ruleId": "fired-from-observed-scheduled",
            "text": "handler entry: firedGenerationId := the scheduledGenerationId observed at entry"
          },
          {
            "ruleId": "rearm-advances-scheduled-only",
            "text": "R01 transaction: fired unchanged, scheduled_old -> scheduled_new"
          },
          {
            "ruleId": "platform-retry-keeps-fired",
            "text": "platform retry after throw: same firedGenerationId, retryCount incremented, isRetry true"
          },
          {
            "ruleId": "self-rearm-fire-consumes-scheduled",
            "text": "self re-armed fire: firedGenerationId equals the previous scheduledGenerationId, retryCount resets to 0"
          },
          {
            "ruleId": "never-reattribute",
            "text": "never reattribute a handler to the generation it scheduled"
          }
        ],
        "mutations": [
          {
            "mutationId": "reattribute-to-latest",
            "text": "reattribute all spans to the latest generation"
          },
          {
            "mutationId": "overwrite-fired-at-rearm",
            "text": "overwrite firedGenerationId at R01"
          },
          {
            "mutationId": "retrycount-as-invocation-key",
            "text": "use retryCount as the invocation-uniqueness key"
          },
          {
            "mutationId": "drop-scheduled-generation",
            "text": "drop scheduledGenerationId"
          }
        ]
      },
      "sealPredicates": {
        "v1": {
          "rows": [
            "R03",
            "R04"
          ],
          "permitDependent": false,
          "boundTo": "journalTakeoverPrefix",
          "predicate": "prefix.before in {takeover-done, sealed}",
          "note": "must remain satisfiable with no permit facts at all"
        },
        "v2": {
          "rows": [
            "R03",
            "R04"
          ],
          "permitDependent": true,
          "boundTo": "journalOwnerEpoch",
          "predicate": "durable permit owner == current journalOwnerEpoch",
          "note": "binds to durable facts so a crash between transfer and seal can resume"
        }
      }
    },
    "sdt.commit.repair/v1": {
      "rows": [
        {
          "rowId": "X00",
          "span": "sdt.commit.repair",
          "emitter": "repair-runner",
          "start": "handler entry",
          "end": "completion / throw",
          "logicalParent": null,
          "coverage": true,
          "kind": "root",
          "successCardinality": "1"
        },
        {
          "rowId": "X02",
          "span": "tag.repair_lease",
          "emitter": "repair-runner",
          "start": "before ensureLease acquire/renew call",
          "end": "acquire/renew call response (there is no release call; LeaseContext lifetime is execution-local)",
          "logicalParent": "X00",
          "coverage": true,
          "kind": "fanout-member",
          "successCardinality": "distinct tags that actually reach ensureLease (dry-run: 0; all-items-resume-skip: 0; several items on one tag: 1)"
        },
        {
          "rowId": "X03e",
          "span": "tag.repair_item.execute_mutating",
          "emitter": "repair-runner",
          "start": "item branch decision start",
          "end": "branch-specific terminal durable evidence (ROLLED_FORWARD/EXCLUDED_AUDITED: resolution+audit; FAILED_CLOSED: resolution only, audit forbidden)",
          "logicalParent": "X00",
          "coverage": false,
          "kind": "fanout-member",
          "successCardinality": "mutating items only"
        },
        {
          "rowId": "X03r",
          "span": "tag.repair_item.resume_skip",
          "emitter": "repair-runner",
          "start": "durable-state read start",
          "end": "skip decision (no durable write)",
          "logicalParent": "X00",
          "coverage": false,
          "kind": "fanout-member",
          "successCardinality": "already-resolved items (durable write 0-call)"
        },
        {
          "rowId": "X03p",
          "span": "tag.repair_item.dry_run_plan",
          "emitter": "repair-runner",
          "start": "workset read start",
          "end": "plan entry produced (no lease, no mutation)",
          "logicalParent": "X00",
          "coverage": false,
          "kind": "fanout-member",
          "successCardinality": "dry-run items over the FULL workset distinct tags (maxItems bounds mutating execution only, not the dry-run plan read)"
        },
        {
          "rowId": "X01",
          "span": "bootstrap.permit_resolved_safe",
          "emitter": "caller",
          "start": "before RESOLVED_SAFE CAS call",
          "end": "body consume",
          "logicalParent": "X00",
          "coverage": true,
          "kind": "direct",
          "successCardinality": "per attempt reaching RESOLVED_SAFE"
        }
      ],
      "universe": [
        "X00",
        "X01",
        "X02",
        "X03e",
        "X03r",
        "X03p"
      ],
      "boundaries": [
        {
          "name": "dry-run",
          "requiredRows": [
            "X00",
            "X03p"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "X02",
            "X03e",
            "X03r",
            "X01"
          ],
          "stateAssertion": "lease and mutation 0-call; X03p counts distinct tags of the FULL workset"
        },
        {
          "name": "all-items-resume-skip",
          "requiredRows": [
            "X00",
            "X03r"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "X02",
            "X03e",
            "X03p",
            "X01"
          ],
          "stateAssertion": "ensureLease never reached, so X02 cardinality is 0; durable write 0-call"
        },
        {
          "name": "execute-mutating-single-tag",
          "requiredRows": [
            "X00",
            "X02",
            "X03e"
          ],
          "conditionalRows": [
            {
              "rowId": "X01",
              "predicate": "the attempt reached RESOLVED_SAFE in this execution",
              "instanceCount": "1 per attempt",
              "whenTrue": "required",
              "whenFalse": "forbidden"
            }
          ],
          "forbiddenRows": [
            "X03p",
            "X03r"
          ],
          "stateAssertion": "several mutating items on one tag reuse one lease: X02 == 1, X03e == N"
        },
        {
          "name": "execute-failed-closed",
          "requiredRows": [
            "X00",
            "X02",
            "X03e"
          ],
          "conditionalRows": [],
          "forbiddenRows": [
            "X03p",
            "X03r",
            "X01"
          ],
          "stateAssertion": "FAILED_CLOSED writes a resolution but NO audit; X03e ends at the resolution record; X01 forbidden"
        }
      ],
      "parentLinks": [
        {
          "row": "X03e",
          "linkedTo": "X02",
          "via": "repair.lease.id + tag.key_hash",
          "note": "X02 ends at the acquire/renew response, so X03e must NOT be its child"
        }
      ]
    }
  },
  "attributeMatrix": {
    "faces": [
      "pre-admission",
      "accepted",
      "reconcile-root",
      "repair-root"
    ],
    "states": [
      "required",
      "optional",
      "forbidden"
    ],
    "attributes": {
      "schema.version": {
        "type": "string-literal",
        "values": [
          "sdt.commit/v1",
          "sdt.commit/v2",
          "sdt.commit.reconcile/v1",
          "sdt.commit.repair/v1"
        ],
        "faces": {
          "pre-admission": "required",
          "accepted": "required",
          "reconcile-root": "required",
          "repair-root": "required"
        }
      },
      "correlation.id": {
        "type": "string",
        "faces": {
          "pre-admission": "required",
          "accepted": "required",
          "reconcile-root": "required",
          "repair-root": "required"
        }
      },
      "attempt.id": {
        "type": "string",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "required",
          "reconcile-root": "required",
          "repair-root": "optional"
        },
        "note": "repair roots are multi-attempt; per-attempt rows carry it"
      },
      "service.id": {
        "type": "string",
        "faces": {
          "pre-admission": "required",
          "accepted": "required",
          "reconcile-root": "required",
          "repair-root": "required"
        }
      },
      "actor.class": {
        "type": "enum",
        "values": [
          "ROOT",
          "BOOTSTRAP",
          "JOURNAL",
          "ALLOCATOR",
          "TAG",
          "REPAIR"
        ],
        "faces": {
          "pre-admission": "required",
          "accepted": "required",
          "reconcile-root": "required",
          "repair-root": "required"
        }
      },
      "actor.key_hash": {
        "type": "hex64",
        "faces": {
          "pre-admission": "optional",
          "accepted": "required",
          "reconcile-root": "required",
          "repair-root": "required"
        }
      },
      "activation.id": {
        "type": "uuid",
        "faces": {
          "pre-admission": "optional",
          "accepted": "optional",
          "reconcile-root": "required",
          "repair-root": "optional"
        },
        "note": "callee rows only; observation-only, never persisted or branched on"
      },
      "activation.first": {
        "type": "boolean",
        "faces": {
          "pre-admission": "optional",
          "accepted": "optional",
          "reconcile-root": "required",
          "repair-root": "optional"
        }
      },
      "operation": {
        "type": "enum-from-manifest-rows",
        "faces": {
          "pre-admission": "required",
          "accepted": "required",
          "reconcile-root": "required",
          "repair-root": "required"
        }
      },
      "span.kind": {
        "type": "enum",
        "values": [
          "root",
          "direct",
          "nested",
          "fanout-stage",
          "fanout-member",
          "sequential-stage",
          "sequential-member",
          "callee"
        ],
        "faces": {
          "pre-admission": "required",
          "accepted": "required",
          "reconcile-root": "required",
          "repair-root": "required"
        }
      },
      "phase.ordinal": {
        "type": "non-negative-integer",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "optional",
          "reconcile-root": "forbidden",
          "repair-root": "forbidden"
        },
        "rowScope": [
          "S05a",
          "S05b",
          "S05c",
          "S05d",
          "S05e"
        ],
        "note": "required on journal.transition rows only"
      },
      "retry.index": {
        "type": "non-negative-integer",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "optional",
          "reconcile-root": "optional",
          "repair-root": "optional"
        }
      },
      "member.index": {
        "type": "non-negative-integer",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "optional",
          "reconcile-root": "optional",
          "repair-root": "optional"
        },
        "rowScope": [
          "S07",
          "S12",
          "S14",
          "S19",
          "R04",
          "R10",
          "X02",
          "X03e",
          "X03r",
          "X03p"
        ],
        "note": "every fan-out or sequential member row (S14 is v1-only and disappears with G36-2)"
      },
      "tag.key_hash": {
        "type": "hex64",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "optional",
          "reconcile-root": "optional",
          "repair-root": "optional"
        },
        "rowScope": [
          "S07",
          "S12",
          "S14",
          "S19",
          "R04",
          "R10",
          "X02",
          "X03e",
          "X03r",
          "X03p"
        ],
        "note": "every member row; raw tag values are never emitted"
      },
      "outcome": {
        "type": "enum-from-manifest-boundaries",
        "faces": {
          "pre-admission": "required",
          "accepted": "required",
          "reconcile-root": "required",
          "repair-root": "required"
        }
      },
      "http.status": {
        "type": "integer",
        "faces": {
          "pre-admission": "optional",
          "accepted": "optional",
          "reconcile-root": "forbidden",
          "repair-root": "optional"
        },
        "note": "required on spans that receive a Response; forbidden on alarm-root, re-arm and local-CAS spans"
      },
      "script.version": {
        "type": "provider-adapter",
        "faces": {
          "pre-admission": "optional",
          "accepted": "optional",
          "reconcile-root": "optional",
          "repair-root": "optional"
        },
        "note": "adapter input; never an authority and never a control branch"
      },
      "colo": {
        "type": "provider-adapter",
        "faces": {
          "pre-admission": "optional",
          "accepted": "optional",
          "reconcile-root": "optional",
          "repair-root": "optional"
        }
      },
      "placement": {
        "type": "provider-adapter",
        "faces": {
          "pre-admission": "optional",
          "accepted": "optional",
          "reconcile-root": "optional",
          "repair-root": "optional"
        }
      },
      "alarm.event.id": {
        "type": "string",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "forbidden",
          "reconcile-root": "required",
          "repair-root": "forbidden"
        },
        "rowScope": [
          "R00"
        ],
        "note": "framework durable alarm generation that fired this handler; root only"
      },
      "alarm.invocation.id": {
        "type": "string",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "forbidden",
          "reconcile-root": "required",
          "repair-root": "forbidden"
        },
        "rowScope": [
          "R00"
        ]
      },
      "alarm.retryCount": {
        "type": "non-negative-integer",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "forbidden",
          "reconcile-root": "required",
          "repair-root": "forbidden"
        },
        "rowScope": [
          "R00"
        ]
      },
      "alarm.isRetry": {
        "type": "boolean",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "forbidden",
          "reconcile-root": "required",
          "repair-root": "forbidden"
        },
        "rowScope": [
          "R00"
        ]
      },
      "recovery.kind": {
        "type": "enum-from-manifest-recovery",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "forbidden",
          "reconcile-root": "required",
          "repair-root": "forbidden"
        },
        "rowScope": [
          "R00"
        ],
        "factDerived": true,
        "note": "the kind is only decided after the allocator-vector requery, and a Cloudflare span cannot be updated after it ends, so ONLY the root (which ends last) may carry it"
      },
      "durable.prefix.at_entry": {
        "type": "enum",
        "values": [
          "pre-takeover",
          "takeover-done",
          "transfer-done",
          "sealed",
          "terminal"
        ],
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "forbidden",
          "reconcile-root": "required",
          "repair-root": "forbidden"
        },
        "rowScope": [
          "R00"
        ]
      },
      "prefix.before": {
        "type": "enum",
        "values": [
          "pre-takeover",
          "takeover-done",
          "transfer-done",
          "sealed",
          "terminal"
        ],
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "forbidden",
          "reconcile-root": "optional",
          "repair-root": "forbidden"
        },
        "rowScope": [
          "R02",
          "R03",
          "R05",
          "R06",
          "R08",
          "R09",
          "R11"
        ],
        "note": "reconcile mutation rows only"
      },
      "prefix.after": {
        "type": "enum",
        "values": [
          "pre-takeover",
          "takeover-done",
          "transfer-done",
          "sealed",
          "terminal"
        ],
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "forbidden",
          "reconcile-root": "optional",
          "repair-root": "forbidden"
        },
        "rowScope": [
          "R02",
          "R03",
          "R05",
          "R06",
          "R08",
          "R09",
          "R11"
        ]
      },
      "repair.execution.id": {
        "type": "string",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "forbidden",
          "reconcile-root": "forbidden",
          "repair-root": "required"
        },
        "rowScope": [
          "X00"
        ]
      },
      "repair.lease.id": {
        "type": "string",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "forbidden",
          "reconcile-root": "forbidden",
          "repair-root": "optional"
        },
        "rowScope": [
          "X02",
          "X03e"
        ],
        "note": "required on X02 and on X03e (the link key back to X02)"
      },
      "repairEpoch": {
        "type": "integer",
        "faces": {
          "pre-admission": "forbidden",
          "accepted": "forbidden",
          "reconcile-root": "forbidden",
          "repair-root": "optional"
        },
        "rowScope": [
          "X02",
          "X03e"
        ]
      }
    }
  },
  "v1ToV2Mapping": [
    {
      "v1": "S09",
      "v2": "P02a",
      "bucket": "renamed-semantic"
    },
    {
      "v1": "S10",
      "v2": "P03",
      "bucket": "renamed-semantic"
    },
    {
      "v1": null,
      "v2": "P01",
      "bucket": "added"
    },
    {
      "v1": null,
      "v2": "P02b",
      "bucket": "added"
    },
    {
      "v1": null,
      "v2": "P04",
      "bucket": "added"
    },
    {
      "v1": null,
      "v2": "P05",
      "bucket": "added"
    },
    {
      "v1": "S13",
      "v2": null,
      "bucket": "removed"
    },
    {
      "v1": "S14",
      "v2": null,
      "bucket": "removed"
    }
  ],
  "unattributedRatio": "max(0, rootDuration - duration(union(clip(callerCoverageIntervals, root)))) / rootDuration"
};
const EXPECTED_SCHEMAS = Object.freeze(["sdt.commit/v1", "sdt.commit/v2", "sdt.commit.reconcile/v1", "sdt.commit.repair/v1"]);
const EXPECTED_ATTRIBUTES = Object.freeze([
  "schema.version", "correlation.id", "attempt.id", "service.id", "actor.class", "actor.key_hash",
  "activation.id", "activation.first", "operation", "span.kind", "phase.ordinal", "retry.index",
  "member.index", "tag.key_hash", "outcome", "http.status", "script.version", "colo", "placement",
  "alarm.event.id", "alarm.invocation.id", "alarm.retryCount", "alarm.isRetry", "recovery.kind",
  "durable.prefix.at_entry", "prefix.before", "prefix.after", "repair.execution.id", "repair.lease.id",
  "repairEpoch",
]);
const EXPECTED_RECOVERY = Object.freeze([
  "pre-allocation-vector-absent", "journal-pre-allocation-vector-present", "post-allocation-full-write",
  "post-allocation-no-write", "post-allocation-partial-write", "permit-release-won", "permit-transfer-won",
  "permit-corrupt-missing",
]);
const RECOVERY_KIND_OWNERSHIP = Object.freeze({
  "pre-allocation-vector-absent": ["v1", "v2"],
  "journal-pre-allocation-vector-present": ["v1", "v2"],
  "post-allocation-full-write": ["v1", "v2"],
  "post-allocation-no-write": ["v1", "v2"],
  "post-allocation-partial-write": ["v1", "v2"],
  "permit-release-won": ["v2"],
  "permit-transfer-won": ["v2"],
  "permit-corrupt-missing": ["v2"],
});
const SCHEMA_VALUES = Object.freeze(["v1", "v2"]);
const TAG_PORT_VALUES = Object.freeze(["zero", "unsealed-members"]);
const GENERATION_RULE_IDS = Object.freeze([
  "fired-from-observed-scheduled", "rearm-advances-scheduled-only", "platform-retry-keeps-fired",
  "self-rearm-fire-consumes-scheduled", "never-reattribute",
]);
const GENERATION_MUTATION_IDS = Object.freeze([
  "reattribute-to-latest", "overwrite-fired-at-rearm", "retrycount-as-invocation-key", "drop-scheduled-generation",
]);
const SEAL_ROWS = Object.freeze(["R03", "R04"]);
const EXPECTED_PARENT_LINK = Object.freeze(["X03e|X02|repair.lease.id + tag.key_hash"]);
const EXPECTED_REQUEST_V1 = Object.freeze(["S00", "S01", "S02", "S03", "S04", "S05a", "S05b", "S05c", "S05d", "S05e", "S06", "S07", "S08", "S09", "S10", "S11", "S12", "S13", "S14", "S15", "S17", "S18", "S19", "S20"]);
const EXPECTED_REQUEST_V2 = Object.freeze(["S00", "S01", "S02", "S03", "S04", "S05a", "S05b", "S05c", "S05d", "S05e", "S06", "S07", "S08", "P01", "P02a", "P02b", "P03", "P04", "P05", "S11", "S12", "S15", "S17", "S18", "S19", "S20"]);
const EXPECTED_RECONCILE = Object.freeze(["R00", "R01", "R02", "R03", "R04", "R05", "R06", "R08", "R09", "R10", "R11"]);
const EXPECTED_REPAIR = Object.freeze(["X00", "X01", "X02", "X03e", "X03r", "X03p"]);
const VALID_REASONS = Object.freeze(["quoted-source", "legacy-stored-field", "prohibition-rule-statement"]);
const SHA256_TRUNCATED = /^sha256:[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{40}$/;
const TOKEN = /(?<![A-Za-z])epoch(?![A-Za-z])/g;

function fail(code, message) {
  throw new Error("commit-trace-generate:" + code + (message === undefined ? "" : ":" + message));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !same(Object.keys(value), expected)) {
    fail(label + " has unexpected keys");
  }
}

function exactSet(actual, expected, label) {
  if (!same([...actual].sort(), [...expected].sort())) {
    fail(label + " differs: actual=" + JSON.stringify([...actual].sort()) + " expected=" + JSON.stringify([...expected].sort()));
  }
}

function digest(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function textDigest(text) {
  return digest(Buffer.from(text, "utf8"));
}

function readText(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function jsonText(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function rowsFor(schema, name) {
  if (!Array.isArray(schema?.rows)) fail(name + " rows must be an array");
  const ids = schema.rows.map((row) => row?.rowId);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
    fail(name + " row ids must be non-empty and unique");
  }
  return ids;
}

function validateParents(rows, name) {
  const ids = new Set(rows.map((row) => row.rowId));
  const parent = new Map(rows.map((row) => [row.rowId, row.logicalParent]));
  for (const row of rows) {
    const value = row.logicalParent;
    if (value === null || value === "provider-subrequest") continue;
    if (typeof value !== "string" || !ids.has(value)) fail(name + "/" + row.rowId + " parent is missing");
    if (value === row.rowId) fail(name + "/" + row.rowId + " is its own parent");
  }
  for (const row of rows) {
    const seen = new Set();
    let cursor = row.rowId;
    while (parent.get(cursor) !== null && parent.get(cursor) !== undefined && parent.get(cursor) !== "provider-subrequest") {
      cursor = parent.get(cursor);
      if (seen.has(cursor)) fail(name + " contains a parent cycle");
      seen.add(cursor);
    }
  }
}

function validateBoundary(boundary, universe, name) {
  if (!boundary || typeof boundary !== "object") fail(name + " boundary is malformed");
  const required = boundary.requiredRows;
  const conditional = boundary.conditionalRows;
  const forbidden = boundary.forbiddenRows;
  if (!Array.isArray(required) || !Array.isArray(conditional) || !Array.isArray(forbidden)) fail(name + " boundary rows are malformed");
  const conditionalIds = conditional.map((entry) => {
    exactKeys(entry, ["rowId", "predicate", "instanceCount", "whenTrue", "whenFalse"], name + " conditional row");
    if (typeof entry.rowId !== "string" || typeof entry.predicate !== "string" || entry.predicate.trim().length === 0 || entry.instanceCount === null || entry.instanceCount === "" || entry.whenTrue !== "required" || entry.whenFalse !== "forbidden") {
      fail(name + " conditional row is invalid");
    }
    return entry.rowId;
  });
  const all = [...required, ...conditionalIds, ...forbidden];
  if (new Set(all).size !== all.length) fail(name + " boundary has overlapping row sets");
  exactSet(all, universe, name + " boundary universe");
  if (typeof boundary.stateAssertion !== "string" || boundary.stateAssertion.trim().length === 0) fail(name + " boundary state assertion is empty");
}

function validateBoundaries(schema, universe, name) {
  const requiresBoundaries = ["sdt.commit/v1", "sdt.commit/v2", "sdt.commit.repair/v1"].includes(name);
  if (!Array.isArray(schema?.boundaries)) {
    if (requiresBoundaries) fail(name + " boundaries must be an array");
    return;
  }
  for (const boundary of schema.boundaries) validateBoundary(boundary, universe, name + "/" + boundary.name);
}

function validateRowsUniverse(rows, universe, name, extras = []) {
  const ids = rows.map((row) => typeof row === "string" ? row : row.rowId);
  exactSet(ids.filter((id) => !extras.includes(id)), universe, name + " row/universe partition");
  for (const id of extras) if (!ids.includes(id)) fail(name + " is missing its extra row " + id);
}

function rowsById(manifest) {
  const result = new Map();
  for (const schema of Object.values(manifest.schemas ?? {})) {
    for (const row of schema.rows ?? []) result.set(row.rowId, row);
  }
  return result;
}

function validateAttributes(manifest) {
  const matrix = manifest.attributeMatrix;
  exactSet(matrix?.faces ?? [], ["pre-admission", "accepted", "reconcile-root", "repair-root"], "attribute faces");
  exactSet(matrix?.states ?? [], ["required", "optional", "forbidden"], "attribute states");
  exactSet(Object.keys(matrix?.attributes ?? {}), EXPECTED_ATTRIBUTES, "attribute identity");
  if (Object.keys(matrix.attributes).length !== 30) fail("attribute matrix must contain 30 attributes");
  const rows = rowsById(manifest);
  for (const [attribute, declaration] of Object.entries(matrix.attributes)) {
    if (typeof declaration.type !== "string") fail(attribute + " is missing its type");
    exactSet(Object.keys(declaration.faces ?? {}), ["pre-admission", "accepted", "reconcile-root", "repair-root"], attribute + " face set");
    for (const state of Object.values(declaration.faces ?? {})) if (!["required", "optional", "forbidden"].includes(state)) fail(attribute + " has an invalid state");
    if (declaration.type === "enum" && (!Array.isArray(declaration.values) || declaration.values.length === 0)) fail(attribute + " enum has no values");
    if (declaration.type === "provider-adapter" && Object.values(declaration.faces).includes("required")) fail(attribute + " provider field is required");
    if (declaration.rowScope !== undefined) {
      if (!Array.isArray(declaration.rowScope) || declaration.rowScope.length === 0) fail(attribute + " rowScope is empty or malformed");
      if (new Set(declaration.rowScope).size !== declaration.rowScope.length) fail(attribute + " rowScope repeats a row");
      for (const rowId of declaration.rowScope) if (!rows.has(rowId)) fail(attribute + " rowScope names an unknown row");
      if (declaration.factDerived === true && !same(declaration.rowScope, ["R00"])) fail(attribute + " fact-derived scope is not rooted");
    }
  }
  if (matrix.attributes["attempt.id"].faces["pre-admission"] !== "forbidden" || matrix.attributes["attempt.id"].faces.accepted !== "required") fail("attempt identity faces are invalid");
  if (matrix.attributes["tag.key_hash"].faces["pre-admission"] !== "forbidden") fail("tag identity is allowed before admission");
  if (matrix.attributes["http.status"].faces["reconcile-root"] !== "forbidden") fail("http status is allowed on the recovery root");
  if (matrix.attributes["recovery.kind"].rowScope?.join("|") !== "R00" || matrix.attributes["recovery.kind"].factDerived !== true) fail("recovery kind scope is invalid");
  const memberRows = new Set([...rows.values()].filter((row) => ["fanout-member", "sequential-member"].includes(row.kind)).map((row) => row.rowId));
  for (const attribute of ["member.index", "tag.key_hash"]) {
    const scope = new Set(matrix.attributes[attribute].rowScope ?? []);
    if ([...memberRows].some((rowId) => !scope.has(rowId))) fail(attribute + " misses a member row");
    if ([...scope].some((rowId) => !memberRows.has(rowId))) fail(attribute + " includes a non-member row");
  }
  const kinds = new Set(matrix.attributes["span.kind"].values);
  const used = new Set([...rows.values()].map((row) => row.kind));
  if ([...used].some((kind) => !kinds.has(kind))) fail("span.kind misses a row kind");
  if ([...kinds].some((kind) => !used.has(kind))) fail("span.kind contains an unused kind");
}

function validateRecovery(manifest) {
  const reconcile = manifest.schemas["sdt.commit.reconcile/v1"];
  exactSet(Object.keys(reconcile.recoveryDag ?? {}), EXPECTED_RECOVERY, "recovery kind identity");
  const universe = EXPECTED_RECONCILE;
  const knownTransitions = new Set(["pre-takeover", "takeover-done", "[v2:transfer-done]", "transfer-done", "sealed", "terminal"]);
  const validateRecoveryRows = (kind, branch, terminalAtEntry = false) => {
    if (!Array.isArray(branch.requiredRows) || !Array.isArray(branch.conditionalRows) || !Array.isArray(branch.forbiddenRows)) fail(kind + " row sets are malformed");
    const conditionalIds = branch.conditionalRows.map((entry) => {
      exactKeys(entry, ["rowId", "predicate", "instanceCount", "whenTrue", "whenFalse"], kind + " conditional row");
      if (typeof entry.predicate !== "string" || entry.predicate.trim().length === 0 || entry.instanceCount === null || entry.instanceCount === "" || entry.whenTrue !== "required" || entry.whenFalse !== "forbidden") fail(kind + " conditional row is invalid");
      return entry.rowId;
    });
    const rows = [...branch.requiredRows, ...conditionalIds, ...branch.forbiddenRows];
    if (new Set(rows).size !== rows.length) fail(kind + " has overlapping recovery rows");
    exactSet(rows, universe, kind + " recovery universe");
    if (typeof branch.factPredicate !== "string" || branch.factPredicate.trim().length === 0 || !TAG_PORT_VALUES.includes(branch.tagMutationPortCount) || typeof branch.terminalOutcome !== "string" || branch.terminalOutcome.trim().length === 0 || !Array.isArray(branch.appliesToSchema) || branch.appliesToSchema.length === 0 || branch.appliesToSchema.some((value) => !SCHEMA_VALUES.includes(value))) fail(kind + " recovery declaration is invalid");
    if (branch.tagMutationPortCount === "zero" && (!branch.forbiddenRows.includes("R03") || !branch.forbiddenRows.includes("R04"))) fail(kind + " zero tag mutation must forbid R03/R04");
    if (branch.tagMutationPortCount === "zero" && branch.requiredRows.includes("R09") && !branch.terminalOutcome.includes("cancel")) fail(kind + " cancel barrier is not declared");
    if (branch.tagMutationPortCount === "unsealed-members" && (!branch.requiredRows.includes("R03") || !branch.requiredRows.includes("R04"))) fail(kind + " unsealed members must require R03/R04");
    const hasTransitions = Object.prototype.hasOwnProperty.call(branch, "transitions");
    if (terminalAtEntry) {
      if (!same(branch.requiredRows, ["R00", "R08"]) || branch.requiredRows.includes("R02") || branch.requiredRows.includes("R06")) fail(kind + " terminal entry must do no recovery work");
    } else {
      if (!branch.requiredRows.includes("R01")) fail("recovery-r01", kind + " must require R01");
      if (!branch.forbiddenRows.includes("R08")) fail("recovery-r08", kind + " must forbid R08");
      if (kind === "permit-transfer-won" && branch.forbiddenRows.includes("R05")) fail("recovery-transfer-r05: permit-transfer-won must not forbid R05");
      if (!hasTransitions) fail(kind + " transitions are invalid");
    }
    if (hasTransitions) {
      if (!Array.isArray(branch.transitions) || branch.transitions.length === 0 || branch.transitions[0] !== "pre-takeover") fail(kind + " transitions are invalid");
      if (branch.transitions.some((value) => !knownTransitions.has(value))) fail(kind + " has an unknown transition");
      const terminatesInvocation = branch.terminatesInvocation === undefined ? true : branch.terminatesInvocation;
      if (typeof terminatesInvocation !== "boolean" || typeof branch.terminalOutcome !== "string") fail(kind + " termination declaration is invalid");
      if (terminatesInvocation && branch.transitions.at(-1) !== "terminal") fail(kind + " terminating branch does not end at terminal");
      if (!terminatesInvocation && (branch.transitions.at(-1) === "terminal" || !branch.terminalOutcome.includes("NON-TERMINAL") || !branch.forbiddenRows.includes("R06"))) fail(kind + " non-terminating branch is invalid");
    }
  };
  for (const [kind, branch] of Object.entries(reconcile.recoveryDag ?? {})) {
    validateRecoveryRows(kind, branch);
    if (!same([...branch.appliesToSchema].sort(), [...(RECOVERY_KIND_OWNERSHIP[kind] ?? [])].sort())) fail(kind + " appliesToSchema is invalid");
  }
  const terminal = reconcile.terminalAtEntryBoundary;
  if (!terminal || terminal.name !== "terminal-at-entry") fail("terminal-at-entry boundary is invalid");
  validateRecoveryRows("terminal-at-entry", terminal, true);
  if (!same([...terminal.appliesToSchema].sort(), [...SCHEMA_VALUES].sort())) fail("terminal-at-entry appliesToSchema is invalid");
}

function validateGeneration(manifest) {
  const machine = manifest.schemas["sdt.commit.reconcile/v1"].generationStateMachine;
  exactSet(Object.keys(machine?.fields ?? {}), ["firedGenerationId", "scheduledGenerationId"], "generation fields");
  const rules = machine?.rules ?? [];
  exactSet(rules.map((entry) => entry.ruleId), GENERATION_RULE_IDS, "generation rule identity");
  if (new Set(rules.map((entry) => entry.ruleId)).size !== rules.length || rules.some((entry) => typeof entry.text !== "string" || entry.text.trim().length === 0)) fail("generation rules are invalid");
  const mutations = machine?.mutations ?? [];
  exactSet(mutations.map((entry) => entry.mutationId), GENERATION_MUTATION_IDS, "generation mutation identity");
  if (new Set(mutations.map((entry) => entry.mutationId)).size !== mutations.length || mutations.some((entry) => typeof entry.text !== "string" || entry.text.trim().length === 0)) fail("generation mutations are invalid");
}

function validateSeals(manifest) {
  const seals = manifest.schemas["sdt.commit.reconcile/v1"].sealPredicates;
  const rows = rowsFor(manifest.schemas["sdt.commit.reconcile/v1"], "reconcile");
  for (const version of SCHEMA_VALUES) {
    const entry = seals?.[version];
    if (!entry || !same([...entry.rows].sort(), [...SEAL_ROWS].sort()) || typeof entry.predicate !== "string" || entry.predicate.trim().length === 0) fail("seal predicate " + version + " is invalid");
  }
  if (!rows.includes("R03") || !rows.includes("R04") || seals.v1.permitDependent !== false || seals.v1.boundTo !== "journalTakeoverPrefix" || seals.v2.permitDependent !== true || seals.v2.boundTo !== "journalOwnerEpoch") fail("seal predicate declarations are invalid");
}

function validateLinks(manifest) {
  const links = manifest.schemas["sdt.commit.repair/v1"].parentLinks ?? [];
  const identities = links.map((entry) => [entry.row, entry.linkedTo, entry.via].join("|"));
  if (new Set(identities).size !== identities.length || !same(identities.sort(), [...EXPECTED_PARENT_LINK].sort())) fail("repair parent links are invalid");
  const rows = new Map(manifest.schemas["sdt.commit.repair/v1"].rows.map((row) => [row.rowId, row]));
  for (const link of links) {
    if (!rows.has(link.row) || !rows.has(link.linkedTo) || typeof link.via !== "string" || link.via.length === 0 || rows.get(link.row).logicalParent === link.linkedTo) fail("repair parent link points at an invalid row");
  }
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 2 || manifest?.name !== "commit-trace-manifest") fail("manifest schema/name is invalid");
  exactSet(Object.keys(manifest.schemas ?? {}), EXPECTED_SCHEMAS, "schema identity");
  const v1 = manifest.schemas["sdt.commit/v1"];
  const v2 = manifest.schemas["sdt.commit/v2"];
  const reconcile = manifest.schemas["sdt.commit.reconcile/v1"];
  const repair = manifest.schemas["sdt.commit.repair/v1"];
  const v1Rows = rowsFor(v1, "v1");
  const v2Rows = rowsFor(v2, "v2");
  const reconcileRows = rowsFor(reconcile, "reconcile");
  const repairRows = rowsFor(repair, "repair");
  validateRowsUniverse(v1Rows, EXPECTED_REQUEST_V1, "v1", ["S16"]);
  validateRowsUniverse(v2Rows, EXPECTED_REQUEST_V2, "v2", ["S16"]);
  validateRowsUniverse(reconcileRows, EXPECTED_RECONCILE, "reconcile");
  validateRowsUniverse(repairRows, EXPECTED_REPAIR, "repair");
  for (const [name, schema] of Object.entries(manifest.schemas)) {
    validateParents(schema.rows, name);
    const universe = name === "sdt.commit/v1" ? EXPECTED_REQUEST_V1 : name === "sdt.commit/v2" ? EXPECTED_REQUEST_V2 : name === "sdt.commit.reconcile/v1" ? EXPECTED_RECONCILE : EXPECTED_REPAIR;
    validateBoundaries(schema, universe, name);
  }
  if (!same(manifest.remoteInvocationUniverse, ["S16"]) || !v1Rows.includes("S16") || v1.universe.includes("S16")) fail("remote invocation partition is invalid");
  exactSet(v1.universe, EXPECTED_REQUEST_V1, "v1 universe");
  exactSet(v2.universe, EXPECTED_REQUEST_V2, "v2 universe");
  exactSet(reconcile.universe, EXPECTED_RECONCILE, "reconcile universe");
  exactSet(repair.universe, EXPECTED_REPAIR, "repair universe");
  const requestIds = v1Rows.filter((row) => row !== "S16");
  exactSet(requestIds, EXPECTED_REQUEST_V1, "v1 row partition");
  exactSet(v2Rows.filter((row) => row !== "S16"), EXPECTED_REQUEST_V2, "v2 row partition");
  if (new Set([...v1Rows, ...v2Rows]).size !== 31) fail("request row identity partition is invalid");
  validateAttributes(manifest);
  validateRecovery(manifest);
  validateGeneration(manifest);
  validateSeals(manifest);
  validateLinks(manifest);
  const mappingSeen = new Set();
  for (const entry of manifest.v1ToV2Mapping ?? []) {
    for (const side of ["v1", "v2"]) {
      if (entry[side] === null) continue;
      const key = side + ":" + entry[side];
      if (mappingSeen.has(key)) fail("mapping row appears in multiple buckets");
      mappingSeen.add(key);
    }
  }
  return {
    schemas: Object.keys(manifest.schemas).length,
    attributes: Object.keys(manifest.attributeMatrix.attributes).length,
    v1Rows: v1Rows.length,
    recoveryKinds: Object.keys(reconcile.recoveryDag).length,
  };
}

function scanNormative(root) {
  const occurrences = [];
  for (const relativePath of NORMATIVE_PATHS) {
    let section = "(preamble)";
    let ordinal = 0;
    const lines = readText(root, relativePath).split("\n");
    for (const line of lines) {
      if (line.startsWith("#")) section = line.replace(/^#+\s*/, "").trim();
      const matches = [...line.matchAll(TOKEN)];
      for (let occurrenceIndex = 0; occurrenceIndex < matches.length; occurrenceIndex += 1) {
        occurrences.push({
          documentId: relativePath,
          stableSectionId: section,
          exactToken: "epoch",
          contextDigest: "sha256:" + createHash("sha256").update(line.trim().replace(/\s+/g, " "), "utf8").digest("hex").slice(0, 32),
          occurrenceIndex,
          documentOccurrenceOrdinal: ordinal,
          columnHint: matches[occurrenceIndex].index,
        });
        ordinal += 1;
      }
    }
  }
  return occurrences;
}

function loadReasons(root) {
  const value = JSON.parse(readText(root, CURATED_REL));
  exactKeys(value, ["schemaVersion", "description", "reasons"], "curated reasons");
  if (value.schemaVersion !== 1 || typeof value.description !== "string" || !Array.isArray(value.reasons)) fail("curated reasons shape is invalid");
  const result = new Map();
  for (const entry of value.reasons) {
    exactKeys(entry, ["documentId", "contextDigest", "occurrenceIndex", "documentOccurrenceOrdinal", "reason", "note"], "curated reason");
    if (!NORMATIVE_PATHS.includes(entry.documentId) || !SHA256_TRUNCATED.test(entry.contextDigest) || !Number.isInteger(entry.occurrenceIndex) || !Number.isInteger(entry.documentOccurrenceOrdinal) || !VALID_REASONS.includes(entry.reason) || typeof entry.note !== "string" || entry.note.length === 0) fail("curated reason entry is invalid");
    const key = [entry.documentId, entry.contextDigest, entry.occurrenceIndex, entry.documentOccurrenceOrdinal].join("|");
    if (result.has(key)) fail("curated reason key is duplicated");
    result.set(key, entry.reason);
  }
  return result;
}

function buildAllowlist(root) {
  const occurrences = scanNormative(root);
  const reasons = loadReasons(root);
  const entries = [];
  const exclusions = [];
  const used = new Set();
  for (const occurrence of occurrences) {
    const key = [occurrence.documentId, occurrence.contextDigest, occurrence.occurrenceIndex, occurrence.documentOccurrenceOrdinal].join("|");
    const reason = reasons.get(key);
    if (!reason) fail("unclassified naked epoch in " + occurrence.documentId + " at ordinal " + occurrence.documentOccurrenceOrdinal);
    used.add(key);
    const item = {
      documentId: occurrence.documentId,
      stableSectionId: occurrence.stableSectionId,
      exactToken: occurrence.exactToken,
      contextDigest: occurrence.contextDigest,
      occurrenceIndex: occurrence.occurrenceIndex,
      documentOccurrenceOrdinal: occurrence.documentOccurrenceOrdinal,
      reason,
    };
    (reason === "prohibition-rule-statement" ? exclusions : entries).push(item);
  }
  for (const key of reasons.keys()) if (!used.has(key)) fail("curated reason is unused: " + key);
  return {
    schemaVersion: 4,
    name: "epoch-namespace-allowlist",
    description: "Occurrence-level classification of every naked epoch in the normative documents. The committed file is the authority; --check never rewrites it.",
    digest: {
      algorithm: "sha256",
      truncatedHexChars: 32,
      canonicalization: "v1: strip, collapse whitespace runs, UTF-8, hash the single line",
    },
    scanScope: {
      documents: [...NORMATIVE_PATHS],
      tokenPattern: "(?<![A-Za-z])epoch(?![A-Za-z])",
      granularity: "occurrence (documentId, contextDigest, occurrenceIndex, documentOccurrenceOrdinal)",
      note: "The scan scope is limited to the two public normative documents.",
    },
    logicalNames: ["leaseEpoch", "pinnedWriterEpoch", "tombstoneEpoch", "epoch", "repairEpoch"],
    reasonSource: "contracts/epoch-reasons.curated.json (curated; no default reason exists)",
    exclusions: {
      kind: "exact-occurrence",
      expectedCount: exclusions.length,
      entries: exclusions,
      rule: "Only occurrences that state a prohibition rule itself are excluded.",
    },
    expectedCount: entries.length,
    entries,
  };
}

function renderViews(manifest, allowlist) {
  const lines = [
    "# RENDERED VIEWS (generated — do not edit)",
    "",
    "Generated from the commit-trace manifest and epoch allowlist by scripts/commit-trace-generate.mjs.",
    "The normative documents define the public scan scope.",
    "",
  ];
  for (const [schemaName, schema] of Object.entries(manifest.schemas)) {
    lines.push("## " + schemaName, "");
    lines.push("| rowId | span | emitter | start | end | parent | coverage | kind | success cardinality |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const row of schema.rows) lines.push("| " + ["rowId", "span", "emitter", "start", "end", "logicalParent", "coverage", "kind", "successCardinality"].map((key) => String(row[key])).join(" | ") + " |");
    lines.push("");
    for (const boundary of schema.boundaries ?? []) {
      lines.push("### boundary: " + boundary.name, "");
      lines.push("- required: " + (boundary.requiredRows.join(", ") || "(none)"));
      lines.push("- conditional: " + (boundary.conditionalRows.map((entry) => entry.rowId + " [" + entry.predicate + "]").join(", ") || "(none)"));
      lines.push("- forbidden: " + (boundary.forbiddenRows.join(", ") || "(none)"));
      lines.push("- state: " + boundary.stateAssertion, "");
    }
  }
  lines.push("## epoch allowlist summary", "");
  lines.push("- entries: " + allowlist.expectedCount);
  lines.push("- exclusions: " + allowlist.exclusions.expectedCount);
  lines.push("- documents: " + allowlist.scanScope.documents.join(", "), "");
  return lines.join("\n").replace(/\n+$/, "");
}

function buildManifest() {
  const manifest = structuredClone(MANIFEST_LITERAL);
  validateManifest(manifest);
  return manifest;
}

export function assertManifest(manifest) {
  const structure = validateManifest(manifest);
  if (!same(manifest, MANIFEST_LITERAL)) fail("manifest-authority: manifest differs from the generator literal");
  return structure;
}

function authorityBytes(root, generatedFiles) {
  return new Map(AUTHORITY_SPECS.map(([relativePath]) => {
    const body = generatedFiles.get(relativePath) ?? readText(root, relativePath);
    return [relativePath, Buffer.from(body, "utf8")];
  }));
}

function buildBundle(root, generatedFiles) {
  const bytesByPath = authorityBytes(root, generatedFiles);
  const authorityFiles = AUTHORITY_SPECS.map(([path, role]) => {
    const bytes = bytesByPath.get(path);
    return { path, role, bytes: bytes.byteLength, digest: digest(bytes) };
  });
  const material = ["sekiban-dcb-ts/commit-trace-bundle/v4", ...authorityFiles.map((entry) => [entry.path, entry.role, entry.bytes, entry.digest].join("\t"))].join("\n");
  return {
    schemaVersion: 4,
    name: "commit-trace-bundle",
    description: "Repository-owned commit-trace authority: public sources, deterministic generator outputs, and checkers sealed by a local A/S pair.",
    authorityFiles,
    bundleDigest: textDigest(material),
  };
}

export function buildGenerated(root = REPO_ROOT) {
  const manifest = buildManifest();
  const allowlist = buildAllowlist(root);
  const rendered = renderViews(manifest, allowlist);
  const files = new Map([
    [RENDERED_REL, rendered + "\n"],
    [MANIFEST_REL, jsonText(manifest)],
    [ALLOWLIST_REL, jsonText(allowlist)],
  ]);
  const bundle = buildBundle(root, files);
  return Object.freeze({ files, bundle, manifest, allowlist });
}

export function checkGenerated(root = REPO_ROOT) {
  const expected = buildGenerated(root);
  for (const [relativePath, body] of expected.files) {
    if (!existsSync(join(root, relativePath)) || readText(root, relativePath) !== body) fail(relativePath + " differs from generated output");
  }
  const bundleBody = jsonText(expected.bundle);
  if (!existsSync(join(root, BUNDLE_REL)) || readText(root, BUNDLE_REL) !== bundleBody) fail(BUNDLE_REL + " differs from generated output");
  return Object.freeze({ generated: [...expected.files.keys()], bundleDigest: expected.bundle.bundleDigest, epochEntries: expected.allowlist.expectedCount, epochExclusions: expected.allowlist.exclusions.expectedCount });
}


export function gitEnv({ isolateGlobal = false } = {}) {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    ...(isolateGlobal ? { GIT_CONFIG_GLOBAL: "/dev/null" } : {}),
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_AUTHOR_") || name.startsWith("GIT_COMMITTER_") || ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].includes(name)) delete env[name];
  }
  return env;
}

export function gitOutput(root, args, env = gitEnv()) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env });
}

export function gitText(root, args, env = gitEnv()) {
  return gitOutput(root, args, env).trim();
}

export function gitBlob(root, spec, env = gitEnv()) {
  try {
    return execFileSync("git", ["show", spec], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function exactPinObject(value, state, authorityCommit, bundleDigest) {
  return same(value, { schemaVersion: 3, state, authorityCommit, bundleDigest });
}

function makePin(bundleDigest, state, authorityCommit) {
  return { schemaVersion: 3, state, authorityCommit, bundleDigest };
}

export function writeAuthority(root = REPO_ROOT) {
  const expected = buildGenerated(root);
  for (const [relativePath, body] of expected.files) writeFileSync(join(root, relativePath), body, "utf8");
  writeFileSync(join(root, BUNDLE_REL), jsonText(expected.bundle), "utf8");
  writeFileSync(join(root, PIN_REL), jsonText(makePin(expected.bundle.bundleDigest, "unsealed", "0".repeat(40))), "utf8");
  return { written: [...expected.files.keys(), BUNDLE_REL, PIN_REL], bundleDigest: expected.bundle.bundleDigest };
}

export function sealAuthority(root = REPO_ROOT, authorityCommit) {
  if (!SHA.test(authorityCommit)) fail("seal requires a full 40-hex authority commit");
  const head = gitText(root, ["rev-parse", "HEAD"]);
  if (head !== authorityCommit) fail("seal requires HEAD to equal the authority commit");
  const expected = buildGenerated(root);
  checkGenerated(root);
  const authorityPaths = new Set([...AUTHORITY_SPECS.map(([path]) => path), BUNDLE_REL]);
  const headPin = gitBlob(root, "HEAD:" + PIN_REL);
  const indexPin = gitBlob(root, ":" + PIN_REL);
  const workingPin = Buffer.from(readText(root, PIN_REL), "utf8");
  if (!headPin || !indexPin || !headPin.equals(indexPin) || !headPin.equals(workingPin)) {
    fail("seal-pin-drift", "the pin index and worktree must equal the HEAD blob before sealing");
  }
  const status = gitOutput(root, ["status", "--porcelain", "--"]);
  const dirty = status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/\r$/, "")).filter(Boolean);
  if (dirty.some((path) => authorityPaths.has(path))) fail("authority paths are dirty; commit A before sealing");
  for (const path of authorityPaths) {
    const blob = gitBlob(root, "HEAD:" + path);
    const expectedBody = path === BUNDLE_REL ? jsonText(expected.bundle) : expected.files.get(path) ?? readText(root, path);
    if (!blob || !blob.equals(Buffer.from(expectedBody, "utf8"))) fail("authority bytes at HEAD are not the generated bytes");
  }
  const placeholder = JSON.parse(readText(root, PIN_REL));
  if (!exactPinObject(placeholder, "unsealed", "0".repeat(40), expected.bundle.bundleDigest)) fail("seal requires the exact placeholder pin");
  const committedPin = gitBlob(root, "HEAD:" + PIN_REL);
  if (!committedPin || !committedPin.equals(Buffer.from(jsonText(placeholder), "utf8"))) fail("seal requires the committed placeholder pin");
  writeFileSync(join(root, PIN_REL), jsonText(makePin(expected.bundle.bundleDigest, "sealed", authorityCommit)), "utf8");
  return { sealed: PIN_REL, authorityCommit, bundleDigest: expected.bundle.bundleDigest };
}

export function selfTest(root = REPO_ROOT) {
  const expected = buildGenerated(root);
  const occurrences = scanNormative(root);
  const reasons = loadReasons(root);
  const expectedEntries = occurrences.filter((occurrence) => reasons.get([occurrence.documentId, occurrence.contextDigest, occurrence.occurrenceIndex, occurrence.documentOccurrenceOrdinal].join("|")) !== "prohibition-rule-statement").length;
  const expectedExclusions = occurrences.length - expectedEntries;
  if (expected.allowlist.expectedCount !== expectedEntries || expected.allowlist.exclusions.expectedCount !== expectedExclusions) fail("self-test epoch classification counts disagree with source content");
  const recoveryMutations = [
    ["recovery-r01-required", (manifest) => {
      const branch = manifest.schemas["sdt.commit.reconcile/v1"].recoveryDag["post-allocation-full-write"];
      branch.requiredRows = branch.requiredRows.filter((row) => row !== "R01");
      branch.forbiddenRows.push("R01");
    }, "recovery-r01:"],
    ["recovery-r08-forbidden", (manifest) => {
      const branch = manifest.schemas["sdt.commit.reconcile/v1"].recoveryDag["post-allocation-full-write"];
      branch.forbiddenRows = branch.forbiddenRows.filter((row) => row !== "R08");
      branch.requiredRows.push("R08");
    }, "recovery-r08:"],
    ["recovery-transfer-r05", (manifest) => {
      const branch = manifest.schemas["sdt.commit.reconcile/v1"].recoveryDag["permit-transfer-won"];
      branch.requiredRows = branch.requiredRows.filter((row) => row !== "R05");
      branch.forbiddenRows.push("R05");
    }, "recovery-transfer-r05:"],
    ["recovery-terminal-conditional-invalid", (manifest) => {
      const boundary = manifest.schemas["sdt.commit.reconcile/v1"].terminalAtEntryBoundary;
      boundary.forbiddenRows = boundary.forbiddenRows.filter((row) => row !== "R06");
      boundary.conditionalRows.push({ rowId: "R06", predicate: "", instanceCount: 1, whenTrue: "required", whenFalse: "forbidden" });
    }, "terminal-at-entry conditional row is invalid"],
    ["recovery-terminal-conditional-overlap", (manifest) => {
      const boundary = manifest.schemas["sdt.commit.reconcile/v1"].terminalAtEntryBoundary;
      boundary.conditionalRows.push({ rowId: "R06", predicate: "a terminal boundary condition", instanceCount: 1, whenTrue: "required", whenFalse: "forbidden" });
    }, "terminal-at-entry has overlapping recovery rows"],
    ["recovery-terminal-universe", (manifest) => {
      const boundary = manifest.schemas["sdt.commit.reconcile/v1"].terminalAtEntryBoundary;
      boundary.forbiddenRows = boundary.forbiddenRows.filter((row) => row !== "R11");
    }, "terminal-at-entry recovery universe"],
    ["recovery-terminal-transition-unknown", (manifest) => {
      const boundary = manifest.schemas["sdt.commit.reconcile/v1"].terminalAtEntryBoundary;
      boundary.transitions = ["pre-takeover", "bogus"];
    }, "terminal-at-entry has an unknown transition"],
    ["recovery-terminal-transition-start", (manifest) => {
      const boundary = manifest.schemas["sdt.commit.reconcile/v1"].terminalAtEntryBoundary;
      boundary.transitions = ["terminal"];
    }, "terminal-at-entry transitions are invalid"],
    ["boundaries-required", (manifest) => {
      delete manifest.schemas["sdt.commit/v1"].boundaries;
    }, "sdt.commit/v1 boundaries must be an array"],
  ];
  for (const [name, mutate, expectedMessage] of recoveryMutations) {
    const altered = structuredClone(expected.manifest);
    mutate(altered);
    try {
      validateManifest(altered);
    } catch (error) {
      if (!String(error).includes("commit-trace-generate:" + expectedMessage)) fail("self-test " + name + " failed for the wrong reason");
      continue;
    }
    fail("self-test " + name + " stayed green");
  }
  const fixture = mkdtempSync(join(tmpdir(), "sdt-g109-generate-"));
  try {
    for (const [path] of [...AUTHORITY_SPECS, [BUNDLE_REL, "generated"], [PIN_REL, "pin"]]) {
      const target = join(fixture, path);
      mkdirSync(resolve(target, ".."), { recursive: true });
      copyFileSync(join(root, path), target);
    }
    execFileSync("git", ["init", "-q"], { cwd: fixture, env: gitEnv({ isolateGlobal: true }), stdio: "ignore" });
    execFileSync("git", ["add", "--all"], { cwd: fixture, env: gitEnv({ isolateGlobal: true }), stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Commit Trace Generator Self Test", "-c", "user.email=commit-trace-generator@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "commit", "-m", "A"], { cwd: fixture, env: gitEnv({ isolateGlobal: true }), stdio: "ignore" });
    const authorityCommit = gitText(fixture, ["rev-parse", "HEAD"], gitEnv({ isolateGlobal: true }));
    const pin = JSON.parse(readText(fixture, PIN_REL));
    writeFileSync(join(fixture, PIN_REL), JSON.stringify(pin, null, 4) + "\n", "utf8");
    execFileSync("git", ["add", PIN_REL], { cwd: fixture, env: gitEnv({ isolateGlobal: true }), stdio: "ignore" });
    writeFileSync(join(fixture, PIN_REL), jsonText(pin), "utf8");
    const stagedStatus = gitOutput(fixture, ["status", "--porcelain", "--", PIN_REL], gitEnv({ isolateGlobal: true })).trimEnd();
    if (!stagedStatus.startsWith("MM ")) fail("self-test", "staged-only pin drift fixture is not MM");
    let rejected = false;
    try {
      sealAuthority(fixture, authorityCommit);
    } catch (error) {
      rejected = String(error).includes("commit-trace-generate:seal-pin-drift");
    }
    if (!rejected) fail("self-test staged-only pin drift stayed green");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  return { schema: "commit-trace-generate/v4", passed: true, generated: [...expected.files.keys()], epochEntries: expectedEntries, epochExclusions: expectedExclusions, mutations: [...recoveryMutations.map(([name]) => name), "staged-only-pin-drift"] };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  if (args.includes("--write")) {
    console.log(JSON.stringify(writeAuthority(), null, 2));
    return;
  }
  const sealIndex = args.indexOf("--seal");
  if (sealIndex >= 0) {
    const authorityCommit = args[sealIndex + 1];
    if (!authorityCommit) fail("--seal requires A");
    console.log(JSON.stringify(sealAuthority(REPO_ROOT, authorityCommit), null, 2));
    return;
  }
  if (args.length === 1 && args[0] === "--check") {
    console.log(JSON.stringify(checkGenerated(), null, 2));
    return;
  }
  fail("one of --write, --seal A, --check, or --self-test is required");
}

if (import.meta.url === "file://" + process.argv[1]) main();
