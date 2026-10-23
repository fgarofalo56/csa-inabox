#!/usr/bin/env bash
# fhir-engine-query.sh - W0-1: the L1 request mix and the ADR-008 / CAPACITY-MODEL section 4
# search patterns against one FHIR engine, with p95 per pattern. Python-stdlib timer (urllib +
# threads, time.perf_counter); no k6 dependency. Documented limitation: a Python client tops out
# well below an engine's ceiling, so req/s here is a LOWER BOUND on the engine and the p95 is
# client-observed (includes loopback/docker-proxy hops).
#
# Usage:
#   ENGINE=hapi FHIR_BASE_URL=http://localhost:8080/fhir \
#     [PATTERN_REQUESTS=200] [MIX_SECONDS=60] [MIX_CONCURRENCY=8] [MIX_WRITE_PCT=5] \
#     bash scripts/measure/health/fhir-engine-query.sh
#
# Phase 1 (per pattern, concurrency 1, PATTERN_REQUESTS each): records p95_<pattern> ms. Concurrency 1
#   so the number is latency, not queueing.
# Phase 2 (L1 mix, MIX_CONCURRENCY threads for MIX_SECONDS): reads weighted by the assumed pattern
#   frequency ranking in CAPACITY-MODEL section 4, plus MIX_WRITE_PCT % Observation creates
#   (CAPACITY-MODEL 1.3: 20 reads per write ~ 4.8 %; default 5). Records mix_req_s, mix_p95_ms,
#   mix_requests, mix_errors.
# Parameters are sampled from the loaded data (patient ids, identifiers, names, birthdates, a
# location) - nothing is hard-coded to a particular cohort.
#
# FAILS (exit 1) when: no patients can be sampled; a pattern returns >1% non-2xx; the mix has >1%
# errors (an error-dominated run is fast, so it must not produce a throughput number).
# Pattern 7 (ImagingStudy) and others legitimately return 0 hits on a Synthea cohort; the script
# records p<N>_mean_hits so an empty-result pattern is visible rather than silently "fast".

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fhir-engine-lib.sh
source "$HERE/fhir-engine-lib.sh"
lib_init
lib_require_env FHIR_BASE_URL
export PATTERN_REQUESTS="${PATTERN_REQUESTS:-200}"
export MIX_SECONDS="${MIX_SECONDS:-60}"
export MIX_CONCURRENCY="${MIX_CONCURRENCY:-8}"
export MIX_WRITE_PCT="${MIX_WRITE_PCT:-5}"

