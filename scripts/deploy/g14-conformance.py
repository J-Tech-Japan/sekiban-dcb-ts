#!/usr/bin/env python3
"""Authenticated G14 sample conformance lane.

The bearer token is read only from a protected operator file and is never
written to the report. Every run uses a fresh service-scoped ID and disables
no checks when the deployment or auth lane is missing.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


def request(base: str, path: str, body: object | None, token: str | None, service_id: str, method: str = "POST") -> tuple[int, dict[str, object]]:
    headers = {"Accept": "application/json", "User-Agent": "SDT-G14-Conformance/1.0", "x-sdt-g11-service-id": service_id}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    payload = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    if payload is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{base.rstrip('/')}{path}", data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read()
        status = error.code
    decoded = json.loads(raw.decode("utf-8")) if raw else {}
    if not isinstance(decoded, dict):
        raise RuntimeError(f"{path} returned non-object JSON")
    return status, decoded


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--phase", choices=("before-restart", "after-restart"), required=True)
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--service-id", help="Run the authenticated V1 five-endpoint lane against an existing service; skips app-command namespace assertions.")
    parser.add_argument("--app-service-id", default=os.environ.get("G14_APP_SERVICE_ID", ""))
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}", args.app_service_id):
        raise SystemExit("G14_APP_SERVICE_ID must be a non-empty deployment service identity")
    token = Path(args.token_file).read_text(encoding="utf-8").strip()
    if not token:
        raise SystemExit("conformance token file is empty")
    state_path = Path(args.state_file)
    if args.service_id is not None:
        service_id = args.service_id
        room_id = f"g22-room-{uuid.uuid4().hex[:12]}"
    elif args.phase == "before-restart":
        service_id = f"g11-g14-{uuid.uuid4().hex[:16]}"
        room_id = f"room-{uuid.uuid4().hex[:12]}"
    else:
        previous = json.loads(state_path.read_text(encoding="utf-8"))
        service_id = previous["serviceId"]
        room_id = previous["roomId"]
    tag = f"room:{room_id}"
    state_id = f"{tag}:RoomProjector"
    lane = "/conformance/v1"
    payload = {"eventType": "RoomCreated", "roomId": room_id, "name": "G14"}
    encoded = base64.b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("ascii")
    checks: dict[str, object] = {}

    for endpoint in ("commit", "tag-latest-sortable", "tag-state", "query", "list-query"):
        bare_path = f"/api/sekiban/serialized/{endpoint}"
        status, _ = request(args.base_url, bare_path, {} if endpoint != "commit" else {"version": 1, "eventCandidates": [], "consistencyTags": []}, None, service_id)
        if status not in (403, 404):
            raise RuntimeError(f"unauthenticated raw {endpoint} returned HTTP {status}")
        checks[f"unauthenticated_{endpoint}"] = status

    # The app command API is intentionally public, but a client cannot use it
    # to select a g11-* namespace. The command uses the server-side
    # SDT_SERVICE_ID deployment var while an authenticated conformance read
    # using the attacker namespace remains empty.
    if args.service_id is None:
        attacker_service_id = f"g11-g14-unauth-{uuid.uuid4().hex[:16]}"
        attacker_room_id = f"unauth-room-{uuid.uuid4().hex[:12]}"
        attacker_tag = f"room:{attacker_room_id}"
        command_status, command_body = request(args.base_url, "/api/commands/create-room", {
            "roomId": attacker_room_id, "name": "unauthenticated-header-probe",
        }, None, attacker_service_id)
        if command_status != 200 or command_body.get("kind") != "committed":
            raise RuntimeError(f"unauthenticated command probe failed HTTP {command_status}: {command_body}")
        attacker_latest_status, attacker_latest = request(args.base_url, f"{lane}/api/sekiban/serialized/tag-latest-sortable", {"tag": attacker_tag}, token, attacker_service_id)
        app_latest_status, app_latest = request(args.base_url, f"{lane}/api/sekiban/serialized/tag-latest-sortable", {"tag": attacker_tag}, token, args.app_service_id)
        if attacker_latest_status != 200 or attacker_latest.get("exists") is not False or attacker_latest.get("lastSortableUniqueId") != "":
            raise RuntimeError(f"unauthenticated command selected attacker namespace: {attacker_latest}")
        if app_latest_status != 200 or app_latest.get("exists") is not True or app_latest.get("lastSortableUniqueId") == "":
            raise RuntimeError(f"unauthenticated command did not use configured app namespace: {app_latest}")
        checks["unauthenticatedCommandG11"] = {"command": command_status, "attackerServiceId": attacker_service_id, "attackerRoomId": attacker_room_id, "attackerNamespaceLatest": attacker_latest_status, "attackerNamespaceExists": attacker_latest.get("exists"), "configuredAppServiceId": args.app_service_id, "configuredAppNamespaceLatest": app_latest_status, "configuredAppNamespaceExists": app_latest.get("exists")}

    commit_status, commit_body = request(args.base_url, f"{lane}/api/sekiban/serialized/commit", {
        "version": 1,
        "eventCandidates": [{"payload": encoded, "eventPayloadName": "RoomCreated", "tags": [tag]}],
        "consistencyTags": [],
    }, token, service_id)
    if commit_status != 200 or not commit_body.get("writtenEvents"):
        raise RuntimeError(f"commit failed HTTP {commit_status}: {commit_body}")
    suid = commit_body["writtenEvents"][0]["sortableUniqueIdValue"]
    checks["commit"] = {"status": commit_status, "written": 1}

    latest_status, latest = request(args.base_url, f"{lane}/api/sekiban/serialized/tag-latest-sortable", {"tag": tag}, token, service_id)
    if latest_status != 200 or latest.get("lastSortableUniqueId") != suid:
        raise RuntimeError(f"latest-sortable failed HTTP {latest_status}: {latest}")
    checks["tagLatestSortable"] = latest_status
    state_status, state = request(args.base_url, f"{lane}/api/sekiban/serialized/tag-state", {"tagStateId": state_id}, token, service_id)
    if state_status != 200 or state.get("lastSortedUniqueId") != suid:
        raise RuntimeError(f"tag-state failed HTTP {state_status}: {state}")
    checks["tagState"] = {"status": state_status, "keys": sorted(state.keys())}

    poll_path = f"{lane}/internal/projection/lag?tagStateId={urllib.parse.quote(state_id)}&serviceId={urllib.parse.quote(service_id)}&poll=1"
    # Queue arrival can occur after the commit response. Require the published
    # 20s SafeWindow from that durable arrival, not merely from the HTTP write.
    deadline = time.monotonic() + 55
    poll_status = 0
    poll_body: dict[str, object] = {}
    while True:
        time.sleep(5)
        poll_status, poll_body = request(args.base_url, poll_path, None, token, service_id, method="GET")
        if poll_status != 200:
            raise RuntimeError(f"projection poll failed HTTP {poll_status}: {poll_body}")
        if poll_body.get("checkpointSuid") == suid:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError(f"projection did not observe committed SUID: {poll_body}")
    query_status, query = request(args.base_url, f"{lane}/api/sekiban/serialized/query", {"queryType": "GetRoomStateQuery", "queryParamsJson": "{}", "waitForSortableUniqueId": suid}, token, service_id)
    if query_status != 200:
        raise RuntimeError(f"query failed HTTP {query_status}: {query}")
    checks["query"] = query_status
    # Reservation has no event in this minimal fixture, so the valid empty
    # list result intentionally omits the scalar room's wait token.
    list_status, listing = request(args.base_url, f"{lane}/api/sekiban/serialized/list-query", {"queryType": "GetReservationListQuery", "queryParamsJson": "{\"PageNumber\":1,\"PageSize\":20}"}, token, service_id)
    if list_status != 200:
        raise RuntimeError(f"list-query failed HTTP {list_status}: {listing}")
    checks["listQuery"] = list_status
    report = {
        "probe": "SDT-G14",
        "phase": args.phase,
        "serviceId": service_id,
        "configuredAppServiceId": args.app_service_id,
        "roomId": room_id,
        "checks": checks,
        "freshServiceId": True,
        "hyperdriveCaching": "disabled by deployment prerequisite",
        "secret": "bearer token read from protected file; value omitted",
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"serviceId": service_id, "roomId": room_id, "suid": suid}, indent=2) + "\n", encoding="utf-8")
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
