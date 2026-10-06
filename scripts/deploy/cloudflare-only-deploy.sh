#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly CONFIG="samples/meeting-room/wrangler.cloudflare-only.jsonc"
readonly SERVICE_ID="${G20_SERVICE_ID:-}"
readonly WORKER_NAME="sekiban-dcb-meeting-room-cloudflare-only"
cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"
if [[ ! "${SERVICE_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]]; then
  printf 'G20_SERVICE_ID must be a fresh non-secret deployment identity\n' >&2
  exit 2
fi

# Migrations and deploy go through the composition helper. This script still
# owns the G20 service-id gate, the conformance secret, and the deploy flags
# the helper does not invent (--strict, --var, --message).
export WRANGLER_BIN
CLI="${REPO_ROOT}/packages/dcb-cloudflare/dist/cli.js"
if [[ ! -f "${CLI}" ]]; then
  npm run build -w @sekiban/dcb-runtime --prefix "${REPO_ROOT}"
  npm run build -w @sekiban/dcb-cloudflare --prefix "${REPO_ROOT}"
fi

if [[ -n "${G20_CONFORMANCE_TOKEN_FILE:-}" ]]; then
  test -f "${G20_CONFORMANCE_TOKEN_FILE}"
  "${WRANGLER_BIN}" secret put CONFORMANCE_TOKEN --name "${WORKER_NAME}" < "${G20_CONFORMANCE_TOKEN_FILE}"
fi

node "${CLI}" deploy --config "${CONFIG}" --keep-vars -- \
  --strict --var "SDT_SERVICE_ID:${SERVICE_ID}" --message "SDT-G20 Cloudflare-only candidate"
"${WRANGLER_BIN}" deployments list --name "${WORKER_NAME}"
