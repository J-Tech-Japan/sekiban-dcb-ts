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

# Migrations are versioned and applied before the Worker is deployed. The
# runtime never executes DDL and the two bindings remain separate databases.
"${WRANGLER_BIN}" d1 migrations apply sekiban-dcb-meeting-room-cloudflare-pipeline --config "${CONFIG}" --remote
"${WRANGLER_BIN}" d1 migrations apply sekiban-dcb-meeting-room-cloudflare-mv --config "${CONFIG}" --remote

# A conformance token is read from protected operator storage only. Its value
# is piped to Wrangler and never appears in command arguments or artifacts.
if [[ -n "${G20_CONFORMANCE_TOKEN_FILE:-}" ]]; then
  test -f "${G20_CONFORMANCE_TOKEN_FILE}"
  "${WRANGLER_BIN}" secret put CONFORMANCE_TOKEN --name "${WORKER_NAME}" < "${G20_CONFORMANCE_TOKEN_FILE}"
fi

"${WRANGLER_BIN}" deploy --config "${CONFIG}" --keep-vars --strict \
  --var "SDT_SERVICE_ID:${SERVICE_ID}" --message "SDT-G20 Cloudflare-only candidate"
"${WRANGLER_BIN}" deployments list --name "${WORKER_NAME}"
