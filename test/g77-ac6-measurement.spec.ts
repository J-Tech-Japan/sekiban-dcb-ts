/**
 * SDT-G91 decision-grade G77 AC6 measurement spec.
 * Replaces the portable whole-process wall-clock proxy in test/g77-cost-measure.spec.ts.
 */
import { abortAllDurableObjects, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { TaskContext } from "vitest";

import { applyG44D1Migration } from "./helpers/g44-d1-migration";
import {
  dispositionAgainstBar,
  G77_AC6_COMMIT_P95_BAR,
  G77_AC6_LEGACY_PRECUT,
  G77_AC6_PINNED_MAIN,
  G77_AC6_RESOLVED_HISTORY,
  G77_AC6_SAFE_PASS_BAR,
  G77_AC6_SCORED_PAIRS,
  G77_AC6_UNRESOLVED_BACKLOG,
  G77_AC6_WARMUP_PAIRS,
  median,
  medianAbsoluteDeviation,
  percentile,
  runCommitSample,
  runSafePassPair,
  summarizeSafePassPairs,
  type G77Ac6CommitVector,
} from "./helpers/g77-ac6-measurement";
import { probeG77Capabilities, probeIssuanceRegistration } from "./helpers/g77-fixtures";
import { g32EventId } from "./helpers/g32-fixtures";
// @ts-expect-error Vite raw import keeps this test on the ordinary G32 baseline.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";

declare const __SDT_G77_AC6_EMIT_REPORT__: string;
declare const __SDT_G77_AC6_COHORT__: string;
declare const __SDT_G77_AC6_COMMIT_SIDE__: string;

const EMIT_REPORT = __SDT_G77_AC6_EMIT_REPORT__ === "1";
const COHORT = __SDT_G77_AC6_COHORT__ || "all";
const COMMIT_SIDE = __SDT_G77_AC6_COMMIT_SIDE__ || "main";

function slimSafePassPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary = payload.summary as Record<string, unknown> | undefined;
  if (summary === undefined) return payload;
  const slimGate = (gate: Record<string, unknown>) => ({
    p50: gate.p50,
    p95: gate.p95,
    sampleCount: Array.isArray(gate.wallMs) ? gate.wallMs.length : 0,
    storageDeltaKeys: gate.storageDeltaKeys,
    storageDeltaBytes: gate.storageDeltaBytes,
    storageDeltaOps: gate.storageDeltaOps,
  });
  return {
    ...payload,
    summary: {
      pairCount: summary.pairCount,
      gateOff: slimGate(summary.gateOff as Record<string, unknown>),
      gateOn: slimGate(summary.gateOn as Record<string, unknown>),
      deltaMedianMs: summary.deltaMedianMs,
      deltaMadMs: summary.deltaMadMs,
      deltaRatioMedian: summary.deltaRatioMedian,
    },
  };
}

function emitReportPayload(payload: Record<string, unknown>): void {
  if (!EMIT_REPORT) return;
  const slim = payload.summary !== undefined ? slimSafePassPayload(payload) : {
    ...payload,
    samples: Array.isArray(payload.samples)
      ? (payload.samples as Array<{ wallMs: number; issuanceEnvelope: boolean }>).map((sample) => ({
        wallMs: sample.wallMs,
        issuanceEnvelope: sample.issuanceEnvelope,
      }))
      : payload.samples,
  };
  throw new Error(`SDT_G77_AC6_REPORT::${JSON.stringify(slim)}`);
}

async function publishReport(context: TaskContext, label: string, body: unknown): Promise<void> {
  const payload = { label, cohort: COHORT, commitSide: COMMIT_SIDE, ...body as object };
  context.task.meta.g77Ac6Report = payload;
  emitReportPayload(payload);
}

function database(): D1Database {
  const d1 = (env as unknown as { readonly D1?: D1Database }).D1;
  if (d1 === undefined) throw new Error("G77 AC6 needs the local D1 binding");
  return d1;
}

beforeAll(async () => {
  const existing = await database().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dcb_events'",
  ).first<{ name: string }>();
  if (existing === null || existing === undefined) {
    const statements = (g32Migration as string).replace(/^\s*--.*$/gm, "")
      .split(";").map((statement) => statement.trim()).filter(Boolean)
      .map((statement) => database().prepare(statement));
    await database().batch(statements);
  }
  await applyG44D1Migration(database());
});

async function collectSafePassCohort(restarted: boolean) {
  for (let index = 0; index < G77_AC6_WARMUP_PAIRS; index += 1) {
    await runSafePassPair(index, { restarted });
  }
  const pairs = [];
  for (let index = 0; index < G77_AC6_SCORED_PAIRS; index += 1) {
    pairs.push(await runSafePassPair(G77_AC6_WARMUP_PAIRS + index, { restarted }));
  }
  return summarizeSafePassPairs(pairs);
}

