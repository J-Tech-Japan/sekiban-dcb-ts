#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 4 ]]; then
  printf 'usage: %s BASE_URL before-restart|after-restart STATE_FILE [REPORT]\n' "$0" >&2
  exit 2
fi

readonly BASE_URL="$1"
readonly PHASE="$2"
readonly STATE_FILE="$3"
readonly REPORT="${4:-${STATE_FILE%.json}-${PHASE}.json}"
readonly SUITE_REF="1b141ed"
readonly SUITE_ROOT="https://raw.githubusercontent.com/J-Tech-Japan/SekibanWasmRuntime/${SUITE_REF}/conformance/serialized-dcb-v1"
readonly STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sekiban-dcb-g11-conformance.XXXXXX")"

# Keep the pinned source inspectable after a run; this avoids deleting scratch
# state while still keeping it outside the repository.
trap 'printf "G11_CONFORMANCE_STAGING=%s\n" "${STAGING_DIR}"' EXIT

if [[ "${PHASE}" == "before-restart" ]]; then
  G11_SERVICE_ID="g11-conformance-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:16])')"
else
  G11_SERVICE_ID="$(python3 - "${STATE_FILE}" <<'PY'
import json
import sys
from pathlib import Path
state = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
value = state.get("serviceId")
if not isinstance(value, str) or not value:
    raise SystemExit("conformance state has no serviceId")
print(value)
PY
)"
fi
export G11_SERVICE_ID
printf 'G11_CONFORMANCE_SERVICE_ID=%s\n' "${G11_SERVICE_ID}"

curl --fail --silent --show-error --location "${SUITE_ROOT}/suite.py" --output "${STAGING_DIR}/suite.py"
curl --fail --silent --show-error --location "${SUITE_ROOT}/fixture-weather.json" --output "${STAGING_DIR}/fixture-weather.json"
# workers.dev rejects Python's default `Python-urllib/*` signature. Keep the
# suite pinned, but give its HTTP client an explicit non-browser probe agent.
python3 - "${STAGING_DIR}/suite.py" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
if "import time" not in source:
    source = source.replace("import sys\n", "import sys\nimport time\n", 1)
if "import urllib.parse" not in source:
    source = source.replace("import os\n", "import os\nimport urllib.parse\n", 1)
needle = 'headers={"Accept": "application/json", "Content-Type": "application/json"}'
replacement = 'headers={"Accept": "application/json", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (compatible; SDT-G11-Conformance/1.0)", "x-sdt-g11-service-id": self.service_id}'
if needle not in source:
    raise SystemExit("pinned suite HTTP header shape changed")
source = source.replace(needle, replacement, 1)
needle = "        self.base_url = base_url.rstrip(\"/\")"
replacement = "        self.base_url = base_url.rstrip(\"/\")\n        self.service_id = os.environ.get(\"G11_SERVICE_ID\", \"\")"
if needle not in source:
    raise SystemExit("pinned suite HttpClient constructor shape changed")
source = source.replace(needle, replacement, 1)
needle = '            "maxObservedHead": max([retry, *concurrent_ids], key=lambda value: value.encode("utf-8")),\n'
replacement = needle + '            "serviceId": self.client.service_id,\n'
if needle not in source:
    raise SystemExit("pinned suite state shape changed")
source = source.replace(needle, replacement, 1)
needle = '    def queries(self, name: str, wait_for: str | None = None) -> None:\n'
method = (
    '    def poll_projection(self, name: str, token: str) -> None:\n'
    '        state_id = self.tag_state_id(token)\n'
    '        url = f"{self.client.base_url}/internal/projection/lag?tagStateId={urllib.parse.quote(state_id)}&serviceId={urllib.parse.quote(self.client.service_id)}&poll=1"\n'
    '        request = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; SDT-G11-Conformance/1.0)"})\n'
    '        try:\n'
    '            with urlopen(request, timeout=60) as response:\n'
    '                status = response.status\n'
    '                raw = response.read()\n'
    '        except HTTPError as error:\n'
    '            status = error.code\n'
    '            raw = error.read()\n'
    '        check(status == 200, f"{name}: projection poll failed with HTTP {status}: {raw!r}")\n'
    '\n'
)
if needle not in source:
    raise SystemExit("pinned suite query method shape changed")
source = source.replace(needle, method + needle, 1)
needle = '        self.tag_state("tag-state", token, retry)\n        self.queries("query", wait_for=retry)'
replacement = '        self.tag_state("tag-state", token, retry)\n        time.sleep(22)\n        for poll_index in range(4):\n            self.poll_projection(f"projection-poll-{poll_index}", token)\n            time.sleep(2)\n        self.queries("query", wait_for=retry)'
if needle not in source:
    raise SystemExit("pinned suite before query shape changed")
source = source.replace(needle, replacement, 1)
needle = '        self.tag_state("restart-tag-state", str(state["token"]), new_head)\n        self.queries("restart-query", wait_for=new_head)'
replacement = '        self.tag_state("restart-tag-state", str(state["token"]), new_head)\n        time.sleep(22)\n        for poll_index in range(4):\n            self.poll_projection(f"restart-projection-poll-{poll_index}", str(state["token"]))\n            time.sleep(2)\n        self.queries("restart-query", wait_for=new_head)'
if needle not in source:
    raise SystemExit("pinned suite after query shape changed")
source = source.replace(needle, replacement, 1)
path.write_text(source, encoding="utf-8")
PY
mkdir -p "$(dirname "${STATE_FILE}")" "$(dirname "${REPORT}")"

python3 "${STAGING_DIR}/suite.py" \
  --base-url "${BASE_URL}" \
  --fixture "${STAGING_DIR}/fixture-weather.json" \
  --phase "${PHASE}" \
  --state-file "${STATE_FILE}" \
  --report "${REPORT}"
