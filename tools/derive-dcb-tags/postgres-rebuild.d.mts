export interface RebuildResult {
  readonly mode: "dry-run" | "apply";
  readonly serviceId: string;
  readonly inputFileSha256: string;
  readonly inputContentDigest: string;
  readonly receipt?: string;
}

export declare function canonicalJson(value: unknown): string;
export declare function validateInput(buffer: Uint8Array, sourceName?: string): { input: unknown; fileSha256: string; contentDigest: string; text: string; buffer: Uint8Array };
export declare function runCommand(argv: readonly string[]): Promise<string>;
