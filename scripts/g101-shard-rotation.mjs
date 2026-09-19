#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "packages/dcb-runtime/src/shard/ShardRotation.ts");

function expect(name, fn) {
  try {
    fn();
    throw new Error(`${name} unexpectedly passed`);
  } catch (error) {
    if (error?.name !== "ShardRotationError") throw error;
    return error.diagnostic.reason;
  }
}

export async function runSelfTest() {
  const built = spawnSync("npm", ["run", "build", "-w", "@sekiban/dcb-runtime"], {
    encoding: "utf8",
    cwd: root,
  });
  if (built.status !== 0) throw new Error(built.stderr || built.stdout || "dcb-runtime build failed");
  const {
    admitActiveWrite,
    assertNoSilentLedgerMerge,
    assertStrictlyBefore,
    createRotationState,
    formatSortableUniqueId,
    maxSortableUniqueId,
    recordLateArrival,
    refuseSafeWindowSeal,
    refuseSealedWrite,
    refuseSilentLedgerMerge,
    replaceSealedIdentity,
    rotateAppend,
  } = await import(pathToFileURL(join(root, "packages/dcb-runtime/dist/index.js")).href);

  const last = formatSortableUniqueId(621_355_968_000_000_000n + 10_000n, 1n);
  const firstOk = formatSortableUniqueId(621_355_968_000_000_000n + 20_000n, 1n);
  const firstBad = formatSortableUniqueId(621_355_968_000_000_000n + 5_000n, 1n);

  let state = createRotationState("d1-1");
  const emptySeal = expect("seal-max-missing", () => rotateAppend(state, "d1-1", [], "d1-2"));
  state = rotateAppend(state, "d1-1", [firstBad, last], "d1-2");
  if (state.sealed.length !== 1 || state.sealed[0].id !== "d1-1" || state.sealed[0].lastSuid !== last) {
    throw new Error("rotateAppend did not seal with maxSortableUniqueId(last(D1-1))");
  }
  if (state.active !== "d1-2") throw new Error("active must become d1-2");
  const activeSealed = expect("active-already-sealed", () =>
    rotateAppend(
      { sealed: [{ id: "d1-1", lastSuid: last }], active: "d1-2", ledger: [] },
      "d1-2",
      [firstOk],
      "d1-1",
    ));
  const swap = expect("identity-swap", () => replaceSealedIdentity(state, 0, "d1-1-rewritten"));
  admitActiveWrite(state, "d1-2", firstOk);
  assertStrictlyBefore(last, firstOk);
  const orderRed = expect("order-red", () => admitActiveWrite(state, "d1-2", firstBad));
  const equalRed = expect("order-equal", () => assertStrictlyBefore(last, last));
  const sealedWrite = expect("sealed-write", () => {
    refuseSealedWrite(state, "d1-1");
  });
  const afterLate = recordLateArrival(state, "d1-1", firstBad);
  if (afterLate.ledger.length !== 1 || afterLate.ledger[0].suid !== firstBad) {
    throw new Error("late arrival did not land only on the ledger");
  }
  const source = readFileSync(sourcePath, "utf8");
  assertNoSilentLedgerMerge(source);
  const silentBad = expect("silent-merge-fixture", () =>
    assertNoSilentLedgerMerge("function mergeLedgerIntoSealed(sealed, ledger) { return sealed.concat(ledger); }"));
  const silent = expect("silent-merge", () => refuseSilentLedgerMerge());
  const safe = expect("safewindow-seal", () => refuseSafeWindowSeal());
  if (/\bSafeWindow\b/.test(source)) throw new Error("rotation module must not reference SafeWindow");
  if (maxSortableUniqueId([firstBad, last]) !== last) throw new Error("max helper drifted");

  const unitA = spawnSync(process.execPath, [join(root, "scripts/g34-provider-composition.mjs"), "--self-test"], {
    encoding: "utf8",
    cwd: root,
  });
  if (unitA.status !== 0) throw new Error(unitA.stderr || unitA.stdout || "Unit A self-test failed");
  if (!String(unitA.stdout).includes("second-shard:second-shard")) {
    throw new Error("Unit A second-shard refusal missing from self-test output");
  }

  return {
    result: "g101-shard-rotation-self-test-passed",
    lastD1_1: last,
    firstD1_2: firstOk,
    probes: {
      "seal-max-missing": emptySeal,
      "active-already-sealed": activeSealed,
      "identity-swap": swap,
      "order-green": "last(D1-1)<first(D1-2)",
      "order-red": orderRed,
      "order-equal": equalRed,
      "sealed-write": sealedWrite,
      "late-ledger": afterLate.ledger.length,
      "silent-merge-fixture": silentBad,
      "silent-merge": silent,
      "safewindow-seal": safe,
      "unit-a-second-shard": "second-shard",
    },
  };
}

async function main() {
  if (!process.argv.includes("--self-test") && !process.argv.includes("--check")) return;
  const result = await runSelfTest();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("g101-shard-rotation.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  });
}
