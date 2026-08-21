import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageRoot = join(root, "packages", "dcb-domain");
const sourceRoot = join(packageRoot, "src");
const fixtureRoot = join(packageRoot, "boundary-fixtures");

const fail = (message) => {
  throw new Error(`SDT-G28 boundary gate: ${message}`);
};

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

function importsOf(source) {
  const fromImports = [...source.matchAll(/(?:import|export)\s+(?:type\s+)?[^;]*?\sfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
  const sideEffectImports = [...source.matchAll(/\bimport\s*["']([^"']+)["']/g)].map((match) => match[1]);
  return [...fromImports, ...sideEffectImports];
}

function dynamicImportsOf(source) {
  return [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
}

function forbiddenGlobal(source) {
  const patterns = [
    /\bDate\.now\s*\(/,
    /\bnew\s+Date\b/,
    /\bMath\.random\s*\(/,
    /\bfetch\s*\(/,
    /\bprocess\b/,
    /\bglobalThis\b/,
    /\b(?:node:)?fs\b/,
    /\b(?:node:)?net\b/,
    /\bnode:http\b/,
  ];
  return patterns.findIndex((pattern) => pattern.test(source));
}

async function checkSourceBoundary() {
  const files = await filesUnder(sourceRoot);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const path = relative(root, file);
    const imports = importsOf(source);
    for (const specifier of [...imports, ...dynamicImportsOf(source)]) {
      if (specifier !== "zod" && !specifier.startsWith(".")) fail(`${path} imports forbidden module ${specifier}`);
    }
    const globalIndex = forbiddenGlobal(source);
    if (globalIndex >= 0) fail(`${path} uses forbidden global #${globalIndex}`);
    if (/\bas\s+(?:any|Event)\b/.test(source)) fail(`${path} contains a forbidden domain cast`);
  }
}

async function checkNegativeFixtures() {
  const importFixtures = new Set(["direct-import.ts", "transitive-import.ts", "path-alias.ts", "deep-relative.ts", "dynamic-import.ts"]);
  const expected = new Map([
    ["direct-import.ts", "@sekiban/dcb-runtime"],
    ["transitive-import.ts", "transitive-helper"],
    ["path-alias.ts", "@/dcb-runtime"],
    ["deep-relative.ts", "../../dcb-core/src/index.ts"],
    ["dynamic-import.ts", "@sekiban/dcb-runtime"],
    ["date-now.ts", "Date.now"],
    ["new-date.ts", "new Date"],
    ["math-random.ts", "Math.random"],
    ["fetch.ts", "fetch"],
    ["process.ts", "process"],
    ["fs.ts", "node:fs"],
    ["network.ts", "node:net"],
  ]);
  for (const [name, marker] of expected) {
    const source = await readFile(join(fixtureRoot, name), "utf8");
    if (!source.includes(marker)) fail(`negative fixture ${name} lost marker ${marker}`);
    const importViolation = importsOf(source).some((specifier) => specifier !== "zod" && !specifier.startsWith("."));
    const dynamicViolation = dynamicImportsOf(source).some((specifier) => specifier !== "zod" && !specifier.startsWith("."));
    const globalViolation = forbiddenGlobal(source) >= 0;
    if (name === "transitive-import.ts") {
      const helper = await readFile(join(fixtureRoot, "transitive-helper.ts"), "utf8");
      if (!importsOf(helper).includes("@sekiban/dcb-core")) fail("transitive helper lost its forbidden import");
    } else if (importFixtures.has(name) && !(importViolation || dynamicViolation || source.includes("../../dcb-core"))) fail(`negative fixture ${name} does not reach import gate`);
    if (!importFixtures.has(name) && !globalViolation && !source.includes("../../dcb-core")) fail(`negative fixture ${name} does not reach globals gate`);
  }
}

async function checkPackageManifestAndPack() {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort();
  if (JSON.stringify(dependencies) !== JSON.stringify(["zod"])) fail(`dependency allowlist is ${dependencies.join(",")}`);
  if (Object.keys(manifest.devDependencies ?? {}).length > 0 || Object.keys(manifest.peerDependencies ?? {}).length > 0) fail("package has a non-zod dependency section");
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--workspace", "@sekiban/dcb-domain"], {
    cwd: root,
    encoding: "utf8",
  });
  if (packed.status !== 0) fail(`npm pack failed: ${packed.stderr}`);
  const report = JSON.parse(packed.stdout)[0];
  const names = report.files.map((file) => file.path);
  for (const required of ["dist/index.js", "dist/index.d.ts", "dist/testing.js", "dist/testing.d.ts"]) {
    if (!names.includes(required)) fail(`npm pack omitted ${required}`);
  }
  if (names.some((name) => name.startsWith("src/") || name.includes("boundary-fixtures") || name.includes("typecheck-fixtures"))) fail("npm pack leaked source or negative fixtures");
}

if (process.env.SDT_G28_BOUNDARY_FORCE_FAILURE === "1") fail("forced-red boundary probe");
await checkSourceBoundary();
await checkNegativeFixtures();
await checkPackageManifestAndPack();
console.log(JSON.stringify({ status: "PASS", package: "@sekiban/dcb-domain", sourceFiles: (await filesUnder(sourceRoot)).length, negativeFixtures: 12 }));
