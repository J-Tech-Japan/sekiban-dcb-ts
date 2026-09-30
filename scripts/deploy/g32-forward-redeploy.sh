#!/usr/bin/env bash
set -euo pipefail

# SDT-G32 forward-only witness. The one-time bridge, freeze, wipe, and new
# binding creation are historical cutover operations; this script refuses to
# run them again. It republishes a sealed source identity, rotates file-fed
# conformance/fence credentials, preserves a pre-captured data set, then
# performs fresh N=10 probes.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly PRIMARY_CONFIG="samples/meeting-room/wrangler.g32-final-primary.jsonc"
readonly RECEIVER_CONFIG="samples/meeting-room/wrangler.g32-final-receiver.jsonc"
readonly PRIMARY_CONFIG_NAME="wrangler.g32-final-primary.jsonc"
readonly PIPELINE_DATABASE_BINDING="D1"
readonly MATERIALIZED_VIEW_DATABASE_BINDING="D1_MV"
readonly QUEUE_NAME="sekiban-dcb-meeting-room-g32-9043d626fe1149cb-outbox"
readonly PRIMARY_BASE_URL="${G32_PRIMARY_BASE_URL:-https://example.workers.dev}"
readonly RECEIVER_BASE_URL="${G32_RECEIVER_BASE_URL:-https://example.workers.dev}"
readonly SOURCE_COMMIT="${G32_SOURCE_COMMIT:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}"
readonly FORWARD_CYCLE="${G32_FORWARD_CYCLE:-forward}"
readonly RECORD_KEY="${G32_FORWARD_RECORD_KEY:-forwardRedeploy${FORWARD_CYCLE}}"
readonly PRIOR_RECORD_KEY="${G32_FORWARD_PRIOR_RECORD_KEY:-}"
readonly CANDIDATE_LABEL="${G32_FORWARD_CANDIDATE_LABEL:-${FORWARD_CYCLE}}"
readonly CONFIG_RELATION="${G32_FORWARD_CONFIG_RELATION:-unchanged}"
readonly PRESEAL_MODE="${G32_FORWARD_PRESEAL:-0}"
readonly PRESEAL_CHECKLIST="${G32_FORWARD_PRESEAL_CHECKLIST:-}"

if [[ ! "${FORWARD_CYCLE}" =~ ^[A-Za-z][A-Za-z0-9_-]*$ || -z "${PRIOR_RECORD_KEY}" ]]; then
  printf 'G32 forward witness requires a safe cycle label and G32_FORWARD_PRIOR_RECORD_KEY\n' >&2
  exit 2
fi
readonly CYCLE_LOWER="$(printf '%s' "${FORWARD_CYCLE}" | tr '[:upper:]' '[:lower:]')"

readonly PRE_FILE="${REPO_ROOT}/.artifacts/g32-forward-${CYCLE_LOWER}-pre-witness.json"
readonly POST_FILE="${REPO_ROOT}/.artifacts/g32-forward-${CYCLE_LOWER}-post-witness.json"
readonly QUEUE_CONSUMERS_FILE="${REPO_ROOT}/.artifacts/g32-forward-${CYCLE_LOWER}-queue-consumers.json"
readonly QUEUE_TOPOLOGY_FILE="${REPO_ROOT}/.artifacts/g32-forward-${CYCLE_LOWER}-queue-topology.json"
readonly MEASUREMENT_FILE="${REPO_ROOT}/.artifacts/g32-forward-${CYCLE_LOWER}-measurement.json"

cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"
if [[ ! "${SOURCE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'G32_SOURCE_COMMIT must be a full candidate SHA\n' >&2
  exit 2
fi

# All candidate material must be inside the manifest before any remote
# operation. A pre-seal pass operates on the exact staged tree with a synthetic
# candidate; a live pass requires a clean sealed commit.
if [[ "${PRESEAL_MODE}" == "1" ]]; then
  if [[ "${G32_FORWARD_DEPLOY_LIVE:-0}" == "1" ]]; then
    printf 'G32 pre-seal forward preflight must never enter live deployment\n' >&2
    exit 2
  fi
  if ! git diff --quiet; then
    printf 'G32 pre-seal forward preflight requires all material staged with no unstaged tracked changes\n' >&2
    exit 2
  fi
  readonly INDEX_TREE="$(git write-tree)"
  readonly CONFIG_DIGEST="${G32_FORWARD_CONFIG_DIGEST:-$(node scripts/deploy/g32-config-digest.mjs "${INDEX_TREE}")}"
  node scripts/g32-candidate-check.mjs --self-test
  node scripts/g32-candidate-check.mjs --pre-seal-dry-run --synthetic-candidate "${SOURCE_COMMIT}" --record-key "${RECORD_KEY}" --prior-key "${PRIOR_RECORD_KEY}"
else
  if [[ "$(git rev-parse HEAD)" != "${SOURCE_COMMIT}" ]]; then
    printf 'G32_SOURCE_COMMIT must equal the sealed checked-out %s SHA\n' "${FORWARD_CYCLE}" >&2
    exit 2
  fi
  if ! git diff --quiet || ! git diff --cached --quiet; then
    printf 'G32 %s must have no tracked working-tree changes before forward witness deployment\n' "${FORWARD_CYCLE}" >&2
    exit 2
  fi
  node scripts/g32-candidate-check.mjs --self-test
  node scripts/g32-candidate-check.mjs --candidate "${SOURCE_COMMIT}"
  readonly CONFIG_DIGEST="$(node scripts/deploy/g32-config-digest.mjs "${SOURCE_COMMIT}")"
fi
node scripts/g32-legacy-ingress-audit.mjs --self-test
readonly PRIOR_CONFIG_DIGEST="$(node -e 'const evidence=require("./docs/SDT-G32-cutover-evidence.json");const key=process.argv[1];const prior=evidence[key];if(!prior?.deploymentConfig?.digest)throw new Error(`missing deployment config digest for ${key}`);process.stdout.write(prior.deploymentConfig.digest);' "${PRIOR_RECORD_KEY}")"
case "${CONFIG_RELATION}" in
  unchanged)
    if [[ "${CONFIG_DIGEST}" != "${PRIOR_CONFIG_DIGEST}" ]]; then
      printf 'G32 %s must retain the prior deployment configuration digest\n' "${FORWARD_CYCLE}" >&2
      exit 2
    fi
    ;;
  changed)
    if [[ "${CONFIG_DIGEST}" == "${PRIOR_CONFIG_DIGEST}" ]]; then
      printf 'G32 %s must change the prior deployment configuration digest\n' "${FORWARD_CYCLE}" >&2
      exit 2
    fi
    ;;
  either) ;;
  *) printf 'G32_FORWARD_CONFIG_RELATION must be unchanged, changed, or either\n' >&2; exit 2 ;;
esac

COMMON_VARS=(
  --var "SDT_SERVICE_ID:g32-9043d626fe1149cb"
  --var "G32_SOURCE_COMMIT:${SOURCE_COMMIT}"
  --var "G32_CONFIG_DIGEST:${CONFIG_DIGEST}"
)

# Read-only preflight: build exact retained bindings and inspect migration
# state. This script deliberately has no migrations apply, D1 create, Queue
# create/remove, bridge freeze, wipe, or seed command.
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --dry-run --strict "${COMMON_VARS[@]}" --var "G32_CUTOVER_FENCE_FINGERPRINT:$(printf '0%.0s' {1..64})"
"${WRANGLER_BIN}" deploy --config "${PRIMARY_CONFIG}" --dry-run --strict "${COMMON_VARS[@]}" --var "G32_CUTOVER_FENCE_FINGERPRINT:$(printf '0%.0s' {1..64})"
check_no_remote_migrations() {
  local binding="$1"
  local output
  output="$("${WRANGLER_BIN}" d1 migrations list "${binding}" --cwd samples/meeting-room --config "${PRIMARY_CONFIG_NAME}" --remote)"
  printf '%s\n' "${output}"
  if [[ "${output}" != *"No migrations to apply"* ]]; then
    printf 'G32 %s remote migration preflight for %s must report No migrations to apply\n' "${FORWARD_CYCLE}" "${binding}" >&2
    exit 1
  fi
}
check_no_remote_migrations "${PIPELINE_DATABASE_BINDING}"
check_no_remote_migrations "${MATERIALIZED_VIEW_DATABASE_BINDING}"

if [[ "${G32_FORWARD_DEPLOY_LIVE:-0}" != "1" ]]; then
  printf 'G32 %s forward preflight PASS; set G32_FORWARD_DEPLOY_LIVE=1 for the witnessed forward-only redeploy\n' "${FORWARD_CYCLE}"
  exit 0
fi

if [[ -z "${PRESEAL_CHECKLIST}" || ! -f "${PRESEAL_CHECKLIST}" ]]; then
  printf 'G32 %s live forward witness requires a completed pre-seal checklist artifact\n' "${FORWARD_CYCLE}" >&2
  exit 2
fi

mkdir -p .artifacts

# Capture existing G32 data before reading/creating any credential, deployment,
# or probe. The post comparison requires this set to be preserved.
node scripts/deploy/g32-forward-witness.mjs --mode pre-deploy-public --base-url "${PRIMARY_BASE_URL}" --output "${PRE_FILE}"

