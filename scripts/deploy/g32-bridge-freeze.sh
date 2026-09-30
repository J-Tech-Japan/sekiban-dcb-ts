#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly PRIMARY_CONFIG="samples/meeting-room/wrangler.g32-bridge-primary.jsonc"
readonly RECEIVER_CONFIG="samples/meeting-room/wrangler.g32-bridge-receiver.jsonc"
readonly SOURCE_COMMIT="${G32_BRIDGE_SOURCE_COMMIT:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}"
readonly OLD_SERVICE_ID="${G32_OLD_SERVICE_ID:-g25-38219c8-20260820f}"
readonly PRIMARY_BASE_URL="${G32_PRIMARY_BASE_URL:-https://example.workers.dev}"
readonly RECEIVER_BASE_URL="${G32_RECEIVER_BASE_URL:-https://example.workers.dev}"
readonly WITNESS_FILE="${REPO_ROOT}/.artifacts/g32-bridge-witness.json"

cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"
if [[ "$(git rev-parse HEAD)" != "${SOURCE_COMMIT}" ]]; then
  printf 'G32_BRIDGE_SOURCE_COMMIT must equal the sealed bridge candidate\n' >&2
  exit 2
fi
if [[ ! "${SOURCE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'G32 bridge source commit must be a full SHA\n' >&2
  exit 2
fi
if [[ ! "${OLD_SERVICE_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]]; then
  printf 'G32 old service id is invalid\n' >&2
  exit 2
fi

mkdir -p .artifacts
BRIDGE_DIGEST="$(git ls-tree -r --name-only "${SOURCE_COMMIT}" -- \
  samples/meeting-room/src/worker.g32-bridge.ts \
  samples/meeting-room/src/g32-bridge.ts \
  samples/meeting-room/wrangler.g32-bridge-primary.jsonc \
  samples/meeting-room/wrangler.g32-bridge-receiver.jsonc \
  contracts/g32-bridge-writer-coverage.json | LC_ALL=C sort | while IFS= read -r path; do printf '%s\0' "$path"; git show "${SOURCE_COMMIT}:${path}"; printf '\0'; done | shasum -a 256 | awk '{print $1}')"
if [[ ! "${BRIDGE_DIGEST}" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'G32 bridge config digest could not be calculated\n' >&2
  exit 2
fi

TOKEN_FILE="${G32_FREEZE_TOKEN_FILE:-$(mktemp "${TMPDIR:-/tmp}/sdt-g32-freeze.XXXXXX")}"
if [[ -z "${G32_FREEZE_TOKEN_FILE:-}" ]]; then
  chmod 600 "${TOKEN_FILE}"
  openssl rand -base64 48 | tr -d '\n' > "${TOKEN_FILE}"
fi
test -f "${TOKEN_FILE}"
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g32-bridge-secrets.XXXXXX")"
chmod 600 "${SECRETS_FILE}"
trap 'rm -f "${TOKEN_FILE}" "${SECRETS_FILE}"' EXIT
TOKEN_FINGERPRINT="$(node -e 'const {createHash}=require("crypto");const fs=require("fs");const token=fs.readFileSync(process.argv[1],"utf8").trim();if(!token)throw new Error("empty freeze token");process.stdout.write(createHash("sha256").update(token,"utf8").digest("hex"));' "${TOKEN_FILE}")"
node -e 'const fs=require("fs");const token=fs.readFileSync(process.argv[1],"utf8").trim();if(!token)throw new Error("empty freeze token");fs.writeFileSync(process.argv[2],JSON.stringify({G32_FREEZE_TOKEN:token})+"\n",{mode:0o600});' "${TOKEN_FILE}" "${SECRETS_FILE}"

COMMON_ARGS=(--keep-vars --strict --secrets-file "${SECRETS_FILE}" --var "SDT_SERVICE_ID:${OLD_SERVICE_ID}" --var "G32_BRIDGE_SOURCE_COMMIT:${SOURCE_COMMIT}" --var "G32_BRIDGE_CONFIG_DIGEST:${BRIDGE_DIGEST}" --var "G32_FREEZE_TOKEN_FINGERPRINT:${TOKEN_FINGERPRINT}")
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --dry-run --strict --var "SDT_SERVICE_ID:${OLD_SERVICE_ID}" --var "G32_BRIDGE_SOURCE_COMMIT:${SOURCE_COMMIT}" --var "G32_BRIDGE_CONFIG_DIGEST:${BRIDGE_DIGEST}" --var "G32_FREEZE_TOKEN_FINGERPRINT:${TOKEN_FINGERPRINT}"
"${WRANGLER_BIN}" deploy --config "${PRIMARY_CONFIG}" --dry-run --strict --var "SDT_SERVICE_ID:${OLD_SERVICE_ID}" --var "G32_BRIDGE_SOURCE_COMMIT:${SOURCE_COMMIT}" --var "G32_BRIDGE_CONFIG_DIGEST:${BRIDGE_DIGEST}" --var "G32_FREEZE_TOKEN_FINGERPRINT:${TOKEN_FINGERPRINT}"

if [[ "${G32_BRIDGE_DEPLOY_LIVE:-0}" != "1" ]]; then
  printf 'G32 bridge preflight PASS; set G32_BRIDGE_DEPLOY_LIVE=1 for the sealed B freeze deployment\n'
  exit 0
fi

# Receiver first ensures an old primary cannot make a successful doorbell call
# during the brief primary-version transition. Both deployments receive the
# same non-secret fingerprint and the same secret via the file-only channel.
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" "${COMMON_ARGS[@]}" --message "SDT-G32 bridge B receiver freeze ${SOURCE_COMMIT}"
"${WRANGLER_BIN}" deploy --config "${PRIMARY_CONFIG}" "${COMMON_ARGS[@]}" --message "SDT-G32 bridge B primary freeze ${SOURCE_COMMIT}"

node scripts/deploy/g32-bridge-witness.mjs \
  --source-commit "${SOURCE_COMMIT}" \
  --config-digest "${BRIDGE_DIGEST}" \
  --token-file "${TOKEN_FILE}" \
  --primary-base-url "${PRIMARY_BASE_URL}" \
  --receiver-base-url "${RECEIVER_BASE_URL}" \
  --output "${WITNESS_FILE}"

printf 'G32 bridge freeze witnessed; local token file will be removed by trap\n'
