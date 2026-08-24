export type G38MManifest = {
  readonly schemaVersion: "1";
  readonly rows: readonly {
    readonly rowId: string;
    readonly path: string;
    readonly target: string;
    readonly changeKind: string;
    readonly expectedValue?: false | "node scripts/deploy/g38-m-witness.mjs";
  }[];
  readonly selfDigest: string;
};

export type G38MRegistryWitness = {
  readonly phase: "pre" | "post";
  readonly capturedAt: string;
  readonly workerName: "sekiban-dcb-meeting-room-doorbell";
  readonly accountId: string;
  readonly registry: Record<string, unknown>;
};

export function canonicalJson(value: unknown): string;
export function manifestDigest(manifest: Omit<G38MManifest, "selfDigest"> | G38MManifest): string;
export function assertMManifest(raw: string | unknown): { readonly manifest: G38MManifest; readonly selfDigest: string };
export function assertDeployableUniverse(input: { readonly repo?: string; readonly base: string; readonly source: string }): unknown;
export function assertEvidenceOnlyUniverse(input: { readonly repo?: string; readonly source: string; readonly evidence: string }): unknown;
export function assertMEvidence(evidence: unknown, input: { readonly baseCommit: string; readonly sourceCommit: string; readonly configDigest: string; readonly manifestSelfDigest: string }): unknown;
export function captureRegistryWitness(input: { readonly phase: "pre" | "post"; readonly accountId: string; readonly workerName?: string; readonly token: string; readonly fetchImpl?: typeof fetch }): Promise<G38MRegistryWitness>;
