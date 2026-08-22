import { describe, expect, it } from "vitest";
import {
  preflightDirectDoorbell,
  readDirectDoorbellConfig,
  selectDirectDoorbellViews,
} from "@sekiban/dcb-runtime";
import { assertDeliveryMatrix } from "../scripts/g29-delivery-matrix.mjs";
import matrix from "../docs/SDT-G29-delivery-matrix.json";
import { meetingRoomDeliveryPolicy } from "../samples/meeting-room/src/domain";

const views = [{ id: "RoomProjector" }, { id: "ReservationProjector" }];
const enabled = {
  DIRECT_DOORBELL: "true",
  DIRECT_DOORBELL_ALLOWED_VIEWS: "RoomProjector,ReservationProjector",
  DIRECT_DOORBELL_MAX_INVOCATIONS: "32",
};

const allQueued = { RoomProjector: "queued" as const, ReservationProjector: "queued" as const };

describe("SDT-G29 per-view delivery policy", () => {
  it("matches the published branch matrix against runtime selection", () => {
    const cases = {
      "immediate-enabled-allowed": { env: enabled, domain: "immediate-preferred" as const, policy: meetingRoomDeliveryPolicy },
      "immediate-enabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "immediate-preferred" as const, policy: meetingRoomDeliveryPolicy },
      "immediate-disabled-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false" }, domain: "immediate-preferred" as const, policy: meetingRoomDeliveryPolicy },
      "immediate-disabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false", DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "immediate-preferred" as const, policy: meetingRoomDeliveryPolicy },
      "queued-enabled-allowed": { env: enabled, domain: "queued" as const, policy: allQueued },
      "queued-enabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "queued" as const, policy: allQueued },
      "queued-disabled-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false" }, domain: "queued" as const, policy: allQueued },
      "queued-disabled-not-allowed": { env: { ...enabled, DIRECT_DOORBELL: "false", DIRECT_DOORBELL_ALLOWED_VIEWS: "" }, domain: "queued" as const, policy: allQueued },
    } as const;
    const actual = Object.fromEntries(Object.entries(cases).map(([rowId, value]) => {
      const config = readDirectDoorbellConfig(value.env, value.domain, value.policy);
      const preflight = preflightDirectDoorbell(config);
      const status = preflight.status;
      const selected = status === "ready" ? selectDirectDoorbellViews(views, config).map((view) => view.id) : [];
      const queueInvocations = value.domain === "queued" || status === "queued-degraded" ? views.length : status === "ready" ? views.length - selected.length : 0;
      return [rowId, {
        descriptor: { domainClass: config.deliveryClass, viewClasses: config.domainViewDeliveryClasses },
        status,
        reason: preflight.reason,
        views: selected,
        directInvocations: selected.length,
        queueInvocations,
      }];
    }));
    expect(assertDeliveryMatrix(actual, matrix)).toEqual({ rows: 8 });
  });

  it("keeps the deployment global class subordinate to the per-view descriptor", () => {
    const config = readDirectDoorbellConfig({
      ...enabled,
      DOMAIN_DELIVERY_CLASS: "queued",
    }, "immediate-preferred", meetingRoomDeliveryPolicy);
    expect(config.deliveryClass).toBe("immediate-preferred");
    expect(selectDirectDoorbellViews(views, config).map((view) => view.id)).toEqual(["RoomProjector", "ReservationProjector"]);
  });

  it("keeps descriptor-absent legacy migration explicit", () => {
    const config = readDirectDoorbellConfig({ ...enabled, DOMAIN_DELIVERY_CLASS: "immediate-preferred" });
    expect(config.domainViewDeliveryClasses).toBeUndefined();
    expect(selectDirectDoorbellViews(views, config).map((view) => view.id)).toEqual(["RoomProjector", "ReservationProjector"]);
  });

  it("does not silently degrade the queued-degraded branch", () => {
    const config = readDirectDoorbellConfig({ ...enabled, DIRECT_DOORBELL: "false", DIRECT_DOORBELL_DEGRADATION: "queued-degraded" }, "immediate-preferred", meetingRoomDeliveryPolicy);
    expect(preflightDirectDoorbell(config)).toMatchObject({ status: "queued-degraded", reason: "deployment_direct_doorbell_disabled" });
    expect(selectDirectDoorbellViews(views, config)).toEqual([]);
  });

  it("turns a changed view policy into an exact matrix failure", () => {
    const config = readDirectDoorbellConfig(enabled, "immediate-preferred", {
      RoomProjector: "immediate-preferred",
      ReservationProjector: "immediate-preferred",
    });
    expect(selectDirectDoorbellViews(views, config).map((view) => view.id)).toEqual(["RoomProjector", "ReservationProjector"]);
  });
});
