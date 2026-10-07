import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { TAG_SQL_SCHEMA_DDL } from "../packages/dcb-runtime/src/tag/TagSqlSchema";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./helpers/g32-fixtures";

interface Scope {
  readonly serviceId: string;
  readonly tag: string;
}

interface SchedulerSeam {
  rearmScheduler(txn: DurableObjectTransaction): Promise<void>;
  runAlarm(): Promise<unknown>;
  setG43SchedulerFaultForTest(fault: "before-rearm" | "after-rearm" | undefined): void;
  g43ScanSourceObligations(tag: string, nowMs: number): Promise<unknown>;
}

type SqlCount = Record<string, SqlStorageValue> & { readonly count: number };

function scope(): Scope {
  return { serviceId: `g43-${crypto.randomUUID()}`, tag: "room:g43" };
}

function tagStub(value: Scope): DurableObjectStub {
  const namespace = (env as unknown as { readonly TAG: DurableObjectNamespace }).TAG;
  return namespace.get(scopeIdFor(namespace, { serviceId: value.serviceId, doClass: "tag", identity: value.tag }));
}

async function post(value: Scope, path: string, body: unknown = {}): Promise<Response> {
  return SELF.fetch(
    `https://tag.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: value.serviceId },
      body: JSON.stringify(body),
    },
  );
}

function candidate(value: Scope, suffix: string, eventTags = [value.tag]) {
  return {
    eventId: g32EventId(`g43-${suffix}`),
    suid: g32Suid(`g43-${suffix}`),
    payload: JSON.stringify({ name: "g43", suffix }),
    eventTags,
    allocatorLineageId: "g43-lineage",
    eventType: "G43Fixture",
    provenance: "g32",
    timestamp: G32_FIXTURE_TIMESTAMP,
  };
}

async function append(value: Scope, suffix: string, eventTags = [value.tag]): Promise<Response> {
  return post(value, "/append", {
    attemptId: `g43-attempt-${suffix}`,
    epoch: 0,
    candidates: [candidate(value, suffix, eventTags)],
  });
}

async function appendWithinTagActor(value: Scope, suffix: string): Promise<number> {
  const body = {
    attemptId: `g43-attempt-${suffix}`,
    epoch: 0,
    candidates: [candidate(value, suffix)],
  };
  return runInDurableObject(tagStub(value), async (instance) => {
    const runtime = instance as unknown as {
      env: { AUTO_DRAIN_OUTBOX?: string };
      append(tag: string, body: unknown, serviceId: string | null): Promise<Response>;
    };
    const originalAutoDrain = runtime.env.AUTO_DRAIN_OUTBOX;
    runtime.env.AUTO_DRAIN_OUTBOX = "false";
    try {
      const response = await runtime.append(value.tag, body, value.serviceId);
      return response.status;
    } finally {
      runtime.env.AUTO_DRAIN_OUTBOX = originalAutoDrain;
    }
  });
}

async function count(value: Scope, table: string): Promise<number> {
  // `table` is a literal from this test, never caller supplied SQL.
  return runInDurableObject(tagStub(value), (_instance, state) => {
    const row = state.storage.sql.exec<SqlCount>(`SELECT COUNT(*) AS count FROM ${table}`).one();
    return row.count;
  });
}

async function makeRetryDue(value: Scope): Promise<void> {
  await runInDurableObject(tagStub(value), async (_instance, state) => {
    state.storage.sql.exec("UPDATE tag_outbox_obligation SET next_attempt_at = 1 WHERE status = 'pending'");
    await state.storage.setAlarm(Date.now() + 60_000);
  });
}

async function rearmScheduler(value: Scope): Promise<number | null> {
  return runInDurableObject(tagStub(value), async (instance, state) =>
    state.storage.transaction(async (txn) => {
      await (instance as unknown as SchedulerSeam).rearmScheduler(txn);
      return state.storage.getAlarm();
    }));
}

async function configuredAlarm(value: Scope): Promise<number | null> {
  return runInDurableObject(tagStub(value), (_instance, state) => state.storage.getAlarm());
}

async function scanSource(value: Scope, nowMs: number): Promise<unknown> {
  return runInDurableObject(tagStub(value), (instance) =>
    (instance as unknown as SchedulerSeam).g43ScanSourceObligations(value.tag, nowMs));
}

async function acquireReservation(value: Scope, suffix: string, expectedHead: string): Promise<{ token: string }> {
  const response = await post(value, "/acquire", {
    attemptId: `g43-scheduler-${suffix}`,
    epoch: 1,
    eventTags: [value.tag],
    consistencyTags: [{ tag: value.tag, lastSortableUniqueId: expectedHead }],
  });
  expect(response.status).toBe(201);
  return (await response.json<{ reservation: { token: string } }>()).reservation;
}

async function replaceQueue(
  value: Scope,
  send: (row: DownstreamOutboxMessage) => Promise<void>,
): Promise<() => Promise<void>> {
  let originalQueue: Queue<DownstreamOutboxMessage> | undefined;
  let originalAutoDrain: string | undefined;
  let runtime: { env: { DOWNSTREAM_QUEUE?: Queue<DownstreamOutboxMessage>; AUTO_DRAIN_OUTBOX?: string } } | undefined;
  await runInDurableObject(tagStub(value), (instance) => {
    runtime = instance as unknown as {
      env: { DOWNSTREAM_QUEUE?: Queue<DownstreamOutboxMessage>; AUTO_DRAIN_OUTBOX?: string };
    };
    originalQueue = runtime.env.DOWNSTREAM_QUEUE;
    originalAutoDrain = runtime.env.AUTO_DRAIN_OUTBOX;
    runtime.env.DOWNSTREAM_QUEUE = {
      send: (row: DownstreamOutboxMessage) => send(row),
    } as unknown as Queue<DownstreamOutboxMessage>;
    runtime.env.AUTO_DRAIN_OUTBOX = "true";
  });
  return async () => {
    await runInDurableObject(tagStub(value), (instance) => {
      const runtime = instance as unknown as {
        env: { DOWNSTREAM_QUEUE?: Queue<DownstreamOutboxMessage>; AUTO_DRAIN_OUTBOX?: string };
      };
      runtime.env.DOWNSTREAM_QUEUE = originalQueue;
      runtime.env.AUTO_DRAIN_OUTBOX = originalAutoDrain;
    });
  };
}

describe("SDT-G43 normalized Tag SQLite authority", () => {
  it("AC2/AC3: commits event, head, membership, obligation, and receipt together in literal normalized tables", async () => {
    const value = scope();
    const appendResponse = await append(value, "five-facts");
    const appendText = await appendResponse.text();
    expect(appendResponse.status, `G43 append-status assertion: ${appendText}`).toBe(201);
    const appendBody = JSON.parse(appendText) as { version: number };

    const tables = await runInDurableObject(tagStub(value), (_instance, state) => state.storage.sql.exec<{ name: string }>(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tag_%' ORDER BY name COLLATE BINARY
    `).toArray().map((row) => row.name));
    expect(tables).toEqual(expect.arrayContaining([
      "tag_identity",
      "tag_reservation",
      "tag_epoch",
      "tag_tombstone",
      "tag_event",
      "tag_head",
      "tag_committed_membership",
      "tag_outbox_obligation",
      "tag_commit_receipt",
    ]));
    expect(TAG_SQL_SCHEMA_DDL).toContain("FOREIGN KEY (service_id, event_id)");
    expect(TAG_SQL_SCHEMA_DDL).toContain("UNIQUE (service_id, event_id, attempt_id)");
    expect(TAG_SQL_SCHEMA_DDL).toContain("canonical_bytes BLOB NOT NULL");

    await expect(count(value, "tag_event"), "G43 event-count assertion").resolves.toBe(1);
    await expect(count(value, "tag_head"), "G43 head-count assertion").resolves.toBe(1);
    await expect(count(value, "tag_committed_membership"), "G43 committed-membership-count assertion").resolves.toBe(1);
    await expect(count(value, "tag_outbox_obligation"), "G43 obligation-count assertion").resolves.toBe(1);
    await expect(count(value, "tag_commit_receipt"), "G43 receipt-count assertion").resolves.toBe(1);
    const writtenVersion = await runInDurableObject(tagStub(value), (_instance, state) => state.storage.sql.exec<{
      [key: string]: SqlStorageValue;
      written_version: number;
    }>("SELECT written_version FROM tag_commit_receipt WHERE attempt_id = ? AND epoch = ?", "g43-attempt-five-facts", 0).one().written_version);
    expect(writtenVersion, "G43 stored-versus-response written-version assertion").toBe(appendBody.version);
    const head = await runInDurableObject(tagStub(value), (_instance, state) => state.storage.sql.exec<{
      [key: string]: SqlStorageValue;
      head_suid: string;
    }>("SELECT head_suid FROM tag_head WHERE singleton = 1").one().head_suid);
    expect(head, "G43 head-value assertion").toBe(candidate(value, "five-facts").suid);

    const stored = await runInDurableObject(tagStub(value), (_instance, state) => state.storage.sql.exec<{
      payload: string;
      event_json: string;
      canonical_bytes: ArrayBuffer;
      event_digest: string;
      declared_tag_set_json: string;
      local_committed_membership_json: string;
    }>(`
      SELECT e.payload, e.event_json, o.canonical_bytes, o.event_digest,
        o.declared_tag_set_json, o.local_committed_membership_json
      FROM tag_event e JOIN tag_outbox_obligation o
        ON e.service_id = o.service_id AND e.event_id = o.event_id
    `).one());
    expect(JSON.parse(stored.event_json)).toEqual(expect.objectContaining({
      attemptId: "g43-attempt-five-facts",
      eventId: candidate(value, "five-facts").eventId,
      suid: candidate(value, "five-facts").suid,
      payload: stored.payload,
      eventTags: [value.tag],
      allocatorLineageId: "g43-lineage",
      eventType: "G43Fixture",
      provenance: "g32",
      timestamp: G32_FIXTURE_TIMESTAMP,
    }));
    expect(stored.canonical_bytes.byteLength).toBeGreaterThan(0);
    expect(stored.event_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(stored.declared_tag_set_json)).toEqual([value.tag]);
    expect(JSON.parse(stored.local_committed_membership_json)).toEqual([
      expect.objectContaining({ serviceId: value.serviceId, tag: value.tag }),
    ]);
  });

  it("AC3: rolls all five commit facts back when the post-write fault fires", async () => {
    const value = scope();
    const response = await post(value, "/append", {
      attemptId: "g43-atomic-fault",
      epoch: 0,
      candidates: [candidate(value, "atomic-fault")],
      faultInjection: "after-append-before-confirm",
    });
    expect(response.status).toBe(503);
    for (const table of [
      "tag_event",
      "tag_head",
      "tag_committed_membership",
      "tag_outbox_obligation",
      "tag_commit_receipt",
    ]) {
      await expect(count(value, table)).resolves.toBe(0);
    }
  });

  it("AC2/AC3: first-write identity cannot be relabelled, and rejected reserve leaves no partial reservation", async () => {
    const value = scope();
    expect((await append(value, "identity-cas")).status).toBe(201);
    await expect(runInDurableObject(tagStub(value), (instance) =>
      (instance as unknown as { fetch(request: Request): Promise<Response> }).fetch(new Request(
        `https://tag.internal/state?__tag=${encodeURIComponent("room:other")}&__serviceId=${encodeURIComponent(value.serviceId)}`,
      )))).rejects.toThrow("Tag Durable Object identity changed");
    await expect(runInDurableObject(tagStub(value), (_instance, state) => state.storage.sql.exec<{
      tag: string;
    }>("SELECT tag FROM tag_identity WHERE singleton = 1").one().tag)).resolves.toBe(value.tag);

    const rejectedReserve = await post(value, "/acquire", {
      attemptId: "g43-rejected-reserve",
      epoch: 1,
      eventTags: [value.tag],
      consistencyTags: [{ tag: value.tag, lastSortableUniqueId: g32Suid("wrong-head") }],
    });
    expect(rejectedReserve.status).toBe(409);
    await expect(count(value, "tag_reservation")).resolves.toBe(0);
    await expect(count(value, "tag_tombstone")).resolves.toBe(0);
  });

  it("AC4: cancel only removes its reservation/tombstone state and never hides committed source facts", async () => {
    const value = scope();
    expect((await append(value, "preserve")).status).toBe(201);
    const acquire = await post(value, "/acquire", {
      attemptId: "g43-cancel",
      epoch: 1,
      eventTags: [value.tag],
      consistencyTags: [{ tag: value.tag, lastSortableUniqueId: candidate(value, "preserve").suid }],
    });
    expect(acquire.status).toBe(201);
    const reservation = await acquire.json<{ reservation: { token: string } }>();
    expect((await post(value, "/cancel", {
      attemptId: "g43-cancel",
      epoch: 1,
      reservationToken: reservation.reservation.token,
    })).status).toBe(200);

    await expect(count(value, "tag_event")).resolves.toBe(1);
    await expect(count(value, "tag_committed_membership")).resolves.toBe(1);
    await expect(count(value, "tag_outbox_obligation")).resolves.toBe(1);
    await expect(count(value, "tag_tombstone")).resolves.toBe(1);

    const delayed = await post(value, "/append", {
      attemptId: "g43-cancel",
      epoch: 1,
      candidates: [candidate(value, "cancel-delayed")],
    });
    expect(delayed.status).toBe(409);
    await expect(delayed.json()).resolves.toMatchObject({ reason: "tombstoned_epoch" });
  });

  it("AC5: scans unacknowledged source obligations without invoking a delivery path", async () => {
    const value = scope();
    expect((await append(value, "scanner")).status).toBe(201);
    await expect(scanSource(value, 123)).resolves.toEqual({
      status: "scan-complete",
      source: "tag_outbox_obligation",
      scannedAt: 123,
      pendingCount: 1,
      findings: [expect.objectContaining({
        code: "tag_outbox_obligation_unacknowledged",
        status: "pending",
        source: "tag_outbox_obligation",
      })],
    });
  });

  it("AC6: a due alarm leaves the source obligation enumerable when automatic delivery is disabled", async () => {
    const value = scope();
    expect((await append(value, "alarm")).status).toBe(201);
    const pending = await post(value, "/outbox/pending", { nowMs: Date.now() });
    expect(pending.status).toBe(200);
    await runInDurableObject(tagStub(value), async (_instance, state) => {
      state.storage.sql.exec("UPDATE tag_outbox_obligation SET next_attempt_at = 1");
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(tagStub(value))).toBe(true);
    const body = await scanSource(value, Date.now()) as { findings: Array<{ status: string; attemptCount: number }> };
    expect(body.findings).toEqual([expect.objectContaining({ status: "pending", attemptCount: expect.any(Number) })]);
  });

  it("AC6: a poison retry cannot starve a sibling obligation or reservation expiry", async () => {
    const value = scope();
    expect((await append(value, "poison")).status).toBe(201);
    expect((await append(value, "sibling")).status).toBe(201);
    const initial = await post(value, "/outbox/pending", { nowMs: Date.now() });
    expect(initial.status).toBe(200);
    const restoreQueue = await replaceQueue(value, async (row) => {
      if (row.eventId === candidate(value, "poison").eventId) throw new Error("fixture poison sink");
    });
    try {
      // Transport acceptance is no longer source acknowledgement under G44.
      // Both rows remain enumerable; the sibling must still receive an
      // independent handoff attempt while the poison row throws.
      await makeRetryDue(value);
      expect(await runDurableObjectAlarm(tagStub(value))).toBe(true);
      let body = await scanSource(value, Date.now()) as { findings: Array<{ eventId: string; status: string; attemptCount: number }> };
      expect(body.findings).toEqual(expect.arrayContaining([expect.objectContaining({
        eventId: candidate(value, "poison").eventId,
        status: "pending",
        attemptCount: 2,
      }), expect.objectContaining({
        eventId: candidate(value, "sibling").eventId,
        status: "pending",
        attemptCount: 2,
      })]));

      // A reservation and the final poison pass are due together. Both due
      // classes advance: the reservation expires while only the poison item is
      // classified terminally for an operator path.
      const acquired = await post(value, "/acquire", {
        attemptId: "g43-expiry-with-poison",
        epoch: 1,
        eventTags: [value.tag],
        consistencyTags: [{ tag: value.tag, lastSortableUniqueId: candidate(value, "sibling").suid }],
      });
      expect(acquired.status).toBe(201);
      await runInDurableObject(tagStub(value), async (_instance, state) => {
        state.storage.sql.exec("UPDATE tag_reservation SET expires_at = 1, alarm_due_at = 1");
      });
      await makeRetryDue(value);
      expect(await runDurableObjectAlarm(tagStub(value))).toBe(true);
      body = await scanSource(value, Date.now()) as typeof body;
      expect(body.findings).toEqual(expect.arrayContaining([expect.objectContaining({
        eventId: candidate(value, "poison").eventId,
        status: "poison",
        attemptCount: 3,
      })]));
      const current = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}/state`,
        { headers: { [TEST_SERVICE_ID_HEADER]: value.serviceId } },
      );
      expect((await current.json<{ activeReservation: unknown }>()).activeReservation).toBeNull();
      // The poison row is terminal, but the sibling remains source-pending
      // until a receiver has proved its D1 receipt, so the shared alarm stays
      // armed for that acknowledged-delivery retry.
      await runInDurableObject(tagStub(value), async (_instance, state) => {
        await expect(state.storage.getAlarm()).resolves.not.toBeNull();
      });
    } finally {
      await restoreQueue();
    }
  });

  it("AC6: one scheduler selects the minimum due time for obligation-before, reservation-before, and equal due work", async () => {
    const cases = [
      { suffix: "obligation-before", obligationOffset: 10_000, reservationOffset: 20_000, expected: "obligation" },
      { suffix: "reservation-before", obligationOffset: 20_000, reservationOffset: 10_000, expected: "reservation" },
      { suffix: "equal", obligationOffset: 10_000, reservationOffset: 10_000, expected: "equal" },
    ] as const;
    for (const item of cases) {
      const value = scope();
      expect((await append(value, `due-${item.suffix}`)).status).toBe(201);
      await acquireReservation(value, item.suffix, candidate(value, `due-${item.suffix}`).suid);
      const base = Date.now() + 60_000;
      await runInDurableObject(tagStub(value), (_instance, state) => {
        state.storage.sql.exec("UPDATE tag_outbox_obligation SET next_attempt_at = ?", base + item.obligationOffset);
        state.storage.sql.exec("UPDATE tag_reservation SET expires_at = ?, alarm_due_at = ?", base + item.reservationOffset, base + item.reservationOffset);
      });
      await rearmScheduler(value);
      expect(await configuredAlarm(value), item.expected).toBe(base + Math.min(item.obligationOffset, item.reservationOffset));
    }
  });

  it("AC6: a due obligation inserted while delivery runs is retained and re-armed for the next handler", async () => {
    const value = scope();
    expect((await append(value, "insert-1")).status).toBe(201);
    let inserted = false;
    const restoreQueue = await replaceQueue(value, async (row) => {
      if (row.eventId === candidate(value, "insert-1").eventId && !inserted) {
        inserted = true;
        // This fixture isolates the alarm's in-flight source selection. It
        // invokes the exact append handler seam inside the same Tag actor with
        // auto-drain scoped off. A second SELF.fetch would independently
        // schedule response-after delivery and could acknowledge insert-2
        // before the outer alarm scans its source rows.
        expect(await appendWithinTagActor(value, "insert-2")).toBe(201);
        // The handler seam returns after the append transaction commits; use a
        // same-DO storage read as the explicit durable completion barrier
        // before the outer alarm resumes its source scan.
        await runInDurableObject(tagStub(value), (_instance, state) => {
          const durable = state.storage.sql.exec<SqlCount>(
            "SELECT COUNT(*) AS count FROM tag_event WHERE event_id = ?",
            candidate(value, "insert-2").eventId,
          ).one();
          expect(durable.count).toBe(1);
        });
        return;
      }
      throw new Error("fixture keeps newly inserted obligation pending");
    });
    try {
      await makeRetryDue(value);
      // Call the real handler body through the DO seam. Miniflare's synthetic
      // alarm helper consumes an alarm when its handler returns, which would
      // hide the re-arm produced by this fixture's in-flight insert.
      const alarmRun = await runInDurableObject(tagStub(value), async (instance, state) => ({
        result: await (instance as unknown as SchedulerSeam).runAlarm(),
        alarm: await state.storage.getAlarm(),
      }));
      expect(alarmRun.result).toBeDefined();
      expect(inserted).toBe(true);
      await expect(scanSource(value, Date.now())).resolves.toMatchObject({
        findings: expect.arrayContaining([expect.objectContaining({ eventId: candidate(value, "insert-2").eventId, status: "pending" })]),
      });
      // Read the re-arm in the same actor turn as the direct handler seam.
      // A separate event-turn poll races the harness's synthetic alarm
      // bookkeeping under the parallel foundation pool.
      expect(alarmRun.alarm).not.toBeNull();
    } finally {
      await restoreQueue();
    }
  });

  it("AC6: crash before and after re-arm preserves due source work for an idempotent later alarm", async () => {
    for (const fault of ["before-rearm", "after-rearm"] as const) {
      const value = scope();
      expect((await append(value, `crash-${fault}`)).status).toBe(201);
      await makeRetryDue(value);
      await runInDurableObject(tagStub(value), (instance) => {
        (instance as unknown as SchedulerSeam).setG43SchedulerFaultForTest(fault);
      });
      // Call the exact production alarm body through the DO seam. This lets
      // the fixture catch the injected crash deterministically instead of
      // leaving Miniflare's automatic retry as an unhandled test-isolate
      // error. The following recovery checks are against the same body.
      await expect(runInDurableObject(tagStub(value), (instance) =>
        (instance as unknown as SchedulerSeam).runAlarm())).rejects.toThrow(
        `G43 scheduler crash ${fault === "before-rearm" ? "before" : "after"} re-arm`,
      );
      await runInDurableObject(tagStub(value), (instance) => {
        (instance as unknown as SchedulerSeam).setG43SchedulerFaultForTest(undefined);
      });
      // The Miniflare alarm harness consumes an alarm whose handler threw;
      // actor recovery must therefore recompute the single source schedule
      // before a later handler can run.  The obligation itself remains in
      // source storage across both sides of the re-arm fault boundary.
      const rearmedAt = await rearmScheduler(value);
      expect(rearmedAt).not.toBeNull();
      await runInDurableObject(tagStub(value), (instance) =>
        (instance as unknown as SchedulerSeam).runAlarm());
      await expect(scanSource(value, Date.now())).resolves.toMatchObject({
        findings: [expect.objectContaining({ eventId: candidate(value, `crash-${fault}`).eventId })],
      });
    }
  });

  it("AC6: a backlog larger than one alarm budget progresses and re-arms instead of starving its tail", async () => {
    const value = scope();
    const expectedEventIds = new Set<string>();
    for (let ordinal = 1; ordinal <= 33; ordinal += 1) {
      const suffix = `backlog-${String(ordinal).padStart(2, "0")}`;
      expectedEventIds.add(candidate(value, suffix).eventId);
      expect((await append(value, suffix)).status).toBe(201);
    }
    const sent: string[] = [];
    // Establish the scheduler state while automatic delivery remains disabled;
    // this prevents the Miniflare alarm dispatcher from racing the fixture's
    // explicit invocation of the production alarm body.
    await runInDurableObject(tagStub(value), async (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE tag_outbox_obligation
        SET next_attempt_at = CASE
          WHEN obligation_sequence = (SELECT MAX(obligation_sequence) FROM tag_outbox_obligation)
            THEN ?
          ELSE 1
        END
        WHERE status = 'pending'
      `, Date.now() + 60_000);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    // `pendingSqlOutbox` is the exact source selection used by `runAlarm`.
    // Prove its real SQL LIMIT boundary before exercising delivery/re-arm.
    const selected = await post(value, "/outbox/pending", { nowMs: Date.now(), limit: 32 });
    await expect(selected.json<{ rows: unknown[] }>()).resolves.toMatchObject({ rows: { length: 32 } });
    await runInDurableObject(tagStub(value), async (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE tag_outbox_obligation
        SET next_attempt_at = CASE
          WHEN obligation_sequence = (SELECT MAX(obligation_sequence) FROM tag_outbox_obligation)
            THEN ?
          ELSE 1
        END
        WHERE status = 'pending'
      `, Date.now() + 60_000);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const restoreQueue = await replaceQueue(value, async (row) => {
      // Environment bindings are shared by the Miniflare test pool.  Other
      // fixture DOs may finish a queued alarm while this test is running, but
      // only this source tag's obligation identities are part of this block.
      if (expectedEventIds.has(row.eventId)) sent.push(row.eventId);
    });
    try {
      await runInDurableObject(tagStub(value), (instance) =>
        (instance as unknown as SchedulerSeam).runAlarm());
      expect(new Set(sent)).toHaveLength(32);
      expect(await configuredAlarm(value)).not.toBeNull();
      // Simulate the distinct G44 receiver-side receipt verification. Queue
      // send alone leaves all rows pending; this test isolates the scheduler
      // once the first bounded batch has genuinely been acknowledged.
      await runInDurableObject(tagStub(value), (_instance, state) => {
        state.storage.sql.exec("UPDATE tag_outbox_obligation SET status = 'acknowledged' WHERE obligation_sequence <= 32");
      });
      await makeRetryDue(value);
      await runInDurableObject(tagStub(value), (instance) =>
        (instance as unknown as SchedulerSeam).runAlarm());
      expect(new Set(sent)).toHaveLength(33);
      await runInDurableObject(tagStub(value), (_instance, state) => {
        state.storage.sql.exec("UPDATE tag_outbox_obligation SET status = 'acknowledged' WHERE obligation_sequence = 33");
      });
      await rearmScheduler(value);
      await expect(scanSource(value, Date.now())).resolves.toMatchObject({ pendingCount: 0, findings: [] });
      expect(await configuredAlarm(value)).toBeNull();
    } finally {
      await restoreQueue();
    }
  }, 10_000);

  it("AC7: rejects a same event identity whose canonical digest changes", async () => {
    const value = scope();
    const original = candidate(value, "digest");
    expect((await post(value, "/append", {
      attemptId: "g43-digest",
      epoch: 0,
      candidates: [original],
    })).status).toBe(201);
    const conflict = await post(value, "/append", {
      attemptId: "g43-digest",
      epoch: 0,
      candidates: [{ ...original, eventTags: [value.tag, "other:g43"] }],
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ reason: "event_digest_conflict" });

    const payloadConflict = await post(value, "/append", {
      attemptId: "g43-digest",
      epoch: 0,
      candidates: [{ ...original, payload: JSON.stringify({ name: "g43", changed: true }) }],
    });
    expect(payloadConflict.status).toBe(409);
    await expect(payloadConflict.json()).resolves.toMatchObject({ reason: "event_digest_conflict" });
  });

  it("AC7: different event identities persist as distinct source rows instead of merging", async () => {
    const value = scope();
    const first = candidate(value, "distinct-1");
    const second = {
      ...first,
      eventId: g32EventId("g43-distinct-2"),
      suid: g32Suid("g43-distinct-2"),
    };
    const response = await post(value, "/append", {
      attemptId: "g43-distinct-attempt",
      epoch: 0,
      candidates: [first, second],
    });
    expect(response.status).toBe(201);
    await expect(count(value, "tag_event")).resolves.toBe(2);
    await expect(count(value, "tag_outbox_obligation")).resolves.toBe(2);
  });

  it("AC8 seam: consumes every cursor reached by a real append handler before reporting counters", async () => {
    const value = scope();
    await runInDurableObject(tagStub(value), (instance) => {
      (instance as unknown as { beginG43SqlMeasurement(): void }).beginG43SqlMeasurement();
    });
    const response = await append(value, "measurement-seam");
    await response.arrayBuffer();
    const snapshot = await runInDurableObject(tagStub(value), (instance) =>
      (instance as unknown as {
        completeG43SqlMeasurement(): {
          rowsRead: number;
          rowsWritten: number;
          statements: readonly string[];
          cursors: readonly { rowsRead: number; rowsWritten: number }[];
        };
      }).completeG43SqlMeasurement());
    expect(snapshot.statements.length).toBe(snapshot.cursors.length);
    expect(snapshot.statements.length).toBeGreaterThan(0);
    expect(snapshot.rowsWritten).toBeGreaterThan(0);
    expect(snapshot.rowsRead).toBeGreaterThan(0);
    expect(snapshot.cursors.every((cursor) => cursor.rowsRead >= 0 && cursor.rowsWritten >= 0)).toBe(true);
  });
});
