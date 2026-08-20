#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly DEPLOY_SERVICE_ID="${G15_SERVICE_ID:-}"
readonly HYPERDRIVE_ID="c236b7b51ed24bf4b312bc370c61a231"

cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"

# Catch-up-sensitive reads must not be served from Hyperdrive's query cache.
"${WRANGLER_BIN}" hyperdrive update "${HYPERDRIVE_ID}" --caching-disabled

# Existing Wrangler secrets (including the conformance bearer) are retained;
# no secret value is passed as an argument or written to repository artifacts.
deploy_args=(deploy --config samples/meeting-room/wrangler.jsonc --keep-vars --strict --message "SDT-G15 meeting-room frontend")
if [[ ! "${DEPLOY_SERVICE_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]]; then
  printf 'G15_SERVICE_ID must be a non-empty deployment service identity\n' >&2
  exit 2
fi
deploy_args+=(--var "SDT_SERVICE_ID:${DEPLOY_SERVICE_ID}")
"${WRANGLER_BIN}" "${deploy_args[@]}"
"${WRANGLER_BIN}" deployments list --name sekiban-dcb-meeting-room