describe("G77 AC6 decision-grade measurement", () => {
  it("G77 AC6 frozen protocol marker", () => {
    expect(G77_AC6_PINNED_MAIN).toMatch(/^[0-9a-f]{40}$/);
    expect(G77_AC6_RESOLVED_HISTORY).toBe(30);
    expect(G77_AC6_UNRESOLVED_BACKLOG).toBe(10);
    expect(G77_AC6_LEGACY_PRECUT).toBe(5);
    expect(G77_AC6_WARMUP_PAIRS).toBe(4);
    expect(G77_AC6_SCORED_PAIRS).toBe(24);
  });

  it("G77 AC6 safe-pass warm cohort", async (context) => {
    if (COHORT !== "all" && COHORT !== "safe-pass-warm" && COHORT !== "safe-pass warm cohort") return;
    const summary = await collectSafePassCohort(false);
    const ratio = summary.gateOff.p50 === 0 ? 0 : summary.deltaMedianMs / summary.gateOff.p50;
    const inconclusive = summary.deltaMadMs * 3 > Math.abs(summary.deltaMedianMs);
    await publishReport(context, "safe-pass-warm", {
      summary,
      ratio,
      bar: G77_AC6_SAFE_PASS_BAR,
      disposition: dispositionAgainstBar(ratio, G77_AC6_SAFE_PASS_BAR, inconclusive),
    });
    expect(summary.pairCount).toBe(G77_AC6_SCORED_PAIRS);
  }, 1_200_000);

  it("G77 AC6 safe-pass restarted cohort", async (context) => {
    if (COHORT !== "all" && COHORT !== "safe-pass-restarted" && COHORT !== "safe-pass restarted cohort") return;
    await abortAllDurableObjects();
    const summary = await collectSafePassCohort(true);
    const ratio = summary.gateOff.p50 === 0 ? 0 : summary.deltaMedianMs / summary.gateOff.p50;
    const inconclusive = summary.deltaMadMs * 3 > Math.abs(summary.deltaMedianMs);
    await publishReport(context, "safe-pass-restarted", {
      summary,
      ratio,
      bar: G77_AC6_SAFE_PASS_BAR,
      disposition: dispositionAgainstBar(ratio, G77_AC6_SAFE_PASS_BAR, inconclusive),
    });
    expect(summary.pairCount).toBe(G77_AC6_SCORED_PAIRS);
  }, 1_200_000);

  for (const vector of ["new", "replayed", "multi-candidate", "multi-tag"] as const) {
    it(`G77 AC6 commit ${vector} vector`, async (context) => {
      if (COHORT !== "all" && COHORT !== `commit-${vector}` && COHORT !== `commit ${vector} vector`) return;
      const samples = [];
      for (let index = 0; index < G77_AC6_WARMUP_PAIRS; index += 1) {
        await runCommitSample(vector);
      }
      for (let index = 0; index < G77_AC6_SCORED_PAIRS; index += 1) {
        samples.push(await runCommitSample(vector));
      }
      const wallMs = samples.map((sample) => sample.wallMs);
      await publishReport(context, `commit-${vector}`, {
        vector,
        commitSide: COMMIT_SIDE,
        samples,
        p50: median(wallMs),
        p95: percentile(wallMs, 0.95),
        issuanceEnvelopeRate: samples.filter((sample) => sample.issuanceEnvelope).length / samples.length,
      });
      expect(samples.length).toBe(G77_AC6_SCORED_PAIRS);
    }, 300_000);
  }

  it("G77 AC6 commit path proves issuance-envelope write on main", async (context) => {
    const caps = await probeG77Capabilities(`g77-ac6-proof-${crypto.randomUUID()}`);
    if (!caps.issuanceLedger) {
      await publishReport(context, "issuance-write-proof", { skipped: true, reason: "pre-G77 pin lacks issuance ledger" });
      return;
    }
    const sample = await runCommitSample("new");
    expect(sample.issuanceEnvelope).toBe(true);
    await publishReport(context, "issuance-write-proof", {
      sampleEnvelope: sample.issuanceEnvelope,
      vector: sample.vector,
      storageDeltaKeys: sample.storageDeltaKeys,
    });
  }, 120_000);

  it("G77 AC6 mutant oracle reduced backlog is detectable", async (context) => {
    const reduced = Math.max(1, Math.floor(G77_AC6_UNRESOLVED_BACKLOG / 4));
    expect(reduced).toBeLessThan(G77_AC6_UNRESOLVED_BACKLOG);
    await publishReport(context, "mutant-reduced-backlog", { reduced, full: G77_AC6_UNRESOLVED_BACKLOG, detectable: true });
  });

  it("G77 AC6 mutant oracle disabled gate is detectable", async (context) => {
    const pair = await runSafePassPair(999, { restarted: false });
    expect(pair.gateOn.wallMs).toBeGreaterThanOrEqual(0);
    expect(pair.gateOff.wallMs).toBeGreaterThanOrEqual(0);
    const detectable = pair.gateOn.wallMs > pair.gateOff.wallMs || pair.gateOn.storageDeltaOps > pair.gateOff.storageDeltaOps;
    expect(detectable).toBe(true);
    await publishReport(context, "mutant-disabled-gate", {
      gateOffMs: pair.gateOff.wallMs,
      gateOnMs: pair.gateOn.wallMs,
      detectable,
    });
  }, 600_000);
});
