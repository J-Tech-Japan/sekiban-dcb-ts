import type { DeliverySource, DownstreamOutboxMessage } from "../downstream/types";
import { resolveDeliveryIdentity } from "../eventIdentity";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";
import { isRfc4122Uuid, isUuidV7, serializedEventMetadata } from "../eventRecord";
import { decayedLagEstimateMs } from "../safeWindow";
import {
  CanonicalEventIdentityConflictError,
  type DeliveryLagRecord,
  type DeliveryIncident,
  type DeliveryIncidentClassification,
  type DeliveryOutcome,
  type DetectorStore,
  type EventStore,
  type InconsistencyClassification,
  type InconsistencyFinding,
  type PendingArrivalRecord,
  type ProjectionCheckpoint,
  type ProjectionCheckpointAdvance,
  type ProjectionLag,
  type ProjectionStore,
  type StoredEvent,
} from "./types";
type JsonObject = Record<string, unknown>;

export interface CosmosDocumentRecord<T extends JsonObject = JsonObject> {
  document: T;
  etag?: string;
}

/** Minimal document operations used by the adapter; it is also the fault-test seam. */
export interface CosmosDocumentClient {
  initialize(): Promise<void>;
  read<T extends JsonObject>(container: string, id: string, partitionKey: string): Promise<CosmosDocumentRecord<T> | undefined>;
  create<T extends JsonObject>(container: string, document: T, partitionKey: string): Promise<CosmosDocumentRecord<T>>;
  replace<T extends JsonObject>(container: string, document: T, partitionKey: string, etag?: string): Promise<boolean>;
  /** Optional fault-test seam; the adapter deliberately never calls it. */
  delete?(container: string, id: string, partitionKey: string): Promise<boolean>;
  query<T extends JsonObject>(
    container: string,
    query: string,
    parameters: readonly { name: string; value: unknown }[],
    partitionKey?: string,
  ): Promise<CosmosDocumentRecord<T>[]>;
}

export type CosmosWriteBoundary = "event" | "lag" | "pending" | "finding" | "checkpoint" | "incident" | "incident-projection";

export interface CosmosContainerNames {
  readonly events: string;
  readonly lagEstimates: string;
  readonly pendingArrivals: string;
  readonly findings: string;
  readonly checkpoints: string;
}

/** Sekiban.Dcb CosmosEvent's immutable logical-record partition. */
export const COSMOS_EVENT_PARTITION_KEY_PATH = "/pk" as const;
/** TS-only auxiliary documents retain a service-local partition. */
export const COSMOS_AUXILIARY_PARTITION_KEY_PATH = "/serviceId" as const;
/** @deprecated Kept as an alias for auxiliary-container callers. */
export const COSMOS_PARTITION_KEY_PATH = COSMOS_AUXILIARY_PARTITION_KEY_PATH;

export const DEFAULT_COSMOS_CONTAINERS: CosmosContainerNames = Object.freeze({
  events: "dcb-events",
  lagEstimates: "dcb-lag-estimates",
  pendingArrivals: "dcb-pending-arrivals",
  findings: "dcb-findings",
  checkpoints: "dcb-projection-checkpoints",
});

export interface CosmosContainerDefinition {
  readonly name: string;
  readonly partitionKeyPath: typeof COSMOS_EVENT_PARTITION_KEY_PATH | typeof COSMOS_AUXILIARY_PARTITION_KEY_PATH;
  readonly partitionKeyValue: (serviceId: string, id?: string) => string;
}

/**
 * The layout is data rather than a comment so every adapter initialization and
 * contract fixture can inspect the same five service-partitioned containers.
 */
export function cosmosContainerDefinitions(
  containers: CosmosContainerNames = DEFAULT_COSMOS_CONTAINERS,
): readonly CosmosContainerDefinition[] {
  return [
    {
      name: containers.events,
      partitionKeyPath: COSMOS_EVENT_PARTITION_KEY_PATH,
      // The C# CosmosEvent is partitioned by the exact serviceId|id pair.
      // Refuse a missing id here so an introspection fixture cannot mistake
      // an auxiliary service partition for the logical event partition.
      partitionKeyValue: (serviceId: string, id?: string) => {
        if (typeof id !== "string" || id.length === 0) throw new Error("Cosmos event partition key requires an event id");
        return eventPk(serviceId, id);
      },
    },
    ...[containers.lagEstimates, containers.pendingArrivals, containers.findings, containers.checkpoints].map((name) => ({
      name,
      partitionKeyPath: COSMOS_AUXILIARY_PARTITION_KEY_PATH,
      partitionKeyValue: (serviceId: string) => serviceId,
    })),
  ];
}

export interface CosmosStoreOptions {
  /** Cosmos account endpoint, including the trailing slash when supplied. */
  readonly endpoint?: string;
  /** Base64 account key. It is supplied by the runtime secret boundary only. */
  readonly key?: string;
  readonly database?: string;
  readonly containers?: Partial<CosmosContainerNames>;
  readonly fetcher?: typeof fetch;
  readonly client?: CosmosDocumentClient;
  readonly beforeWrite?: (boundary: CosmosWriteBoundary) => void | Promise<void>;
}

export class CosmosClientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "CosmosClientError";
  }
}

interface CosmosResponseBody {
  Documents?: JsonObject[];
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Cosmos ${name} was not a string`);
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : asString(value, name);
}

function asNumber(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Cosmos ${name} was not a safe integer`);
  return number;
}

function asStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Cosmos ${name} was not a string array`);
  }
  return [...value];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(binaryCompare);
}

function binaryCompare(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function assertUtcTimestamp(value: string, eventId: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{4})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new CanonicalEventIdentityConflictError("cosmos", eventId, "Cosmos Timestamp must be canonical UTC ISO-8601");
  }
}

/** V1 SUIDs are opaque byte strings; never use locale or numeric ordering. */
export function compareCosmosSuid(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function safeId(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join("~");
}

/** The exact CosmosEvent partition-key derivation from Sekiban.Dcb. */
function eventPk(serviceId: string, id: string): string {
  return `${serviceId}|${id}`;
}

function auxiliaryPk(serviceId: string): string {
  return eventPk(serviceId, "__dcb_event_ops__");
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof CosmosClientError && error.status === status;
}

function eventFrom(document: JsonObject, ops?: JsonObject): StoredEvent {
  const arrivals = Array.isArray(ops?.arrivals) ? ops.arrivals : [];
  const id = asString(document.id, "id");
  const tags = asStringArray(document.tags, "tags");
  return {
    serviceId: asString(document.serviceId, "serviceId"),
    id,
    eventId: id,
    sortableUniqueId: asString(document.sortableUniqueId, "sortableUniqueId"),
    suid: asString(document.sortableUniqueId, "sortableUniqueId"),
    payload: asString(document.payload, "payload"),
    tags,
    eventTags: tags,
    eventType: asString(document.eventType, "eventType"),
    timestamp: asString(document.timestamp, "timestamp"),
    causationId: nullableString(document.causationId, "causationId"),
    correlationId: nullableString(document.correlationId, "correlationId"),
    executedUser: nullableString(document.executedUser, "executedUser"),
    provenance: "g32",
    firstArrivedAt: ops === undefined ? 0 : asNumber(ops.firstArrivedAt, "firstArrivedAt"),
    lastArrivedAt: ops === undefined ? 0 : asNumber(ops.lastArrivedAt, "lastArrivedAt"),
    maxDeliveryLagMs: ops === undefined ? 0 : asNumber(ops.maxDeliveryLagMs, "maxDeliveryLagMs"),
    arrivals: arrivals.map((arrival): DeliveryLagRecord => {
      if (typeof arrival !== "object" || arrival === null || Array.isArray(arrival)) {
        throw new Error("Cosmos arrival was not an object");
      }
      const value = arrival as JsonObject;
      return {
        serviceId: asString(value.serviceId, "arrival.serviceId"),
        eventId: asString(value.eventId, "arrival.eventId"),
        tag: asString(value.tag, "arrival.tag"),
        enqueuedAt: asNumber(value.enqueuedAt, "arrival.enqueuedAt"),
        arrivedAt: asNumber(value.arrivedAt, "arrival.arrivedAt"),
        lagMs: asNumber(value.lagMs, "arrival.lagMs"),
      };
    }),
  };
}

function pendingFrom(document: JsonObject): PendingArrivalRecord {
  return {
    serviceId: asString(document.serviceId, "serviceId"),
    attemptId: asString(document.attemptId, "attemptId"),
    eventId: asString(document.eventId, "eventId"),
    suid: asString(document.suid, "suid"),
    expectedPaths: sortedUnique(asStringArray(document.expectedPaths, "expectedPaths")),
    observedPaths: sortedUnique(asStringArray(document.observedPaths, "observedPaths")),
    firstObservedAt: asNumber(document.firstObservedAt, "firstObservedAt"),
    lagBoundMs: asNumber(document.lagBoundMs, "lagBoundMs"),
  };
}

function findingFrom(document: JsonObject): InconsistencyFinding {
  const classification = asString(document.classification, "classification");
  if (classification !== "MISSING_STABLE" && classification !== "EXCLUDED_AUDITED" && classification !== "RESOLVED_LATE") {
    throw new Error("Cosmos classification was invalid");
  }
  return {
    serviceId: asString(document.serviceId, "serviceId"),
    eventId: asString(document.eventId, "eventId"),
    path: asString(document.path, "path"),
    classification,
    firstObservedAt: asNumber(document.firstObservedAt, "firstObservedAt"),
    lagBoundMs: asNumber(document.lagBoundMs, "lagBoundMs"),
    observedAt: asNumber(document.observedAt, "observedAt"),
  };
}

function incidentClassification(value: unknown): DeliveryIncidentClassification {
  const classification = asString(value, "classification");
  if (classification !== "SUID_COLLISION" && classification !== "ORDER_VIOLATION" && classification !== "LINEAGE_MISMATCH") {
    throw new Error("Cosmos delivery incident classification was invalid");
  }
  return classification;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return asString(value, name);
}

function incidentFrom(document: JsonObject): DeliveryIncident {
  return {
    serviceId: asString(document.serviceId, "serviceId"),
    identityKey: asString(document.identityKey, "identityKey"),
    classification: incidentClassification(document.classification),
    suid: optionalString(document.suid, "suid"),
    existingEventId: optionalString(document.existingEventId, "existingEventId"),
    incomingEventId: optionalString(document.incomingEventId, "incomingEventId"),
    eventId: optionalString(document.eventId, "eventId"),
    boundLineageId: optionalString(document.boundLineageId, "boundLineageId"),
    incomingLineageId: optionalString(document.incomingLineageId, "incomingLineageId"),
    observedAt: asNumber(document.observedAt, "observedAt"),
  };
}

function collisionIdentity(serviceId: string, suid: string, existingEventId: string, incomingEventId: string): string {
  const [first, second] = [existingEventId, incomingEventId].sort(binaryCompare);
  return `SUID_COLLISION|${serviceId}|${suid}|${first}|${second}`;
}

function lineageIdentity(serviceId: string, boundLineageId: string, incomingLineageId: string): string {
  return `LINEAGE_MISMATCH|${serviceId}|${boundLineageId}|${incomingLineageId}`;
}

interface DurableEventMetadata {
  readonly causationId: string | null;
  readonly correlationId: string | null;
  readonly executedUser: string | null;
}

function metadataForDelivery(message: DownstreamOutboxMessage, deliverySource: DeliverySource): DurableEventMetadata {
  const serialized = serializedEventMetadata(message.eventId);
  if (deliverySource !== "import") {
    if (
      message.causationId !== serialized.causationId ||
      message.correlationId !== serialized.correlationId ||
      message.executedUser !== serialized.executedUser
    ) {
      throw new CanonicalEventIdentityConflictError("cosmos", message.eventId, "Cosmos metadata must use the serialized C# constants");
    }
    return serialized;
  }
  const values = [message.causationId, message.correlationId, message.executedUser];
  if (!values.every((value) => value === null || typeof value === "string")) {
    throw new CanonicalEventIdentityConflictError("cosmos", message.eventId, "Cosmos import metadata must be string or null");
  }
  const allNull = values.every((value) => value === null);
  const allSerialized = message.causationId === serialized.causationId &&
    message.correlationId === serialized.correlationId && message.executedUser === serialized.executedUser;
  if (!allNull && !allSerialized) {
    throw new CanonicalEventIdentityConflictError("cosmos", message.eventId, "Cosmos import metadata must be all null or serialized constants");
  }
  return {
    causationId: message.causationId,
    correlationId: message.correlationId,
    executedUser: message.executedUser,
  };
}

function checkpointFrom(document: JsonObject): ProjectionCheckpoint {
  return {
    serviceId: asString(document.serviceId, "serviceId"),
    projectionId: asString(document.projectionId, "projectionId"),
    lastSuid: asString(document.lastSuid, "lastSuid"),
    stateJson: asString(document.stateJson, "stateJson"),
    version: asNumber(document.version, "version"),
    updatedAt: asNumber(document.updatedAt, "updatedAt"),
  };
}

function emulatorKeyBytes(key: string): Uint8Array {
  const binary = atob(key);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Fetch-based Cosmos SQL API client; it uses only Web APIs available in workerd. */
export class CosmosRestClient implements CosmosDocumentClient {
  private initialized = false;
  private readonly endpoint: string;
  private readonly key: string;
  private readonly database: string;
  private readonly fetcher: typeof fetch;
  private readonly containers: CosmosContainerNames;

  constructor(options: Required<Pick<CosmosStoreOptions, "endpoint" | "key" | "database">> & Pick<CosmosStoreOptions, "fetcher" | "containers">) {
    this.endpoint = options.endpoint.endsWith("/") ? options.endpoint : `${options.endpoint}/`;
    this.key = options.key;
    this.database = options.database;
    this.fetcher = options.fetcher ?? fetch;
    this.containers = { ...DEFAULT_COSMOS_CONTAINERS, ...options.containers };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.ensureResource("dbs", { id: this.database });
    for (const container of cosmosContainerDefinitions(this.containers)) {
      await this.ensureResource(`dbs/${encodeURIComponent(this.database)}/colls`, {
        id: container.name,
        partitionKey: { paths: [container.partitionKeyPath], kind: "Hash" },
      });
    }
    this.initialized = true;
  }

  async read<T extends JsonObject>(container: string, id: string, partitionKey: string): Promise<CosmosDocumentRecord<T> | undefined> {
    const response = await this.request(
      "GET",
      `dbs/${encodeURIComponent(this.database)}/colls/${encodeURIComponent(container)}/docs/${encodeURIComponent(id)}`,
      undefined,
      { "x-ms-documentdb-partitionkey": JSON.stringify([partitionKey]) },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw await this.errorFrom(response, "Cosmos document read failed");
    const document = await response.json() as T;
    return { document, etag: response.headers.get("etag") ?? undefined };
  }

  async create<T extends JsonObject>(container: string, document: T, partitionKey: string): Promise<CosmosDocumentRecord<T>> {
    const response = await this.request(
      "POST",
      `dbs/${encodeURIComponent(this.database)}/colls/${encodeURIComponent(container)}/docs`,
      document,
      { "x-ms-documentdb-partitionkey": JSON.stringify([partitionKey]) },
    );
    if (!response.ok) throw await this.errorFrom(response, "Cosmos document create failed");
    return { document: await response.json() as T, etag: response.headers.get("etag") ?? undefined };
  }

  async replace<T extends JsonObject>(container: string, document: T, partitionKey: string, etag?: string): Promise<boolean> {
    const response = await this.request(
      "PUT",
      `dbs/${encodeURIComponent(this.database)}/colls/${encodeURIComponent(container)}/docs/${encodeURIComponent(String(document.id))}`,
      document,
      {
        "x-ms-documentdb-partitionkey": JSON.stringify([partitionKey]),
        ...(etag === undefined ? {} : { "if-match": etag }),
      },
    );
    if (response.status === 412) return false;
    if (!response.ok) throw await this.errorFrom(response, "Cosmos document replace failed");
    return true;
  }

  async query<T extends JsonObject>(
    container: string,
    query: string,
    parameters: readonly { name: string; value: unknown }[],
    partitionKey?: string,
  ): Promise<CosmosDocumentRecord<T>[]> {
    const results: CosmosDocumentRecord<T>[] = [];
    let continuation: string | undefined;
    do {
      const response = await this.request(
        "POST",
        `dbs/${encodeURIComponent(this.database)}/colls/${encodeURIComponent(container)}/docs`,
        { query, parameters },
        {
          "x-ms-documentdb-isquery": "true",
          "content-type": "application/query+json",
          "x-ms-max-item-count": "1000",
          ...(partitionKey === undefined ? {} : { "x-ms-documentdb-partitionkey": JSON.stringify([partitionKey]) }),
          ...(continuation === undefined ? {} : { "x-ms-continuation": continuation }),
        },
      );
      if (!response.ok) throw await this.errorFrom(response, "Cosmos query failed");
      const body = await response.json() as CosmosResponseBody;
      for (const document of body.Documents ?? []) {
        results.push({ document: document as T, etag: response.headers.get("etag") ?? undefined });
      }
      continuation = response.headers.get("x-ms-continuation") ?? undefined;
    } while (continuation !== undefined && continuation.length > 0);
    return results;
  }

  private async ensureResource(path: string, body: JsonObject): Promise<void> {
    const response = await this.request("POST", path, body);
    if (response.status !== 201 && response.status !== 409) {
      throw await this.errorFrom(response, "Cosmos resource initialization failed");
    }
  }

  private async request(method: string, path: string, body?: JsonObject, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const date = new Date().toUTCString().toLowerCase();
    const resourceType = path.includes("/docs/") || path.endsWith("/docs") ? "docs" : path.includes("/colls/") ? "colls" : "dbs";
    // Cosmos signs the identity of the addressed resource. Collection-level
    // create/query requests sign their parent, while item reads/replacements
    // sign the full document link (and database/container creation signs the
    // parent resource). Using the request URI verbatim would produce a valid
    // HMAC over the wrong resource and is rejected by the service.
    const normalizedPath = path.replace(/^\//, "");
    const resourceLink = resourceType === "dbs" && method === "POST" && normalizedPath === "dbs"
      ? ""
      : resourceType === "colls" && method === "POST" && normalizedPath.endsWith("/colls")
        ? normalizedPath.slice(0, -"/colls".length)
        : resourceType === "docs" && normalizedPath.endsWith("/docs")
          ? normalizedPath.slice(0, -"/docs".length)
          : normalizedPath;
    const signaturePayload = `${method.toLowerCase()}\n${resourceType}\n${resourceLink}\n${date}\n\n`;
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      (() => {
        const bytes = emulatorKeyBytes(this.key);
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        return buffer;
      })(),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = encodeURIComponent(`type=master&ver=1.0&sig=${base64(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signaturePayload)))}`);
    const response = await this.fetcher(new URL(path, this.endpoint), {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-ms-date": date,
        "x-ms-version": "2018-12-31",
        authorization: signature,
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  }

  private async errorFrom(response: Response, prefix: string): Promise<CosmosClientError> {
    // Never include response bodies: Cosmos errors can echo account or query
    // details and must not enter Worker logs or committed evidence.
    return new CosmosClientError(response.status, `${prefix} (HTTP ${response.status})`);
  }
}

interface EventDocument extends JsonObject {
  id: string;
  pk: string;
  serviceId: string;
  sortableUniqueId: string;
  eventType: string;
  payload: string;
  tags: string[];
  timestamp: string;
  causationId: string | null;
  correlationId: string | null;
  executedUser: string | null;
}

/** TS operational sidecar; deliberately not part of CosmosEvent's record. */
interface EventOpsDocument extends JsonObject {
  id: string;
  pk: string;
  serviceId: string;
  kind: "event-ops";
  eventId: string;
  attemptId: string;
  allocatorLineageId: string;
  firstArrivedAt: number;
  lastArrivedAt: number;
  maxDeliveryLagMs: number;
  arrivals: DeliveryLagRecord[];
}

interface LineageBindingDocument extends JsonObject {
  id: string;
  pk: string;
  serviceId: string;
  kind: "allocator-lineage-binding";
  allocatorLineageId: string;
  boundAt: number;
}

interface SuidBindingDocument extends JsonObject {
  id: string;
  pk: string;
  serviceId: string;
  kind: "suid-binding";
  suid: string;
  eventId: string;
}

interface IncidentDocument extends JsonObject {
  id: string;
  pk: string;
  serviceId: string;
  kind: "delivery-incident";
  identityKey: string;
  classification: DeliveryIncidentClassification;
  suid?: string;
  existingEventId?: string;
  incomingEventId?: string;
  eventId?: string;
  boundLineageId?: string;
  incomingLineageId?: string;
  observedAt: number;
}

interface LagDocument extends JsonObject {
  id: string;
  serviceId: string;
  estimateMs: number;
  observedAt: number;
}

interface PendingDocument extends JsonObject {
  id: string;
  serviceId: string;
  eventId: string;
  attemptId: string;
  suid: string;
  expectedPaths: string[];
  observedPaths: string[];
  firstObservedAt: number;
  lagBoundMs: number;
}

interface FindingDocument extends JsonObject {
  id: string;
  serviceId: string;
  eventId: string;
  path: string;
  classification: InconsistencyClassification;
  firstObservedAt: number;
  lagBoundMs: number;
  observedAt: number;
}

interface CheckpointDocument extends JsonObject {
  id: string;
  serviceId: string;
  projectionId: string;
  lastSuid: string;
  stateJson: string;
  version: number;
  updatedAt: number;
}

export class CosmosEventStore implements EventStore, DetectorStore, ProjectionStore {
  private initialized = false;
  private readonly client: CosmosDocumentClient;
  private readonly containers: CosmosContainerNames;
  private readonly beforeWrite?: CosmosStoreOptions["beforeWrite"];

  constructor(options: CosmosStoreOptions) {
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      if (options.endpoint === undefined || options.key === undefined || options.database === undefined) {
        throw new Error("Cosmos endpoint, key, and database are required for the Cosmos store");
      }
      this.client = new CosmosRestClient({
        endpoint: options.endpoint,
        key: options.key,
        database: options.database,
        fetcher: options.fetcher,
        containers: options.containers,
      });
    }
    this.containers = { ...DEFAULT_COSMOS_CONTAINERS, ...options.containers };
    this.beforeWrite = options.beforeWrite;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.client.initialize();
    this.initialized = true;
  }

  async recordDelivery(message: DownstreamOutboxMessage, arrivedAt: number, deliverySource: DeliverySource = "queue"): Promise<DeliveryOutcome> {
    this.ready();
    const identity = resolveDeliveryIdentity(message, deliverySource);
    assertSortableUniqueId(message.suid);
    const acceptsImportedId = deliverySource === "import";
    if (!(acceptsImportedId ? isRfc4122Uuid(message.eventId) : isUuidV7(message.eventId))) {
      throw new CanonicalEventIdentityConflictError(
        "cosmos",
        message.eventId,
        `Cosmos EventId must be an ${acceptsImportedId ? "RFC 4122 UUID" : "UUID v7"}`,
      );
    }
    try {
      JSON.parse(message.payload);
    } catch {
      throw new CanonicalEventIdentityConflictError("cosmos", message.eventId, "Cosmos Payload must be UTF-8 JSON text");
    }
    assertUtcTimestamp(message.timestamp ?? new Date(arrivedAt).toISOString(), message.eventId);
    const metadata = metadataForDelivery(message, deliverySource);
    const lagMs = Math.max(0, arrivedAt - message.enqueuedAt);
    const eventTags = [...message.eventTags];
    const binding = await this.readLineageBinding(message.serviceId);
    if (binding !== undefined && binding.document.allocatorLineageId !== message.allocatorLineageId) {
      const incident: DeliveryIncident = {
        serviceId: message.serviceId,
        identityKey: lineageIdentity(message.serviceId, binding.document.allocatorLineageId, message.allocatorLineageId),
        classification: "LINEAGE_MISMATCH",
        boundLineageId: binding.document.allocatorLineageId,
        incomingLineageId: message.allocatorLineageId,
        observedAt: arrivedAt,
      };
      await this.persistIncident(incident);
      return { outcome: "lineage-mismatch", kind: "lineage-mismatch", incident };
    }
    if (binding === undefined) {
      await this.bindLineage(message.serviceId, message.allocatorLineageId, arrivedAt);
      const racedBinding = await this.readLineageBinding(message.serviceId);
      if (racedBinding === undefined) {
        throw new Error("Cosmos allocator lineage binding was not durable");
      }
      if (racedBinding.document.allocatorLineageId !== message.allocatorLineageId) {
        const incident: DeliveryIncident = {
          serviceId: message.serviceId,
          identityKey: lineageIdentity(message.serviceId, racedBinding.document.allocatorLineageId, message.allocatorLineageId),
          classification: "LINEAGE_MISMATCH",
          boundLineageId: racedBinding.document.allocatorLineageId,
          incomingLineageId: message.allocatorLineageId,
          observedAt: arrivedAt,
        };
        await this.persistIncident(incident);
        return { outcome: "lineage-mismatch", kind: "lineage-mismatch", incident };
      }
    }
    const currentEvents = await this.eventDocuments(message.serviceId);
    const existingBySuid = currentEvents.find((entry) => entry.document.sortableUniqueId === message.suid);
    if (existingBySuid !== undefined && existingBySuid.document.id !== message.eventId) {
      const incident: DeliveryIncident = {
        serviceId: message.serviceId,
        identityKey: collisionIdentity(
          message.serviceId,
          message.suid,
          existingBySuid.document.id,
          message.eventId,
        ),
        classification: "SUID_COLLISION",
        suid: message.suid,
        existingEventId: existingBySuid.document.id,
        incomingEventId: message.eventId,
        observedAt: arrivedAt,
      };
      await this.persistIncident(incident);
      return { outcome: "suid-collision", kind: "suid-collision", incident };
    }
    const reservedEventId = await this.reserveSuid(message.serviceId, message.suid, message.eventId);
    if (reservedEventId !== undefined && reservedEventId !== message.eventId) {
      const incident: DeliveryIncident = {
        serviceId: message.serviceId,
        identityKey: collisionIdentity(message.serviceId, message.suid, reservedEventId, message.eventId),
        classification: "SUID_COLLISION",
        suid: message.suid,
        existingEventId: reservedEventId,
        incomingEventId: message.eventId,
        observedAt: arrivedAt,
      };
      await this.persistIncident(incident);
      return { outcome: "suid-collision", kind: "suid-collision", incident };
    }
    const currentHead = currentEvents.reduce<string | undefined>((head, entry) =>
      head === undefined || compareCosmosSuid(entry.document.sortableUniqueId, head) > 0 ? entry.document.sortableUniqueId : head, undefined);
    const recoveryBacklogSample = currentHead !== undefined && compareCosmosSuid(message.suid, currentHead) < 0;
    const event = await this.mutateEvent(message, eventTags, identity.key, message.timestamp ?? new Date(arrivedAt).toISOString(), metadata);
    const ops = await this.mutateEventOps(message, arrivedAt, lagMs);
    if (!recoveryBacklogSample && deliverySource !== "fast") await this.updateLag(message.serviceId, lagMs, arrivedAt);
    return { outcome: "stored", kind: "stored", event: eventFrom(event, ops) };
  }

  async readAllEvents(serviceId: string, since: string): Promise<StoredEvent[]> {
    this.ready();
    if (since.length !== 0) assertSortableUniqueId(since);
    const documents = await this.eventDocuments(serviceId);
    const events = await Promise.all(documents.map(async (entry) =>
      eventFrom(entry.document, await this.eventOps(serviceId, entry.document.id))));
    return events
      .filter((event) => compareCosmosSuid(event.suid, since) > 0)
      .sort((left, right) => compareCosmosSuid(left.suid, right.suid) || binaryCompare(left.eventId, right.eventId));
  }

  async currentLagBound(serviceId: string, nowMs?: number): Promise<number> {
    this.ready();
    const row = await this.client.read<LagDocument>(this.containers.lagEstimates, serviceId, serviceId);
    if (row === undefined) return 0;
    const estimate = asNumber(row.document.estimateMs, "estimateMs");
    const observedAt = asNumber(row.document.observedAt, "observedAt");
    const decayNow = nowMs !== undefined && nowMs >= 100_000_000_000 && observedAt >= 100_000_000_000
      ? nowMs
      : observedAt;
    return decayedLagEstimateMs(estimate, observedAt, decayNow);
  }

  async listProjectionTags(serviceId: string): Promise<string[]> {
    this.ready();
    const tags = new Set<string>();
    for (const entry of await this.eventDocuments(serviceId)) {
      for (const tag of asStringArray(entry.document.tags, "tags")) tags.add(tag);
    }
    return [...tags].sort(binaryCompare);
  }

  async readProjectionCheckpoint(serviceId: string, projectionId: string): Promise<ProjectionCheckpoint | undefined> {
    this.ready();
    const row = await this.client.read<CheckpointDocument>(this.containers.checkpoints, safeId(projectionId), serviceId);
    return row === undefined ? undefined : checkpointFrom(row.document);
  }

  async advanceProjectionCheckpoint(input: ProjectionCheckpointAdvance): Promise<boolean> {
    this.ready();
    const id = safeId(input.projectionId);
    const document: CheckpointDocument = {
      id,
      serviceId: input.serviceId,
      projectionId: input.projectionId,
      lastSuid: input.lastSuid,
      stateJson: input.stateJson,
      version: input.version,
      updatedAt: input.updatedAt,
    };
    const existing = await this.client.read<CheckpointDocument>(this.containers.checkpoints, id, input.serviceId);
    if (existing === undefined) {
      if (input.expectedLastSuid !== null) return false;
      await this.beforeWrite?.("checkpoint");
      try {
        await this.client.create(this.containers.checkpoints, document, input.serviceId);
        return true;
      } catch (error) {
        if (isStatus(error, 409)) return false;
        throw error;
      }
    }
    if (existing.document.lastSuid !== input.expectedLastSuid) return false;
    await this.beforeWrite?.("checkpoint");
    return this.client.replace(this.containers.checkpoints, document, input.serviceId, existing.etag);
  }

  async projectionLag(serviceId: string, projectionId: string, tag: string): Promise<ProjectionLag> {
    this.ready();
    const checkpoint = await this.readProjectionCheckpoint(serviceId, projectionId);
    const checkpointSuid = checkpoint?.lastSuid ?? "";
    const candidates = await this.eventDocuments(serviceId);
    const matching = (await Promise.all(
      candidates.map(async (entry) => eventFrom(entry.document, await this.eventOps(serviceId, entry.document.id))),
    )).filter((event) => event.eventTags.includes(tag));
    const headSuid = matching.reduce((head, event) =>
      head === "" || compareCosmosSuid(event.suid, head) > 0 ? event.suid : head, "");
    return {
      serviceId,
      projectionId,
      tag,
      checkpointSuid,
      headSuid,
      behindEvents: matching.filter((event) => compareCosmosSuid(event.suid, checkpointSuid) > 0).length,
    };
  }

  async upsertPending(message: DownstreamOutboxMessage, firstObservedAt: number, lagBoundMs: number): Promise<PendingArrivalRecord> {
    this.ready();
    const id = safeId(message.eventId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this.client.read<PendingDocument>(this.containers.pendingArrivals, id, message.serviceId);
      if (existing === undefined) {
        const document: PendingDocument = {
          id,
          serviceId: message.serviceId,
          eventId: message.eventId,
          attemptId: message.attemptId,
          suid: message.suid,
          expectedPaths: sortedUnique(message.eventTags),
          observedPaths: [message.tag],
          firstObservedAt,
          lagBoundMs,
        };
        await this.beforeWrite?.("pending");
        try {
          await this.client.create(this.containers.pendingArrivals, document, message.serviceId);
          return pendingFrom(document);
        } catch (error) {
          if (isStatus(error, 409)) continue;
          throw error;
        }
      }
      const pending = pendingFrom(existing.document);
      if (pending.attemptId !== message.attemptId || pending.suid !== message.suid) {
        throw new Error(`EventId ${message.eventId} has contradictory pending-arrival identity`);
      }
      const document: PendingDocument = {
        ...existing.document,
        expectedPaths: sortedUnique([...pending.expectedPaths, ...message.eventTags]),
        observedPaths: sortedUnique([...pending.observedPaths, message.tag]),
        lagBoundMs: Math.max(pending.lagBoundMs, lagBoundMs),
      };
      await this.beforeWrite?.("pending");
      if (await this.client.replace(this.containers.pendingArrivals, document, message.serviceId, existing.etag)) {
        return pendingFrom(document);
      }
    }
    throw new Error("Cosmos pending-arrival CAS did not converge");
  }

  async listPending(serviceId?: string): Promise<PendingArrivalRecord[]> {
    this.ready();
    const rows = await this.client.query<PendingDocument>(
      this.containers.pendingArrivals,
      serviceId === undefined ? "SELECT * FROM c" : "SELECT * FROM c WHERE c.serviceId = @serviceId",
      serviceId === undefined ? [] : [{ name: "@serviceId", value: serviceId }],
      serviceId,
    );
    return rows.map((row) => pendingFrom(row.document)).sort((left, right) =>
      binaryCompare(left.serviceId, right.serviceId) || binaryCompare(left.eventId, right.eventId));
  }

  async appendFinding(finding: InconsistencyFinding): Promise<void> {
    this.ready();
    const document: FindingDocument = {
      id: safeId(finding.eventId, finding.path, finding.classification),
      ...finding,
    };
    await this.beforeWrite?.("finding");
    try {
      await this.client.create(this.containers.findings, document, finding.serviceId);
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
    }
  }

  async appendDeliveryIncident(incident: DeliveryIncident): Promise<void> {
    this.ready();
    await this.persistIncident(incident);
    await this.projectIncident(incident);
  }

  async hasDeliveryIncident(serviceId: string, identityKey: string): Promise<boolean> {
    this.ready();
    return (await this.client.read<IncidentDocument>(
      this.containers.events,
      safeId("incident", identityKey),
      auxiliaryPk(serviceId),
    )) !== undefined;
  }

  async listDeliveryIncidents(serviceId?: string): Promise<DeliveryIncident[]> {
    this.ready();
    const rows = await this.client.query<IncidentDocument>(
      this.containers.events,
      serviceId === undefined ? "SELECT * FROM c" : "SELECT * FROM c WHERE c.serviceId = @serviceId",
      serviceId === undefined ? [] : [{ name: "@serviceId", value: serviceId }],
    );
    return rows
      .filter((row) => row.document.kind === "delivery-incident")
      .map((row) => incidentFrom(row.document))
      .sort((left, right) => left.observedAt - right.observedAt || binaryCompare(left.identityKey, right.identityKey));
  }

  /** Retryable async projection from the same-partition incident landing. */
  async projectDeliveryIncidents(serviceId?: string): Promise<number> {
    const incidents = await this.listDeliveryIncidents(serviceId);
    let projected = 0;
    for (const incident of incidents) {
      await this.projectIncident(incident);
      projected += 1;
    }
    return projected;
  }

  private async readLineageBinding(serviceId: string): Promise<CosmosDocumentRecord<LineageBindingDocument> | undefined> {
    return this.client.read<LineageBindingDocument>(
      this.containers.events,
      safeId("allocator-lineage-binding"),
      auxiliaryPk(serviceId),
    );
  }

  private async bindLineage(serviceId: string, allocatorLineageId: string, boundAt: number): Promise<void> {
    const document: LineageBindingDocument = {
      id: safeId("allocator-lineage-binding"),
      pk: auxiliaryPk(serviceId),
      serviceId,
      kind: "allocator-lineage-binding",
      allocatorLineageId,
      boundAt,
    };
    try {
      await this.client.create(this.containers.events, document, auxiliaryPk(serviceId));
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
    }
  }

  /**
   * Cosmos has no cross-document unique index. A same-partition SUID binding
   * is the equivalent guard: the first EventId reserves the opaque SUID and
   * every later delivery reuses or rejects that reservation before event
   * mutation. Historical rows are still checked by eventDocuments above.
   */
  private async reserveSuid(serviceId: string, suid: string, eventId: string): Promise<string | undefined> {
    const id = safeId("suid-binding", suid);
    const existing = await this.client.read<SuidBindingDocument>(this.containers.events, id, auxiliaryPk(serviceId));
    if (existing !== undefined) return existing.document.eventId;
    const document: SuidBindingDocument = {
      id,
      pk: auxiliaryPk(serviceId),
      serviceId,
      kind: "suid-binding",
      suid,
      eventId,
    };
    await this.beforeWrite?.("event");
    try {
      await this.client.create(this.containers.events, document, auxiliaryPk(serviceId));
      return eventId;
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
      const raced = await this.client.read<SuidBindingDocument>(this.containers.events, id, auxiliaryPk(serviceId));
      return raced?.document.eventId;
    }
  }

  private async persistIncident(incident: DeliveryIncident): Promise<void> {
    const document: IncidentDocument = {
      id: safeId("incident", incident.identityKey),
      pk: auxiliaryPk(incident.serviceId),
      serviceId: incident.serviceId,
      kind: "delivery-incident",
      identityKey: incident.identityKey,
      classification: incident.classification,
      ...(incident.suid === undefined ? {} : { suid: incident.suid }),
      ...(incident.existingEventId === undefined ? {} : { existingEventId: incident.existingEventId }),
      ...(incident.incomingEventId === undefined ? {} : { incomingEventId: incident.incomingEventId }),
      ...(incident.eventId === undefined ? {} : { eventId: incident.eventId }),
      ...(incident.boundLineageId === undefined ? {} : { boundLineageId: incident.boundLineageId }),
      ...(incident.incomingLineageId === undefined ? {} : { incomingLineageId: incident.incomingLineageId }),
      observedAt: incident.observedAt,
    };
    await this.beforeWrite?.("incident");
    try {
      await this.client.create(this.containers.events, document, auxiliaryPk(incident.serviceId));
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
    }
  }

  private async projectIncident(incident: DeliveryIncident): Promise<void> {
    const document = {
      id: safeId("incident", incident.identityKey),
      serviceId: incident.serviceId,
      eventId: incident.eventId ?? incident.incomingEventId ?? incident.identityKey,
      path: incident.classification,
      classification: incident.classification,
      firstObservedAt: incident.observedAt,
      lagBoundMs: 0,
      observedAt: incident.observedAt,
      kind: "delivery-incident" as const,
      identityKey: incident.identityKey,
    };
    await this.beforeWrite?.("incident-projection");
    try {
      await this.client.create(this.containers.findings, document, incident.serviceId);
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
    }
  }

  async hasFinding(serviceId: string, eventId: string, path: string, classification: InconsistencyClassification): Promise<boolean> {
    this.ready();
    return (await this.client.read<FindingDocument>(
      this.containers.findings,
      safeId(eventId, path, classification),
      serviceId,
    )) !== undefined;
  }

  async listFindings(serviceId?: string, eventId?: string): Promise<InconsistencyFinding[]> {
    this.ready();
    const predicates: string[] = [];
    const parameters: { name: string; value: unknown }[] = [];
    if (serviceId !== undefined) {
      predicates.push("c.serviceId = @serviceId");
      parameters.push({ name: "@serviceId", value: serviceId });
    }
    if (eventId !== undefined) {
      predicates.push("c.eventId = @eventId");
      parameters.push({ name: "@eventId", value: eventId });
    }
    const rows = await this.client.query<FindingDocument>(
      this.containers.findings,
      `SELECT * FROM c${predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`}`,
      parameters,
      serviceId,
    );
    return rows
      .filter((row) => row.document.kind === undefined)
      .map((row) => findingFrom(row.document)).sort((left, right) =>
      left.observedAt - right.observedAt || binaryCompare(left.eventId, right.eventId) || binaryCompare(left.path, right.path));
  }

  private async eventDocuments(serviceId: string): Promise<CosmosDocumentRecord<EventDocument>[]> {
    const rows = await this.client.query<EventDocument>(
      this.containers.events,
      "SELECT * FROM c WHERE c.serviceId = @serviceId AND IS_DEFINED(c.sortableUniqueId)",
      [{ name: "@serviceId", value: serviceId }],
    );
    return rows;
  }

  private async eventOps(serviceId: string, eventId: string): Promise<EventOpsDocument | undefined> {
    const row = await this.client.read<EventOpsDocument>(
      this.containers.events,
      safeId("event-ops", eventId),
      eventPk(serviceId, eventId),
    );
    return row?.document;
  }

  private async mutateEvent(
    message: DownstreamOutboxMessage,
    eventTags: string[],
    eventType: string,
    timestamp: string,
    metadata: DurableEventMetadata,
  ): Promise<EventDocument> {
    const id = message.eventId;
    const pk = eventPk(message.serviceId, id);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this.client.read<EventDocument>(this.containers.events, id, pk);
      if (existing === undefined) {
        const document: EventDocument = {
          id,
          pk,
          serviceId: message.serviceId,
          sortableUniqueId: message.suid,
          eventType,
          payload: message.payload,
          tags: eventTags,
          timestamp,
          causationId: metadata.causationId,
          correlationId: metadata.correlationId,
          executedUser: metadata.executedUser,
        };
        await this.beforeWrite?.("event");
        try {
          await this.client.create(this.containers.events, document, pk);
          return document;
        } catch (error) {
          if (isStatus(error, 409)) continue;
          throw error;
        }
      }
      const prior = eventFrom(existing.document);
      if (prior.eventType !== eventType) {
        throw new CanonicalEventIdentityConflictError("cosmos", message.eventId);
      }
      if (prior.suid !== message.suid || prior.payload !== message.payload ||
        JSON.stringify(prior.eventTags) !== JSON.stringify(eventTags) ||
        prior.timestamp !== timestamp || prior.causationId !== metadata.causationId ||
        prior.correlationId !== metadata.correlationId || prior.executedUser !== metadata.executedUser) {
        throw new Error(`EventId ${message.eventId} conflicts with its durable Cosmos row`);
      }
      return existing.document;
    }
    throw new Error("Cosmos event CAS did not converge");
  }

  private async mutateEventOps(
    message: DownstreamOutboxMessage,
    arrivedAt: number,
    lagMs: number,
  ): Promise<EventOpsDocument> {
    const id = safeId("event-ops", message.eventId);
    const pk = eventPk(message.serviceId, message.eventId);
    const nextArrival: DeliveryLagRecord = {
      serviceId: message.serviceId,
      eventId: message.eventId,
      tag: message.tag,
      enqueuedAt: message.enqueuedAt,
      arrivedAt,
      lagMs,
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this.client.read<EventOpsDocument>(this.containers.events, id, pk);
      if (existing === undefined) {
        const document: EventOpsDocument = {
          id,
          pk,
          serviceId: message.serviceId,
          kind: "event-ops",
          eventId: message.eventId,
          attemptId: message.attemptId,
          allocatorLineageId: message.allocatorLineageId,
          firstArrivedAt: arrivedAt,
          lastArrivedAt: arrivedAt,
          maxDeliveryLagMs: lagMs,
          arrivals: [nextArrival],
        };
        await this.beforeWrite?.("event");
        try {
          await this.client.create(this.containers.events, document, pk);
          return document;
        } catch (error) {
          if (isStatus(error, 409)) continue;
          throw error;
        }
      }
      if (existing.document.allocatorLineageId !== message.allocatorLineageId) {
        throw new CanonicalEventIdentityConflictError("cosmos", message.eventId, "Cosmos event sidecar lineage conflicts");
      }
      const arrivals = [...existing.document.arrivals];
      const index = arrivals.findIndex((arrival) => arrival.tag === message.tag);
      if (index < 0) arrivals.push(nextArrival);
      else {
        const prior = arrivals[index]!;
        arrivals[index] = {
          ...prior,
          enqueuedAt: Math.min(prior.enqueuedAt, nextArrival.enqueuedAt),
          arrivedAt: Math.max(prior.arrivedAt, nextArrival.arrivedAt),
          lagMs: Math.max(prior.lagMs, nextArrival.lagMs),
        };
      }
      const document: EventOpsDocument = {
        ...existing.document,
        firstArrivedAt: Math.min(existing.document.firstArrivedAt, arrivedAt),
        lastArrivedAt: Math.max(existing.document.lastArrivedAt, arrivedAt),
        maxDeliveryLagMs: Math.max(existing.document.maxDeliveryLagMs, lagMs),
        arrivals,
      };
      await this.beforeWrite?.("event");
      if (await this.client.replace(this.containers.events, document, pk, existing.etag)) return document;
    }
    throw new Error("Cosmos event sidecar CAS did not converge");
  }

  private async updateLag(serviceId: string, lagMs: number, observedAt: number): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this.client.read<LagDocument>(this.containers.lagEstimates, serviceId, serviceId);
      const currentEstimate = existing === undefined
        ? 0
        : decayedLagEstimateMs(asNumber(existing.document.estimateMs, "estimateMs"), asNumber(existing.document.observedAt, "observedAt"), observedAt);
      const document: LagDocument = {
        id: serviceId,
        serviceId,
        estimateMs: Math.max(currentEstimate, lagMs),
        observedAt,
      };
      await this.beforeWrite?.("lag");
      if (existing === undefined) {
        try {
          await this.client.create(this.containers.lagEstimates, document, serviceId);
          return;
        } catch (error) {
          if (isStatus(error, 409)) continue;
          throw error;
        }
      } else if (await this.client.replace(this.containers.lagEstimates, document, serviceId, existing.etag)) {
        return;
      }
    }
    throw new Error("Cosmos lag estimate CAS did not converge");
  }

  private ready(): void {
    if (!this.initialized) throw new Error("CosmosEventStore.initialize() must complete before use");
  }
}
