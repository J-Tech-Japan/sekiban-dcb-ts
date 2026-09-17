#!/usr/bin/env node
/**
 * Evaluate whether the active Cloudflare deployment is an SDT-G99 npm-consumer
 * tip suitable for speed/latency measurement.
 */
export function evaluateTipIdentity({ deployments, expectedCommit, service }) {
  const expectedService = "sekiban-dcb-meeting-room-cloudflare-only";
  if (service !== expectedService) {
    return Object.freeze({
      ok: false,
      reason: `service must be ${expectedService}`,
      activeVersionId: null,
      message: "",
    });
  }
  const active = Array.isArray(deployments)
    ? deployments.find((entry) => {
        const versions = entry?.versions;
        return Array.isArray(versions) && versions.some((v) => Number(v?.percentage) === 100);
      })
    : undefined;
  if (active === undefined) {
    return Object.freeze({
      ok: false,
      reason: "no 100% traffic deployment found",
      activeVersionId: null,
      message: "",
    });
  }
  const message = typeof active?.annotations?.["workers/message"] === "string"
    ? active.annotations["workers/message"]
    : "";
  const version = Array.isArray(active.versions)
    ? active.versions.find((v) => Number(v?.percentage) === 100)
    : undefined;
  const activeVersionId = typeof version?.version_id === "string" ? version.version_id : null;
  const marker = "SDT-G99 npm-consumer tip";
  if (!message.includes(marker)) {
    return Object.freeze({
      ok: false,
      reason: `active deployment message missing '${marker}'`,
      activeVersionId,
      message,
    });
  }
  if (typeof expectedCommit !== "string" || expectedCommit.length < 7 || !message.includes(expectedCommit)) {
    return Object.freeze({
      ok: false,
      reason: "active deployment message does not include expected tip commit",
      activeVersionId,
      message,
    });
  }
  return Object.freeze({
    ok: true,
    reason: null,
    activeVersionId,
    message,
  });
}
