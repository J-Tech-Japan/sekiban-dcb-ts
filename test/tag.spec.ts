import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MAX_EPOCH } from "../src/tag/TagDurableObject";
import {
  RESERVATION_WINDOW_MS,
  type TagRecord,
  type TagReservation,
} from "../src/tag/types";

interface Scope {
  serviceId: string;
  tag: string;
}

interface Rejection {
  reason: string;
}

async function post(scope: Scope, path: string, body: unknown = {}): Promise<Response> {
  return SELF.fetch(
    `https://tag.test/tags/${encodeURIComponent(scope.serviceId)}/${encodeURIComponent(scope.tag)}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function newScope(): Scope {
  return { serviceId: `service-${crypto.randomUUID()}`, tag: "orders" };
}

function candidate(scope: Scope, eventId: string, suid: string, payload = "payload") {
  return { eventId, suid, payload, eventTags: [scope.tag] };
}

async function state(scope: Scope): Promise<TagRecord> {
  const response = await SELF.fetch(
    `https://tag.test/tags/${encodeURIComponent(scope.serviceId)}/${encodeURIComponent(scope.tag)}/state`,
  );
  expect(response.status).toBe(200);
  return responseJson<TagRecord>(response);
}

async function acquire(
  scope: Scope,
  attemptId: string,
  epoch: number,
  expectedHead = "",
  options: { eventTags?: string[]; consistencyTags?: unknown[] } = {},
): Promise<Response> {
  return post(scope, "/acquire", {
    attemptId,
    epoch,
    eventTags: options.eventTags ?? [scope.tag],
    consistencyTags:
      options.consistencyTags ?? [{ tag: scope.tag, lastSortableUniqueId: expectedHead }],
  });
}

async function reservation(response: Response): Promise<TagReservation> {
  expect(response.status).toBe(201);
  return (await responseJson<{ reservation: TagReservation }>(response)).reservation;
}

async function rejectionReason(response: Response): Promise<string> {
  expect(response.status).toBe(409);
  return (await responseJson<Rejection>(response)).reason;
}

