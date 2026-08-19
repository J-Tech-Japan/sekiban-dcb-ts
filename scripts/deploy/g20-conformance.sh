#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly BASE_URL="${G20_BASE_URL:-}"
readonly SERVICE_ID="${G20_SERVICE_ID:-}"
readonly TOKEN_FILE="${G20_CONFORMANCE_TOKEN_FILE:-}"
readonly PHASE="${G20_PHASE:-before-restart}"
readonly STATE_FILE="${G20_STATE_FILE:-${REPO_ROOT}/.artifacts/g20-conformance-state.json}"
readonly REPORT="${G20_REPORT:-${REPO_ROOT}/.artifacts/g20-conformance-${PHASE}.json}"
cd "${REPO_ROOT}"
test -n "${BASE_URL}" || { printf 'G20_BASE_URL is required\n' >&2; exit 2; }
test -n "${SERVICE_ID}" || { printf 'G20_SERVICE_ID is required\n' >&2; exit 2; }
test -f "${TOKEN_FILE}" || { printf 'G20_CONFORMANCE_TOKEN_FILE is required\n' >&2; exit 2; }
G14_APP_SERVICE_ID="${SERVICE_ID}" python3 "${SCRIPT_DIR}/g14-conformance.py" \
  --base-url "${BASE_URL}" --phase "${PHASE}" --state-file "${STATE_FILE}" \
  --report "${REPORT}" --token-file "${TOKEN_FILE}" --app-service-id "${SERVICE_ID}"
