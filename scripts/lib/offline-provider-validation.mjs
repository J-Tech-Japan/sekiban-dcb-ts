import { createHash } from "node:crypto";

export class OfflineProviderValidationError extends Error {
  constructor(value) {
    super(value.reason);
    this.name = "OfflineProviderValidationError";
    this.diagnostic = Object.freeze(value);
  }
}

export function diagnosticRecord(code, path, reason) {
  return Object.freeze({ code, path, reason });
}

export function raiseDiagnostic(value) {
  throw new OfflineProviderValidationError(diagnosticRecord(value.code, value.path, value.reason));
}

function report(onError, value) {
  if (onError === undefined) raiseDiagnostic(value);
  onError(diagnosticRecord(value.code, value.path, value.reason));
}

function parseError(onError, path, detail) {
  report(onError, { code: "JSONC_PARSE", path, reason: "jsonc-parse", detail });
}

export function stripJsonComments(source, label, onError) {
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
    } else if (current === "/" && next === "/") {
      const newline = source.indexOf("\n", index + 2);
      if (newline < 0) break;
      result += "\n";
      index = newline;
    } else if (current === "/" && next === "*") {
      const closing = source.indexOf("*/", index + 2);
      if (closing < 0) {
        parseError(onError, label, `${label} has an unterminated block comment`);
        return "";
      }
      result += " ";
      index = closing + 1;
    } else {
      result += current;
    }
  }
  return result;
}

export function scanJsonObjectKeys(source, label, onError) {
  const text = stripJsonComments(source, label, onError);
  let index = 0;

  function whitespace() {
    while (/\s/.test(text[index] ?? "")) index += 1;
  }

  function string() {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const current = text[index++];
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') return JSON.parse(text.slice(start, index));
    }
    parseError(onError, label, `${label} has an unterminated string`);
  }

  function value(path) {
    whitespace();
    const current = text[index];
    if (current === "{") {
      index += 1;
      const keys = new Set();
      whitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        whitespace();
        if (text[index] !== '"') {
          parseError(onError, path, `${label}${path} expected an object key`);
          return;
        }
        const key = string();
        const keyPath = `${path}.${key}`;
        if (keys.has(key)) {
          report(onError, { code: "DUPLICATE_KEY", path, reason: "duplicate-collection-key" });
          return;
        }
        keys.add(key);
        whitespace();
        if (text[index] !== ":") {
          parseError(onError, keyPath, `${keyPath} is missing a colon`);
          return;
        }
        index += 1;
        value(keyPath);
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          parseError(onError, path, `${label}${path} expected a comma`);
          return;
        }
        index += 1;
      }
      parseError(onError, path, `${label}${path} is unterminated`);
      return;
    }
    if (current === "[") {
      index += 1;
      let item = 0;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        value(`${path}[${item}]`);
        item += 1;
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          parseError(onError, path, `${label}${path} expected a comma`);
          return;
        }
        index += 1;
      }
      parseError(onError, path, `${label}${path} is unterminated`);
      return;
    }
    if (current === '"') {
      string();
      return;
    }
    const start = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
    if (index === start) parseError(onError, path, `${label}${path} has an empty value`);
  }

  value("$");
  whitespace();
  if (index !== text.length) parseError(onError, label, `${label} has trailing content`);
}

export function parseJsonc(source, label, onError) {
  scanJsonObjectKeys(source, label, onError);
  try {
    return JSON.parse(stripJsonComments(source, label, onError));
  } catch (error) {
    parseError(onError, label, `${label}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function assertClosedObject(value, path, allowedKeys, onError) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report(onError, { code: "SHAPE", path, reason: "authority-shape" });
  }
  const actual = Object.keys(value).sort();
  const allowed = [...allowedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(allowed)) {
    report(onError, { code: "KEYS", path, reason: "authority-key" });
  }
  return value;
}

export function assertNonEmptyString(value, path, onError) {
  if (typeof value !== "string" || value.length === 0) {
    report(onError, { code: "SHAPE", path, reason: "authority-shape" });
  }
  return value;
}

export function assertArray(value, path, onError) {
  if (!Array.isArray(value)) report(onError, { code: "SHAPE", path, reason: "authority-shape" });
  return value;
}

export function assertUnique(values, path, onError) {
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      report(onError, {
        code: "DUPLICATE_IDENTITY",
        path: `${path}[${index}]`,
        reason: "duplicate-collection-key",
      });
    }
    seen.add(value);
  }
}

export function assertUniqueBy(entries, identity, path, onError) {
  assertUnique(entries.map(identity), path, onError);
}

export function compareExactOrdered(actual, expected, path, onError, reason = "parity") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) report(onError, { code: "EXACT_ORDERED", path, reason });
}

export function compareExactSet(actual, expected, path, onError, reason = "parity") {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) report(onError, { code: "EXACT_SET", path, reason });
}

export function rowKey(value) {
  return JSON.stringify(value);
}

function jcs(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS number is not finite");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value !== "object") throw new Error("JCS value is not a JSON type");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(",")}}`;
}

export function canonicalJson(value, mode = "jcs") {
  if (mode === "jcs") return jcs(value);
  if (mode === "row-key") return rowKey(value);
  throw new Error(`unknown offline canonicalization mode: ${mode}`);
}

export function domainSeparatedSha256(payload, domain) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0")
    .update(canonicalJson(payload, "jcs"), "utf8")
    .digest("hex");
}
