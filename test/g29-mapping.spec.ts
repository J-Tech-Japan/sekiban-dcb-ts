import { describe, expect, it } from "vitest";
import mappingArtifact from "../docs/SDT-G29-mapping.json";
import { assertMappingContract, mutateMapping, validateMapping } from "../scripts/g29-mapping-contract.mjs";

const mapping = validateMapping(mappingArtifact);

function actualContract() {
  return Object.fromEntries(mapping.rows.map((row) => [
    row.rowId,
    Object.fromEntries(mapping.columns.map((column) => [column, row[column]])),
  ]));
}

describe("SDT-G29 mapping authority", () => {
  it("loads the versioned table and validates the shared adapter-neutral contract", () => {
    expect(mapping.schemaVersion).toBe(1);
    expect(assertMappingContract(actualContract(), mapping)).toEqual({ rows: 13, columns: 7 });
  });

  it.each([
    ["event-payload", "wire"],
    ["canonical-identity", "owner"],
    ["tags", "doTs"],
    ["view-descriptor", "unsupported"],
  ])("reports an exact row/column when %s:%s is dropped", (rowId, column) => {
    expect(() => assertMappingContract(mutateMapping(actualContract(), rowId, column), mapping))
      .toThrow(`${rowId}:${column}`);
  });
});
