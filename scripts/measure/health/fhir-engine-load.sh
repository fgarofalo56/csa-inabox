#!/usr/bin/env bash
# fhir-engine-load.sh - W0-1: bulk-load a Synthea FHIR bundle directory into a FHIR engine and
# record resources posted, wall time and resources/second.
#
# Usage:
#   ENGINE=hapi FHIR_BASE_URL=http://localhost:8080/fhir COHORT_DIR=./temp/lhds-w0/l1/cohort/fhir \
#     [LOAD_CONCURRENCY=4] [PG_DOCKER_CONTAINER=...] bash scripts/measure/health/fhir-engine-load.sh
#
# Env: see fhir-engine-lib.sh. Extra:
#   COHORT_DIR         directory of Synthea *.json transaction bundles (required)
#   LOAD_TOLERATE_FAILURES  bundles allowed to fail (default 0). Non-zero is for known-bad Synthea
#                      bundles (conditional reference to an unmatched Location); the count is
#                      recorded as bundles_failed and must be disclosed next to the throughput.
#   LOAD_CONCURRENCY   parallel POSTs for patient bundles (default 1; shared files are always serial)
#
# Order: hospitalInformation*.json and practitionerInformation*.json first (patient bundles reference
# them), then patient bundles. Resources posted = sum of entry[] counts of every bundle that returned
# 2xx. If PG env is available the script also records pg_bytes_before_load (schema floor, taken
# BEFORE the first POST) and the SQL-side resource count after load.
#
# FAILS (exit 1) when: no bundle files; more than LOAD_TOLERATE_FAILURES bundles return non-2xx; SQL resource count after load is
# below 90% of resources posted (the engine acknowledged writes it did not keep).

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fhir-engine-lib.sh
source "$HERE/fhir-engine-lib.sh"
lib_init
lib_require_env FHIR_BASE_URL COHORT_DIR
[ -d "$COHORT_DIR" ] || lib_die "COHORT_DIR '$COHORT_DIR' is not a directory"
LOAD_CONCURRENCY="${LOAD_CONCURRENCY:-1}"

HAVE_PG=0
if [ -n "${PG_DOCKER_CONTAINER:-}" ] || [ -n "${PGHOST:-}" ]; then HAVE_PG=1; fi

PY=$(
  cat <<'EOF'
import json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

base = os.environ["FHIR_BASE_URL"].rstrip("/")
token = os.environ.get("FHIR_BEARER_TOKEN", "")
conc = int(os.environ["LOAD_CONCURRENCY"])
files_shared = [f for f in sys.argv[1].split("\n") if f]
files_patient = [f for f in sys.argv[2].split("\n") if f]

def post(path):
    with open(path, "rb") as fh:
        body = fh.read()
    n = len(json.loads(body).get("entry", []))
    req = urllib.request.Request(base, data=body, method="POST")
    req.add_header("Content-Type", "application/fhir+json")
    req.add_header("Accept", "application/fhir+json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            resp = json.loads(r.read() or b'{}')
            # A transaction can return HTTP 2xx while individual entries failed (Medplum returns
            # per-entry 429s when its FHIR quota is exhausted). Count only entries whose own
            # response.status is 2xx; anything else makes the bundle a failure.
            ents = resp.get("entry", [])
            good = sum(1 for e in ents if str(e.get("response", {}).get("status", "")).startswith("2"))
            if resp.get("resourceType") != "Bundle" or good != n:
                return path, 0, 599, "2xx but only %d/%d entries acknowledged 2xx" % (good, n)
            return path, n, r.status, ""
    except urllib.error.HTTPError as e:
        return path, 0, e.code, e.read()[:300].decode("utf-8", "replace")
    except Exception as e:  # connection reset etc: report, do not swallow
        return path, 0, -1, repr(e)

t0 = time.perf_counter()
results = [post(f) for f in files_shared]
with ThreadPoolExecutor(max_workers=conc) as ex:
    results += list(ex.map(post, files_patient))
wall = time.perf_counter() - t0

bad = [r for r in results if not (200 <= r[2] < 300)]
posted = sum(r[1] for r in results)
for r in bad[:5]:
    print("FAILED %s status=%s %s" % (os.path.basename(r[0]), r[2], r[3]), file=sys.stderr)
print("%d\t%d\t%.3f\t%d" % (posted, len(results), wall, len(bad)))
EOF
)

shared=$(find "$COHORT_DIR" -maxdepth 1 -name '*.json' \( -name 'hospitalInformation*' -o -name 'practitionerInformation*' \) | sort)
patient=$(find "$COHORT_DIR" -maxdepth 1 -name '*.json' ! -name 'hospitalInformation*' ! -name 'practitionerInformation*' | sort)
[ -n "$patient" ] || lib_die "no patient bundles under $COHORT_DIR (this fails when the directory is empty or wrong)"

if [ "$HAVE_PG" = 1 ]; then
  lib_record pg_bytes_before_load "$(lib_pg_total_bytes)" bytes
fi

out=$(lib_py "$PY" "$shared" "$patient")
posted=$(echo "$out" | cut -f1)
nfiles=$(echo "$out" | cut -f2)
wall=$(echo "$out" | cut -f3)
nbad=$(echo "$out" | cut -f4)
LOAD_TOLERATE_FAILURES="${LOAD_TOLERATE_FAILURES:-0}"
if [ "$nbad" -gt "$LOAD_TOLERATE_FAILURES" ]; then
  lib_die "$nbad of $nfiles bundles returned non-2xx, above LOAD_TOLERATE_FAILURES=$LOAD_TOLERATE_FAILURES (see FAILED lines above); not recording a throughput for a partial load"
fi
lib_record bundles_failed "$nbad" bundles
[ "$posted" -gt 0 ] || lib_die "0 resources posted"

rate=$(lib_py "import sys; print('%.2f' % (float(sys.argv[1])/float(sys.argv[2])))" "$posted" "$wall")
lib_record resources_posted "$posted" resources
lib_record bundles_attempted "$nfiles" bundles
lib_record load_concurrency "$LOAD_CONCURRENCY" threads
lib_record load_wall_s "$wall" s
lib_record load_res_s "$rate" res/s

if [ "$HAVE_PG" = 1 ]; then
  stored=$(lib_pg_resource_count)
  lib_record resources_stored_sql "$stored" resources
  # Failing value: stored < 0.9 * posted
  if [ "$((stored * 10))" -lt "$((posted * 9))" ]; then
    lib_die "SQL shows $stored stored resources vs $posted posted (<90%): the engine acknowledged writes it did not keep, or the SQL count query does not match this engine's schema"
  fi
fi
