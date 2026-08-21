#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly PRIMARY_CONFIG="samples/meeting-room/wrangler.direct-doorbell.jsonc"
readonly RECEIVER_CONFIG="samples/meeting-room/wrangler.doorbell.jsonc"
readonly VIEW_COUNT="${G26_VIEW_COUNT:-}"
readonly SERVICE_ID="${G26_SERVICE_ID:-}"
readonly ALLOWED_VIEWS="${G26_ALLOWED_VIEWS:-}"

cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"

if [[ ! "${VIEW_COUNT}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'G26_VIEW_COUNT must be a positive integer\n' >&2
  exit 2
fi
if [[ ! "${SERVICE_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]]; then
  printf 'G26_SERVICE_ID must be a fresh non-secret deployment identity\n' >&2
  exit 2
fi
if [[ -z "${ALLOWED_VIEWS}" ]]; then
  printf 'G26_ALLOWED_VIEWS must be a non-empty comma-separated view list\n' >&2
  exit 2
fi

# The receiver and primary are deployed as one topology. CLI vars override the
# checked-in defaults without changing the config roots in the candidate tree;
# the authenticated conformance endpoint verifies the effective values before
# any measurement starts.
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --keep-vars --strict \
  --var "SDT_SERVICE_ID:${SERVICE_ID}" \
  --var "G26_VIEW_COUNT:${VIEW_COUNT}" \
  --var "DIRECT_DOORBELL_ALLOWED_VIEWS:${ALLOWED_VIEWS}" \
  --message "SDT-G26 topology receiver ${VIEW_COUNT}-view"

"${WRANGLER_BIN}" deploy --config "${PRIMARY_CONFIG}" --keep-vars --strict \
  --var "SDT_SERVICE_ID:${SERVICE_ID}" \
  --var "G26_VIEW_COUNT:${VIEW_COUNT}" \
  --var "DIRECT_DOORBELL_ALLOWED_VIEWS:${ALLOWED_VIEWS}" \
  --message "SDT-G26 topology primary ${VIEW_COUNT}-view"

"${WRANGLER_BIN}" deployments list --name sekiban-dcb-g26-meeting-room
