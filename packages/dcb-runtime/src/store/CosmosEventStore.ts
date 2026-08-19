import type { DownstreamOutboxMessage } from "../downstream/types";
import { decayedLagEstimateMs } from "../safeWindow";
import type {
  DeliveryLagRecord,
  DetectorStore,
  EventStore,
  InconsistencyClassification,
  InconsistencyFinding,
  PendingArrivalRecord,
  ProjectionCheckpoint,
  ProjectionCheckpointAdvance,
  ProjectionLag,
  ProjectionStore,
  StoredEvent,
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
  query<T extends JsonObject>(
    container: string,
    query: string,
    parameters: readonly { name: string; value: unknown }[],
    partitionKey?: string,
  ): Promise<CosmosDocumentRecord<T>[]>;
}

export type CosmosWriteBoundary = "event" | "lag" | "pending" | "finding" | "checkpoint";

export interface CosmosContainerNames {
  readonly events: string;
  readonly lagEstimates: string;
  readonly pendingArrivals: string;
  readonly findings: string;
  readonly checkpoints: string;
}

export const DEFAULT_COSMOS_CONTAINERS: CosmosContainerNames = Object.freeze({
  events: "dcb-events",
  lagEstimates: "dcb-lag-estimates",
  pendingArrivals: "dcb-pending-arrivals",
  findings: "dcb-findings",
  checkpoints: "dcb-projection-checkpoints",
});

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

function asNumber(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Cosmos ${name} was not a safe integer`);
  return number;
}

function asStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Cosmos ${name} was not a string array`);
  }
  return sortedUnique(value);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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

function isStatus(error: unknown, status: number): boolean {
  return error instanceof CosmosClientError && error.status === status;
}

