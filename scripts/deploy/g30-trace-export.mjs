#!/usr/bin/env node
export * from "../g30-trace-export.mjs";
import { runCli } from "../g30-trace-export.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