describe("TagDurableObject", () => {
  it("AC1: reads the SQLite head for observed consistency tags and reserves only those tags", async () => {
    const scope = newScope();
    const wrongField = await acquire(scope, "wrong-field", 1, "", {
      consistencyTags: [{ tag: scope.tag, lastSortedUniqueId: "" }],
    });
    expect(wrongField.status).toBe(400);
    expect((await responseJson<{ error: string }>(wrongField)).error).toBe(
      "each consistency tag needs lastSortableUniqueId",
    );
    const absentAfterWrongField = await SELF.fetch(
      `https://tag.test/tags/${encodeURIComponent(scope.serviceId)}/${encodeURIComponent(scope.tag)}/state`,
    );
    expect(absentAfterWrongField.status).toBe(404);

    const nullHead = await acquire(scope, "null-head", 1, "", {
      consistencyTags: [{ tag: scope.tag, lastSortableUniqueId: null }],
    });
    expect(nullHead.status).toBe(400);
    expect((await responseJson<{ error: string }>(nullHead)).error).toBe(
      "lastSortableUniqueId must not be null",
    );
    const absent = await SELF.fetch(
      `https://tag.test/tags/${encodeURIComponent(scope.serviceId)}/${encodeURIComponent(scope.tag)}/state`,
    );
    expect(absent.status).toBe(404);

    const omitted = await acquire(scope, "omitted", 1, "", {
      consistencyTags: [{ tag: "other", lastSortableUniqueId: "unrelated" }],
    });
    expect(omitted.status).toBe(200);
    expect((await responseJson<{ status: string }>(omitted)).status).toBe("omitted");

    const written = await post(scope, "/append", {
      attemptId: "omitted",
      epoch: 1,
      candidates: [candidate(scope, "event-1", "suid-00000000000000000000000000000001")],
    });
    expect(written.status).toBe(201);
    expect((await state(scope)).events[0]!.eventTags).toEqual([scope.tag]);

    expect(await rejectionReason(await acquire(scope, "stale-head", 2, ""))).toBe(
      "consistency_head_mismatch",
    );
    const first = await reservation(
      await acquire(scope, "first-observed", 2, "suid-00000000000000000000000000000001"),
    );
    expect(first.expectedHead).toBe("suid-00000000000000000000000000000001");
    expect(await rejectionReason(await acquire(scope, "second-observed", 1, first.expectedHead))).toBe(
      "active_reservation_conflict",
    );
    expect((await state(scope)).activeReservation?.attemptId).toBe("first-observed");
  });

  it("AC2: uses the 30-second window, cleans expiry at boundaries, and clears alarms", async () => {
    const scope = newScope();
    const original = await reservation(await acquire(scope, "expiring", 1));
    expect(original.expiresAt - Date.now()).toBeGreaterThanOrEqual(RESERVATION_WINDOW_MS - 100);

    expect((await post(scope, "/debug/clock", { nowMs: original.expiresAt - 1 })).status).toBe(200);
    expect(await rejectionReason(await acquire(scope, "just-before", 1))).toBe(
      "active_reservation_conflict",
    );

    expect((await post(scope, "/debug/clock", { nowMs: original.expiresAt + 1 })).status).toBe(200);
    const later = await reservation(await acquire(scope, "just-after", 1));
    expect(later.attemptId).toBe("just-after");
    expect((await post(scope, "/confirm", {
      attemptId: "expiring",
      epoch: 1,
      reservationToken: original.token,
    })).status).toBe(409);

    const alarmScope = newScope();
    await reservation(await acquire(alarmScope, "alarm-expiring", 1));
    const alarmReservation = (await state(alarmScope)).activeReservation!;
    await post(alarmScope, "/debug/clock", { nowMs: alarmReservation.expiresAt + 1 });
    const alarm = await post(alarmScope, "/debug/alarm");
    expect(alarm.status).toBe(200);
    const cleaned = await state(alarmScope);
    expect(cleaned.activeReservation).toBeNull();
    expect(cleaned.alarmDueAt).toBeNull();
  });

  it("AC3: seals the maximum epoch without regression and rejects stale operations", async () => {
    const scope = newScope();
    await reservation(await acquire(scope, "epoch-owner", MAX_EPOCH - 1));
    expect((await post(scope, "/seal", { attemptId: "epoch-owner", epoch: MAX_EPOCH })).status).toBe(200);
    const sealed = await state(scope);
    expect(sealed.highestEpoch).toContainEqual({ attemptId: "epoch-owner", epoch: MAX_EPOCH });
    expect(sealed.sealedEpoch).toContainEqual({ attemptId: "epoch-owner", epoch: MAX_EPOCH });
    expect(sealed.activeReservation).toBeNull();

    expect((await post(scope, "/seal", { attemptId: "epoch-owner", epoch: MAX_EPOCH })).status).toBe(200);
    const sameEpoch = await state(scope);
    expect(sameEpoch.version).toBe(sealed.version);
    expect((await post(scope, "/seal", { attemptId: "epoch-owner", epoch: MAX_EPOCH - 1 })).status).toBe(200);
    const lowerEpoch = await state(scope);
    expect(lowerEpoch.version).toBe(sealed.version);
    expect(lowerEpoch.highestEpoch).toContainEqual({ attemptId: "epoch-owner", epoch: MAX_EPOCH });

    expect(await rejectionReason(await acquire(scope, "epoch-owner", MAX_EPOCH - 1))).toBe("stale_epoch");
    expect(await rejectionReason(await post(scope, "/append", {
      attemptId: "epoch-owner",
      epoch: MAX_EPOCH - 1,
      candidates: [candidate(scope, "late", "suid-00000000000000000000000000000001")],
    }))).toBe("stale_epoch");
  });

  it("AC4: tombstone-cancel atomically clears ownership and blocks delayed acquire", async () => {
    const scope = newScope();
    const acquired = await reservation(await acquire(scope, "cancel-owner", 1));
    const cancelled = await post(scope, "/cancel", {
      attemptId: "cancel-owner",
      epoch: 1,
      reservationToken: acquired.token,
    });
    expect(cancelled.status).toBe(200);
    const tombstoned = await state(scope);
    expect(tombstoned.activeReservation).toBeNull();
    expect(tombstoned.tombstones).toContainEqual({ attemptId: "cancel-owner", epoch: 1 });

    const repeated = await post(scope, "/cancel", {
      attemptId: "cancel-owner",
      epoch: 1,
      reservationToken: acquired.token,
    });
    expect(repeated.status).toBe(200);
    expect((await state(scope)).version).toBe(tombstoned.version);
    expect(await rejectionReason(await acquire(scope, "cancel-owner", 0))).toBe("stale_epoch");
    expect(await rejectionReason(await acquire(scope, "cancel-owner", 1))).toBe("tombstoned_epoch");
    expect((await acquire(scope, "cancel-owner", 2)).status).toBe(201);
  });

  it("AC4: retries a tombstone-cancel by attempt and epoch without changing another reservation", async () => {
    const scope = newScope();
    const first = await reservation(await acquire(scope, "cancel-owner-a", 1));
    expect((await post(scope, "/cancel", {
      attemptId: "cancel-owner-a",
      epoch: 1,
      reservationToken: first.token,
    })).status).toBe(200);

    const unrelated = await reservation(await acquire(scope, "cancel-owner-b", 1));
    const beforeRetry = await state(scope);
    expect(beforeRetry.activeReservation).toEqual(unrelated);

    const retried = await post(scope, "/cancel", {
      attemptId: "cancel-owner-a",
      epoch: 1,
      reservationToken: first.token,
    });
    expect(retried.status).toBe(200);
    expect(await responseJson<{ status: string; idempotent: boolean; version: number }>(retried)).toEqual({
      status: "cancelled",
      idempotent: true,
      version: beforeRetry.version,
    });

    const afterRetry = await state(scope);
    expect(afterRetry).toEqual(beforeRetry);
    expect(await rejectionReason(await acquire(scope, "cancel-owner-a", 1))).toBe("tombstoned_epoch");
    expect(await state(scope)).toEqual(beforeRetry);
  });

  it("AC5: checks exact duplicates before epoch, then reservation ownership, then monotonicity", async () => {
    const duplicateScope = newScope();
    const owned = await reservation(await acquire(duplicateScope, "ordered", 1));
    const original = candidate(duplicateScope, "event-1", "suid-00000000000000000000000000000001");
    expect((await post(duplicateScope, "/append", {
      attemptId: "ordered",
      epoch: 1,
      reservationToken: owned.token,
      candidates: [original],
    })).status).toBe(201);
    expect((await post(duplicateScope, "/seal", { attemptId: "ordered", epoch: 2 })).status).toBe(200);
    const beforeDuplicate = await state(duplicateScope);

    const oldDuplicate = await post(duplicateScope, "/append", {
      attemptId: "ordered",
      epoch: 0,
      candidates: [original],
    });
    expect(oldDuplicate.status).toBe(200);
    expect(await state(duplicateScope)).toEqual(beforeDuplicate);
    expect(await rejectionReason(await post(duplicateScope, "/append", {
      attemptId: "ordered",
      epoch: 0,
      candidates: [{ ...original, payload: "changed" }],
    }))).toBe("stale_epoch");

    const tokenScope = newScope();
    expect((await post(tokenScope, "/append", {
      attemptId: "seed",
      epoch: 1,
      candidates: [candidate(tokenScope, "seed", "suid-00000000000000000000000000000002")],
    })).status).toBe(201);
    await reservation(await acquire(tokenScope, "owner", 1, "suid-00000000000000000000000000000002"));
    expect(await rejectionReason(await post(tokenScope, "/append", {
      attemptId: "foreign",
      epoch: 1,
      candidates: [candidate(tokenScope, "foreign", "suid-00000000000000000000000000000001")],
    }))).toBe("reservation_token_required");
  });

  it("AC6: appends ordered batches and confirms reservations atomically under injected faults", async () => {
    const scope = newScope();
    const owned = await reservation(await acquire(scope, "batch", 1));
    const reverseBatch = [
      candidate(scope, "event-2", "suid-00000000000000000000000000000002"),
      candidate(scope, "event-1", "suid-00000000000000000000000000000001"),
    ];
    const beforeFault = await state(scope);
    const fault = await post(scope, "/append", {
      attemptId: "batch",
      epoch: 1,
      reservationToken: owned.token,
      candidates: reverseBatch,
      faultInjection: "after-append-before-confirm",
    });
    expect(fault.status).toBe(503);
    expect(await state(scope)).toEqual(beforeFault);

    const appended = await post(scope, "/append", {
      attemptId: "batch",
      epoch: 1,
      reservationToken: owned.token,
      candidates: reverseBatch,
    });
    expect(appended.status).toBe(201);
    const complete = await state(scope);
    expect(complete.events.map((event) => event.suid)).toEqual([
      "suid-00000000000000000000000000000001",
      "suid-00000000000000000000000000000002",
    ]);
    expect(complete.outbox.map((row) => row.suid)).toEqual(complete.events.map((event) => event.suid));
    expect(complete.head).toBe("suid-00000000000000000000000000000002");
    expect(complete.activeReservation).toBeNull();
    expect(complete.confirmations).toContainEqual({ attemptId: "batch", epoch: 1 });
  });

  it("AC7: makes delayed acquire, append, and confirm deterministic around seal and cancel", async () => {
    const scope = newScope();
    const owned = await reservation(await acquire(scope, "seal-race", 1));
    expect((await post(scope, "/seal", { attemptId: "seal-race", epoch: 2 })).status).toBe(200);
    const afterSeal = await state(scope);
    expect(afterSeal.activeReservation).toBeNull();
    expect(afterSeal.tombstones).toContainEqual({ attemptId: "seal-race", epoch: 2 });

    expect(await rejectionReason(await acquire(scope, "seal-race", 1))).toBe("stale_epoch");
    expect(await rejectionReason(await post(scope, "/append", {
      attemptId: "seal-race",
      epoch: 1,
      reservationToken: owned.token,
      candidates: [candidate(scope, "late", "suid-00000000000000000000000000000001")],
    }))).toBe("stale_epoch");
    expect(await rejectionReason(await post(scope, "/confirm", {
      attemptId: "seal-race",
      epoch: 1,
      reservationToken: owned.token,
    }))).toBe("stale_epoch");
    expect(await state(scope)).toEqual(afterSeal);

    const cancelScope = newScope();
    const cancelling = await reservation(await acquire(cancelScope, "cancel-race", 1));
    expect((await post(cancelScope, "/cancel", {
      attemptId: "cancel-race",
      epoch: 1,
      reservationToken: cancelling.token,
    })).status).toBe(200);
    expect(await rejectionReason(await acquire(cancelScope, "cancel-race", 1))).toBe("tombstoned_epoch");
    expect((await acquire(cancelScope, "cancel-race", 2)).status).toBe(201);
  });

  it("AC8: persists exact-key fences and invokes the minimal gate hook in both paths", async () => {
    const scope = newScope();
    expect((await post(scope, "/fence/install", {
      reason: "operator",
      attemptId: "fence-owner",
      epoch: 1,
    })).status).toBe(201);
    const installed = await state(scope);
    expect(installed.fences).toContainEqual({ reason: "operator", attemptId: "fence-owner", epoch: 1 });
    expect((await post(scope, "/fence/install", {
      reason: "operator",
      attemptId: "fence-owner",
      epoch: 1,
    })).status).toBe(200);
    expect((await state(scope)).version).toBe(installed.version);

    expect((await post(scope, "/fence/clear", {
      reason: "operator",
      attemptId: "fence-owner",
      epoch: 1,
    })).status).toBe(200);
    const cleared = await state(scope);
    expect(cleared.fences).toEqual([]);
    expect(cleared.clearedFences).toContainEqual({ reason: "operator", attemptId: "fence-owner", epoch: 1 });
    expect((await post(scope, "/fence/clear", {
      reason: "operator",
      attemptId: "fence-owner",
      epoch: 1,
    })).status).toBe(200);
    expect((await state(scope)).version).toBe(cleared.version);

    expect((await post(scope, "/fence/install", {
      reason: "gate-observation",
      attemptId: "gated-writer",
      epoch: 1,
    })).status).toBe(201);
    const acquired = await acquire(scope, "gated-writer", 1);
    expect(acquired.status).toBe(201);
    const reservationResult = await responseJson<{ reservation: TagReservation; fenceGate: { checked: boolean } }>(
      acquired,
    );
    expect(reservationResult.fenceGate.checked).toBe(true);
    const appended = await post(scope, "/append", {
      attemptId: "gated-writer",
      epoch: 1,
      reservationToken: reservationResult.reservation.token,
      candidates: [candidate(scope, "gate-event", "suid-00000000000000000000000000000001")],
    });
    expect(appended.status).toBe(201);
    expect((await responseJson<{ fenceGate: { checked: boolean } }>(appended)).fenceGate.checked).toBe(true);
    expect((await post(scope, "/fence/install", { reason: "missing-epoch", attemptId: "x" })).status).toBe(400);
  });
});
