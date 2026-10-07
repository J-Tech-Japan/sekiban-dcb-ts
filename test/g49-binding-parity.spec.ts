import { describe, expect, it } from "vitest";

// @ts-expect-error The guard is an intentionally imported JavaScript module.
import { namedImportFrom, parseImportDeclarations } from "../scripts/g49-binding-parity-check.mjs";

describe("SDT-G49 binding-parity parser", () => {
  it("G49 parser: keeps import declarations statement-bounded and fails closed for missing or ambiguous bindings", () => {
    const source = `
      // Comments must not join neighboring declarations.
      import DefaultValue, {
        /* runtime named import */ RuntimeValue as LocalRuntime,
        type InlineType,
        AnotherRuntime,
      } from "./runtime";
      import type { TypeOnly } from "./types";
      import "./side-effect";
      import { ConsecutiveValue } from "./consecutive";
      import { SecondRuntime } from "./second-runtime";
    `;

    const declarations = parseImportDeclarations(source, "root parser test");
    expect(declarations.map((declaration: { moduleName: string }) => declaration.moduleName)).toEqual([
      "./runtime",
      "./types",
      "./side-effect",
      "./consecutive",
      "./second-runtime",
    ]);
    expect(declarations[0]).toMatchObject({
      moduleName: "./runtime",
      isTypeOnly: false,
      defaultImport: "DefaultValue",
      namedImports: [
        { imported: "RuntimeValue", local: "LocalRuntime" },
        { imported: "AnotherRuntime", local: "AnotherRuntime" },
      ],
    });
    expect(declarations[1]).toMatchObject({ isTypeOnly: true, namedImports: [] });
    expect(declarations[2]).toMatchObject({ isTypeOnly: false, namedImports: [] });
    expect(declarations[3].namedImports).toEqual([{ imported: "ConsecutiveValue", local: "ConsecutiveValue" }]);

    expect(() => namedImportFrom(
      'import { Present } from "./other";',
      "./runtime",
      "missing expected runtime module",
      ["Expected"],
    )).toThrow(/exactly one usable named import/);
    expect(() => namedImportFrom(
      'import { First } from "./runtime"; import { Second } from "./runtime";',
      "./runtime",
      "ambiguous expected runtime module",
    )).toThrow(/exactly one usable named import/);
    expect(() => parseImportDeclarations(
      'import { First as Same } from "./one"; import { Second as Same } from "./two";',
      "duplicate runtime binding",
    )).toThrow(/repeats local runtime import Same/);
  });
});
