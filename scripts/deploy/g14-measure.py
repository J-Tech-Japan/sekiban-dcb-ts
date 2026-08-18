#!/usr/bin/env python3
"""Redacted read-cost probe for the deployed meeting-room sample."""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--samples", type=int, default=5)
    args = parser.parse_args()
    token = Path(args.token_file).read_text(encoding="utf-8").strip()
    if not token:
        raise SystemExit("measurement token file is empty")
    service_id = f"g11-g14-measure-{uuid.uuid4().hex[:16]}"
    durations: list[float] = []
    for index in range(args.samples):
        room_id = f"measure-{uuid.uuid4().hex[:10]}-{index}"
        request = urllib.request.Request(
            f"{args.base_url.rstrip('/')}/api/commands/create-room",
            data=json.dumps({"roomId": room_id, "name": "measurement"}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "SDT-G14-Measure/1.0", "x-sdt-g11-service-id": service_id},
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                status = response.status
                response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            error.read()
        if status != 200:
            raise RuntimeError(f"sample command returned HTTP {status}")
        durations.append((time.perf_counter() - started) * 1000)
    ordered = sorted(durations)
    report = {
        "probe": "SDT-G14",
        "serviceId": service_id,
        "sampleCount": args.samples,
        "commandPathReadCostProxyMs": {
            "definition": "application command HTTP latency; no Cloudflare billing or storedBytes claim",
            "min": min(durations),
            "p50": statistics.median(durations),
            "p95": ordered[max(0, int(len(ordered) * 0.95) - 1)],
            "max": max(durations),
        },
        "g11BaselineMs": {"min": 1400, "max": 1800, "comparison": "recorded for operator review; no fabricated pass claim"},
        "secret": "bearer token read from protected file; value omitted",
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
