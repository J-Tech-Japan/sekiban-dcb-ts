#!/usr/bin/env python3
"""HTTP-only SDT-G11 probe; emits redacted measurement JSON.

The probe never accepts or prints a database credential. It records request
latency, the observed tag-state payload size, and convergence to the durable
tag-state head. Cloudflare dashboard/GraphQL metrics are recorded separately
in the report when available.
"""

from __future__ import annotations

import argparse
import base64
import json
import statistics
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def post(base_url: str, path: str, body: dict[str, object], service_id: str) -> tuple[int, dict[str, object], float]:
    payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=payload,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "x-sdt-g11-service-id": service_id,
            "User-Agent": "Mozilla/5.0 (compatible; SDT-G11-Measure/1.0)",
        },
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            status = response.status
            data = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        data = error.read()
    elapsed_ms = (time.perf_counter() - started) * 1000
    decoded = json.loads(data.decode("utf-8")) if data else {}
    if not isinstance(decoded, dict):
        raise RuntimeError(f"{path} returned a non-object JSON body")
    return status, decoded, elapsed_ms


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--tags", type=int, default=8)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.tags < 1:
        raise SystemExit("--tags must be positive")

    service_id = f"g11-measure-{uuid.uuid4().hex[:16]}"
    probe_id = f"g11-{uuid.uuid4()}"
    commit_latencies: list[float] = []
    convergence_latencies: list[float] = []
    tag_payload_bytes: list[int] = []
    events: list[dict[str, object]] = []

    for index in range(args.tags):
        token = f"{probe_id}-{index}"
        tag = f"weather:{token}"
        payload = {
            "forecastId": token,
            "location": "Tokyo",
            "temperatureC": 21,
            "summary": "SDT-G11",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        encoded = base64.b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("ascii")
        status, response, commit_ms = post(
            args.base_url,
            "/api/sekiban/serialized/commit",
            {
                "version": 1,
                "eventCandidates": [{
                    "payload": encoded,
                    "eventPayloadName": "WeatherForecastCreated",
                    "tags": [tag],
                }],
                "consistencyTags": [],
            },
            service_id,
        )
        if status != 200 or not response.get("writtenEvents"):
            raise RuntimeError(f"commit probe failed with HTTP {status}: {response}")
        suid = response["writtenEvents"][0]["sortableUniqueIdValue"]
        commit_latencies.append(commit_ms)

        deadline = time.perf_counter() + 120
        observed_ms = None
        state_body: dict[str, object] = {}
        while time.perf_counter() < deadline:
            state_status, state_body, _ = post(
                args.base_url,
                "/api/sekiban/serialized/tag-state",
                {"tagStateId": f"weather:{token}:WeatherForecastProjector"},
                service_id,
            )
            if state_status == 200 and state_body.get("lastSortedUniqueId") == suid:
                observed_ms = (120 - max(0, deadline - time.perf_counter())) * 1000
                break
            time.sleep(0.25)
        if observed_ms is None:
            raise RuntimeError(f"tag-state did not converge to {suid}")
        convergence_latencies.append(observed_ms)
        tag_payload_bytes.append(len(json.dumps(state_body, separators=(",", ":")).encode("utf-8")))
        events.append({"tag": tag, "suid": suid, "statePayloadBytes": tag_payload_bytes[-1]})

    def summary(values: list[float]) -> dict[str, float]:
        ordered = sorted(values)
        return {
            "count": len(values),
            "minMs": min(values),
            "p50Ms": statistics.median(values),
            "p95Ms": ordered[max(0, int(len(values) * 0.95) - 1)],
            "maxMs": max(values),
        }

    report = {
        "probe": "SDT-G11",
        "serviceId": service_id,
        "tagCount": args.tags,
        "safeWindowFloorMs": 20_000,
        "safeWindowCeilingMs": 120_000,
        "adapterWriteLatencyProxy": {
            "definition": "commit HTTP latency through the deployed adapter path; no database credential is observed",
            **summary(commit_latencies),
        },
        "tagStateConvergenceLatency": summary(convergence_latencies),
        "tagStateSerializedPayloadBytes": {
            "definition": "durable tag-state response payload lower bound; Cloudflare DO storage bytes are supplied by dashboard/GraphQL metrics",
            "count": len(tag_payload_bytes),
            "min": min(tag_payload_bytes),
            "p50": statistics.median(tag_payload_bytes),
            "max": max(tag_payload_bytes),
        },
        "events": events,
    }
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
