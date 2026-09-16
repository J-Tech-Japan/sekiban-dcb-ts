#!/usr/bin/env node
/** @deprecated SDT-G91 — delegate to scripts/g77-ac6-measure.mjs */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const delegate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "g77-ac6-measure.mjs");
const result = spawnSync(process.execPath, [delegate, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
