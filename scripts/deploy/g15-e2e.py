#!/usr/bin/env python3
"""SDT-G15 app-layer E2E harness.

The same command runs against a local Miniflare/Workers dev URL and a deployed
workers.dev URL. It never sends a raw V1 request with credentials: browser-like
commands and reads use only the sample app API, while the raw-path probes verify
the G14 404 boundary. ``harnessGraceMs`` is measurement metadata only; it never
extends the UI's 120,000ms visibility decision.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


UI_SAFE_WINDOW_BOUND_MS = 120_000


def compare_v1_ordinal(left: str, right: str) -> int:
    left_bytes = left.encode("utf-8")
    right_bytes = right.encode("utf-8")
    for left_byte, right_byte in zip(left_bytes, right_bytes):
        if left_byte != right_byte:
            return left_byte - right_byte
    return len(left_bytes) - len(right_bytes)


def request(base_url: str, path: str, method: str = "GET", body: object | None = None) -> tuple[int, Any, float]:
    payload = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {"Accept": "application/json", "User-Agent": "SDT-G15-E2E/1.0"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{base_url.rstrip('/')}{path}", data=payload, headers=headers, method=method)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read()
        status = error.code
    elapsed_ms = (time.perf_counter() - started) * 1000
    content_type = response.headers.get("Content-Type", "") if "response" in locals() else ""
    if "json" in content_type or (raw and raw[:1] in (b"{", b"[")):
        decoded = json.loads(raw.decode("utf-8")) if raw else {}
    else:
        decoded = raw.decode("utf-8")
    return status, decoded, elapsed_ms


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def commit_suid(body: dict[str, Any]) -> str:
    response = body.get("response") if isinstance(body.get("response"), dict) else body
    events = response.get("writtenEvents") if isinstance(response, dict) else None
    require(isinstance(events, list) and events, f"commit did not return writtenEvents: {body}")
    first = events[0]
    require(isinstance(first, dict) and isinstance(first.get("sortableUniqueIdValue"), str), f"commit SUID missing: {body}")
    return first["sortableUniqueIdValue"]


def read_until_visible(base_url: str, room_id: str, commit_id: str) -> tuple[dict[str, Any], float]:
    started = time.perf_counter()
    deadline = started + UI_SAFE_WINDOW_BOUND_MS / 1000
    observations: list[dict[str, Any]] = []
    while time.perf_counter() < deadline:
        status, body, elapsed_ms = request(
            base_url,
            f"/api/read/room?roomId={urllib.parse.quote(room_id)}",
            method="GET",
        )
        require(status == 200 and isinstance(body, dict), f"room read returned HTTP {status}: {body}")
        head = body.get("lastSortedUniqueId")
        require(isinstance(head, str), f"room read omitted lastSortedUniqueId: {body}")
        observations.append({"head": head, "requestMs": round(elapsed_ms, 3)})
        if compare_v1_ordinal(head, commit_id) >= 0:
            return {
                "status": status,
                "head": head,
                "state": body.get("state"),
                "observations": observations,
            }, (time.perf_counter() - started) * 1000
        # This is only a bounded event-loop yield. It is not the semantic
        # threshold and cannot clear pending; the ordinal comparison decides.
        remaining = max(0.0, deadline - time.perf_counter())
        time.sleep(min(0.25, remaining))
    raise RuntimeError(f"projection did not become visible within {UI_SAFE_WINDOW_BOUND_MS}ms: {observations[-3:]}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--harness-grace-ms", type=int, default=5_000)
    args = parser.parse_args()
    require(args.harness_grace_ms >= 0, "harnessGraceMs must be non-negative")

    run_id = uuid.uuid4().hex
    room_id = f"g15-room-{run_id[:16]}"
    reservation_id = f"g15-reservation-{run_id[:16]}"
    measurements: dict[str, Any] = {}

    # This is the browser visibility oracle exercised with deterministic facts;
    # the live loop below uses the same ordinal relation and deadline.
    require(compare_v1_ordinal("suid-01", "suid-02") < 0, "ordinal pending fixture malformed")
    require(compare_v1_ordinal("suid-02", "suid-02") >= 0, "ordinal equal fixture malformed")
    require(compare_v1_ordinal("suid-03", "suid-02") >= 0, "ordinal visible fixture malformed")
    measurements["visibilityOracle"] = {
        "headBelowCommit": "pending",
        "headEqualOrAboveCommit": "visible",
        "timeoutAtMs": UI_SAFE_WINDOW_BOUND_MS,
    }

    status, html, _ = request(args.base_url, "/", method="GET")
    require(status == 200 and isinstance(html, str), f"frontend root returned HTTP {status}")
    require("/app.js" in html and "<form" in html, "frontend root is not the static meeting-room UI")

    raw_checks: dict[str, int] = {}
    for endpoint in ("commit", "tag-latest-sortable", "tag-state", "query", "list-query"):
        raw_status, _, _ = request(
            args.base_url,
            f"/api/sekiban/serialized/{endpoint}",
            method="POST",
            body={"version": 1, "eventCandidates": [], "consistencyTags": []} if endpoint == "commit" else {},
        )
        require(raw_status in (403, 404), f"raw V1 {endpoint} was reachable with HTTP {raw_status}")
        raw_checks[endpoint] = raw_status

    create_status, create_body, create_ms = request(
        args.base_url,
        "/api/commands/create-room",
        method="POST",
        body={"roomId": room_id, "name": "SDT-G15"},
    )
    require(create_status == 200 and isinstance(create_body, dict) and create_body.get("kind") == "committed", f"create-room failed HTTP {create_status}: {create_body}")
    create_suid = commit_suid(create_body)
    created_read, created_visible_ms = read_until_visible(args.base_url, room_id, create_suid)
    require(isinstance(created_read.get("state"), dict) and created_read["state"].get("status") == "created", f"room projection did not update: {created_read}")

    reserve_status, reserve_body, reserve_ms = request(
        args.base_url,
        "/api/commands/reserve-room",
        method="POST",
        body={"roomId": room_id, "reservationId": reservation_id, "userId": "g15"},
    )
    require(reserve_status == 200 and isinstance(reserve_body, dict) and reserve_body.get("kind") == "committed", f"reserve-room failed HTTP {reserve_status}: {reserve_body}")
    reserve_suid = commit_suid(reserve_body)
    reserve_read_started = time.perf_counter()
    reserve_deadline = reserve_read_started + UI_SAFE_WINDOW_BOUND_MS / 1000
    reservation_read: dict[str, Any] | None = None
    while time.perf_counter() < reserve_deadline:
        read_status, read_body, _ = request(
            args.base_url,
            f"/api/read/reservation?reservationId={urllib.parse.quote(reservation_id)}",
            method="GET",
        )
        require(read_status == 200 and isinstance(read_body, dict), f"reservation read failed HTTP {read_status}: {read_body}")
        head = read_body.get("lastSortedUniqueId")
        require(isinstance(head, str), f"reservation read omitted head: {read_body}")
        if compare_v1_ordinal(head, reserve_suid) >= 0:
            reservation_read = read_body
            break
        time.sleep(min(0.25, max(0.0, reserve_deadline - time.perf_counter())))
    require(reservation_read is not None, f"reservation projection did not become visible within {UI_SAFE_WINDOW_BOUND_MS}ms")
    require(isinstance(reservation_read.get("state"), dict) and reservation_read["state"].get("status") == "reserved", f"reservation projection did not update: {reservation_read}")

    cancel_status, cancel_body, cancel_ms = request(
        args.base_url,
        "/api/commands/cancel-reservation",
        method="POST",
        body={"reservationId": reservation_id},
    )
    require(cancel_status == 200 and isinstance(cancel_body, dict) and cancel_body.get("kind") == "committed", f"cancel-reservation failed HTTP {cancel_status}: {cancel_body}")
    cancel_suid = commit_suid(cancel_body)

    rejected_status, rejected_body, _ = request(
        args.base_url,
        "/api/commands/create-room",
        method="POST",
        body={"name": "invalid"},
    )
    require(rejected_status == 400 and isinstance(rejected_body, dict) and rejected_body.get("kind") == "invalid" and rejected_body.get("code") == "invalid_command_input", f"rejection was not distinct: {rejected_status} {rejected_body}")

    report = {
        "probe": "SDT-G15",
        "baseUrl": args.base_url,
        "runId": run_id,
        "roomId": room_id,
        "reservationId": reservation_id,
        "uiSafeWindowBoundMs": UI_SAFE_WINDOW_BOUND_MS,
        "harnessGraceMs": args.harness_grace_ms,
        "harnessGraceSemanticRole": "measurement-only; never widens UI visibility threshold",
        "visibilityOracle": measurements["visibilityOracle"],
        "rawV1Unauthenticated": raw_checks,
        "commands": {
            "create": {"status": create_status, "requestMs": round(create_ms, 3), "suid": create_suid},
            "reserve": {"status": reserve_status, "requestMs": round(reserve_ms, 3), "suid": reserve_suid},
            "cancel": {"status": cancel_status, "requestMs": round(cancel_ms, 3), "suid": cancel_suid},
            "rejected": {"status": rejected_status, "kind": rejected_body.get("kind"), "code": rejected_body.get("code")},
        },
        "projection": {
            "createVisible": True,
            "createCommitToVisibleMs": round(created_visible_ms, 3),
            "createObservations": created_read["observations"],
            "reservationVisible": True,
        },
        "freshRunIds": True,
        "secret": "no bearer token or credential used by app-layer E2E",
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
