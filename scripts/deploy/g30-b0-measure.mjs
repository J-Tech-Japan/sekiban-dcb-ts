#!/usr/bin/env node
export * from "../g30-b0-measure.mjs";
import { runCli } from "../g30-b0-measure.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
