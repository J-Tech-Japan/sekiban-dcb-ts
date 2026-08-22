import {
  deserializePortableSnapshot,
  executeCommand,
  executePortableCommand,
  serializePortableSnapshot,
  serializeDecisionLog,
  type CandidateEnvelope,
  type DecisionLog,
  type PortableSnapshot,
  type ProjectorLike,
  type SnapshotReader,
} from "@sekiban/dcb-domain";
import {
  createRoomCommand,
  meetingRoomEvents,
  meetingRoomAuthoringDomain,
  meetingRoomDomain,
  meetingRoomProjectors,
  meetingRoomRuntimeConfig,
  reserveRoomCommand,
  reservationTag,
  roomTag,
} from "./domain";

export const MAPPING_COLUMNS = Object.freeze(["field", "wire", "owner", "doTs", "portable", "version", "unsupported"] as const);

const MAPPING_INPUT = Object.freeze({ roomId: "g29-mapping-shared", name: "Observed" });
const MAPPING_NOW = "mapping-fixed-now" as const;

type MappingRun = Readonly<{
  readonly candidate: CandidateEnvelope;
  readonly decisionLog: DecisionLog;
  readonly decisionLogBytes: string;
  readonly outcome: string;
  readonly claims: readonly string[];
}>;

export type MappingExecutionObservation = Readonly<{
  readonly contract: ReturnType<typeof observeMappingContract>;
  readonly doTs: MappingRun;
  readonly portable: MappingRun;
  readonly portableSnapshot: PortableSnapshot;
  readonly restoredSnapshot: PortableSnapshot;
  readonly eventTypes: readonly string[];
  readonly viewManifest: readonly { readonly id: string; readonly source: string; readonly projector?: string; readonly deliveryClass?: string }[];
  readonly runtimeBridgeOutcome: string;
}>;

function snapshotWire(): string {
  return serializePortableSnapshot({
    projectorId: "RoomProjector",
    tag: roomTag(MAPPING_INPUT.roomId),
    head: null,
    state: { status: "empty", version: 0, roomId: null, name: "" },
    exists: false,
  });
}

function snapshotReaderFromWire(serialized: string): SnapshotReader {
  const restored = deserializePortableSnapshot(serialized);
  return {
    read: (projector: ProjectorLike, tag) => {
      if (projector.id !== restored.projectorId || tag.id !== restored.tag.id) {
        throw new Error(`G29 mapping portable snapshot boundary mismatch:${projector.id}:${tag.id}`);
      }
      return restored;
    },
  };
}

function summarizeRun(result: Awaited<ReturnType<typeof executeCommand>>): MappingRun {
  if (result.envelope === undefined) throw new Error("G29 mapping fixture did not produce a candidate");
  return Object.freeze({
    candidate: result.envelope,
    decisionLog: result.log,
    decisionLogBytes: serializeDecisionLog(result.log),
    outcome: result.decision.kind,
    claims: Object.freeze(result.log.readClaims.map((claim) => `${claim.kind}:${claim.projectorId ?? "-"}:${claim.tag.id}:${claim.head ?? ""}`)),
  });
}

function eventTypes(): readonly string[] {
  return Object.freeze(meetingRoomAuthoringDomain.events.map((definition) => definition.eventType));
}

function viewManifest(): readonly { readonly id: string; readonly source: string; readonly projector?: string; readonly deliveryClass?: string }[] {
  return Object.freeze(meetingRoomAuthoringDomain.views.map((view) => Object.freeze({ ...view })));
}

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
  readonly execution: MappingExecutionObservation;
}> {
  const doTsResult = await executeCommand(createRoomCommand, MAPPING_INPUT, {
    timeProvider: { now: () => "mapping-fixed-now" },
  });
  const portableSnapshot = deserializePortableSnapshot(snapshotWire());
  const portableResult = await executePortableCommand(createRoomCommand, MAPPING_INPUT, {
    timeProvider: { now: () => MAPPING_NOW },
    snapshots: snapshotReaderFromWire(snapshotWire()),
  });
  if (doTsResult.status !== "accepted" || portableResult.status !== "accepted") throw new Error("G29 mapping shared fixture did not commit");
  const doTs = summarizeRun(doTsResult);
  const portable = summarizeRun(portableResult);
  const restoredSnapshot = deserializePortableSnapshot(serializePortableSnapshot(portableSnapshot));
  const runtimeCommand = meetingRoomDomain.commands.find((command) => command.id === createRoomCommand.id);
  if (runtimeCommand === undefined) throw new Error("G29 mapping runtime bridge command is not registered");
  const runtimeResult = await runtimeCommand.execute(MAPPING_INPUT, {
    now: MAPPING_NOW,
    snapshots: snapshotReaderFromWire(snapshotWire()),
  });
  const execution = Object.freeze({
    contract: observeMappingContract(),
    doTs,
    portable,
    portableSnapshot,
    restoredSnapshot,
    eventTypes: eventTypes(),
    viewManifest: viewManifest(),
    runtimeBridgeOutcome: (runtimeResult as { readonly kind?: string }).kind ?? "unknown",
  });
  return Object.freeze({
    contract: execution.contract,
    candidate: doTs.candidate,
    decisionLog: doTs.decisionLog,
    decisionLogBytes: doTs.decisionLogBytes,
    execution,
  });
}

export function mappingObservationTags(): readonly string[] {
  return Object.freeze([roomTag("mapping-room").id, reservationTag("mapping-reservation").id]);
}
