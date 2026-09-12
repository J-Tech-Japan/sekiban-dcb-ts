import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ENABLED = process.env.SDT_G79_HOSTED_MEASURE === "1";
const ARTIFACT = resolve(process.cwd(), ".artifacts/sdt-g79-hosted-test-timing.jsonl");

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonError(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function gitHead() {
  const explicit = process.env.GITHUB_HEAD_SHA ?? process.env.GIT_COMMIT;
  if (explicit) return explicit;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8"));
      const pullRequestHead = event?.pull_request?.head?.sha;
      if (typeof pullRequestHead === "string" && pullRequestHead.length > 0) return pullRequestHead;
    } catch {
      // Fall through to the standard workflow SHA when the event is absent or unreadable.
    }
  }
  return process.env.GITHUB_SHA ?? "local-unresolved";
}

function runIdentity() {
  return {
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
    sha: gitHead(),
    invocation: `${process.env.GITHUB_JOB ?? process.env.npm_lifecycle_event ?? "vitest"}:${process.pid}`,
  };
}

function cliTimeout(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--testTimeout" || argument === "--test-timeout") {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed)) return parsed;
    }
    const match = argument.match(/^--(?:testTimeout|test-timeout)=(\d+(?:\.\d+)?)$/);
    if (match) return Number(match[1]);
  }
  return null;
}

function sourceLocation(test) {
  const file = test?.module?.relativeModuleId ?? test?.module?.moduleId ?? "unknown";
  const location = test?.location;
  return `${file}:${location?.line ?? "?"}:${location?.column ?? "?"}`;
}

function workBasis(file, name) {
  const value = `${file} ${name}`;
  if (value.includes("g43-tag-sql") || value.includes("backlog larger than one alarm")) {
    return "33 sequential durable appends, SQL LIMIT 32, two alarm passes, acknowledgements, and re-arm";
  }
  if (value.includes("commit.spec") && value.includes("AC7: allocation and cancellation faults")) {
    return "one allocation/cancellation fault injection, allocator/tag fact inspection, and the direct Section 6 response contract";
  }
  if (value.includes("tag.spec") && value.includes("G5: treats fences as an exact-key")) {
    return "exact-key fence install/clear/append ordering with the named fence acknowledgement and unrelated-fence checks";
  }
  if (value.includes("repair.spec") && value.includes("takes Branch B")) {
    return "one provider-exclusion Branch B repair, stable Tag head/version assertions, and the public repair response";
  }
  if (value.includes("repair.spec") && value.includes("six crash/race boundaries")) {
    return "six sequential crash/race boundary observations, durable Tag re-queries, and convergence without Response.error";
  }
  if (value.includes("g69-ordering") && value.includes("real MV generations")) {
    return "real materialized-view generations, join commit delivery, and public safe-reader status across the ordering schedule";
  }
  if (value.includes("g43-measurement")) {
    return "five history sizes across real Tag-DO SQL transitions and a closed range-plan predicate";
  }
  if (value.includes("g71-composition")) {
    return "two real SELF.fetch commits, scoped Tag deliveries through the sample worker.queue, SafeWindow hold and logical-clock release, safe and unsafe reads through the executor and sample route";
  }
  if (value.includes("g67-safe-lane")) {
    return "ten paced real D1/DO commits, queue kicks, and safe-reader convergence";
  }
  if (value.includes("repair.spec")) {
    return "partial-write repair Branch B and provider-exclusion binding";
  }
  if (value.includes("tag.spec")) {
    return "fence install/clear/append race and exact-key durable-set contract";
  }
  if (value.includes("commit.spec")) {
    return "allocator, cancellation, and durable allocator/tag fact contract";
  }
  return `named test contract in ${file}; retained pending repeated evidence and no inferred budget change`;
}

function classify(durationMs, budgetMs, state) {
  if (durationMs == null || budgetMs == null) {
    return state === "passed" ? "unmeasured" : "censored";
  }
  if (durationMs > budgetMs) return "over-budget";
  if (durationMs >= budgetMs * 0.5) return "near-budget";
  return "comfortable";
}

function normalizeFile(root, module) {
  const candidate = module?.relativeModuleId ?? module?.moduleId ?? "unknown";
  if (!candidate || candidate === "unknown") return candidate;
  return candidate.startsWith("/") ? relative(root, candidate) : candidate;
}

export default class G79HostedVitestReporter {
  constructor() {
    this.enabled = ENABLED;
    this.root = process.cwd();
    this.vitest = null;
    this.rows = new Map();
    this.startedAt = Date.now();
    this.identity = runIdentity();
    this.argv = process.argv.slice(2);
    this.cliTestTimeout = cliTimeout(this.argv);
    this.sourceCache = new Map();
    this.configDeclaresTestTimeout = false;
  }

  sourceText(file) {
    if (this.sourceCache.has(file)) return this.sourceCache.get(file);
    try {
      const text = readFileSync(resolve(this.root, file), "utf8");
      this.sourceCache.set(file, text);
      return text;
    } catch {
      this.sourceCache.set(file, null);
      return null;
    }
  }

