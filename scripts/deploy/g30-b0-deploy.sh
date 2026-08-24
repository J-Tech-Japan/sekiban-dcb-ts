#!/usr/bin/env bash
set -euo pipefail

# SDT-G30 B0 acquisition. This is an attribution-only A(off)-B(on)-A'(off)
# runbook. It does not create resources, apply migrations, change placement,
# alter commit protocol, or use B0 as a performance acceptance threshold.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly PRIMARY_OFF_CONFIG="samples/meeting-room/wrangler.g30-primary-off.jsonc"
readonly PRIMARY_ON_CONFIG="samples/meeting-room/wrangler.g30-primary-on.jsonc"
readonly RECEIVER_CONFIG="samples/meeting-room/wrangler.g30-receiver-off.jsonc"
readonly PRIMARY_CONFIG_NAME="wrangler.g30-primary-off.jsonc"
readonly PRIMARY_WORKER_NAME="sekiban-dcb-meeting-room-cloudflare-only"
readonly BASE_URL="${G30_PRIMARY_BASE_URL:-https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev}"
readonly SOURCE_COMMIT="${G30_SOURCE_COMMIT:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}"
readonly ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
readonly TRACE_TOKEN_FILE="${G30_OBSERVABILITY_TOKEN_FILE:-}"

cd "${REPO_ROOT}"
readonly CONFIG_DIGEST="$(node "${SCRIPT_DIR}/g30-config-digest.mjs" "${SOURCE_COMMIT}")"

readonly ARTIFACTS_DIR="${REPO_ROOT}/.artifacts"
readonly PRELIGHT_FILE="${ARTIFACTS_DIR}/g30-b0-preflight.json"
readonly A_FILE="${ARTIFACTS_DIR}/g30-b0-A.json"
readonly B_FILE="${ARTIFACTS_DIR}/g30-b0-B.json"
readonly APRIME_FILE="${ARTIFACTS_DIR}/g30-b0-A-prime.json"
readonly TRACES_FILE="${ARTIFACTS_DIR}/g30-b0-traces.json"
readonly TRACE_QUERY_FILE="${ARTIFACTS_DIR}/g30-observability-query.json"
readonly A_WITNESS_FILE="${ARTIFACTS_DIR}/g30-b0-A-deployment.json"
readonly B_WITNESS_FILE="${ARTIFACTS_DIR}/g30-b0-B-deployment.json"
readonly APRIME_WITNESS_FILE="${ARTIFACTS_DIR}/g30-b0-A-prime-deployment.json"