function eventFrom(document: JsonObject): StoredEvent {
  const arrivals = Array.isArray(document.arrivals) ? document.arrivals : [];
  return {
    serviceId: asString(document.serviceId, "serviceId"),
    eventId: asString(document.eventId, "eventId"),
    suid: asString(document.suid, "suid"),
    payload: asString(document.payload, "payload"),
    eventTags: asStringArray(document.eventTags, "eventTags"),
    firstArrivedAt: asNumber(document.firstArrivedAt, "firstArrivedAt"),
    lastArrivedAt: asNumber(document.lastArrivedAt, "lastArrivedAt"),
    maxDeliveryLagMs: asNumber(document.maxDeliveryLagMs, "maxDeliveryLagMs"),
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
    expectedPaths: asStringArray(document.expectedPaths, "expectedPaths"),
    observedPaths: asStringArray(document.observedPaths, "observedPaths"),
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
    for (const container of Object.values(this.containers)) {
      await this.ensureResource(`dbs/${encodeURIComponent(this.database)}/colls`, {
        id: container,
        partitionKey: { paths: ["/serviceId"], kind: "Hash" },
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
  serviceId: string;
  eventId: string;
  suid: string;
  payload: string;
  eventTags: string[];
  firstArrivedAt: number;
  lastArrivedAt: number;
  maxDeliveryLagMs: number;
  arrivals: DeliveryLagRecord[];
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

  async recordDelivery(message: DownstreamOutboxMessage, arrivedAt: number): Promise<StoredEvent> {
    this.ready();
    const lagMs = Math.max(0, arrivedAt - message.enqueuedAt);
    const eventTags = sortedUnique(message.eventTags);
    const currentEvents = await this.eventDocuments(message.serviceId);
    const currentHead = currentEvents.reduce<string | undefined>((head, entry) =>
      head === undefined || compareCosmosSuid(entry.document.suid, head) > 0 ? entry.document.suid : head, undefined);
    const recoveryBacklogSample = currentHead !== undefined && compareCosmosSuid(message.suid, currentHead) < 0;
    const event = await this.mutateEvent(message, arrivedAt, lagMs, eventTags);
    if (!recoveryBacklogSample) await this.updateLag(message.serviceId, lagMs, arrivedAt);
    return eventFrom(event);
  }

  async readAllEvents(serviceId: string, since: string): Promise<StoredEvent[]> {
    this.ready();
    const documents = await this.eventDocuments(serviceId);
    return documents
      .map((entry) => eventFrom(entry.document))
      .filter((event) => compareCosmosSuid(event.suid, since) > 0)
      .sort((left, right) => compareCosmosSuid(left.suid, right.suid) || left.eventId.localeCompare(right.eventId));
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
      for (const tag of asStringArray(entry.document.eventTags, "eventTags")) tags.add(tag);
    }
    return [...tags].sort((left, right) => left.localeCompare(right));
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
    const matching = (await this.eventDocuments(serviceId))
      .map((entry) => eventFrom(entry.document))
      .filter((event) => event.eventTags.includes(tag));
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
      left.serviceId.localeCompare(right.serviceId) || left.eventId.localeCompare(right.eventId));
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
    return rows.map((row) => findingFrom(row.document)).sort((left, right) =>
      left.observedAt - right.observedAt || left.eventId.localeCompare(right.eventId) || left.path.localeCompare(right.path));
  }

  private async eventDocuments(serviceId: string): Promise<CosmosDocumentRecord<EventDocument>[]> {
    return this.client.query<EventDocument>(
      this.containers.events,
      "SELECT * FROM c WHERE c.serviceId = @serviceId",
      [{ name: "@serviceId", value: serviceId }],
      serviceId,
    );
  }

  private async mutateEvent(
    message: DownstreamOutboxMessage,
    arrivedAt: number,
    lagMs: number,
    eventTags: string[],
  ): Promise<EventDocument> {
    const id = safeId(message.eventId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this.client.read<EventDocument>(this.containers.events, id, message.serviceId);
      if (existing === undefined) {
        const document: EventDocument = {
          id,
          serviceId: message.serviceId,
          eventId: message.eventId,
          suid: message.suid,
          payload: message.payload,
          eventTags,
          firstArrivedAt: arrivedAt,
          lastArrivedAt: arrivedAt,
          maxDeliveryLagMs: lagMs,
          arrivals: [{
            serviceId: message.serviceId,
            eventId: message.eventId,
            tag: message.tag,
            enqueuedAt: message.enqueuedAt,
            arrivedAt,
            lagMs,
          }],
        };
        await this.beforeWrite?.("event");
        try {
          await this.client.create(this.containers.events, document, message.serviceId);
          return document;
        } catch (error) {
          if (isStatus(error, 409)) continue;
          throw error;
        }
      }
      const prior = eventFrom(existing.document);
      if (prior.suid !== message.suid || prior.payload !== message.payload || JSON.stringify(prior.eventTags) !== JSON.stringify(eventTags)) {
        throw new Error(`EventId ${message.eventId} conflicts with its durable Cosmos row`);
      }
      const arrivals = [...prior.arrivals];
      const arrivalIndex = arrivals.findIndex((arrival) => arrival.tag === message.tag);
      const nextArrival: DeliveryLagRecord = {
        serviceId: message.serviceId,
        eventId: message.eventId,
        tag: message.tag,
        enqueuedAt: message.enqueuedAt,
        arrivedAt,
        lagMs,
      };
      if (arrivalIndex < 0) arrivals.push(nextArrival);
      else arrivals[arrivalIndex] = {
        ...arrivals[arrivalIndex]!,
        enqueuedAt: Math.min(arrivals[arrivalIndex]!.enqueuedAt, message.enqueuedAt),
        arrivedAt: Math.max(arrivals[arrivalIndex]!.arrivedAt, arrivedAt),
        lagMs: Math.max(arrivals[arrivalIndex]!.lagMs, lagMs),
      };
      const document: EventDocument = {
        ...existing.document,
        eventTags,
        firstArrivedAt: Math.min(prior.firstArrivedAt, arrivedAt),
        lastArrivedAt: Math.max(prior.lastArrivedAt, arrivedAt),
        maxDeliveryLagMs: Math.max(prior.maxDeliveryLagMs, lagMs),
        arrivals,
      };
      await this.beforeWrite?.("event");
      if (await this.client.replace(this.containers.events, document, message.serviceId, existing.etag)) return document;
    }
    throw new Error("Cosmos event CAS did not converge");
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
