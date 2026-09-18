/** Provider-neutral, immutable G32 dump wire. */
export interface BootstrapManifest {
  readonly format: "sekiban-dcb-bootstrap";
  readonly version: 1;
  readonly source: { readonly serviceId: string; readonly lineageId: string };
  readonly target: { readonly serviceId: string; readonly allocatorLineageId: string };
  readonly highWatermark: string | null;
  readonly eventCount: number;
  readonly tagCounts: Readonly<Record<string, number>>;
  readonly contentDigest: string;
  readonly canonicalization: "utf8-json-sorted-keys-v1";
}

export interface BootstrapEventRecord {
  readonly eventId: string;
  readonly suid: string;
  readonly payload: string;
  readonly eventTags: readonly string[];
  readonly eventType: string;
  readonly provenance: Readonly<{ readonly origin: "g32" }>;
  readonly timestamp: string;
  readonly causationId: string | null;
  readonly correlationId: string | null;
  readonly executedUser: string | null;
}

export interface BootstrapDump {
  readonly manifest: BootstrapManifest;
  readonly events: readonly BootstrapEventRecord[];
}

export type BootstrapStatus = "EMPTY" | "PLANNED" | "IMPORTING" | "VERIFYING" | "READY" | "FAILED";

export interface BootstrapControlRecord {
  readonly schemaVersion: 1;
  readonly status: BootstrapStatus;
  readonly importId: string | null;
  readonly targetServiceId: string;
  readonly allocatorLineageId: string | null;
  readonly source: BootstrapManifest["source"] | null;
  readonly digest: string | null;
  readonly manifest: BootstrapManifest | null;
  readonly progress: Readonly<Record<string, string | null>>;
  readonly leaseEpoch: number;
  readonly leaseUntil: number | null;
  readonly failure: string | null;
  readonly readyAt: string | null;
  readonly normalInFlight: number;
  /** Commands admitted before a bootstrap plan.  The epoch is carried to every
   * final durable write, rather than treating admission as a one-time check. */
  readonly normalCommands?: Readonly<Record<string, number>>;
  /** Recently released entry admissions, retained only for their final epoch check. */
  readonly releasedCommands?: Readonly<Record<string, number>>;
  /**
   * SDT-G36 durable write permits. Held from before allocation until every
   * target tag of that attempt is durably resolved. Absent on old records
   * (treated as `{}`). Only a bootstrap barrier, never commit authority.
   */
  readonly writePermits?: Readonly<Record<string, string>>;
  /** READY is a post-verification state, never merely an import completion. */
  readonly verifiedImportId?: string | null;
  readonly verifiedLeaseEpoch?: number | null;
  readonly storeCompletion?: "prepopulated-manifest" | null;
}

/** G22 supplies provider implementations. Bootstrap core deliberately has no adapter. */
export interface BootstrapStoreAdmissionPort {
  admitBootstrap(input: {
    readonly importId: string;
    readonly leaseEpoch: number;
    readonly manifest: BootstrapManifest;
    readonly events: readonly BootstrapEventRecord[];
  }): Promise<void>;
  verifyBootstrap(input: {
    readonly importId: string;
    readonly manifest: BootstrapManifest;
  }): Promise<void>;
}
