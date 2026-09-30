#!/usr/bin/env bash
set -euo pipefail

# SDT-G11 deployment entry point. It is intentionally secret-free: Hyperdrive
# owns the database credential and REPAIR_OPERATOR_TOKEN is supplied through
# Wrangler's protected secret store, never through this repository.
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WORKER_NAME="serialized-dcb-v1-runtime"
readonly QUEUE_NAME="serialized-dcb-v1-outbox"
readonly HYPERDRIVE_ID="REPLACE_WITH_SAMPLE_HYPERDRIVE_ID"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"

if [[ ! -x "${WRANGLER_BIN}" ]]; then
  printf 'Wrangler executable not found: %s\n' "${WRANGLER_BIN}" >&2
  exit 1
fi

cd "${REPO_ROOT}"

# The queue is an idempotent prerequisite for the producer/consumer binding.
if ! "${WRANGLER_BIN}" queues list | grep -Fq "${QUEUE_NAME}"; then
  "${WRANGLER_BIN}" queues create "${QUEUE_NAME}"
fi

# Conformance and measurement reads must observe fresh PostgreSQL state.
"${WRANGLER_BIN}" hyperdrive update "${HYPERDRIVE_ID}" --caching-disabled

# Secrets are never passed as arguments. If a protected operator file is
# supplied by the operator, Wrangler reads it from stdin without printing it.
if [[ -n "${G11_OPERATOR_TOKEN_FILE:-}" ]]; then
  test -f "${G11_OPERATOR_TOKEN_FILE}"
  "${WRANGLER_BIN}" secret put REPAIR_OPERATOR_TOKEN --name "${WORKER_NAME}" < "${G11_OPERATOR_TOKEN_FILE}"
fi

"${WRANGLER_BIN}" deploy --keep-vars --strict --message "SDT-G11 deploy verification"
"${WRANGLER_BIN}" hyperdrive get "${HYPERDRIVE_ID}"
"${WRANGLER_BIN}" deployments list --name "${WORKER_NAME}"
