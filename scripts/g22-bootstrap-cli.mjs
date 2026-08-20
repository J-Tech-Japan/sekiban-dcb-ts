#!/usr/bin/env node
/** Minimal operator CLI. The bearer value is read only from protected local storage. */
import { readFile } from "node:fs/promises";

const [operation, serviceId, file] = process.argv.slice(2);
const baseUrl = process.env.SDT_G22_BASE_URL;
const bearerFile = process.env.SDT_G22_BEARER_FILE;
if (!["plan", "import", "status", "abort", "export"].includes(operation) || !serviceId || !baseUrl || !bearerFile) {
  throw new Error("usage: SDT_G22_BASE_URL=... SDT_G22_BEARER_FILE=/protected/token g22-bootstrap-cli.mjs <plan|import|status|abort|export> <serviceId> [json-file]");
}
const token = (await readFile(bearerFile, "utf8")).trim();
if (!token) throw new Error("operator bearer file is empty");
const body = operation === "status" ? undefined : JSON.parse(await readFile(file ?? "", "utf8"));
const response = await fetch(`${baseUrl.replace(/\/$/, "")}/operator/bootstrap/${encodeURIComponent(serviceId)}/${operation}`, {
  method: operation === "status" ? "GET" : "POST",
  headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
process.stdout.write(`${await response.text()}\n`);
process.exitCode = response.ok ? 0 : 1;
