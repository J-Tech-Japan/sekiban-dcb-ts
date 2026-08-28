/**
 * Node-safe contract entrypoint for SDT-G42's external probe runner.
 *
 * The primary Worker imports the same source through `cloudflare.ts`; this
 * narrow entrypoint intentionally does not compose the Cloudflare runtime, so
 * the pre-run runner and checker can execute under ordinary Node without
 * resolving `cloudflare:workers`.
 */
export {
  G42_JOURNAL_PROBE_PATH,
  G42_JOURNAL_PROBE_SCHEMA,
} from "./journal/JournalFirstTouchProbe";
