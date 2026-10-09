export interface RebuildResult {
  readonly mode: "dry-run" | "apply";
  readonly serviceId: string;
  readonly inputFileSha256: string;
  readonly inputContentDigest: string;
  readonly receipt?: string;
}

export declare function canonicalJson(value: unknown): string;
export declare function eventDigestForRecord(
  record: Record<string, unknown>,
  digestInfo: Record<string, unknown>,
  declaredTagSet: string[],
): { canonicalBytesBase64: string; eventDigest: string };
export declare function validateInput(buffer: Uint8Array, sourceName?: string): { input: unknown; fileSha256: string; contentDigest: string; text: string; buffer: Uint8Array };
export declare function setReceiptWriteHookForTests(
  hook: ((context: { path: string; receipt: string }) => void | Promise<void>) | undefined,
): void;
export declare function runCommand(argv: readonly string[]): Promise<string>;
