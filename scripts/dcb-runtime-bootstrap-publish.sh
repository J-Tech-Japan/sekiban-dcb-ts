#!/usr/bin/env bash
# SDT-G99 local bootstrap publish for @sekiban/dcb-runtime
#
# Trusted Publishing (OIDC) cannot create a brand-new package. This script is the
# one-time local path: build → publish without provenance (private GitHub source)
# → verify npm view → print Trusted Publisher registration URLs.
#
# Usage (MUST run from repository root):
#   cd /path/to/repo
#   ./scripts/dcb-runtime-bootstrap-publish.sh --dry-run
#   ./scripts/dcb-runtime-bootstrap-publish.sh
#   npm run publish:g99:runtime-bootstrap
#
# Absolute paths (this worktree):
#   root:    /path/to/repo
#   script:  /path/to/repo/scripts/dcb-runtime-bootstrap-publish.sh
#   package: /path/to/repo/packages/dcb-runtime
#   receipt: /path/to/repo/.artifacts/sdt-g99-runtime-bootstrap-publish.json
#
# Prerequisites:
#   - npm login as a maintainer of the @sekiban scope (OTP / 2FA as prompted)
#   - Network access to registry.npmjs.org
#   - Working tree packages/dcb-runtime/package.json must be private:false @0.2.0
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

info_paths() {
  cat <<EOF
dcb-runtime-bootstrap: working directory (repo root): ${ROOT}
dcb-runtime-bootstrap: script:  ${ROOT}/scripts/dcb-runtime-bootstrap-publish.sh
dcb-runtime-bootstrap: package: ${ROOT}/packages/dcb-runtime
EOF
}

PACKAGE_DIR="${ROOT}/packages/dcb-runtime"
MANIFEST="${PACKAGE_DIR}/package.json"
EXPECTED_NAME="@sekiban/dcb-runtime"
EXPECTED_VERSION="0.2.0"
DRY_RUN=0
SKIP_BUILD=0

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: ${arg}" >&2
      echo "usage: $0 [--dry-run] [--skip-build]" >&2
      exit 2
      ;;
  esac
done

fail() { echo "dcb-runtime-bootstrap: ERROR: $*" >&2; exit 1; }
info() { echo "dcb-runtime-bootstrap: $*"; }

info_paths

[[ -f "${MANIFEST}" ]] || fail "missing ${MANIFEST}"

NAME="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).name)" "${MANIFEST}")"
VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version)" "${MANIFEST}")"
PRIVATE="$(node -e "console.log(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).private))" "${MANIFEST}")"

[[ "${NAME}" == "${EXPECTED_NAME}" ]] || fail "package name is ${NAME}, expected ${EXPECTED_NAME}"
[[ "${VERSION}" == "${EXPECTED_VERSION}" ]] || fail "package version is ${VERSION}, expected ${EXPECTED_VERSION}"
[[ "${PRIVATE}" == "false" ]] || fail "package must be private:false (got ${PRIVATE})"

info "checking npm login (npm whoami)"
if ! WHOAMI="$(npm whoami 2>/dev/null)"; then
  fail "not logged in to npm. Run: npm login   (https://www.npmjs.com/login)"
fi
info "npm whoami → ${WHOAMI}"

info "checking whether ${EXPECTED_NAME}@${EXPECTED_VERSION} already exists"
EXISTING_OK=0
VERSION_PROBE_CODE="$(curl -sS -o /dev/null -w "%{http_code}" "https://registry.npmjs.org/@sekiban/dcb-runtime/${EXPECTED_VERSION}")"
if [[ "${VERSION_PROBE_CODE}" == "200" ]]; then
  info "already on registry (version doc HTTP 200): ${EXPECTED_NAME}@${EXPECTED_VERSION}"
  info "skipping publish; next step is Trusted Publisher registration (see footer)"
  EXISTING_OK=1
elif EXISTING="$(npm view "${EXPECTED_NAME}@${EXPECTED_VERSION}" version 2>/dev/null)"; then
  if [[ "${EXISTING}" == "${EXPECTED_VERSION}" ]]; then
    info "already on registry via npm view: ${EXPECTED_NAME}@${EXPECTED_VERSION}"
    EXISTING_OK=1
  fi
fi

if [[ "${SKIP_BUILD}" -ne 1 ]]; then
  info "building @sekiban/dcb-core then @sekiban/dcb-runtime"
  npm run build --workspace @sekiban/dcb-core
  npm run build --workspace @sekiban/dcb-runtime
else
  info "skipping build (--skip-build)"
fi

[[ -f "${PACKAGE_DIR}/dist/index.js" ]] || fail "missing dist/index.js — build failed?"
[[ -f "${PACKAGE_DIR}/LICENSE" ]] || fail "missing LICENSE"
[[ -f "${PACKAGE_DIR}/README.md" ]] || fail "missing README.md"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/dcb-runtime-bootstrap.XXXXXX")"
cleanup() { rm -rf "${STAGE}"; }
trap cleanup EXIT

info "staging publish tree at ${STAGE} (provenance stripped; git tree untouched)"
# Pack files allowlist matches package.json "files": dist, README, LICENSE + package.json
mkdir -p "${STAGE}"
cp "${MANIFEST}" "${STAGE}/package.json"
cp "${PACKAGE_DIR}/LICENSE" "${STAGE}/LICENSE"
cp "${PACKAGE_DIR}/README.md" "${STAGE}/README.md"
cp -a "${PACKAGE_DIR}/dist" "${STAGE}/dist"

