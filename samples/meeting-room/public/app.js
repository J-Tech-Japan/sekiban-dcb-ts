/* global FormData, document, fetch, setTimeout */

import {
  UI_SAFE_WINDOW_BOUND_MS,
  compareV1Ordinal,
  commandOutcome,
  reservationListView,
  roomQueryView,
  visibilityState,
} from "./ui-model.js";
import {
  requestPostCommitReservationList,
} from "./reservation-auto-refresh.js";

const statusElement = document.querySelector("#status");
const projectionElement = document.querySelector("#projection");
const roomForm = document.querySelector("#room-form");
const reservationForm = document.querySelector("#reservation-form");
const cancelForm = document.querySelector("#cancel-form");
const reservationsRefresh = document.querySelector("#reservations-refresh");
const reservationsState = document.querySelector("#reservations-state");
const reservationsHead = document.querySelector("#reservations-head");
const reservationsBody = document.querySelector("#reservations-body");
const roomQueryForm = document.querySelector("#room-query-form");
const roomQueryState = document.querySelector("#room-query-state");
const roomQueryHead = document.querySelector("#room-query-head");
const roomQueryResult = document.querySelector("#room-query-result");

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

async function sendCommand(commandId, input, projection, options = {}) {
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
  if (suid !== undefined) setStatus(`Committed (${suid})`, "success");
  if (options.refreshReservations === true && suid !== undefined) {
    await refreshReservationsAfterCommit(suid);
    return;
  }
  if (suid === undefined || projection === undefined) {
    setStatus(message, "success");
    return;
  }
  await observeProjection(projection.kind, projection.id, suid);
}

function setQueryState(element, message, kind) {
  element.textContent = message;
  element.dataset.kind = kind;
}

function setReadHead(element, readHead) {
  element.textContent = readHead === undefined ? "Read head unavailable" : `Read head: ${readHead}`;
}

function renderReservationRows(rows) {
  reservationsBody.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const value of [row.reservationId, row.roomId, row.status, String(row.version)]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    reservationsBody.append(tr);
  }
}

const RESERVATION_PAGE_SIZE = 20;
const RESERVATIONS_ENDPOINT = "/api/read/reservations";

async function fetchReservationPage(pageNumber, options = {}) {
  const pageSize = options.pageSize ?? RESERVATION_PAGE_SIZE;
  const response = options.waitForSortableUniqueId === undefined
    ? await fetch(
      `${RESERVATIONS_ENDPOINT}?pageNumber=${pageNumber}&pageSize=${pageSize}${options.newestFirst === true ? "&newestFirst=true" : ""}`,
      { headers: { Accept: "application/json" } },
    )
    : await requestPostCommitReservationList(fetch, options.waitForSortableUniqueId);
  return reservationListView(response.status, await responseBody(response));
}

/**
 * Reserve/cancel completes through exactly one list-query carrying the commit
 * SUID. The runtime owns the bounded wait; this browser path deliberately
 * does not retry or poll after a 504.
 */
async function refreshReservationsAfterCommit(commitSuid) {
  setQueryState(reservationsState, `List head unavailable; waiting for ${commitSuid}`, "pending");
  try {
    const view = await fetchReservationPage(1, { waitForSortableUniqueId: commitSuid });
    if (view.kind === "error") {
      renderReservationRows([]);
      if (view.status === 504 || view.code === "timeout") {
        setQueryState(reservationsState, "Reservations are still catching up. Use Refresh to read the latest list.", "timeout");
      } else {
        setQueryState(reservationsState, `Error: ${view.error}`, "error");
      }
      return;
    }
    setReadHead(reservationsHead, view.readHead);
    const newestFirst = view.rows.slice(0, RESERVATION_PAGE_SIZE);
    renderReservationRows(newestFirst);
    const catchUp = typeof view.readHead !== "string"
      ? `List head unavailable; waiting for ${commitSuid}`
      : compareV1Ordinal(view.readHead, commitSuid) >= 0
        ? `List head ${view.readHead} caught up to ${commitSuid}`
        : `List head ${view.readHead} waiting for ${commitSuid}`;
    setQueryState(
      reservationsState,
      `${catchUp} — ${view.kind === "empty" ? "No reservations found." : `${view.totalCount} reservation(s) — showing newest ${newestFirst.length}`}`,
      view.kind === "empty" ? "empty" : "ready",
    );
  } catch (error) {
    renderReservationRows([]);
    setQueryState(reservationsState, `Error: ${error instanceof Error ? error.message : "Network request failed"}`, "error");
  }
}

