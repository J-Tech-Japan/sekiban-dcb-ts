#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly WORKER_NAME="sekiban-dcb-meeting-room"
readonly HYPERDRIVE_ID="REPLACE_WITH_SAMPLE_HYPERDRIVE_ID"
readonly DEPLOY_SERVICE_ID="${G14_SERVICE_ID:-}"
cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"
if [[ -z "${DEPLOY_SERVICE_ID}" ]]; then
  printf 'G14_SERVICE_ID is required: deploy each environment with a fresh non-secret service identity\n' >&2
  exit 2
fi

# G14 reads are catch-up-sensitive; leave Hyperdrive query caching disabled
# for every deployment and measurement run.
"${WRANGLER_BIN}" hyperdrive update "${HYPERDRIVE_ID}" --caching-disabled

# The conformance token is set only from a protected local file. Its value is
# never an argument, log line, config var, source file, or committed artifact.
if [[ -n "${G14_CONFORMANCE_TOKEN_FILE:-}" ]]; then
  test -f "${G14_CONFORMANCE_TOKEN_FILE}"
  "${WRANGLER_BIN}" secret put CONFORMANCE_TOKEN --name "${WORKER_NAME}" < "${G14_CONFORMANCE_TOKEN_FILE}"
fi

"${WRANGLER_BIN}" deploy --config samples/meeting-room/wrangler.jsonc --keep-vars --strict \
  --var "SDT_SERVICE_ID:${DEPLOY_SERVICE_ID}" --message "SDT-G14 meeting-room sample"
"${WRANGLER_BIN}" deployments list --name "${WORKER_NAME}"
