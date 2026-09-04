import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const strippedNames = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "WRANGLER_API_TOKEN",
];

const argv = process.argv.slice(2);
const receiptIndex = argv.indexOf("--receipt");
if (receiptIndex < 0 || !argv[receiptIndex + 1]) {
  throw new Error("--receipt <path> is required");
}
const receiptPath = argv[receiptIndex + 1];
const stdinIndex = argv.indexOf("--stdin-file");
const stdinPath = stdinIndex >= 0 ? argv[stdinIndex + 1] : undefined;
const separatorIndex = argv.indexOf("--");
if (separatorIndex < 0 || !argv[separatorIndex + 1]) {
  throw new Error("command must follow --");
}
const command = argv.slice(separatorIndex + 1);

const childEnv = { ...process.env };
for (const name of strippedNames) delete childEnv[name];

const result = spawnSync(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: childEnv,
  encoding: "utf8",
  input: stdinPath ? fs.readFileSync(stdinPath) : undefined,
  maxBuffer: 32 * 1024 * 1024,
});

const receipt = {
  command,
  stdinFile: stdinPath ?? null,
  strippedEnvironmentNames: strippedNames,
  exitCode: result.status,
  signal: result.signal,
  error: result.error ? String(result.error) : null,
  stdout: result.stdout ?? "",
  stderr: result.stderr ?? "",
};
fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
