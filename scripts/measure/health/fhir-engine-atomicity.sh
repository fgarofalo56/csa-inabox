#!/usr/bin/env bash
# fhir-engine-atomicity.sh - W0-1: does a FAILED FHIR transaction bundle roll back fully?
#
# Usage:
#   ENGINE=medplum FHIR_BASE_URL=http://medplum:8103/fhir/R4 FHIR_BEARER_TOKEN=$(cat /work/medplum.token) \
#     bash scripts/measure/health/fhir-engine-atomicity.sh
#
# Why: the local smoke saw one Synthea bundle (an unmatched conditional reference) return HTTP 200 on Medplum
# with 486 of 496 entries acknowledged and a live count consistent with a PARTIAL commit; HAPI rejected the same
# bundle with 404 and kept nothing. This script settles it with a bundle built for the purpose.
#
# Method: four transaction bundles per engine, every entry tagged with a per-run, per-case marker
# (meta.tag system http://lhds.example/w0-atomicity). Each case = 5 valid Patients, then ONE bad LAST entry:
#   control_valid      no bad entry (6 valid Patients)                          POSITIVE CONTROL of the probe
#   bad_required       last entry: Observation without the required `status`
#   bad_condref        last entry: Observation whose subject is a conditional reference matching nothing
#                      (the shape that failed in the Synthea cohort)
#   bad_resourcetype   last entry: resource of an unknown resourceType
# After each POST the script counts what PERSISTED by searching Patient?_tag=<marker> (page walk, not a trusted
# total) and also reads the response's per-entry statuses. Verdict per case:
#   rolled_back      HTTP non-2xx AND persisted = 0
#   partial_commit   persisted between 1 and the number of valid Patients (the failure kept some entries)
#   all_persisted    persisted = all valid Patients although the bundle had a bad entry (bad entry ignored or
#                    only that entry failed)
#   accepted         HTTP 2xx and every entry 2xx (only expected for the control)
# Records (to $RESULTS_DIR/<ENGINE>-atomicity.tsv, NOT <ENGINE>.tsv: the report's copy-paste control must not see
# it): atomicity_<case>_{http,entries_2xx,persisted,verdict}.
#
# FAILS (exit 1) when the probe is blind: the control bundle must persist exactly 6 and be counted as 6. If it is
# not, "persisted 0" for the bad cases would be a counting failure, not a rollback, and nothing is recorded.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fhir-engine-lib.sh
source "$HERE/fhir-engine-lib.sh"
lib_init
lib_require_env FHIR_BASE_URL
RESULT_FILE="$RESULTS_DIR/$ENGINE-atomicity.tsv"
export RESULT_FILE

