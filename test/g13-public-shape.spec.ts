import { describe, expect, it } from "vitest";
import { defineTag } from "@sekiban/dcb-core";
import { ClaimLedgerExecutor, type ReadonlyTagStateResponse } from "@sekiban/dcb-client";
import { AllocatorDurableObject, handleDownstreamQueue } from "@sekiban/dcb-runtime";

describe("SDT-G13 public package shape", () => {
  it("resolves only the public entrypoints and exposes readonly DTOs", () => {
    expect(defineTag("consumer", "fixture").id).toBe("consumer:fixture");
    expect(typeof ClaimLedgerExecutor).toBe("function");
    expect(typeof AllocatorDurableObject).toBe("function");
    expect(typeof handleDownstreamQueue).toBe("function");
    const response: ReadonlyTagStateResponse = {
      payload: {},
      version: 1,
      lastSortedUniqueId: "s-1",
      tagGroup: "consumer",
      tagContent: "fixture",
      tagProjector: "projector",
    };
    expect(response.lastSortedUniqueId).toBe("s-1");
  });
});