# Rotate both deployed secrets through a file only. Values never enter command
# arguments, output, or committed evidence. The trap makes local credential
# removal fail-safe even if deployment/post-witness fails.
TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g32-${CYCLE_LOWER}-conformance.XXXXXX")"
FENCE_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g32-${CYCLE_LOWER}-fence.XXXXXX")"
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g32-${CYCLE_LOWER}-secrets.XXXXXX")"
chmod 600 "${TOKEN_FILE}" "${FENCE_FILE}" "${SECRETS_FILE}"
trap 'rm -f "${TOKEN_FILE}" "${FENCE_FILE}" "${SECRETS_FILE}"' EXIT
openssl rand -base64 48 | tr -d '\n' > "${TOKEN_FILE}"
openssl rand -base64 48 | tr -d '\n' > "${FENCE_FILE}"
FENCE_FINGERPRINT="$(node -e 'const fs=require("fs");const {createHash}=require("crypto");const value=fs.readFileSync(process.argv[1],"utf8").trim();if(!value)throw new Error("empty G32 fence token");process.stdout.write(createHash("sha256").update(value,"utf8").digest("hex"));' "${FENCE_FILE}")"
node -e 'const fs=require("fs");const conformance=fs.readFileSync(process.argv[1],"utf8").trim();const fence=fs.readFileSync(process.argv[2],"utf8").trim();if(!conformance||!fence)throw new Error("empty G32 deployment secret");fs.writeFileSync(process.argv[3],JSON.stringify({CONFORMANCE_TOKEN:conformance,G32_CUTOVER_FENCE_TOKEN:fence})+"\n",{mode:0o600});' "${TOKEN_FILE}" "${FENCE_FILE}" "${SECRETS_FILE}"

# The receiver has no Queue-consumer config and is deployed first. --keep-vars
# retains unrelated production configuration while the secret file replaces
# only the freshly rotated conformance/fence credentials.
FINAL_VARS=("${COMMON_VARS[@]}" --var "G32_CUTOVER_FENCE_FINGERPRINT:${FENCE_FINGERPRINT}")
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --keep-vars --strict --secrets-file "${SECRETS_FILE}" "${FINAL_VARS[@]}" --message "SDT-G32 ${FORWARD_CYCLE} forward receiver ${SOURCE_COMMIT}"
"${WRANGLER_BIN}" deploy --config "${PRIMARY_CONFIG}" --keep-vars --strict --secrets-file "${SECRETS_FILE}" "${FINAL_VARS[@]}" --message "SDT-G32 ${FORWARD_CYCLE} forward primary ${SOURCE_COMMIT}"

for attempt in {1..15}; do
  "${WRANGLER_BIN}" queues consumer worker list "${QUEUE_NAME}" --json > "${QUEUE_CONSUMERS_FILE}"
  if node scripts/deploy/g32-queue-topology.mjs --input "${QUEUE_CONSUMERS_FILE}" --output "${QUEUE_TOPOLOGY_FILE}"; then
    break
  fi
  if [[ "${attempt}" == "15" ]]; then
    printf 'G32 %s Queue consumer topology did not converge\n' "${FORWARD_CYCLE}" >&2
    exit 1
  fi
  sleep 2
done

node scripts/deploy/g32-forward-witness.mjs \
  --conformance-retry-attempts 15 --conformance-retry-delay-ms 1000 \
  --base-url "${PRIMARY_BASE_URL}" --receiver-base-url "${RECEIVER_BASE_URL}" \
  --token-file "${TOKEN_FILE}" --source-commit "${SOURCE_COMMIT}" --config-digest "${CONFIG_DIGEST}" --output "${POST_FILE}"
node scripts/deploy/g32-forward-witness.mjs --mode compare --before "${PRE_FILE}" --after "${POST_FILE}" --source-commit "${SOURCE_COMMIT}"

# Exactly N=10 fresh command -> one server wait/list cycles run only after the
# preservation witness. g32-measure also rechecks the old 37-character SUID
# typed rejection and public raw-V1 closure.
node scripts/deploy/g32-measure.mjs --base-url "${PRIMARY_BASE_URL}" --token-file "${TOKEN_FILE}" --samples 10 --report "${MEASUREMENT_FILE}"
node scripts/deploy/g32-forward-record-evidence.mjs \
  --source-commit "${SOURCE_COMMIT}" --pre "${PRE_FILE}" --post "${POST_FILE}" \
  --measurement "${MEASUREMENT_FILE}" --queue-topology "${QUEUE_TOPOLOGY_FILE}" \
  --record-key "${RECORD_KEY}" --prior-key "${PRIOR_RECORD_KEY}" --candidate-label "${CANDIDATE_LABEL}" \
  --preseal "${PRESEAL_CHECKLIST}" \
  --output docs/SDT-G32-cutover-evidence.json

printf 'G32 %s forward-only witnessed redeploy complete; R may change only evidence and one retained-candidate append\n' "${FORWARD_CYCLE}"
