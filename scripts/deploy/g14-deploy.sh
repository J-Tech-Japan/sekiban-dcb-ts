#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly WORKER_NAME="sekiban-dcb-meeting-room"
readonly HYPERDRIVE_ID="c236b7b51ed24bf4b312bc370c61a231"
cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"

# G14 reads are catch-up-sensitive; leave Hyperdrive query caching disabled
# for every deployment and measurement run.
"${WRANGLER_BIN}" hyperdrive update "${HYPERDRIVE_ID}" --caching-disabled

# The conformance token is set only from a protected local file. Its value is
# never an argument, log line, config var, source file, or committed artifact.
if [[ -n "${G14_CONFORMANCE_TOKEN_FILE:-}" ]]; then
  test -f "${G14_CONFORMANCE_TOKEN_FILE}"
  "${WRANGLER_BIN}" secret put CONFORMANCE_TOKEN --name "${WORKER_NAME}" < "${G14_CONFORMANCE_TOKEN_FILE}"
fi

"${WRANGLER_BIN}" deploy --config samples/meeting-room/wrangler.jsonc --keep-vars --strict --message "SDT-G14 meeting-room sample"
"${WRANGLER_BIN}" deployments list --name "${WORKER_NAME}"