PY=$(
  cat <<'EOF'
import json, os, secrets, sys, urllib.request, urllib.error

base = os.environ["FHIR_BASE_URL"].rstrip("/")
token = os.environ.get("FHIR_BEARER_TOKEN", "")
SYS = "http://lhds.example/w0-atomicity"
run = secrets.token_hex(4)

def call(method, path, body=None):
    url = path if path.startswith("http") else (base + "/" + path if path else base)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/fhir+json")
    if body is not None:
        req.add_header("Content-Type", "application/fhir+json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw[:200].decode("utf-8", "replace")}

def tag(case):
    return {"system": SYS, "code": "%s-%s" % (run, case)}

def uuid():
    h = secrets.token_hex(16)
    return "%s-%s-4%s-8%s-%s" % (h[:8], h[8:12], h[13:16], h[17:20], h[20:32])

def valid_patient(case, i):
    return {"fullUrl": "urn:uuid:" + uuid(),
            "resource": {"resourceType": "Patient", "meta": {"tag": [tag(case)]},
                         "name": [{"family": "Atomicity%s" % run, "given": ["C%s%d" % (case[:3], i)]}]},
            "request": {"method": "POST", "url": "Patient"}}

def bad_last(case, kind):
    if kind == "bad_required":
        res = {"resourceType": "Observation", "meta": {"tag": [tag(case)]},
               "code": {"coding": [{"system": "http://loinc.org", "code": "8867-4"}]}}  # no status: required 1..1
    elif kind == "bad_condref":
        res = {"resourceType": "Observation", "status": "final", "meta": {"tag": [tag(case)]},
               "code": {"coding": [{"system": "http://loinc.org", "code": "8867-4"}]},
               "subject": {"reference": "Patient?identifier=http://lhds.example/none|no-such-%s" % run}}
    else:
        res = {"resourceType": "NotAResourceType", "meta": {"tag": [tag(case)]}}
    return {"fullUrl": "urn:uuid:" + uuid(), "resource": res, "request": {"method": "POST", "url": res["resourceType"]}}

def persisted(case):
    """Walk Patient?_tag=... pages and count entries. Not a trusted `total`: counts what the engine returns."""
    n = 0
    st, b = call("GET", "Patient?_tag=%s%%7C%s-%s&_count=50" % (SYS, run, case))
    while True:
        if st != 200:
            sys.exit("persisted-count search failed for %s: HTTP %s" % (case, st))
        n += len(b.get("entry", []))
        nxt = [l["url"] for l in b.get("link", []) if l.get("relation") == "next"]
        if not nxt:
            return n
        st, b = call("GET", nxt[0])

cases = ["control_valid", "bad_required", "bad_condref", "bad_resourcetype"]
NVALID = {"control_valid": 6}
out = []
control_ok = None
for case in cases:
    nvalid = NVALID.get(case, 5)
    entries = [valid_patient(case, i) for i in range(nvalid)]
    if case != "control_valid":
        entries.append(bad_last(case, case))
    st, resp = call("POST", "", {"resourceType": "Bundle", "type": "transaction", "entry": entries})
    ents = resp.get("entry", []) if isinstance(resp, dict) else []
    good = sum(1 for e in ents if str(e.get("response", {}).get("status", "")).startswith("2"))
    per = persisted(case)
    if case == "control_valid":
        control_ok = (200 <= st < 300 and per == nvalid)
        if not control_ok:
            sys.exit("probe is blind: control bundle HTTP %s persisted %d, expected 2xx and %d. Not recording." % (st, per, nvalid))
    two_xx = 200 <= st < 300
    if two_xx and good == len(entries) and per == nvalid:
        verdict = "accepted"
    elif (not two_xx) and per == 0:
        verdict = "rolled_back"
    elif 0 < per < nvalid:
        verdict = "partial_commit"
    elif per == nvalid:
        verdict = "all_persisted"
    else:
        verdict = "unclassified"
    oo = ""
    if isinstance(resp, dict) and resp.get("resourceType") == "OperationOutcome":
        oo = (resp.get("issue", [{}])[0].get("diagnostics") or resp["issue"][0].get("details", {}).get("text", ""))[:140]
    # Per-entry statuses of the non-2xx entries: a 200 bundle response whose bad entry says 400/404/412 is the whole
    # evidence that the engine reported entry-level failure instead of failing the transaction.
    bad = ["#%d:%s" % (i, e.get("response", {}).get("status", "?")) for i, e in enumerate(ents)
           if not str(e.get("response", {}).get("status", "")).startswith("2")]
    if bad:
        oo = (oo + " entry-statuses " + " ".join(bad[:5])).strip()
    out.append((case, st, good, len(entries), per, nvalid, verdict, oo))
for case, st, good, n, per, nvalid, verdict, oo in out:
    print("%s\t%s\t%d\t%d\t%d\t%s\t%s" % (case, st, good, n, per, verdict, oo.replace("\t", " ").replace("\n", " ")))
EOF
)

res=$(lib_py "$PY")
echo "case	http	entries_2xx(of n)	persisted	verdict	detail" >&2
while IFS=$'\t' read -r case http good nent persisted verdict detail; do
  lib_record "atomicity_${case}_http" "$http" status
  lib_record "atomicity_${case}_entries_sent" "$nent" entries
  lib_record "atomicity_${case}_entries_2xx" "$good" entries
  lib_record "atomicity_${case}_persisted" "$persisted" patients
  lib_record "atomicity_${case}_verdict" "$verdict" verdict
  echo "DETAIL $case: ${detail:-none}"
done <<<"$res"
