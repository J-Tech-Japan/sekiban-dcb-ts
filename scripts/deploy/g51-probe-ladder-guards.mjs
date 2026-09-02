#!/usr/bin/env node
/** Focused non-live guards for the SDT-G51 AC5 retained-probe ladder. */
import { readFileSync } from "node:fs";
import { queryNamedSpanCohort } from "./g30-trace-export.mjs";

function fail(message) {
  throw new Error(`g51-probe-ladder-guards:${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const template = Object.freeze({
  limit: 2000,
  parameters: Object.freeze({
    filterCombination: "or",
    filters: Object.freeze([
      Object.freeze({ key: "$workers.scriptName", operation: "eq", type: "string", value: "sekiban-dcb-meeting-room-cloudflare-only" }),
      Object.freeze({ key: "$workers.scriptName", operation: "eq", type: "string", value: "sekiban-dcb-meeting-room-doorbell" }),
    ]),
  }),
});

const ledger = Object.freeze([
  Object.freeze({ requestId: "0000000000000001-SJC" }),
  Object.freeze({ requestId: "0000000000000002-SJC" }),
]);

async function exactProbeQueryKeepsOnlyTheNamedOneAttributeSpan() {
  let payload;
  const result = await queryNamedSpanCohort({
    accountId: "guard-account",
    token: "test-token",
    template,
    ledger,
    spanName: "sdt.g51.probe.p1",
    attributeKey: "sdt.g51.probe",
    attributeValue: "p1",
    requestTelemetry: async (input) => {
      payload = input.payload;
      return {
        result: {
          events: {
            events: [
              { $metadata: { rayId: "0000000000000001", spanName: "sdt.g51.probe.p1" }, source: { attributes: { "sdt.g51.probe": "p1" } } },
              { $metadata: { rayId: "0000000000000002", spanName: "sdt.g51.probe.p1" }, source: { attributes: { "sdt.g51.probe": "wrong-value" } } },
              { $metadata: { spanName: "sdt.g51.probe.p1" }, source: { attributes: { "sdt.g51.probe": "p1" } } },
              { $metadata: { rayId: "0000000000000001", spanName: "unrelated.span" }, source: { attributes: { "sdt.g51.probe": "p1" } } },
            ],
          },
        },
      };
    },
  });
  assert(result.retainedSpanCount === 3, "named probe count included or excluded the wrong provider events");
  assert(result.retainedRequestCount === 2, "exact cohort ray join was not retained");
  assert(result.attributeMatchedSpanCount === 2, "one-attribute match count is wrong");
  assert(result.attributeMatchedRequestCount === 1, "one-attribute request match count is wrong");
  assert(result.unjoinableRetainedSpanCount === 1, "rayless retained probe was not reported honestly");
  const filters = payload?.parameters?.filters;
  assert(Array.isArray(filters), "probe query did not use the bounded filter form");
  assert(filters.some((filter) => filter.key === "$metadata.spanName" && filter.value === "sdt.g51.probe.p1"), "probe query did not constrain the provider span name");
  assert(filters.some((filter) => filter.key === "$metadata.rayId" && filter.operation === "in"), "probe query did not constrain exact cohort rays");
  return {
    retainedSpanCount: result.retainedSpanCount,
    attributeMatchedRequestCount: result.attributeMatchedRequestCount,
    unjoinableRetainedSpanCount: result.unjoinableRetainedSpanCount,
  };
}

function p1RemainsAtThePublicFetchBoundary() {
  const source = readFileSync("samples/meeting-room/src/worker.cloudflare-only.ts", "utf8");
  const directP1 = /if \(path\.startsWith\("\/api\/commands\/"\)\) \{\s*return ctx\.tracing\.enterSpan\(G51_P1_PROBE_SPAN, \(span\) => \{\s*span\.setAttribute\(G51_PROBE_ATTRIBUTE, "p1"\);\s*return command\(request, env, ctx\);/s;
  assert(directP1.test(source), "P1 is no longer a direct public fetch-handler probe around command dispatch");
  const attributeCalls = source.match(/span\.setAttribute\(G51_PROBE_ATTRIBUTE, "p1"\)/g) ?? [];
  assert(attributeCalls.length === 1, "P1 must keep exactly one application attribute");
  return { directFetchBoundary: true, applicationAttributeCalls: attributeCalls.length };
}

process.stdout.write(`${JSON.stringify({
  exactProbeQuery: await exactProbeQueryKeepsOnlyTheNamedOneAttributeSpan(),
  p1Shape: p1RemainsAtThePublicFetchBoundary(),
  result: "g51-probe-ladder-guards-passed",
}, null, 2)}\n`);