node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[1];
const manifest = JSON.parse(readFileSync(path, 'utf8'));
if (manifest.publishConfig && Object.hasOwn(manifest.publishConfig, 'provenance')) {
  delete manifest.publishConfig.provenance;
}
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
" "${STAGE}/package.json"

PUBLISH_ARGS=(--access public)
if [[ "${DRY_RUN}" -eq 1 ]]; then
  PUBLISH_ARGS+=(--dry-run)
  info "dry-run publish: npm publish ${PUBLISH_ARGS[*]}"
else
  info "live publish: npm publish ${PUBLISH_ARGS[*]}"
  info "expect an OTP / 2FA prompt if your account requires it"
fi

if [[ "${EXISTING_OK}" -eq 1 && "${DRY_RUN}" -ne 1 ]]; then
  info "registry already has ${EXPECTED_NAME}@${EXPECTED_VERSION}; not republishing"
else
  (
    cd "${STAGE}"
    # Private GitHub source cannot ship provenance; force it off even if npm auto-enables.
    env NPM_CONFIG_PROVENANCE=false npm publish "${PUBLISH_ARGS[@]}"
  )
fi

if [[ "${DRY_RUN}" -eq 1 ]]; then
  info "dry-run complete (nothing published)"
  exit 0
fi

info "verifying registry (version doc + tarball + access; package-root npm view can lag)"
VERSION_URL="https://registry.npmjs.org/@sekiban/dcb-runtime/${EXPECTED_VERSION}"
TARBALL_URL="https://registry.npmjs.org/@sekiban/dcb-runtime/-/dcb-runtime-${EXPECTED_VERSION}.tgz"
VERSION_CODE="$(curl -sS -o /tmp/dcb-runtime-version.json -w "%{http_code}" "${VERSION_URL}")"
TARBALL_CODE="$(curl -sS -o /dev/null -w "%{http_code}" "${TARBALL_URL}")"
ACCESS_STATUS="$(npm access get status "${EXPECTED_NAME}" 2>/dev/null || true)"
info "GET ${VERSION_URL} → HTTP ${VERSION_CODE}"
info "GET ${TARBALL_URL} → HTTP ${TARBALL_CODE}"
info "npm access get status → ${ACCESS_STATUS:-unknown}"

if [[ "${VERSION_CODE}" != "200" || "${TARBALL_CODE}" != "200" ]]; then
  fail "bootstrap publish did not leave a readable ${EXPECTED_VERSION} version/tarball on the registry"
fi

VIEWED=""
if VIEWED="$(npm view "${EXPECTED_NAME}" version 2>/dev/null)"; then
  info "npm view ${EXPECTED_NAME} version → ${VIEWED}"
else
  info "NOTE: package-root npm view is still 404 (npmjs page may be 403). Version+tarball exist; proceed to Trusted Publisher."
  VIEWED="${EXPECTED_VERSION}"
fi

RECEIPT="${ROOT}/.artifacts/sdt-g99-runtime-bootstrap-publish.json"
mkdir -p "${ROOT}/.artifacts"
node --input-type=module -e "
import { writeFileSync, readFileSync } from 'node:fs';
let versionDoc = null;
try { versionDoc = JSON.parse(readFileSync('/tmp/dcb-runtime-version.json', 'utf8')); } catch {}
const receipt = {
  schema: 'sdt-g99-runtime-bootstrap-publish/v1',
  package: process.argv[1],
  version: process.argv[2],
  publisher: process.argv[3],
  recordedAt: new Date().toISOString(),
  npmViewVersion: process.argv[4],
  versionDocHttp: process.argv[5],
  tarballHttp: process.argv[6],
  accessStatus: process.argv[7],
  tarball: versionDoc?.dist?.tarball ?? null,
};
writeFileSync(process.argv[8], JSON.stringify(receipt, null, 2) + '\n');
" "${EXPECTED_NAME}" "${EXPECTED_VERSION}" "${WHOAMI}" "${VIEWED}" "${VERSION_CODE}" "${TARBALL_CODE}" "${ACCESS_STATUS:-unknown}" "${RECEIPT}"
info "PASS: wrote ${RECEIPT}"

cat <<EOF

=== Bootstrap publish succeeded ===

Verified:
  version doc: ${VERSION_URL} (HTTP ${VERSION_CODE})
  tarball:     ${TARBALL_URL} (HTTP ${TARBALL_CODE})
  access:      ${ACCESS_STATUS:-unknown}

NOTE: package-root \`npm view ${EXPECTED_NAME}\` / npmjs.com page can still 404/403
right after first create. That does NOT mean Trusted Publisher must come first —
Trusted Publisher attaches to an existing package, and this package now exists.

Next: register Trusted Publisher (AC1 OIDC path)
  1. Open (logged in as @sekiban maintainer):
     https://www.npmjs.com/package/@sekiban/dcb-runtime/access
     If that 403s in a logged-out browser, open while logged into npmjs.com.
  2. Trusted Publisher → GitHub Actions:
       Organization or user: J-Tech-Japan
       Repository:           sekiban-dcb-ts
       Workflow filename:    publish-dcb-unpublished.yml
       Environment name:     (leave empty)
       Allowed actions:      allow npm publish
  3. (Recommended) second connection: release-dcb-matched-set.yml
  4. Docs: https://docs.npmjs.com/trusted-publishers/#for-github-actions
  5. Run OIDC publish:
     https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/workflows/publish-dcb-unpublished.yml
     Branch: main · packages: dcb-runtime
  6. Confirm later:
     npm view @sekiban/dcb-runtime version

EOF
