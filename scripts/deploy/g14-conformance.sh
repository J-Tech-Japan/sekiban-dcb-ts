#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  printf 'usage: %s BASE_URL before-restart|after-restart STATE_FILE [REPORT]\n' "$0" >&2
  exit 2
fi

readonly BASE_URL="$1"
readonly PHASE="$2"
readonly STATE_FILE="$3"
readonly REPORT="${4:-${STATE_FILE%.json}-${PHASE}.json}"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TOKEN_FILE="${G14_CONFORMANCE_TOKEN_FILE:-}"
if [[ -z "${TOKEN_FILE}" || ! -f "${TOKEN_FILE}" ]]; then
  printf 'G14_CONFORMANCE_TOKEN_FILE must point to a protected bearer-token file\n' >&2
  exit 1
fi

python3 "${SCRIPT_DIR}/g14-conformance.py" --base-url "${BASE_URL}" --phase "${PHASE}" \
  --state-file "${STATE_FILE}" --report "${REPORT}" --token-file "${TOKEN_FILE}" \
  --app-service-id "${G14_APP_SERVICE_ID:-serialized-dcb-v1}"
