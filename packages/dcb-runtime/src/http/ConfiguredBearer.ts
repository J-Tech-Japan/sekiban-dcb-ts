export type ConfiguredBearerResult =
  | "unconfigured"
  | "missing"
  | "invalid"
  | "authorized";

export type ConfiguredBearerTokenNormalization = "exact" | "trim";

export interface CheckConfiguredBearerOptions {
  readonly tokenNormalization?: ConfiguredBearerTokenNormalization;
}

async function sha256(value: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
}

function digestsMatch(expected: Uint8Array, supplied: Uint8Array): boolean {
  let difference = expected.length ^ supplied.length;
  const length = Math.max(expected.length, supplied.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (expected[index] ?? 0) ^ (supplied[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Decide whether a configured shared secret admits this request.
 * Callers map the four results onto their own HTTP responses.
 * The binding is configured only when it is a string with a non-whitespace
 * character. Exact mode keeps those bytes; trim mode is opt-in.
 */
export async function checkConfiguredBearer(
  request: Request,
  binding: unknown,
  options?: CheckConfiguredBearerOptions,
): Promise<ConfiguredBearerResult> {
  if (typeof binding !== "string" || binding.trim().length === 0) {
    return "unconfigured";
  }
  const effectiveToken = options?.tokenNormalization === "trim" ? binding.trim() : binding;
  const supplied = request.headers.get("authorization");
  if (supplied === null) return "missing";
  const expected = `Bearer ${effectiveToken}`;
  const [expectedDigest, suppliedDigest] = await Promise.all([
    sha256(expected),
    sha256(supplied),
  ]);
  return digestsMatch(expectedDigest, suppliedDigest) ? "authorized" : "invalid";
}
