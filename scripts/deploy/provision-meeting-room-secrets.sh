#!/usr/bin/env bash
# Put meeting-room Worker secrets from protected files. Values stay on stdin.
set +x
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  printf 'usage: provision-meeting-room-secrets.sh <wrangler> <worker> <repair-token-file> [conformance-token-file]\n' >&2
  exit 2
fi

WRANGLER_BIN="$1"
WORKER_NAME="$2"
REPAIR_FILE="$3"
CONFORMANCE_FILE="${4:-}"

require_secret_file() {
  local label="$1"
  local path="$2"
  if [[ ! -f "${path}" || ! -r "${path}" ]]; then
    printf '%s file must be a readable regular file\n' "${label}" >&2
    exit 2
  fi
  if ! grep -q '[^[:space:]]' "${path}"; then
    printf '%s file must contain a non-whitespace character\n' "${label}" >&2
    exit 2
  fi
}

require_secret_file "REPAIR_OPERATOR_TOKEN" "${REPAIR_FILE}"
"${WRANGLER_BIN}" secret put REPAIR_OPERATOR_TOKEN --name "${WORKER_NAME}" < "${REPAIR_FILE}"

if [[ -n "${CONFORMANCE_FILE}" ]]; then
  require_secret_file "CONFORMANCE_TOKEN" "${CONFORMANCE_FILE}"
  "${WRANGLER_BIN}" secret put CONFORMANCE_TOKEN --name "${WORKER_NAME}" < "${CONFORMANCE_FILE}"
fi
