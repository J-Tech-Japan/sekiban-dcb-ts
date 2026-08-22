import {
  executeCommand,
  serializeDecisionLog,
  type CandidateEnvelope,
  type DecisionLog,
} from "@sekiban/dcb-domain";
import {
  createRoomCommand,
  meetingRoomEvents,
  meetingRoomProjectors,
  meetingRoomRuntimeConfig,
  reserveRoomCommand,
  reservationTag,
  roomTag,
} from "./domain";

export const MAPPING_COLUMNS = Object.freeze(["field", "wire", "owner", "doTs", "portable", "version", "unsupported"] as const);

function observationSnapshot() {
  const roomCreated = meetingRoomEvents.roomCreated;
  const roomReserved = meetingRoomEvents.roomReserved;
  const roomProjector = meetingRoomProjectors.roomProjector;
  const reservationProjector = meetingRoomProjectors.reservationProjector;
  const derivedReservationTags = roomReserved.tags({ roomId: "mapping-room", reservationId: "mapping-reservation", userId: "mapping-user" });
  const reserveReads = reserveRoomCommand.reads({ roomId: "mapping-room", reservationId: "mapping-reservation", userId: "mapping-user" });
  if (roomCreated.eventType !== "RoomCreated:1" || roomReserved.eventType !== "RoomReserved:1") throw new Error("G29 mapping observed event registry is not canonical");
  if (derivedReservationTags.map((tag) => tag.id).join(",") !== "room:mapping-room,reservation:mapping-reservation") throw new Error("G29 mapping observed tag deriver changed");
  if (reserveReads.claims.length !== 2 || roomProjector.version !== 1 || reservationProjector.version !== 1) throw new Error("G29 mapping observed read/projector contract changed");
  if (meetingRoomRuntimeConfig.deliveryViews.length !== 2) throw new Error("G29 mapping observed view descriptor count changed");

  return Object.freeze({
    "event-payload": {
      field: "event payload",
      wire: "V1 eventCandidates[].payload (base64 JSON); stored payload is lossless JSON",
      owner: "registered event definition schema",
      doTs: "event.make(payload) and event.create(payload)",
      portable: "JsonValue payload without runtime brands",
      version: `event definition version, default ${roomCreated.version}`,
      unsupported: "caller-selected eventPayloadVersion",
    },
    "business-time": {
      field: "business time",
      wire: "DecisionLog.now / command candidate now",
      owner: "single command execution clock capture",
      doTs: "context.now()",
      portable: "FixedNow (string | number | bigint)",
      version: "one value for every retry attempt",
      unsupported: "allocator time used as business time",
    },
    "canonical-identity": {
      field: "canonical identity",
      wire: "eventPayloadName:decimalVersion",
      owner: "registered domain definition at commit admission",
      doTs: "event.eventType",
      portable: "eventType string",
      version: "name-local decimal version",
      unsupported: "identity derived from eventId or payload sniffing",
    },
    "event-id": {
      field: "eventId",
      wire: "StoredEvent.eventId / downstream envelope eventId",
      owner: "allocator and commit admission",
      doTs: "absent from authoring decision",
      portable: "optional transport metadata only",
      version: "G27 runtime identity",
      unsupported: "authoring command manufactures eventId",
    },
    suid: {
      field: "SUID",
      wire: "StoredEvent.suid / receipt key",
      owner: "OrderClock allocator",
      doTs: "absent from authoring decision",
      portable: "optional transport metadata only",
      version: "monotone allocated ordinal",
      unsupported: "business clock or client ordinal as SUID",
    },
    tags: {
      field: "tags",
      wire: "eventCandidates[].tags and stored eventTags",
      owner: "event definition tag deriver",
      doTs: "event.tags(payload)",
      portable: "readonly Tag[] with family/value/id",
      version: "derived once and preserved per hop",
      unsupported: "re-derived tags from mutable payload after append",
    },
    state: {
      field: "state",
      wire: "tag-state payload and materialized row",
      owner: "projector state union",
      doTs: "projector.validateState / projector handlers",
      portable: "JSON-serializable discriminated state",
      version: "projector definition version",
      unsupported: "unvalidated arbitrary state cast",
    },
    projector: {
      field: "projector",
      wire: "tagProjector and projector version",
      owner: "registered projector definition",
      doTs: "projector(id, tag family, events)",
      portable: "projector id/version descriptor",
      version: "positive projector version",
      unsupported: "projector inferred from payload discriminator",
    },
    "command-input": {
      field: "command input",
      wire: "V1 request commandId/input",
      owner: "command input schema",
      doTs: "command.parseInput",
      portable: "validated JSON input",
      version: "command definition id",
      unsupported: "handler-side unchecked object cast",
    },
    "read-set": {
      field: "read-set",
      wire: "consistencyTags and candidate read claims",
      owner: "command reads declaration",
      doTs: "read/readSet/readExists",
      portable: "immutable per-tag head claims",
      version: "one claim per declared projector/tag cell",
      unsupported: "undeclared snapshot read",
    },
    "decision-log": {
      field: "DecisionLog",
      wire: "internal diagnostic only; never V1 body",
      owner: "session lifecycle",
      doTs: "executeCommand session log",
      portable: "now, staged events, read claims, terminal decision",
      version: "schemaVersion 1",
      unsupported: "eventId/SUID allocation fields",
    },
    "terminal-outcome": {
      field: "terminal outcome",
      wire: "committed/noop/rejected/typed conflict",
      owner: "command decision plus commit port",
      doTs: "done/none/reject",
      portable: "discriminated outcome union",
      version: "V1-compatible result mapping",
      unsupported: "silent fallback from typed reject",
    },
    "view-descriptor": {
      field: "view descriptor",
      wire: "tagProjector/query view identity; no V1 shape change",
      owner: "domain view registration and deployment policy",
      doTs: "domain.views entry",
      portable: "id/source/projector/deliveryClass descriptor",
      version: "descriptor schemaVersion 1",
      unsupported: "global deployment variable overriding a view",
    },
  });
}

export function observeMappingContract(): Record<string, Record<(typeof MAPPING_COLUMNS)[number], string>> {
  return observationSnapshot() as Record<string, Record<(typeof MAPPING_COLUMNS)[number], string>>;
}

export async function observePortableMappingExecution(): Promise<{
  readonly contract: ReturnType<typeof observeMappingContract>;
  readonly candidate: CandidateEnvelope;
  readonly decisionLog: DecisionLog;
  readonly decisionLogBytes: string;
}> {
  let candidate: CandidateEnvelope | undefined;
  const result = await executeCommand(createRoomCommand, { roomId: "g29-mapping-runtime", name: "Observed" }, {
    timeProvider: { now: () => "mapping-fixed-now" },
    commit: (envelope) => {
      candidate = envelope;
      return { kind: "accepted" };
    },
  });
  if (candidate === undefined || result.status !== "accepted") throw new Error("G29 mapping DO-ts command execution did not commit");
  const decisionLogBytes = serializeDecisionLog(result.log);
  return Object.freeze({
    contract: observeMappingContract(),
    candidate,
    decisionLog: result.log,
    decisionLogBytes,
  });
}

export function mappingObservationTags(): readonly string[] {
  return Object.freeze([roomTag("mapping-room").id, reservationTag("mapping-reservation").id]);
}
