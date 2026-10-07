#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, relative, resolve } from "node:path";

const sampleRoot = resolve(process.cwd(), "samples/meeting-room");
const expectedWorkerDependencies = Object.freeze([
  "@sekiban/dcb-client",
  "@sekiban/dcb-cloudflare",
  "@sekiban/dcb-core",
  "@sekiban/dcb-domain",
  "@sekiban/dcb-runtime",
]);

function requireContract(condition, message) {
  if (!condition) throw new Error(message);
}

function stripJsonComments(source) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }
    if (current === "/" && next === "/") {
      const newline = source.indexOf("\n", index + 2);
      if (newline < 0) break;
      result += "\n";
      index = newline;
      continue;
    }
    if (current === "/" && next === "*") {
      const closing = source.indexOf("*/", index + 2);
      if (closing < 0) throw new Error("unterminated Wrangler JSONC comment");
      result += " ";
      index = closing + 1;
      continue;
    }
    result += current;
  }
  return result;
}

function readJsonc(path) {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
}

function configuredAssetsDirectory(root) {
  const configPath = resolve(root, "wrangler.jsonc");
  const config = readJsonc(configPath);
  const directory = config.assets?.directory;
  requireContract(typeof directory === "string" && directory.length > 0, "sample Wrangler config must declare assets.directory");
  return { configText: readFileSync(configPath, "utf8"), directory };
}

function enumerateAssets(directory, root = directory) {
  requireContract(existsSync(directory), "configured assets.directory does not exist: " + directory);
  const assets = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...enumerateAssets(path, root));
      continue;
    }
    if (entry.isFile() && [".html", ".js"].includes(extname(entry.name))) {
      assets.push({ path, relativePath: relative(root, path).split("\\").join("/") });
    }
  }
  return assets;
}

function checkBrowserAssets(assets) {
  for (const asset of assets) {
    const source = readFileSync(asset.path, "utf8");
    requireContract(!/\b(react|vue|svelte|next)\b/i.test(source), `browser asset ${asset.relativePath} contains forbidden framework marker`);
    const packageImport = source.match(/["'](@sekiban\/[^"']+)["']/);
    if (packageImport !== null) {
      requireContract(false, `browser asset ${asset.relativePath} imports forbidden package ${packageImport[1]}`);
    }
  }
}

function checkStaticMarkers(root) {
  const html = readFileSync(resolve(root, "public/index.html"), "utf8");
  const app = readFileSync(resolve(root, "public/app.js"), "utf8");
  for (const marker of [
    'id="reservation-list-panel"',
    'id="reservations-refresh"',
    'id="reservations-body"',
    'id="room-query-panel"',
    'id="room-query-form"',
    'id="room-query-result"',
    'src="/app.js"',
  ]) {
    requireContract(html.includes(marker), `missing static UI marker: ${marker}`);
  }
  for (const marker of [
    '"/api/read/reservations"',
    "/api/read/room-query?roomId=",
    '"#reservations-refresh"',
    '"#room-query-form"',
    "reservationListView",
    "roomQueryView",
  ]) {
    requireContract(app.includes(marker), `missing query UI behavior: ${marker}`);
  }
}

function checkWorkerContract(root, configText) {
  const samplePackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const found = Object.keys(samplePackage.dependencies ?? {}).sort();
  const expected = [...expectedWorkerDependencies].sort();
  requireContract(
    found.join(",") === expected.join(","),
    `Worker dependency allowlist mismatch: expected ${expected.join(",")}; found ${found.join(",")}`,
  );
  requireContract(!configText.includes('"SDT_SERVICE_ID"'), "sample Wrangler config must not bake an SDT_SERVICE_ID default");
}

export function checkSample(root = sampleRoot) {
  const { configText, directory } = configuredAssetsDirectory(root);
  const assets = enumerateAssets(resolve(root, directory));
  checkStaticMarkers(root);
  checkBrowserAssets(assets);
  checkWorkerContract(root, configText);
  return assets.map((asset) => asset.relativePath);
}

function expectedFailure(action, expectedMessage) {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    requireContract(message === expectedMessage, `fixture message mismatch: ${message}`);
    return;
  }
  throw new Error("fixture unexpectedly passed: " + expectedMessage);
}

function selfTest() {
  checkSample(sampleRoot);
  const temporary = mkdtempSync(resolve(tmpdir(), "sdt-g16-ui-check-"));
  const copiedRoot = resolve(temporary, "meeting-room");
  try {
    cpSync(sampleRoot, copiedRoot, { recursive: true });
    const uiModelPath = resolve(copiedRoot, "public/ui-model.js");
    writeFileSync(uiModelPath, readFileSync(uiModelPath, "utf8") + '\nimport "@sekiban/dcb-runtime";\n', "utf8");
    expectedFailure(
      () => checkSample(copiedRoot),
      "browser asset ui-model.js imports forbidden package @sekiban/dcb-runtime",
    );

    rmSync(copiedRoot, { recursive: true, force: true });
    cpSync(sampleRoot, copiedRoot, { recursive: true });
    const packagePath = resolve(copiedRoot, "package.json");
    const packageDocument = JSON.parse(readFileSync(packagePath, "utf8"));
    packageDocument.dependencies = {
      "@sekiban/dcb-client": "0.2.0",
      "@sekiban/dcb-core": "0.2.0",
      "@sekiban/dcb-runtime": "0.2.0",
    };
    writeFileSync(packagePath, JSON.stringify(packageDocument, null, 2) + "\n", "utf8");
    expectedFailure(
      () => checkSample(copiedRoot),
      "Worker dependency allowlist mismatch: expected @sekiban/dcb-client,@sekiban/dcb-cloudflare,@sekiban/dcb-core,@sekiban/dcb-domain,@sekiban/dcb-runtime; found @sekiban/dcb-client,@sekiban/dcb-core,@sekiban/dcb-runtime",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify({
    result: "g16-ui-contract-passed",
    browserAssetFixture: "red",
    workerAllowlistFixture: "red",
  }) + "\n");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  checkSample();
  console.log("SDT-G16 static UI contract: PASS");
}
