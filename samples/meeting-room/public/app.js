/* global FormData, document, fetch, setTimeout */

import {
  UI_SAFE_WINDOW_BOUND_MS,
  compareV1Ordinal,
  commandOutcome,
  commandSnapshots as buildCommandSnapshots,
  reconcileOccupiedAgainstRead,
  reservationListView,
  roomQueryView,
  snapshotInputValue,
  snapshotKey,
  snapshotLooksOccupied,
  tagsToReconcileForCommand,
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

// The browser keeps only portable, JSON-safe projector snapshots.  A commit
// response is authoritative for its per-tag heads; a list/query read head is
// the fallback observed head when the UI learned the state through a read.
// After a server C-0 / SDT_SERVICE_ID rotate, occupied entries are reconciled
// against /api/read before create/reserve so stale exists:true cannot invent
// reservation_exists / room_exists.
const portableSnapshots = new Map();

function rememberSnapshot(snapshot) {
  if (typeof snapshot?.projectorId !== "string" || typeof snapshot?.tag !== "string") return;
  if (typeof snapshot.head !== "string" && snapshot.head !== null) return;
  if (typeof snapshot.exists !== "boolean" || typeof snapshot.state !== "object" || snapshot.state === null) return;
  portableSnapshots.set(snapshotKey(snapshot.projectorId, snapshot.tag), Object.freeze({ ...snapshot }));
}

function knownSnapshot(projectorId, tag) {
  return portableSnapshots.get(snapshotKey(projectorId, tag));
}

function forgetSnapshot(projectorId, tag) {
  portableSnapshots.delete(snapshotKey(projectorId, tag));
}

function commandSnapshots(commandId, input) {
  return buildCommandSnapshots(commandId, input, knownSnapshot);
}

function executorCommandBody(commandId, input) {
  const executor = commandSnapshots(commandId, input);
  return { input, executor };
}

async function reconcileOccupiedSnapshots(commandId, input) {
  for (const entry of tagsToReconcileForCommand(commandId, input)) {
    const known = knownSnapshot(entry.projectorId, entry.tag);
    if (!snapshotLooksOccupied(known)) continue;
    const read = await readProjection(entry.kind, entry.id);
    const decision = reconcileOccupiedAgainstRead(known, read.status, read.body);
    if (decision.action === "forget") {
      forgetSnapshot(entry.projectorId, entry.tag);
    } else if (decision.action === "refresh" && decision.snapshot !== undefined) {
      rememberSnapshot(decision.snapshot);
    }
  }
}

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
  const events = Array.isArray(body?.writtenEvents) ? body.writtenEvents : response && Array.isArray(response.writtenEvents) ? response.writtenEvents : [];
  const first = events[0];
  return first && typeof first.sortableUniqueIdValue === "string" ? first.sortableUniqueIdValue : undefined;
}

function committedHead(body, tag, fallback) {
  const heads = Array.isArray(body?.heads) ? body.heads : [];
  const match = heads.find((entry) => {
    const entryTag = typeof entry?.tag === "string" ? entry.tag : entry?.tag?.id;
    return entryTag === tag;
  });
  return typeof match?.head === "string" ? match.head : fallback;
}

function rememberCommittedSnapshots(commandId, input, body) {
  if (body?.kind !== "committed") return;
  const suid = commitSortableUniqueId(body);
  const roomId = snapshotInputValue(input, "roomId");
  const reservationId = snapshotInputValue(input, "reservationId");
  if (commandId === "create-room" && roomId !== undefined && suid !== undefined) {
    const tag = `room:${roomId}`;
    rememberSnapshot({
      projectorId: "RoomProjector",
      tag,
      head: committedHead(body, tag, suid),
      exists: true,
      state: { status: "created", version: 1, roomId, name: snapshotInputValue(input, "name") ?? "" },
    });
  }
  if (commandId === "reserve-room" && roomId !== undefined && reservationId !== undefined && suid !== undefined) {
    const roomTag = `room:${roomId}`;
    const reservationTag = `reservation:${reservationId}`;
    const previousRoom = knownSnapshot("RoomProjector", roomTag);
    if (previousRoom !== undefined) {
      rememberSnapshot({ ...previousRoom, head: committedHead(body, roomTag, suid) });
    }
    rememberSnapshot({
      projectorId: "ReservationProjector",
      tag: reservationTag,
      head: committedHead(body, reservationTag, suid),
      exists: true,
      state: { status: "reserved", version: 1, reservationId, roomId },
    });
  }
  if (commandId === "cancel-reservation" && reservationId !== undefined && suid !== undefined) {
    const tag = `reservation:${reservationId}`;
    const previous = knownSnapshot("ReservationProjector", tag);
    if (previous !== undefined) {
      rememberSnapshot({
        ...previous,
        head: committedHead(body, tag, suid),
        state: { ...previous.state, status: "cancelled" },
      });
    }
  }
  if (commandId === "release-room" && roomId !== undefined && suid !== undefined) {
    const tag = `room:${roomId}`;
    const previous = knownSnapshot("RoomProjector", tag);
    if (previous !== undefined) {
      rememberSnapshot({ ...previous, head: committedHead(body, tag, suid), state: { ...previous.state, status: "released" } });
    }
  }
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
  // Drop occupied client memory that disagrees with a fresh server read so a
  // post-C-0 tab cannot send exists:true and invent reservation_exists.
  if (commandId === "create-room" || commandId === "reserve-room") {
    await reconcileOccupiedSnapshots(commandId, input);
  }
  const response = await fetch(`/api/commands/${commandId}`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(executorCommandBody(commandId, input)),
  });
  const body = await responseBody(response);
  const [kind, message] = describeOutcome(response.status, body);
  if (kind !== "committed") {
    if (kind === "conflict" || kind === "partial") {
      await reconcileOccupiedSnapshots(commandId, input);
    }
    setStatus(message, kind === "noop" ? "info" : "error");
    showProjection(body, kind);
    return;
  }
  rememberCommittedSnapshots(commandId, input, body);
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
  const view = reservationListView(response.status, await responseBody(response));
  if (typeof view.readHead === "string" && Array.isArray(view.rows)) {
    for (const row of view.rows) {
      if (typeof row?.reservationId !== "string" || typeof row.roomId !== "string") continue;
      rememberSnapshot({
        projectorId: "ReservationProjector",
        tag: `reservation:${row.reservationId}`,
        head: view.readHead,
        exists: true,
        state: row,
      });
    }
  }
  return view;
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
    if (typeof view.readHead === "string" && view.result && typeof view.result === "object") {
      if (view.result.status === "empty") {
        forgetSnapshot("RoomProjector", `room:${roomId}`);
      } else {
        rememberSnapshot({
          projectorId: "RoomProjector",
          tag: `room:${roomId}`,
          head: view.readHead,
          exists: true,
          state: view.result,
        });
      }
    }
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
