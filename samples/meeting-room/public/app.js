/* global FormData, document, fetch, setTimeout */

import {
  UI_SAFE_WINDOW_BOUND_MS,
  commandOutcome,
  visibilityState,
} from "./ui-model.js";

const statusElement = document.querySelector("#status");
const projectionElement = document.querySelector("#projection");
const roomForm = document.querySelector("#room-form");
const reservationForm = document.querySelector("#reservation-form");
const cancelForm = document.querySelector("#cancel-form");

function setStatus(message, kind = "info") {
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
}

function showProjection(value, kind = "visible") {
  projectionElement.dataset.kind = kind;
  projectionElement.textContent = JSON.stringify(value, null, 2);
}

async function responseBody(response) {
  try {
    return await response.json();
  } catch {
    return { error: `HTTP ${response.status}`, code: "transport" };
  }
}

function commitSortableUniqueId(body) {
  const response = body && typeof body.response === "object" && body.response !== null ? body.response : body;
  const events = response && Array.isArray(response.writtenEvents) ? response.writtenEvents : [];
  const first = events[0];
  return first && typeof first.sortableUniqueIdValue === "string" ? first.sortableUniqueIdValue : undefined;
}

function describeOutcome(status, body) {
  const outcome = commandOutcome(status, body);
  const diagnostic = typeof body?.error === "string" ? `: ${body.error}` : "";
  if (outcome === "conflict") return ["conflict", `Conflict${diagnostic}`];
  if (outcome === "rejected") return ["rejected", `Rejected${diagnostic}`];
  if (outcome === "partial") return ["partial", `Partial write${diagnostic}`];
  if (outcome === "timeout") return ["timeout", `Outcome undetermined${diagnostic}`];
  if (outcome === "unavailable") return ["unavailable", `Projection unavailable${diagnostic}`];
  if (outcome === "noop") return ["noop", `No change${diagnostic}`];
  if (outcome === "transport") return ["transport", `Transport error${diagnostic}`];
  return ["committed", "Committed"];
}

async function readProjection(kind, id) {
  const response = await fetch(`/api/read/${kind}?${kind === "room" ? "roomId" : "reservationId"}=${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
  });
  return { status: response.status, body: await responseBody(response) };
}

async function observeProjection(kind, id, commitSuid) {
  const startedAt = Date.now();
  const deadline = startedAt + UI_SAFE_WINDOW_BOUND_MS;
  setStatus(`Committed; waiting for projection head to reach ${commitSuid} (SafeWindow ${UI_SAFE_WINDOW_BOUND_MS}ms)`, "pending");
  for (;;) {
    const read = await readProjection(kind, id);
    const lastSortedUniqueId = typeof read.body?.lastSortedUniqueId === "string" ? read.body.lastSortedUniqueId : "";
    const state = visibilityState({
      commitSortableUniqueId: commitSuid,
      lastSortedUniqueId,
      startedAt,
      now: Date.now(),
    });
    if (state === "visible") {
      showProjection(read.body, "visible");
      setStatus(`Visible after ${Date.now() - startedAt}ms (lastSortedUniqueId ${lastSortedUniqueId})`, "success");
      return;
    }
    if (read.status >= 400) {
      const [, message] = describeOutcome(read.status, read.body);
      const kind = commandOutcome(read.status, read.body);
      setStatus(message, kind === "timeout" ? "timeout" : "error");
      showProjection(read.body, kind);
      return;
    }
    if (state === "timeout" || Date.now() >= deadline) {
      setStatus(`Projection visibility timed out after ${UI_SAFE_WINDOW_BOUND_MS}ms; outcome is not success`, "timeout");
      showProjection({ ...read.body, code: "timeout", error: "Projection did not reach the committed sortableUniqueId within the published SafeWindow bound" }, "timeout");
      return;
    }
    setStatus(`Pending: read head ${lastSortedUniqueId || "(empty)"} is below commit ${commitSuid}`, "pending");
    // The timer is only a polling yield. Visibility is never decided by its
    // cadence or by a retry count; the SUID comparison above is authoritative.
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
}

async function sendCommand(commandId, input, projection) {
  setStatus(`Sending ${commandId}…`, "pending");
  const response = await fetch(`/api/commands/${commandId}`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  const body = await responseBody(response);
  const [kind, message] = describeOutcome(response.status, body);
  if (kind !== "committed") {
    setStatus(message, kind === "noop" ? "info" : "error");
    showProjection(body, kind);
    return;
  }
  showProjection(body, "committed");
  const suid = commitSortableUniqueId(body);
  if (suid === undefined || projection === undefined) {
    setStatus(message, "success");
    return;
  }
  await observeProjection(projection.kind, projection.id, suid);
}

roomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(roomForm);
  void sendCommand("create-room", {
    roomId: form.get("roomId"),
    name: form.get("name"),
  }, { kind: "room", id: form.get("roomId") });
});

reservationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(reservationForm);
  void sendCommand("reserve-room", {
    roomId: form.get("roomId"),
    reservationId: form.get("reservationId"),
    userId: form.get("userId"),
  }, { kind: "reservation", id: form.get("reservationId") });
});

cancelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(cancelForm);
  void sendCommand("cancel-reservation", {
    reservationId: form.get("reservationId"),
  }, { kind: "reservation", id: form.get("reservationId") });
});
