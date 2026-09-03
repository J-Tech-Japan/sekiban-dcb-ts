import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { CommitWorker, type CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import type { AllocatedCommitCandidate, ValidatedCommitEnvelope } from "../packages/dcb-runtime/src/commit/types";
import type { G43SqlMeasurementSnapshot } from "../packages/dcb-runtime/src/tag/TagSqlMeasurement";
import type { TagEvent, TagHeadFacts, TagRecord } from "../packages/dcb-runtime/src/tag/types";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./helpers/g32-fixtures";

interface Scope {
  readonly serviceId: string;
  readonly tag: string;
}

interface HeadFactsMeasurementSeam {
  beginG43SqlMeasurement(): void;
  completeG43SqlMeasurement(): G43SqlMeasurementSnapshot;
}

interface CommitSuccessResponseSeam {
  successResponse(
    input: ValidatedCommitEnvelope,
    candidates: AllocatedCommitCandidate[],
    attemptId: string,
    startedAt: number,
    fault: undefined,
  ): Promise<unknown>;
}

interface HeadFactsSample {
  readonly historySize: number;
  readonly rawBody: string;
  readonly expected: TagHeadFacts;
  readonly snapshot: G43SqlMeasurementSnapshot;
}

const FIXTURE_TAG = "room:g45-head-facts";
const FIXTURE_UPDATED_AT = "2026-08-29T12:34:56.789Z";
const SUID_BASE = 8_000_000;

function tagStub(value: Scope): DurableObjectStub {
  const namespace = (env as unknown as { readonly TAG: DurableObjectNamespace }).TAG;
  return namespace.get(scopeIdFor(namespace, { serviceId: value.serviceId, doClass: "tag", identity: value.tag }));
}

function scope(historySize: number): Scope {
  return {
    serviceId: `g45-${String(historySize).padStart(4, "0")}-${crypto.randomUUID()}`,
    tag: FIXTURE_TAG,
  };
}

function eventFor(value: Scope, ordinal: number): TagEvent {
  return {
    attemptId: "g45-history-seed",
    eventId: g32EventId(`g45:${value.serviceId}:${ordinal}`),
    suid: g32Suid(SUID_BASE + ordinal),
    payload: JSON.stringify({ fixture: "g45-head-facts", ordinal }),
    eventTags: [value.tag],
    allocatorLineageId: "g45-history-seed",
    eventType: "G45HeadFactsFixture",
    provenance: "g32",
    timestamp: G32_FIXTURE_TIMESTAMP,
  };
}

function headFor(historySize: number): string {
  return g32Suid(SUID_BASE + historySize);
}

async function growHistory(value: Scope, fromExclusive: number, toInclusive: number): Promise<void> {
  if (toInclusive <= fromExclusive) throw new Error("G45 history must grow");
  await runInDurableObject(tagStub(value), (_instance, state) => {
    const sql = state.storage.sql;
    if (fromExclusive === 0) {
      sql.exec("INSERT INTO tag_identity (singleton, tag, created_at) VALUES (1, ?, ?)", value.tag, FIXTURE_UPDATED_AT);
      sql.exec(`
        INSERT INTO tag_control (
          singleton, schema_version, head_suid, clock_offset_ms, clock_now_ms,
          version, repair_owner, repair_lease_until, highest_repair_epoch,
          repair_scope_version, created_at, updated_at
        ) VALUES (1, 3, '', 0, NULL, 0, NULL, NULL, 0, 0, ?, ?)
      `, FIXTURE_UPDATED_AT, FIXTURE_UPDATED_AT);
      sql.exec("INSERT INTO tag_head (singleton, service_id, head_suid) VALUES (1, ?, '')", value.serviceId);
    }
    for (let ordinal = fromExclusive + 1; ordinal <= toInclusive; ordinal += 1) {
      const event = eventFor(value, ordinal);
      sql.exec(`
        INSERT INTO tag_event (
          service_id, event_id, attempt_id, suid, payload, event_tags_json,
          allocator_lineage_id, event_type, provenance, timestamp, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, value.serviceId, event.eventId, event.attemptId, event.suid, event.payload,
      JSON.stringify(event.eventTags), event.allocatorLineageId, event.eventType,
      event.provenance, event.timestamp, JSON.stringify(event));
    }
    const head = headFor(toInclusive);
    sql.exec("UPDATE tag_control SET head_suid = ?, version = ?, updated_at = ? WHERE singleton = 1", head, toInclusive, FIXTURE_UPDATED_AT);
    sql.exec("UPDATE tag_head SET head_suid = ? WHERE singleton = 1", head);
  });
}

async function seedHistory(value: Scope, historySize: number): Promise<void> {
  await growHistory(value, 0, historySize);
}

async function getHeadFacts(value: Scope): Promise<Response> {
  return SELF.fetch(
    `https://tag.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}/head-facts`,
    { headers: { [TEST_SERVICE_ID_HEADER]: value.serviceId } },
  );
}

async function getState(value: Scope): Promise<Response> {
  return SELF.fetch(
    `https://tag.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}/state`,
    { headers: { [TEST_SERVICE_ID_HEADER]: value.serviceId } },
  );
}

async function measureHeadFacts(value: Scope, historySize: number): Promise<HeadFactsSample> {
  await runInDurableObject(tagStub(value), (instance) => {
    (instance as unknown as HeadFactsMeasurementSeam).beginG43SqlMeasurement();
  });
  const response = await getHeadFacts(value);
  expect(response.status).toBe(200);
  const rawBody = await response.text();
  const expected: TagHeadFacts = {
    head: headFor(historySize),
    version: historySize,
    updatedAt: FIXTURE_UPDATED_AT,
  };
  const snapshot = await runInDurableObject(tagStub(value), (instance) =>
    (instance as unknown as HeadFactsMeasurementSeam).completeG43SqlMeasurement());
  return { historySize, rawBody, expected, snapshot };
}

function normalizedStatements(snapshot: G43SqlMeasurementSnapshot): string[] {
  return snapshot.statements.map((statement) => statement.replace(/\s+/g, " ").trim());
}

function assertHeadFactsGrowthBound(samples: readonly HeadFactsSample[]): void {
  const expectedHistorySizes = [1, 10, 100, 1000, 5000];
  expect(samples.map((sample) => sample.historySize)).toEqual(expectedHistorySizes);
  for (const sample of samples) {
    // The response must be exactly the scalar contract for that state: no
    // history-derived payload and no extra fields can hide behind byte growth.
    expect(sample.rawBody).toBe(JSON.stringify(sample.expected));
    expect(normalizedStatements(sample.snapshot).some((statement) => /\btag_event\b/i.test(statement))).toBe(false);
  }

  const statementSets = samples.map((sample) => JSON.stringify(normalizedStatements(sample.snapshot)));
  expect(new Set(statementSets).size).toBe(1);
  const allRowsRead = samples.map((sample) => sample.snapshot.rowsRead);
  expect(Math.max(...allRowsRead) - Math.min(...allRowsRead)).toBe(0);
  expect(new Set(allRowsRead)).toEqual(new Set([3]));
}

function fakeTagNamespace(factsByTag: Readonly<Record<string, TagHeadFacts>>, paths: string[]): DurableObjectNamespace {
  return {
    idFromName(name: string): DurableObjectId {
      return name as unknown as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      const tag = String(id).split("|").at(-1)!;
      return {
        async fetch(request: Request): Promise<Response> {
          const url = new URL(request.url);
          paths.push(url.pathname);
          const facts = factsByTag[tag];
          return facts === undefined
            ? new Response(JSON.stringify({ code: "tag_not_found" }), { status: 404 })
            : new Response(JSON.stringify(facts), { status: 200 });
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

describe("SDT-G45 scalar Tag head facts", () => {
  it("AC1/AC2: real /head-facts is table-aware, equivalent to /state, and keeps identity outcomes", async () => {
    const value = scope(100);
    await seedHistory(value, 100);

    const measured = await measureHeadFacts(value, 100);
    expect(normalizedStatements(measured.snapshot)).toEqual([
      "SELECT tag FROM tag_identity WHERE singleton = 1",
      "SELECT head_suid, version, updated_at FROM tag_control WHERE singleton = 1",
      "SELECT head_suid FROM tag_head WHERE singleton = 1",
    ]);
    expect(measured.snapshot.rowsRead).toBe(3);
    expect(measured.snapshot.rowsWritten).toBe(0);

    const state = await getState(value);
    expect(state.status).toBe(200);
    const fullRecord = await state.json<TagRecord>();
    expect(JSON.parse(measured.rawBody)).toEqual({
      head: fullRecord.head,
      version: fullRecord.version,
      updatedAt: fullRecord.updatedAt,
    });

    const mismatchedIdentity = await tagStub(value).fetch(
      new Request("https://tag.internal/head-facts?__tag=room:other"),
    );
    expect(mismatchedIdentity.status).toBe(409);
    expect(await mismatchedIdentity.json()).toMatchObject({ code: "tag_identity_conflict" });

    const missingIdentity = await tagStub(value).fetch(new Request("https://tag.internal/head-facts"));
    expect(missingIdentity.status).toBe(400);
    expect(await missingIdentity.json()).toMatchObject({ code: "tag_identity_required" });

    const absent = scope(1);
    const absentResponse = await getHeadFacts(absent);
    expect(absentResponse.status).toBe(404);
    expect(await absentResponse.json()).toMatchObject({ code: "tag_not_found" });
  });

  it("AC2: commit success response requests head facts for every written tag and keeps the fixture bytes", async () => {
    const eventId = g32EventId("g45-commit-response");
    const candidates: AllocatedCommitCandidate[] = [{
      eventId,
      suid: g32Suid(9_000_000),
      payload: JSON.stringify({ fixture: "g45" }),
      eventPayloadName: "G45CommitResponse",
      eventType: "G45CommitResponse:1",
      tags: ["room:a", "room:b"],
      timestamp: G32_FIXTURE_TIMESTAMP,
    }];
    const input: ValidatedCommitEnvelope = {
      eventCandidates: candidates,
      consistencyTags: [],
      allTags: ["room:a", "room:b"],
    };
    const paths: string[] = [];
    const worker = new CommitWorker({
      TAG: fakeTagNamespace({
        "room:a": { head: g32Suid(9_000_000), version: 10, updatedAt: "2026-08-29T12:00:00.000Z" },
        "room:b": { head: g32Suid(9_000_000), version: 11, updatedAt: "2026-08-29T12:00:00.001Z" },
      }, paths),
    } as unknown as CommitWorkerEnv, "g45-fixture-service");

    const now = 1_788_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const complete = await (worker as unknown as CommitSuccessResponseSeam).successResponse(
        input,
        candidates,
        "g45-fixture-attempt",
        now,
        undefined,
      );
      expect(paths).toEqual(["/head-facts", "/head-facts"]);
      expect(JSON.stringify(complete)).toBe(
        "{\"writtenEvents\":[{\"payload\":\"eyJmaXh0dXJlIjoiZzQ1In0=\",\"sortableUniqueIdValue\":\"062135596800900000018115144724\",\"id\":\"00e79db1-708b-704d-b867-f491cc2c870c\",\"eventMetadata\":{\"causationId\":\"00e79db1-708b-704d-b867-f491cc2c870c\",\"correlationId\":\"SerializedCommit\",\"executedUser\":\"SerializedSekibanExecutor\"},\"tags\":[\"room:a\",\"room:b\"],\"eventPayloadName\":\"G45CommitResponse\"}],\"tagWriteResults\":[{\"tag\":\"room:a\",\"version\":10,\"writtenAt\":\"2026-08-29T12:00:00.000Z\"},{\"tag\":\"room:b\",\"version\":11,\"writtenAt\":\"2026-08-29T12:00:00.001Z\"}],\"duration\":\"PT0S\"}",
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("AC3: real handler head-facts read has a singleton non-event SQL set at every history point", async () => {
    const samples: HeadFactsSample[] = [];
    const value = scope(5_000);
    let previousHistorySize = 0;
    for (const historySize of [1, 10, 100, 1000, 5000]) {
      await growHistory(value, previousHistorySize, historySize);
      samples.push(await measureHeadFacts(value, historySize));
      previousHistorySize = historySize;
    }
    assertHeadFactsGrowthBound(samples);
  }, 60_000);

  it("AC3 checker rejects each standalone falsification", () => {
    const expected: TagHeadFacts = { head: headFor(1), version: 1, updatedAt: FIXTURE_UPDATED_AT };
    const baseline = [1, 10, 100, 1000, 5000].map((historySize): HeadFactsSample => ({
      historySize,
      rawBody: JSON.stringify({ ...expected, version: historySize }),
      expected: { ...expected, version: historySize },
      snapshot: {
        statements: [
          "SELECT tag FROM tag_identity WHERE singleton = 1",
          "SELECT head_suid, version, updated_at FROM tag_control WHERE singleton = 1",
          "SELECT head_suid FROM tag_head WHERE singleton = 1",
        ],
        cursors: [],
        rowsRead: 3,
        rowsWritten: 0,
      },
    }));
    expect(() => assertHeadFactsGrowthBound(baseline)).not.toThrow();

    const restoredFullState = baseline.map((sample) => sample.historySize === 100
      ? { ...sample, snapshot: { ...sample.snapshot, statements: [...sample.snapshot.statements, "SELECT event_json FROM tag_event ORDER BY suid ASC"] } }
      : sample);
    expect(() => assertHeadFactsGrowthBound(restoredFullState)).toThrow();

    const historyProportionalLimit = baseline.map((sample) => sample.historySize === 1000
      ? {
        ...sample,
        snapshot: {
          ...sample.snapshot,
          statements: [...sample.snapshot.statements, "SELECT event_json FROM tag_event ORDER BY suid ASC LIMIT (SELECT COUNT(*) FROM tag_event)"],
          rowsRead: 1003,
        },
      }
      : sample);
    expect(() => assertHeadFactsGrowthBound(historyProportionalLimit)).toThrow();

    // A constant LIMIT still violates AC1 even though it can keep the row
    // count flat.  This is why the table-aware statement oracle is primary
    // evidence rather than an aggregate rows-read assertion.
    const constantTagEventLimit = baseline.map((sample) => sample.historySize === 10
      ? {
        ...sample,
        snapshot: {
          ...sample.snapshot,
          statements: [...sample.snapshot.statements, "SELECT event_json FROM tag_event ORDER BY suid ASC LIMIT 1"],
          rowsRead: 4,
        },
      }
      : sample);
    expect(() => assertHeadFactsGrowthBound(constantTagEventLimit)).toThrow();

    const intermediateOnlySpike = baseline.map((sample) => sample.historySize === 100
      ? { ...sample, snapshot: { ...sample.snapshot, rowsRead: 4 } }
      : sample);
    expect(() => assertHeadFactsGrowthBound(intermediateOnlySpike)).toThrow();
  });
});
