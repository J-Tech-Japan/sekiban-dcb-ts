import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const baseUrl = process.env.G61_BASE_URL;
const tokenFile = process.env.G53_CONFORMANCE_TOKEN_FILE;
const outputPath = process.env.G61_HEALTH_PROBE_OUTPUT ?? ".artifacts/sdt-g61-w148-health-probe.json";
if (!baseUrl || !tokenFile) throw new Error("G61_BASE_URL and G53_CONFORMANCE_TOKEN_FILE are required");
const token = readFileSync(tokenFile, "utf8").trim();
if (token.length === 0) throw new Error("conformance token file is empty");
const startedAtMs = Date.now();
const response = await fetch(new URL("/conformance/v1/read-health", baseUrl), {
  headers: { authorization: `Bearer ${token}`, accept: "application/json" },
});
const receivedAtMs = Date.now();
const rawBody = await response.text();
let body;
try { body = JSON.parse(rawBody); } catch { body = { raw: rawBody }; }
const receipt = {
  url: new URL("/conformance/v1/read-health", baseUrl).toString(),
  status: response.status,
  startedAtMs,
  receivedAtMs,
  responseMs: receivedAtMs - startedAtMs,
  body,
  cfRay: response.headers.get("cf-ray"),
};
const output = resolve(outputPath);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: receipt.status, output })}\n`);