test -x "${WRANGLER_BIN}"
if [[ ! "${SOURCE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'G30_SOURCE_COMMIT must be a full sealed candidate SHA\n' >&2
  exit 2
fi
if [[ "$(git rev-parse HEAD)" != "${SOURCE_COMMIT}" || -n "$(git status --porcelain --untracked-files=no)" ]]; then
  printf 'G30 B0 requires a clean checked-out final candidate equal to G30_SOURCE_COMMIT\n' >&2
  exit 2
fi

# These checks run before any remote operation. `--check` is target read-only;
# the host authority owns generation/sealing and target-side write is forbidden.
node scripts/commit-trace-contract.mjs --check
node scripts/commit-trace-contract.mjs --self-test
node scripts/g30-b0-contract.mjs --self-test
node scripts/g30-config-check.mjs --self-test
node scripts/g30-candidate-check.mjs --self-test
node scripts/g30-candidate-check.mjs --candidate "${SOURCE_COMMIT}"
npm run test:g30

if [[ "${G30_B0_LIVE:-0}" != "1" ]]; then
  "${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --dry-run --strict \
    --var "SDT_SERVICE_ID:g32-9043d626fe1149cb"
  "${WRANGLER_BIN}" deploy --config "${PRIMARY_OFF_CONFIG}" --dry-run --strict \
    --var "SDT_SERVICE_ID:g32-9043d626fe1149cb"
  for binding in D1 D1_MV; do
    output="$("${WRANGLER_BIN}" d1 migrations list "${binding}" --cwd samples/meeting-room --config "${PRIMARY_CONFIG_NAME}" --remote)"
    printf '%s\n' "${output}"
    [[ "${output}" == *"No migrations to apply"* ]] || { printf 'G30 %s has unapplied migration(s)\n' "${binding}" >&2; exit 1; }
  done
  printf 'G30 B0 preflight PASS; set G30_B0_LIVE=1 with a telemetry query and file-fed observability token to acquire B0\n'
  exit 0
fi

[[ -n "${ACCOUNT_ID}" && -f "${TRACE_TOKEN_FILE}" ]] || {
  printf 'G30 live B0 requires CLOUDFLARE_ACCOUNT_ID plus a readable observability token file\n' >&2; exit 2;
}

# Repeat the non-mutating remote preflight immediately before live deployment.
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --dry-run --strict \
  --var "SDT_SERVICE_ID:g32-9043d626fe1149cb"
"${WRANGLER_BIN}" deploy --config "${PRIMARY_OFF_CONFIG}" --dry-run --strict \
  --var "SDT_SERVICE_ID:g32-9043d626fe1149cb"
for binding in D1 D1_MV; do
  output="$("${WRANGLER_BIN}" d1 migrations list "${binding}" --cwd samples/meeting-room --config "${PRIMARY_CONFIG_NAME}" --remote)"
  [[ "${output}" == *"No migrations to apply"* ]] || { printf 'G30 %s has unapplied migration(s)\n' "${binding}" >&2; exit 1; }
done

mkdir -p "${ARTIFACTS_DIR}"
node -e 'const fs=require("fs");const out=process.argv[1];fs.writeFileSync(out,JSON.stringify({task:"SDT-G30",sourceCommit:process.argv[2],configDigest:process.argv[3],placement:"off",preflight:"both-worker-dry-runs and remote D1 migration checks passed before live deployment",capturedAt:new Date().toISOString()},null,2)+"\n");' "${PRELIGHT_FILE}" "${SOURCE_COMMIT}" "${CONFIG_DIGEST}"

# Rotate only the authenticated conformance credential through a file. The
# value never appears in a command argument, log, or evidence. --keep-vars
# preserves the existing G32 cutover fence and all unrelated production vars.
TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g30-conformance.XXXXXX")"
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g30-secrets.XXXXXX")"
chmod 600 "${TOKEN_FILE}" "${SECRETS_FILE}"
trap 'rm -f "${TOKEN_FILE}" "${SECRETS_FILE}"' EXIT
openssl rand -base64 48 | tr -d '\n' > "${TOKEN_FILE}"
node -e 'const fs=require("fs");const token=fs.readFileSync(process.argv[1],"utf8").trim();if(!token)throw new Error("empty G30 token");fs.writeFileSync(process.argv[2],JSON.stringify({CONFORMANCE_TOKEN:token})+"\n",{mode:0o600});' "${TOKEN_FILE}" "${SECRETS_FILE}"

common_vars=(--var "SDT_SERVICE_ID:g32-9043d626fe1149cb")
deploy_phase() {
  local phase="$1" config="$2"
  "${WRANGLER_BIN}" deploy --config "${config}" --keep-vars --strict --secrets-file "${SECRETS_FILE}" "${common_vars[@]}" \
    --message "SDT-G30 B0 ${phase} g32-9043d626fe1149cb ${SOURCE_COMMIT} ${CONFIG_DIGEST}"
}

# The deployed candidate is attested by Cloudflare's immutable Worker Version
# metadata. G30 deliberately does not add a witness route or runtime variable
# solely for B0; the version message binds phase, C and config digest outside
# the public protocol.
capture_primary_witness() {
  local phase="$1" output="$2" versions="${output}.versions.json"
  "${WRANGLER_BIN}" versions list --name "${PRIMARY_WORKER_NAME}" --json > "${versions}"
  node "${SCRIPT_DIR}/g30-deployment-witness.mjs" --phase "${phase}" --source-commit "${SOURCE_COMMIT}" \
    --config-digest "${CONFIG_DIGEST}" --service-id "g32-9043d626fe1149cb" --worker "${PRIMARY_WORKER_NAME}" \
    --versions "${versions}" --output "${output}"
}

# Deploy receiver once with tracing sampled off, then retain its exact code and
# bindings while only the primary's trace sampling toggles A -> B -> A-prime.
deploy_phase A "${RECEIVER_CONFIG}"
deploy_phase A "${PRIMARY_OFF_CONFIG}"
capture_primary_witness A "${A_WITNESS_FILE}"
node "${SCRIPT_DIR}/g30-b0-measure.mjs" --base-url "${BASE_URL}" --token-file "${TOKEN_FILE}" --phase A --source-commit "${SOURCE_COMMIT}" --config-digest "${CONFIG_DIGEST}" --deployment-witness "${A_WITNESS_FILE}" --output "${A_FILE}"

deploy_phase B "${PRIMARY_ON_CONFIG}"
capture_primary_witness B "${B_WITNESS_FILE}"
node "${SCRIPT_DIR}/g30-b0-measure.mjs" --base-url "${BASE_URL}" --token-file "${TOKEN_FILE}" --phase B --source-commit "${SOURCE_COMMIT}" --config-digest "${CONFIG_DIGEST}" --deployment-witness "${B_WITNESS_FILE}" --output "${B_FILE}"

# The checked-in query template is materialized from the actual B client
# ledger; it has no human-supplied request IDs or observation declarations.
# The token is file-fed and this export may not replace a missing/slow trace.
node "${SCRIPT_DIR}/g30-observability-query.mjs" --ledger "${B_FILE}" --output "${TRACE_QUERY_FILE}"
node "${SCRIPT_DIR}/g30-trace-export.mjs" --ledger "${B_FILE}" --account-id "${ACCOUNT_ID}" --api-token-file "${TRACE_TOKEN_FILE}" --query "${TRACE_QUERY_FILE}" --output "${TRACES_FILE}"

deploy_phase A-prime "${PRIMARY_OFF_CONFIG}"
capture_primary_witness A-prime "${APRIME_WITNESS_FILE}"
node "${SCRIPT_DIR}/g30-b0-measure.mjs" --base-url "${BASE_URL}" --token-file "${TOKEN_FILE}" --phase A-prime --source-commit "${SOURCE_COMMIT}" --config-digest "${CONFIG_DIGEST}" --deployment-witness "${APRIME_WITNESS_FILE}" --output "${APRIME_FILE}"

# The recorder derives activation, idle, and four-hypothesis dispositions from
# the joined structured Workers Logs export. No operator-authored claim file
# can become retained evidence.
node "${SCRIPT_DIR}/g30-b0-record-evidence.mjs" --source-commit "${SOURCE_COMMIT}" \
  --phase-a "${A_FILE}" --phase-b "${B_FILE}" --phase-a-prime "${APRIME_FILE}" --traces "${TRACES_FILE}" \
  --preflight "${PRELIGHT_FILE}" \
  --output docs/SDT-G30-b0-evidence.json --markdown-output docs/SDT-G30-b0-evidence.md

# R is evidence only. The recorder above has already trace-bound every raw
# observation; now retain the raw phase/export inputs under the allowed docs
# evidence paths without hard-coding the sealed candidate.
cp "${A_FILE}" docs/SDT-G30-B0-evidence-A.json
cp "${B_FILE}" docs/SDT-G30-B0-evidence-B.json
cp "${APRIME_FILE}" docs/SDT-G30-B0-evidence-A-prime.json
cp "${TRACES_FILE}" docs/SDT-G30-B0-evidence-traces.json
cp "${A_WITNESS_FILE}" docs/SDT-G30-B0-evidence-A-deployment.json
cp "${B_WITNESS_FILE}" docs/SDT-G30-B0-evidence-B-deployment.json
cp "${APRIME_WITNESS_FILE}" docs/SDT-G30-B0-evidence-A-prime-deployment.json

printf 'G30 B0 complete at %s; token files are deleted by trap and R may change only SDT-G30 evidence docs plus one retained candidate line\n' "${SOURCE_COMMIT}"
