import { describe, expect, it } from "vitest";
// @ts-expect-error Vite raw source fixture
import runnerSource from "../tools/sekiban-parity/run.mjs?raw";

describe("SDT-G32 pinned C# parity runner transport", () => {
  it("builds actual pinned sources outside the single JSON stdout transport", () => {
    expect(runnerSource).toMatch(/function buildCsharpRunner\(source\) \{[\s\S]*?run\("dotnet", \[\s*"build",/);
    expect(runnerSource).toMatch(/return \[\s*"run",\s*"--no-build",\s*"--project",/);
    expect(runnerSource).toContain("buildCsharpRunner(source.path)");
    expect(runnerSource).toContain('JSON.parse(run("dotnet", csharpArguments(source, "produce")))');
  });
});