  writtenTimeout(test, file) {
    const line = test.location?.line;
    const text = this.sourceText(file);
    if (!text || !line) return null;
    const lines = text.split("\n");
    const start = Math.max(0, line - 1);
    let declaration = start;
    while (declaration >= 0 && !/\b(?:it|test|specify)\s*\(/.test(lines[declaration])) declaration -= 1;
    if (declaration < 0) return null;
    const lineOffsets = [];
    let offset = 0;
    for (const value of lines) {
      lineOffsets.push(offset);
      offset += value.length + 1;
    }
    const declarationOffset = lineOffsets[declaration];
    const open = text.indexOf("(", declarationOffset);
    if (open < 0) return null;
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let end = -1;
    for (let index = open; index < text.length; index += 1) {
      const character = text[index];
      const next = text[index + 1];
      if (lineComment) {
        if (character === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (character === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === "/" && next === "/") {
        lineComment = true;
        index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        continue;
      }
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) return null;
    const segment = text.slice(declarationOffset, end);
    const timeoutMatches = [
      ...segment.matchAll(/\btimeout\s*:\s*(\d[\d_]*)/g),
      ...segment.matchAll(/,\s*(\d[\d_]*)\s*\)\s*$/g),
    ];
    if (timeoutMatches.length === 0) return null;
    const raw = timeoutMatches.at(-1)[1].replaceAll("_", "");
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  onInit(vitest) {
    if (!this.enabled) return;
    this.vitest = vitest;
    this.root = vitest.config.root ?? process.cwd();
    try {
      const configSource = readFileSync(resolve(this.root, "vitest.config.ts"), "utf8");
      this.configDeclaresTestTimeout = /\btestTimeout\s*:/.test(configSource);
    } catch {
      this.configDeclaresTestTimeout = false;
    }
    mkdirSync(dirname(ARTIFACT), { recursive: true });
  }

  emit(record) {
    if (!this.enabled) return;
    const line = JSON.stringify({
      schema: "sdt-g79-hosted-vitest-v1",
      ...this.identity,
      lifecycle: process.env.npm_lifecycle_event ?? null,
      ...record,
    });
    appendFileSync(ARTIFACT, `${line}\n`);
    console.log(`SDT-G79_HOSTED_TEST_TIMING ${line}`);
  }

  rowFor(test, stateOverride) {
    const file = normalizeFile(this.root, test.module);
    const name = test.fullName ?? test.name ?? "unknown";
    const diagnostic = test.diagnostic?.();
    const durationMs = numberOrNull(diagnostic?.duration);
    const explicitTimeoutMs = this.writtenTimeout(test, file);
    const timeoutMs = explicitTimeoutMs ?? this.cliTestTimeout ?? numberOrNull(this.vitest?.config?.testTimeout) ?? 5000;
    const budgetSource = explicitTimeoutMs != null
      ? "written per-test option"
      : this.cliTestTimeout != null
        ? "CLI --testTimeout"
        : this.configDeclaresTestTimeout
          ? "written Vitest config testTimeout"
          : "Vitest inherited default";
    const budgetOrigin = explicitTimeoutMs != null
      ? `${file}:${test.location?.line ?? "?"}`
      : this.cliTestTimeout != null
        ? "process.argv --testTimeout"
        : this.configDeclaresTestTimeout
          ? "vitest.config.ts:testTimeout"
          : "Vitest default (5,000 ms)";
    const state = stateOverride ?? test.result?.().state ?? "censored";
    return {
      recordType: "test",
      testId: test.id ?? null,
      file,
      name,
      location: sourceLocation(test),
      state,
      durationMs,
      budgetMs: timeoutMs,
      budgetSource,
      budgetOrigin,
      budgetLocation: sourceLocation(test),
      budgetBasis: workBasis(file, name),
      classification: classify(durationMs, timeoutMs, state),
      censored: durationMs == null || state === "skipped" || state === "pending",
      retryCount: diagnostic?.retryCount ?? null,
      repeatCount: diagnostic?.repeatCount ?? null,
    };
  }

  onTestCaseResult(test) {
    if (!this.enabled) return;
    const row = this.rowFor(test);
    this.rows.set(row.testId ?? `${row.file}:${row.location}:${row.name}`, row);
    this.emit(row);
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    if (!this.enabled) return;
    for (const module of testModules) {
      for (const test of module.children.allTests()) {
        const key = test.id ?? `${normalizeFile(this.root, module)}:${test.location?.line ?? "?"}:${test.fullName}`;
        if (this.rows.has(key)) continue;
        const row = this.rowFor(test, test.result?.().state ?? "censored");
        row.censored = true;
        row.censoredReason = "no onTestCaseResult receipt before run end";
        this.emit(row);
      }
    }
    this.emit({
      recordType: "run-summary",
      reason,
      durationMs: Date.now() - this.startedAt,
      testCount: this.rows.size,
      failedCount: [...this.rows.values()].filter((row) => row.state === "failed").length,
      censoredCount: [...this.rows.values()].filter((row) => row.censored).length,
      unhandledErrors: unhandledErrors.map(jsonError).filter(Boolean),
    });
  }
}
