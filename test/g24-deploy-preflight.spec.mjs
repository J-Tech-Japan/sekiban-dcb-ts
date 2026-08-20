import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const deployScript = join(repoRoot, "scripts/deploy/g15-deploy.sh");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runWithInvalidServiceId(serviceId) {
  const directory = mkdtempSync(join(tmpdir(), "sdt-g24-deploy-"));
  temporaryDirectories.push(directory);
  const logPath = join(directory, "wrangler.log");
  const wranglerStub = join(directory, "wrangler-stub.sh");
  writeFileSync(wranglerStub, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"${G24_WRANGLER_LOG}\"\n", "utf8");
  chmodSync(wranglerStub, 0o755);
  const environment = {
    ...process.env,
    WRANGLER_BIN: wranglerStub,
    G24_WRANGLER_LOG: logPath,
  };
  if (serviceId === undefined) delete environment.G15_SERVICE_ID;
  else environment.G15_SERVICE_ID = serviceId;
  const result = spawnSync("bash", [deployScript], { cwd: repoRoot, env: environment, encoding: "utf8" });
  return { result, calls: readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean) };
}

describe("SDT-G24 G15 deployment preflight", () => {
  it.each([undefined, "not valid!"])("aborts before deploy when G15_SERVICE_ID is %j", (serviceId) => {
    const { result, calls } = runWithInvalidServiceId(serviceId);
    expect(result.status).toBe(2);
    expect(calls.filter((call) => call.split(" ")[0] === "deploy")).toEqual([]);
  });
});
