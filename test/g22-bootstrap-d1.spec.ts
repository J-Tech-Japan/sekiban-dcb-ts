import { env } from "cloudflare:test";
import { beforeAll, describe, it } from "vitest";

// @ts-expect-error Vite raw asset import keeps migration execution tied to the committed SQL.
import migration from "../migrations/d1/0001_pipeline_store.sql?raw";
import { createD1BootstrapAdapter, D1EventStore } from "../packages/dcb-runtime/src/d1";
import { runG22BootstrapProviderContract } from "./helpers/g22-bootstrap-provider-contract";

function database(): D1Database {
  const binding = (env as unknown as { D1?: D1Database }).D1;
  if (binding === undefined) throw new Error("D1 binding is required for the real Miniflare bootstrap contract");
  return binding;
}

describe("SDT-G22 D1 bootstrap provider adapter", () => {
  beforeAll(async () => {
    const statements = (migration as string).replace(/^\s*--.*$/gm, "").split(";").map((statement) => statement.trim()).filter(Boolean);
    await database().batch(statements.map((statement) => database().prepare(statement)));
  });

  it("runs export snapshot and admission identity invariants against D1EventStore in Miniflare", async () => {
    await runG22BootstrapProviderContract("d1", new D1EventStore(database()), (store) => createD1BootstrapAdapter(store as D1EventStore));
  });
});