PY=$(
  cat <<'EOF'
import json, os, random, sys, threading, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

base = os.environ["FHIR_BASE_URL"].rstrip("/")
token = os.environ.get("FHIR_BEARER_TOKEN", "")
N = int(os.environ["PATTERN_REQUESTS"])
SECS = float(os.environ["MIX_SECONDS"])
CONC = int(os.environ["MIX_CONCURRENCY"])
WPCT = float(os.environ["MIX_WRITE_PCT"])
rnd = random.Random(42)  # fixed seed: same parameter draw for both engines

def call(method, path, body=None):
    url = path if path.startswith("http") else base + "/" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/fhir+json")
    if body is not None:
        req.add_header("Content-Type", "application/fhir+json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return (time.perf_counter() - t) * 1000.0, r.status, raw
    except urllib.error.HTTPError as e:
        return (time.perf_counter() - t) * 1000.0, e.code, e.read()
    except Exception as e:
        return (time.perf_counter() - t) * 1000.0, -1, repr(e).encode()

def p95(xs):
    s = sorted(xs)
    return s[min(len(s) - 1, int(round(0.95 * len(s) + 0.5)) - 1)]

# ---- sample parameters from the loaded data
st, raw = call("GET", "Patient?_count=200")[1:]
if st != 200:
    sys.exit("cannot sample patients: status %s %s" % (st, raw[:200]))
pats = [e["resource"] for e in json.loads(raw).get("entry", []) if "resource" in e]
if not pats:
    sys.exit("no Patient resources found: nothing loaded, or the base URL is wrong")
pids = [p["id"] for p in pats]
idents = [i["value"] for p in pats for i in p.get("identifier", [])[:1] if i.get("value")]
fams = [p["name"][0]["family"] for p in pats if p.get("name") and p["name"][0].get("family")]
bds = [p["birthDate"] for p in pats if p.get("birthDate")]
loc = None
_, s2, r2 = call("GET", "Encounter?_count=50")
if s2 == 200:
    for e in json.loads(r2).get("entry", []):
        for l in e["resource"].get("location", []):
            ref = l.get("location", {}).get("reference", "")
            if ref.startswith("Location/"):
                loc = ref.split("/", 1)[1]
                break
        if loc:
            break
doc_type = None
_, s3, r3 = call("GET", "DocumentReference?_count=20")
if s3 == 200:
    for e in json.loads(r3).get("entry", []):
        c = e["resource"].get("type", {}).get("coding", [])
        if c:
            doc_type = "%s|%s" % (c[0].get("system", ""), c[0].get("code", ""))
            break

def pid(): return rnd.choice(pids)
patterns = {
    "P1_patient_identifier": lambda: "Patient?identifier=" + rnd.choice(idents),
    "P2_observation_vitals": lambda: "Observation?patient=%s&category=vital-signs&date=ge2000-01-01&_sort=-date&_count=100" % pid(),
    "P3_condition": lambda: "Condition?patient=" + pid(),
    "P3_medicationrequest": lambda: "MedicationRequest?patient=" + pid(),
    "P3_allergyintolerance": lambda: "AllergyIntolerance?patient=" + pid(),
    "P4_encounter_patient_date": lambda: "Encounter?patient=%s&date=ge2000-01-01" % pid(),
    "P5_documentreference": lambda: "DocumentReference?patient=%s&date=ge2000-01-01%s" % (pid(), ("&type=" + doc_type) if doc_type else ""),
    "P6_patient_name_birthdate": lambda: "Patient?name=%s&birthdate=%s" % (rnd.choice(fams), rnd.choice(bds)),
    "P7_imagingstudy": lambda: "ImagingStudy?patient=" + pid(),
    "P9_lastupdated_scan": lambda: "Observation?_lastUpdated=ge2000-01-01&_count=100",
}
if loc:
    patterns["P4_encounter_location_date"] = lambda: "Encounter?location=%s&date=ge2000-01-01" % loc
else:
    print("NOTE: no Encounter.location found; P4_encounter_location_date not measured", file=sys.stderr)
weights = {  # CAPACITY-MODEL section 4 ranking -> weights (documented, not measured)
    "P1_patient_identifier": 30, "P2_observation_vitals": 20, "P3_condition": 5,
    "P3_medicationrequest": 5, "P3_allergyintolerance": 5, "P4_encounter_patient_date": 8,
    "P4_encounter_location_date": 2, "P5_documentreference": 8, "P6_patient_name_birthdate": 6,
    "P7_imagingstudy": 3, "P9_lastupdated_scan": 2,
}

out = []  # (metric, value, unit)
for name, mk in patterns.items():
    lat, errs, hits = [], 0, []
    for _ in range(N):
        ms, status, raw = call("GET", mk())
        lat.append(ms)
        if not (200 <= status < 300):
            errs += 1
        else:
            try: hits.append(len(json.loads(raw).get("entry", [])))
            except ValueError: errs += 1
    if errs * 100 > N:
        sys.exit("pattern %s: %d/%d requests failed (>1%%); refusing to publish a latency for a failing query" % (name, errs, N))
    out.append(("p95_" + name, "%.1f" % p95(lat), "ms"))
    out.append(("p50_" + name, "%.1f" % sorted(lat)[len(lat) // 2], "ms"))
    out.append(("mean_hits_" + name, "%.1f" % (sum(hits) / max(1, len(hits))), "entries/page"))

# ---- phase 2: mix
names = [n for n in patterns]
wts = [weights.get(n, 1) for n in names]
lock = threading.Lock()
lat_all, errs_all = [], [0]
stop = time.perf_counter() + SECS
def worker(seed):
    r = random.Random(seed)
    while time.perf_counter() < stop:
        if r.random() * 100 < WPCT:
            body = {"resourceType": "Observation", "status": "final",
                    "code": {"coding": [{"system": "http://loinc.org", "code": "8867-4"}]},
                    "subject": {"reference": "Patient/" + r.choice(pids)},
                    "valueQuantity": {"value": 60 + r.random() * 40, "unit": "/min"}}
            ms, status, _ = call("POST", "Observation", body)
        else:
            n = r.choices(names, weights=wts)[0]
            ms, status, _ = call("GET", patterns[n]())
        with lock:
            lat_all.append(ms)
            if not (200 <= status < 300): errs_all[0] += 1
t0 = time.perf_counter()
with ThreadPoolExecutor(max_workers=CONC) as ex:
    list(ex.map(worker, range(1000, 1000 + CONC)))
wall = time.perf_counter() - t0
if not lat_all:
    sys.exit("mix issued 0 requests")
if errs_all[0] * 100 > len(lat_all):
    sys.exit("mix: %d/%d requests failed (>1%%); refusing to publish a throughput for an error-dominated run" % (errs_all[0], len(lat_all)))
out += [("mix_requests", str(len(lat_all)), "requests"), ("mix_errors", str(errs_all[0]), "requests"),
        ("mix_req_s", "%.1f" % (len(lat_all) / wall), "req/s"), ("mix_p95_ms", "%.1f" % p95(lat_all), "ms"),
        ("mix_concurrency", str(CONC), "threads")]
for m, v, u in out:
    print("%s\t%s\t%s" % (m, v, u))
EOF
)

res=$(lib_py "$PY")
while IFS=$'\t' read -r m v u; do
  lib_record "$m" "$v" "$u"
done <<<"$res"
