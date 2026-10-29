#!/usr/bin/env bash
# Deploy the meeting-room sample through the composition helper.
# The Worker name and bindings stay in this sample's wrangler config.
# Bundle-only forms are exactly: --dry-run    and    -- --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONFIG="$ROOT/samples/meeting-room/wrangler.cloudflare-only.jsonc"
CLI="$ROOT/packages/dcb-cloudflare/dist/cli.js"
WRANGLER_BIN="${WRANGLER_BIN:-$ROOT/node_modules/.bin/wrangler}"
WORKER_NAME="sekiban-dcb-meeting-room-cloudflare-only"
DRY_CONFIG="samples/meeting-room/wrangler.cloudflare-only.jsonc"
PROVISION="$ROOT/scripts/deploy/provision-meeting-room-secrets.sh"

if [[ $# -eq 1 && "$1" == "--dry-run" ]] || [[ $# -eq 2 && "$1" == "--" && "$2" == "--dry-run" ]]; then
  "${WRANGLER_BIN}" deploy --config "${DRY_CONFIG}" --dry-run
  exit 0
fi

for arg in "$@"; do
  if [[ "${arg}" == "--dry-run" ]]; then
    printf 'dry-run cannot be combined with other deploy arguments\n' >&2
    exit 2
  fi
done

if [[ ! -f "$CLI" ]]; then
  npm run build -w @sekiban/dcb-runtime --prefix "$ROOT"
  npm run build -w @sekiban/dcb-cloudflare --prefix "$ROOT"
fi

if [[ -z "${REPAIR_OPERATOR_TOKEN_FILE:-}" ]]; then
  printf 'REPAIR_OPERATOR_TOKEN_FILE is required\n' >&2
  exit 2
fi

if [[ -n "${CONFORMANCE_TOKEN_FILE:-}" ]]; then
  "${PROVISION}" "${WRANGLER_BIN}" "${WORKER_NAME}" "${REPAIR_OPERATOR_TOKEN_FILE}" "${CONFORMANCE_TOKEN_FILE}"
else
  "${PROVISION}" "${WRANGLER_BIN}" "${WORKER_NAME}" "${REPAIR_OPERATOR_TOKEN_FILE}"
fi

node "$CLI" deploy --config "$CONFIG" "$@"