async function loadReservations() {
  setQueryState(reservationsState, "Loading reservations…", "pending");
  try {
    // The server pages in ascending SUID order, so the newest rows live on the
    // LAST page. Fetch the last page (and its predecessor when the last page
    // is partial) and render newest-first.
    const first = await fetchReservationPage(1);
    if (first.kind === "error") {
      renderReservationRows([]);
      setQueryState(reservationsState, `Error: ${first.error}`, "error");
      return;
    }
    setReadHead(reservationsHead, first.readHead);
    if (first.kind === "empty") {
      renderReservationRows([]);
      setQueryState(reservationsState, "No reservations found.", "empty");
      return;
    }
    const totalCount = first.totalCount;
    const totalPages = Math.max(1, Math.ceil(totalCount / RESERVATION_PAGE_SIZE));
    let rows = first.rows;
    if (totalPages > 1) {
      const last = await fetchReservationPage(totalPages);
      if (last.kind === "error") {
        renderReservationRows([]);
        setQueryState(reservationsState, `Error: ${last.error}`, "error");
        return;
      }
      rows = last.rows;
      if (rows.length < RESERVATION_PAGE_SIZE && totalPages > 2) {
        const previous = await fetchReservationPage(totalPages - 1);
        if (previous.kind === "ready") rows = [...previous.rows, ...rows];
      } else if (rows.length < RESERVATION_PAGE_SIZE && totalPages === 2) {
        rows = [...first.rows, ...rows];
      }
      setReadHead(reservationsHead, last.readHead);
    }
    const newestFirst = rows.slice(-RESERVATION_PAGE_SIZE).reverse();
    renderReservationRows(newestFirst);
    setQueryState(
      reservationsState,
      `${totalCount} reservation(s) — showing newest ${newestFirst.length}`,
      "ready",
    );
  } catch (error) {
    renderReservationRows([]);
    setQueryState(reservationsState, `Error: ${error instanceof Error ? error.message : "Network request failed"}`, "error");
  }
}

async function queryRoom(roomId) {
  setQueryState(roomQueryState, "Loading room query…", "pending");
  try {
    const response = await fetch(`/api/read/room-query?roomId=${encodeURIComponent(roomId)}`, {
      headers: { Accept: "application/json" },
    });
    const view = roomQueryView(response.status, await responseBody(response));
    setReadHead(roomQueryHead, view.readHead);
    if (view.kind === "error") {
      roomQueryResult.textContent = "No room result.";
      setQueryState(roomQueryState, `Error: ${view.error}`, "error");
      return;
    }
    roomQueryResult.textContent = JSON.stringify(view.result, null, 2);
    setQueryState(roomQueryState, "Room query ready", "ready");
  } catch (error) {
    roomQueryResult.textContent = "No room result.";
    setQueryState(roomQueryState, `Error: ${error instanceof Error ? error.message : "Network request failed"}`, "error");
  }
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
  }, { kind: "reservation", id: form.get("reservationId") }, { refreshReservations: true });
});

cancelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(cancelForm);
  void sendCommand("cancel-reservation", {
    reservationId: form.get("reservationId"),
  }, { kind: "reservation", id: form.get("reservationId") }, { refreshReservations: true });
});

reservationsRefresh.addEventListener("click", () => {
  void loadReservations();
});

roomQueryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(roomQueryForm);
  const roomId = form.get("roomId");
  if (typeof roomId === "string" && roomId.length > 0) void queryRoom(roomId);
});

void loadReservations();
