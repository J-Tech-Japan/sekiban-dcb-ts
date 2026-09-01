#!/usr/bin/env python3
"""External SDT-G49 W46 app-layer receipts; the G15/G16 harness is untouched."""

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


SAFE_WINDOW_MS = 120_000


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def request(base_url: str, path: str, method: str = "GET", body: object | None = None) -> tuple[int, Any, float]:
    payload = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {"Accept": "application/json", "User-Agent": "SDT-G49-W46-receipt/1.0"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    started = time.perf_counter()
    req = urllib.request.Request(f"{base_url.rstrip('/')}{path}", data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read()
            status = response.status
            content_type = response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as error:
        raw = error.read()
        status = error.code
        content_type = error.headers.get("Content-Type", "")
    elapsed_ms = (time.perf_counter() - started) * 1000
    decoded: Any
    if "json" in content_type or (raw and raw[:1] in (b"{", b"[")):
        decoded = json.loads(raw.decode("utf-8")) if raw else {}
    else:
        decoded = raw.decode("utf-8")
    return status, decoded, elapsed_ms


def commit_suid(body: dict[str, Any]) -> str:
    response = body.get("response") if isinstance(body.get("response"), dict) else body
    events = response.get("writtenEvents") if isinstance(response, dict) else None
    require(isinstance(events, list) and len(events) > 0, f"commit did not return writtenEvents: {body}")
    first = events[0]
    require(isinstance(first, dict) and isinstance(first.get("sortableUniqueIdValue"), str), f"commit SUID missing: {body}")
    return first["sortableUniqueIdValue"]


def compare_v1_ordinal(left: str, right: str) -> int:
    left_bytes = left.encode("utf-8")
    right_bytes = right.encode("utf-8")
    for left_byte, right_byte in zip(left_bytes, right_bytes):
        if left_byte != right_byte:
            return left_byte - right_byte
    return len(left_bytes) - len(right_bytes)


def read_visible(base_url: str, kind: str, parameter: str, value: str, commit_id: str) -> dict[str, Any]:
    started = time.perf_counter()
    observations: list[dict[str, Any]] = []
    while True:
        elapsed_ms = (time.perf_counter() - started) * 1000
        require(elapsed_ms <= SAFE_WINDOW_MS, f"{kind} visibility timed out after {SAFE_WINDOW_MS}ms: {observations[-3:]}")
        status, body, request_ms = request(
            base_url,
            f"/api/read/{kind}?{parameter}={urllib.parse.quote(value)}",
        )
        require(status == 200 and isinstance(body, dict), f"{kind} read returned HTTP {status}: {body}")
        head = body.get("lastSortedUniqueId")
        require(isinstance(head, str), f"{kind} read omitted lastSortedUniqueId: {body}")
        elapsed_ms = (time.perf_counter() - started) * 1000
        observation = {
            "status": status,
            "head": head,
            "requestMs": round(request_ms, 3),
            "elapsedMs": round(elapsed_ms, 3),
            "state": body.get("state"),
            "visible": compare_v1_ordinal(head, commit_id) >= 0,
        }
        observations.append(observation)
        if observation["visible"]:
            return {"read": body, "readHead": head, "observations": observations}
        time.sleep(min(0.25, max(0.0, (SAFE_WINDOW_MS - elapsed_ms) / 1000)))


def write_report(path: str, report: dict[str, Any]) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def sanity(base_url: str) -> dict[str, Any]:
    room_id = f"g49-w46-sanity-room-{uuid.uuid4().hex[:16]}"
    status, body, request_ms = request(
        base_url,
        "/api/commands/create-room",
        method="POST",
        body={"roomId": room_id, "name": "SDT-G49 W46 sanity"},
    )
    require(status == 200 and isinstance(body, dict) and body.get("kind") == "committed", f"sanity create-room failed HTTP {status}: {body}")
    return {
        "schema": "sdt-g49-pr98-w46-sanity/v1",
        "mode": "sanity-create-room",
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "baseUrl": base_url,
        "roomId": room_id,
        "create": {"status": status, "requestMs": round(request_ms, 3), "suid": commit_suid(body), "response": body},
        "exactlyOneCreateRoomCommand": True,
    }


def trace(base_url: str) -> dict[str, Any]:
    run_id = uuid.uuid4().hex
    room_id = f"g49-w46-trace-room-{run_id[:16]}"
    reservation_id = f"g49-w46-trace-reservation-{run_id[:16]}"
    create_status, create_body, create_ms = request(
        base_url,
        "/api/commands/create-room",
        method="POST",
        body={"roomId": room_id, "name": "SDT-G49 W46 trace"},
    )
    require(create_status == 200 and isinstance(create_body, dict) and create_body.get("kind") == "committed", f"trace create-room failed HTTP {create_status}: {create_body}")
    create_suid = commit_suid(create_body)
    room = read_visible(base_url, "room", "roomId", room_id, create_suid)
    require(isinstance(room["read"].get("state"), dict) and room["read"]["state"].get("status") == "created", f"trace room was not created: {room}")

    reserve_status, reserve_body, reserve_ms = request(
        base_url,
        "/api/commands/reserve-room",
        method="POST",
        body={"roomId": room_id, "reservationId": reservation_id, "userId": "g49-w46"},
    )
    require(reserve_status == 200 and isinstance(reserve_body, dict) and reserve_body.get("kind") == "committed", f"trace reserve-room failed HTTP {reserve_status}: {reserve_body}")
    reserve_suid = commit_suid(reserve_body)
    reservation = read_visible(base_url, "reservation", "reservationId", reservation_id, reserve_suid)
    require(isinstance(reservation["read"].get("state"), dict) and reservation["read"]["state"].get("status") == "reserved", f"trace reservation was not reserved: {reservation}")
    return {
        "schema": "sdt-g49-pr98-w46-ac5-trace/v1",
        "mode": "external-app-layer-trace",
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "baseUrl": base_url,
        "runId": run_id,
        "room": {
            "roomId": room_id,
            "create": {"status": create_status, "requestMs": round(create_ms, 3), "suid": create_suid, "response": create_body},
            "readState": room["read"].get("state"),
            "readHead": room["readHead"],
            "readResponse": room["read"],
            "observations": room["observations"],
        },
        "reservation": {
            "reservationId": reservation_id,
            "reserve": {"status": reserve_status, "requestMs": round(reserve_ms, 3), "suid": reserve_suid, "response": reserve_body},
            "readState": reservation["read"].get("state"),
            "readHead": reservation["readHead"],
            "readResponse": reservation["read"],
            "observations": reservation["observations"],
        },
        "harnessModified": False,
        "safeWindowBoundMs": SAFE_WINDOW_MS,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("sanity", "trace"), required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    report = sanity(args.base_url) if args.mode == "sanity" else trace(args.base_url)
    write_report(args.report, report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
