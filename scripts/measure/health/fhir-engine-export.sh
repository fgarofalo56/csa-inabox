#!/usr/bin/env bash
# fhir-engine-export.sh - W0-1: system-level FHIR Bulk Data `$export` on the single-engine path,
# resources/second (CAPACITY-MODEL section 7 baseline; the 23 k res/s target needs the parallel
# worker design of W6, this measures only the engine's own path).
#
# Usage:
#   ENGINE=hapi FHIR_BASE_URL=http://localhost:8080/fhir [EXPORT_TIMEOUT_S=3600] \
#     bash scripts/measure/health/fhir-engine-export.sh
#
# Flow: GET [base]/$export (Accept application/fhir+json, Prefer respond-async) -> 202 + Content-Location
# -> poll until 200 -> download every output[].url -> count ndjson lines.
# Records: export_resources (lines downloaded), export_wall_s (kickoff -> last file downloaded),
# export_server_wall_s (kickoff -> status 200), export_res_s (resources / export_wall_s).
# Host in output URLs is rewritten to the FHIR_BASE_URL origin (the server may advertise an
# in-container address).
#
# Engine prerequisites: HAPI needs HAPI_FHIR_BULK_EXPORT_ENABLED=true; Medplum needs a bearer token
# with export rights (FHIR_BEARER_TOKEN).
#
# FAILS (exit 1) when: kickoff is not 202, the poll times out, any file download is non-200, or the
# export returns 0 resources (a 0 would print a rate of 0 and look like a measurement).

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fhir-engine-lib.sh
source "$HERE/fhir-engine-lib.sh"
lib_init
lib_require_env FHIR_BASE_URL
export EXPORT_TIMEOUT_S="${EXPORT_TIMEOUT_S:-3600}"

PY=$(
  cat <<'EOF'
import json, os, sys, time, urllib.request, urllib.error, urllib.parse

base = os.environ["FHIR_BASE_URL"].rstrip("/")
origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlparse(base))
token = os.environ.get("FHIR_BEARER_TOKEN", "")
deadline = time.perf_counter() + float(os.environ["EXPORT_TIMEOUT_S"])

def req(url, headers):
    r = urllib.request.Request(url, headers=headers)
    if token:
        r.add_header("Authorization", "Bearer " + token)
    return r

def fix(u):
    p = urllib.parse.urlparse(u)
    return origin + p.path + (("?" + p.query) if p.query else "")

t0 = time.perf_counter()
try:
    resp = urllib.request.urlopen(req(base + "/$export", {"Accept": "application/fhir+json", "Prefer": "respond-async"}), timeout=120)
except urllib.error.HTTPError as e:
    sys.exit("kickoff failed: %s %s" % (e.code, e.read()[:300]))
if resp.status != 202:
    sys.exit("kickoff returned %s, expected 202" % resp.status)
status_url = fix(resp.headers["Content-Location"])
manifest = None
t_server = None
while time.perf_counter() < deadline:
    try:
        r = urllib.request.urlopen(req(status_url, {"Accept": "application/json"}), timeout=120)
    except urllib.error.HTTPError as e:
        sys.exit("status poll failed: %s %s" % (e.code, e.read()[:300]))
    if r.status == 200:
        manifest = json.loads(r.read())
        t_server = time.perf_counter() - t0
        break
    r.read()
    time.sleep(1)
if manifest is None:
    sys.exit("export did not complete within EXPORT_TIMEOUT_S")
total = 0
for o in manifest.get("output", []):
    try:
        r = urllib.request.urlopen(req(fix(o["url"]), {"Accept": "application/fhir+ndjson"}), timeout=600)
    except urllib.error.HTTPError as e:
        sys.exit("download %s failed: %s" % (o.get("type"), e.code))
    for line in r:
        if line.strip():
            total += 1
wall = time.perf_counter() - t0
if total == 0:
    sys.exit("export completed but returned 0 resources")
print("%d\t%.3f\t%.3f\t%.2f" % (total, wall, t_server, total / wall))
EOF
)

out=$(lib_py "$PY")
lib_record export_resources "$(echo "$out" | cut -f1)" resources
lib_record export_wall_s "$(echo "$out" | cut -f2)" s
lib_record export_server_wall_s "$(echo "$out" | cut -f3)" s
lib_record export_res_s "$(echo "$out" | cut -f4)" res/s
