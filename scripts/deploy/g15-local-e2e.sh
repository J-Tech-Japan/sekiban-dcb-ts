#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly PORT="${G15_LOCAL_PORT:-8787}"
readonly BASE_URL="${G15_LOCAL_BASE_URL:-http://127.0.0.1:${PORT}}"
readonly REPORT="${G15_LOCAL_REPORT:-${REPO_ROOT}/.artifacts/g15-local-e2e.json}"
readonly SERVER_LOG="${G15_LOCAL_SERVER_LOG:-${REPO_ROOT}/.artifacts/g15-wrangler.log}"

cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"
test -n "${POSTGRES_URL:-}" || {
  printf 'POSTGRES_URL is required; the local Miniflare E2E must not silently skip PostgreSQL\n' >&2
  exit 2
}
mkdir -p "$(dirname "${REPORT}")"
: > "${SERVER_LOG}"

CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="${POSTGRES_URL}" \
  "${WRANGLER_BIN}" dev --config samples/meeting-room/wrangler.jsonc --local --port "${PORT}" --log-level error \
  > "${SERVER_LOG}" 2>&1 &
readonly SERVER_PID=$!
trap 'kill "${SERVER_PID}" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl --silent --show-error --fail "${BASE_URL}/" >/dev/null 2>&1; then
    exec python3 "${SCRIPT_DIR}/g15-e2e.py" --base-url "${BASE_URL}" --report "${REPORT}"
  fi
  sleep 1
done

printf 'local meeting-room Worker did not become ready; see %s\n' "${SERVER_LOG}" >&2
exit 1
