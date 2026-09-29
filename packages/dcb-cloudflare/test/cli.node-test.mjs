/* global process */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const cli = await import("../dist/cli.js");

const pipelineId = "11111111-1111-4111-8111-111111111111";
const mvId = "22222222-2222-4222-8222-222222222222";

function configText() {
  return JSON.stringify({
    account_id: "account-test",
    d1_databases: [
      { binding: "D1", database_name: "pipeline", database_id: pipelineId, migrations_dir: "migrations/d1/g32", migrations_table: "custom_migrations" },
      { binding: "D1_MV", database_name: "mv", database_id: mvId, migrations_dir: "migrations/mv" },
    ],
  });
}

test("cf plans UUID migrations with cwd, table, account and marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcb-cloudflare-cli-test-"));
  try {
    const configPath = join(root, "nested", "wrangler.jsonc");
    const fakeCf = join(root, "cf");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(fakeCf, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCf, 0o755);
    const requests = [];
    const result = await cli.executeCloudflareCli(["migrate", "--config", configPath, "--cli", "cf"], {
      cwd: root,
      env: { ...process.env, CF_BIN: fakeCf, CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_API_TOKEN: "parent-token-g104" },
      readText: () => configText(),
      spawn: async (request) => { requests.push(request); return 0; },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.commands, [
      ["cf", "d1", "migrations", "apply", pipelineId, "--dir", "migrations/d1/g32", "--table", "custom_migrations"],
      ["cf", "d1", "migrations", "apply", mvId, "--dir", "migrations/mv"],
    ]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].cwd, join(root, "nested"));
    assert.equal(requests[0].command[0], fakeCf);
    assert.equal(requests[0].env.CLOUDFLARE_ACCOUNT_ID, "account-test");
    assert.equal(requests[0].env.SEKIBAN_DCB_CF_HELPER, "d1-migrations");
    assert.equal(requests[0].env.CLOUDFLARE_API_TOKEN, "parent-token-g104");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cf refuses unsafe flags before spawning and strips marker for Wrangler", async () => {
  const config = JSON.stringify({ d1_databases: [{ binding: "D1", database_name: "pipeline", database_id: pipelineId }] });
  const errors = [];
  let spawned = 0;
  const refused = await cli.executeCloudflareCli(["migrate", "--config", "caller.jsonc", "--cli", "cf", "--local"], {
    env: { ...process.env, CF_BIN: "/fake/cf" },
    readText: () => config,
    stderr: (message) => errors.push(message),
    spawn: async () => { spawned += 1; return 0; },
  });
  assert.equal(refused.exitCode, 1);
  assert.equal(spawned, 0);
  assert.match(errors[0], /--local/);

  const requests = [];
  const wrangler = await cli.executeCloudflareCli(["migrate", "--config", "caller.jsonc"], {
    env: { ...process.env, SEKIBAN_DCB_CF_HELPER: "d1-migrations" },
    readText: () => config,
    spawn: async (request) => { requests.push(request); return 0; },
  });
  assert.equal(wrangler.exitCode, 0);
  assert.equal(requests[0].env.SEKIBAN_DCB_CF_HELPER, undefined);
  assert.deepEqual(wrangler.commands[0], ["wrangler", "d1", "migrations", "apply", "pipeline", "--config", "caller.jsonc", "--remote"]);
});
