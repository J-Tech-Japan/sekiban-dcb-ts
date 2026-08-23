import { tracing } from "cloudflare:workers";
import type { NativeTracing } from "./CommitTrace";

/**
 * The Worker runtime, not application code, establishes parentage. Both
 * entrypoints expose the identical API; using the module form lets Durable
 * Object handlers participate without adding a header or body field.
 */
export function cloudflareTracing(
  context?: Pick<ExecutionContext, "tracing">,
): NativeTracing {
  return (context?.tracing ?? tracing) as unknown as NativeTracing;
}
