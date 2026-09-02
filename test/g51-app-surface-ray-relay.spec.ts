import { describe, expect, it } from "vitest";
import { runtimeRequestWithIngressRay } from "../samples/meeting-room/src/ingress-observation";

describe("SDT-G51 app-surface trace identity relay", () => {
  it("preserves the ingress CF-Ray on the synthetic runtime request without changing the commit request", async () => {
    const request = runtimeRequestWithIngressRay(new Request("https://runtime.internal/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json", "x-application-header": "unchanged" },
      body: JSON.stringify({ version: 1, eventCandidates: [] }),
    }), undefined, "g51-ingress-ray-SJC");

    expect(request.headers.get("cf-ray")).toBe("g51-ingress-ray-SJC");
    expect(request.headers.get("x-application-header")).toBe("unchanged");
    expect(request.method).toBe("POST");
    await expect(request.json()).resolves.toEqual({ version: 1, eventCandidates: [] });
  });

  it("does not manufacture a trace join when the ingress has no CF-Ray", () => {
    const request = runtimeRequestWithIngressRay("https://runtime.internal/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, null);

    expect(request.headers.has("cf-ray")).toBe(false);
  });
});
