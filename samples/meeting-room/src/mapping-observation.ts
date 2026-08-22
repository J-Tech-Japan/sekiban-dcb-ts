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

/**
 * Evidence captured by the real CommitWorker admission fixture.  The mapping
 * observation consumes this value; it never manufactures an identity or a
 * storage ordinal while describing the contract.
 */
export type MappingAdmissionEvidence = Readonly<{
  readonly eventPayloadName: string;
  readonly eventType: string;
  readonly registeredVersion: number;
  readonly payloadBase64: string;
  readonly storedEventId: string;
  readonly storedSuid: string;
  readonly tags: readonly string[];
  readonly callerSelectedVersionRejected: boolean;
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
  readonly admission: MappingAdmissionEvidence;
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

type MappingContract = Record<string, Record<(typeof MAPPING_COLUMNS)[number], string>>;

type MappingContractInput = Readonly<{
  readonly admission: MappingAdmissionEvidence;
  readonly doTs: MappingRun;
  readonly portable: MappingRun;
  readonly portableSnapshot: PortableSnapshot;
  readonly restoredSnapshot: PortableSnapshot;
  readonly eventTypes: readonly string[];
  readonly viewManifest: readonly { readonly id: string; readonly source: string; readonly projector?: string; readonly deliveryClass?: string }[];
}>;

function observedContract(input: MappingContractInput): MappingContract {
  const created = meetingRoomEvents.roomCreated;
  const reserved = meetingRoomEvents.roomReserved;
  const roomProjector = meetingRoomProjectors.roomProjector;
  const reservationProjector = meetingRoomProjectors.reservationProjector;
  const reservationTags = reserved.tags({ roomId: "mapping-room", reservationId: "mapping-reservation", userId: "mapping-user" });
  const reserveReads = reserveRoomCommand.reads({ roomId: "mapping-room", reservationId: "mapping-reservation", userId: "mapping-user" });
  const createdValue = created.create(MAPPING_INPUT);
  const createdPayload = created.make(MAPPING_INPUT);
  const candidateEvent = input.doTs.candidate.events[0];
  const portableEvent = input.portable.candidate.events[0];
  const snapshotRoundTrip = JSON.stringify(input.portableSnapshot) === JSON.stringify(input.restoredSnapshot);
  const sameIdentity = candidateEvent?.eventType === portableEvent?.eventType && candidateEvent?.eventType === input.admission.eventType;
  const sameTags = candidateEvent?.tags.map((tag) => tag.id).join(",") === input.admission.tags.join(",");
  const commandInputValidated = meetingRoomAuthoringDomain.commands.find((command) => command.id === createRoomCommand.id)?.parseInput(MAPPING_INPUT) !== undefined;
  const allViewsHaveProjectors = input.viewManifest.length === meetingRoomRuntimeConfig.deliveryViews.length && input.viewManifest.every((view) => typeof view.projector === "string");
  if (!sameIdentity || !sameTags || !snapshotRoundTrip || !commandInputValidated || !allViewsHaveProjectors) {
    throw new Error("G29 mapping shared execution evidence diverged at an observed boundary");
  }
  if (created.eventType !== input.admission.eventType || createdValue.eventType !== input.admission.eventType || createdPayload.roomId !== MAPPING_INPUT.roomId) {
    throw new Error("G29 mapping CommitWorker admission is not using the registered event definition");
  }
  if (input.admission.registeredVersion !== created.version || !input.admission.callerSelectedVersionRejected) {
    throw new Error("G29 mapping admission authority probe did not execute");
  }
  if (reservationTags.map((tag) => tag.id).join(",") !== "room:mapping-room,reservation:mapping-reservation" || reserveReads.claims.length !== 2) {
    throw new Error("G29 mapping tag/read observation changed");
  }
  if (roomProjector.version !== 1 || reservationProjector.version !== 1 || input.eventTypes.length !== meetingRoomAuthoringDomain.events.length) {
    throw new Error("G29 mapping projector/event registry observation changed");
  }

  const candidatePayload = candidateEvent?.payload;
  const portablePayload = portableEvent?.payload;
  const candidateTags = candidateEvent?.tags.map((tag) => tag.id) ?? [];
  const admissionPayload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(input.admission.payloadBase64), (character) => character.charCodeAt(0)))) as unknown;
  const hasAllocatorMetadata = input.admission.storedEventId.length > 0 && input.admission.storedSuid.length > 0;
  const checked = (value: string, condition: boolean, boundary: string): string => {
    if (!condition) throw new Error(`G29 mapping observation boundary failed:${boundary}`);
    return value;
  };
  const row = (...cells: readonly [string, string][]): Record<(typeof MAPPING_COLUMNS)[number], string> => Object.fromEntries(cells) as Record<(typeof MAPPING_COLUMNS)[number], string>;
  const observedRows: Readonly<Record<string, () => Record<(typeof MAPPING_COLUMNS)[number], string>>> = {
    "event-payload": () => row(
      ["field", checked("event payload", candidatePayload !== undefined && portablePayload !== undefined, "event-payload/field")],
      ["wire", checked("V1 eventCandidates[].payload (base64 JSON); stored payload is lossless JSON", input.admission.payloadBase64.length > 0 && JSON.stringify(admissionPayload) === JSON.stringify({ roomId: "g29-mapping-shared", name: "Observed" }) && hasAllocatorMetadata, "event-payload/wire")],
      ["owner", checked("registered event definition schema", input.admission.registeredVersion === created.version && input.admission.eventPayloadName === created.eventPayloadName, "event-payload/owner")],
      ["doTs", checked("event.make(payload) and event.create(payload)", JSON.stringify(candidatePayload) === JSON.stringify(createdPayload) && createdValue.eventType === candidateEvent?.eventType, "event-payload/doTs")],
      ["portable", checked("JsonValue payload without runtime brands", JSON.stringify(portablePayload) === JSON.stringify(candidatePayload), "event-payload/portable")],
      ["version", `event definition version, default ${input.admission.registeredVersion}`],
      ["unsupported", checked("caller-selected eventPayloadVersion", input.admission.callerSelectedVersionRejected, "event-payload/unsupported")],
    ),
    "business-time": () => row(
      ["field", checked("business time", input.doTs.decisionLog.now === input.portable.decisionLog.now, "business-time/field")],
      ["wire", checked("DecisionLog.now / command candidate now", input.doTs.decisionLog.now === input.doTs.candidate.now, "business-time/wire")],
      ["owner", checked("single command execution clock capture", input.doTs.decisionLog.now === MAPPING_NOW, "business-time/owner")],
      ["doTs", "context.now()"],
      ["portable", "FixedNow (string | number | bigint)"],
      ["version", checked("one value for every retry attempt", input.doTs.decisionLog.now === input.portable.decisionLog.now, "business-time/version")],
      ["unsupported", checked("allocator time used as business time", !hasAllocatorMetadata || input.doTs.decisionLog.now !== input.admission.storedSuid, "business-time/unsupported")],
    ),
    "canonical-identity": () => row(
      ["field", checked("canonical identity", sameIdentity, "canonical-identity/field")],
      ["wire", checked("eventPayloadName:decimalVersion", /^\w+:\d+$/.test(input.admission.eventType), "canonical-identity/wire")],
      ["owner", checked("registered domain definition at commit admission", input.admission.registeredVersion === created.version, "canonical-identity/owner")],
      ["doTs", checked("event.eventType", created.eventType === candidateEvent?.eventType, "canonical-identity/doTs")],
      ["portable", checked("eventType string", typeof portableEvent?.eventType === "string", "canonical-identity/portable")],
      ["version", "name-local decimal version"],
      ["unsupported", "identity derived from eventId or payload sniffing"],
    ),
    "event-id": () => row(
      ["field", "eventId"],
      ["wire", "StoredEvent.eventId / downstream envelope eventId"],
      ["owner", checked("allocator and commit admission", hasAllocatorMetadata, "event-id/owner")],
      ["doTs", "absent from authoring decision"],
      ["portable", "optional transport metadata only"],
      ["version", "G27 runtime identity"],
      ["unsupported", "authoring command manufactures eventId"],
    ),
    suid: () => row(
      ["field", "SUID"],
      ["wire", "StoredEvent.suid / receipt key"],
      ["owner", checked("OrderClock allocator", hasAllocatorMetadata, "suid/owner")],
      ["doTs", "absent from authoring decision"],
      ["portable", "optional transport metadata only"],
      ["version", "monotone allocated ordinal"],
      ["unsupported", "business clock or client ordinal as SUID"],
    ),
    tags: () => row(
      ["field", checked("tags", sameTags, "tags/field")],
      ["wire", checked("eventCandidates[].tags and stored eventTags", candidateTags.length === input.admission.tags.length, "tags/wire")],
      ["owner", checked("event definition tag deriver", reservationTags.length === 2, "tags/owner")],
      ["doTs", "event.tags(payload)"],
      ["portable", "readonly Tag[] with family/value/id"],
      ["version", "derived once and preserved per hop"],
      ["unsupported", "re-derived tags from mutable payload after append"],
    ),
    state: () => row(
      ["field", checked("state", input.portableSnapshot.state !== undefined, "state/field")],
      ["wire", "tag-state payload and materialized row"],
      ["owner", "projector state union"],
      ["doTs", "projector.validateState / projector handlers"],
      ["portable", checked("JSON-serializable discriminated state", snapshotRoundTrip, "state/portable")],
      ["version", "projector definition version"],
      ["unsupported", "unvalidated arbitrary state cast"],
    ),
    projector: () => row(
      ["field", "projector"],
      ["wire", "tagProjector and projector version"],
      ["owner", checked("registered projector definition", roomProjector.version === 1 && reservationProjector.version === 1, "projector/owner")],
      ["doTs", "projector(id, tag family, events)"],
      ["portable", "projector id/version descriptor"],
      ["version", "positive projector version"],
      ["unsupported", "projector inferred from payload discriminator"],
    ),
    "command-input": () => row(
      ["field", checked("command input", commandInputValidated, "command-input/field")],
      ["wire", "V1 request commandId/input"],
      ["owner", "command input schema"],
      ["doTs", "command.parseInput"],
      ["portable", "validated JSON input"],
      ["version", "command definition id"],
      ["unsupported", "handler-side unchecked object cast"],
    ),
    "read-set": () => row(
      ["field", checked("read-set", reserveReads.claims.length === 2, "read-set/field")],
      ["wire", "consistencyTags and candidate read claims"],
      ["owner", "command reads declaration"],
      ["doTs", "read/readSet/readExists"],
      ["portable", checked("immutable per-tag head claims", input.doTs.claims.length === input.portable.claims.length, "read-set/portable")],
      ["version", "one claim per declared projector/tag cell"],
      ["unsupported", "undeclared snapshot read"],
    ),
    "decision-log": () => row(
      ["field", checked("DecisionLog", input.doTs.decisionLogBytes.length > 0, "decision-log/field")],
      ["wire", "internal diagnostic only; never V1 body"],
      ["owner", "session lifecycle"],
      ["doTs", "executeCommand session log"],
      ["portable", "now, staged events, read claims, terminal decision"],
      ["version", "schemaVersion 1"],
      ["unsupported", "eventId/SUID allocation fields"],
    ),
    "terminal-outcome": () => row(
      ["field", checked("terminal outcome", input.doTs.outcome === input.portable.outcome, "terminal-outcome/field")],
      ["wire", "committed/noop/rejected/typed conflict"],
      ["owner", "command decision plus commit port"],
      ["doTs", "done/none/reject"],
      ["portable", "discriminated outcome union"],
      ["version", "V1-compatible result mapping"],
      ["unsupported", "silent fallback from typed reject"],
    ),
    "view-descriptor": () => row(
      ["field", checked("view descriptor", allViewsHaveProjectors, "view-descriptor/field")],
      ["wire", "tagProjector/query view identity; no V1 shape change"],
      ["owner", "domain view registration and deployment policy"],
      ["doTs", checked("domain.views entry", input.viewManifest.length === meetingRoomRuntimeConfig.deliveryViews.length, "view-descriptor/doTs")],
      ["portable", "id/source/projector/deliveryClass descriptor"],
      ["version", "descriptor schemaVersion 1"],
      ["unsupported", "global deployment variable overriding a view"],
    ),
  };
  return Object.fromEntries(Object.entries(observedRows).map(([rowId, observe]) => [rowId, observe()])) as MappingContract;
}

export function observeMappingContract(input: MappingContractInput): MappingContract {
  return observedContract(input);
}

export async function observePortableMappingExecution(admission: MappingAdmissionEvidence): Promise<{
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
  const observedEventTypes = eventTypes();
  const observedViewManifest = viewManifest();
  const runtimeBridgeOutcome = (runtimeResult as { readonly kind?: string }).kind ?? "unknown";
  const contract = observeMappingContract({
    admission,
    doTs,
    portable,
    portableSnapshot,
    restoredSnapshot,
    eventTypes: observedEventTypes,
    viewManifest: observedViewManifest,
  });
  const execution = Object.freeze({
    contract,
    doTs,
    portable,
    portableSnapshot,
    restoredSnapshot,
    eventTypes: observedEventTypes,
    viewManifest: observedViewManifest,
    runtimeBridgeOutcome,
    admission,
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
