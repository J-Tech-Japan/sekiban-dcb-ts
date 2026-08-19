#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly BASE_URL="${G20_BASE_URL:-}"
readonly SERVICE_ID="${G20_SERVICE_ID:-}"
readonly REPORT="${G20_E2E_REPORT:-${REPO_ROOT}/.artifacts/g20-query-e2e.json}"
cd "${REPO_ROOT}"
test -n "${BASE_URL}" || { printf 'G20_BASE_URL is required\n' >&2; exit 2; }
test -n "${SERVICE_ID}" || { printf 'G20_SERVICE_ID is required\n' >&2; exit 2; }
G15_EXPECTED_SERVICE_ID="${SERVICE_ID}" python3 "${SCRIPT_DIR}/g15-e2e.py" \
  --base-url "${BASE_URL}" --report "${REPORT}" --include-query-views
