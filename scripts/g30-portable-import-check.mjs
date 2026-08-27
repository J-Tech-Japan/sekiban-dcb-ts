#!/usr/bin/env node
/**
 * The portable provider/contract lanes execute under Node, where the
 * Cloudflare-only `cloudflare:workers` module is intentionally unavailable.
 * Keep the package root importable there while the Cloudflare entrypoint owns
 * injection of the real custom-span API into Worker and DO callbacks.
 */
const runtime = await import("@sekiban/dcb-runtime");

if (typeof runtime.createRuntimeWorker !== "function") {
  throw new Error("G30 portable runtime root did not export createRuntimeWorker");
}

console.log(JSON.stringify({
  runtime: "@sekiban/dcb-runtime",
  cloudflareImportLeak: false,
}, null, 2));
