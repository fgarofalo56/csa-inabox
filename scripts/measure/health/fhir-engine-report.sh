#!/usr/bin/env bash
# fhir-engine-report.sh - W0-1: print the receipt table from the per-engine result files written by
# fhir-engine-{load,bytes,query,export}.sh, and FAIL when the table cannot be trusted.
#
# Usage:
#   RESULTS_DIR=./temp/lhds-w0/results [ENGINES="hapi medplum"] bash scripts/measure/health/fhir-engine-report.sh
#
# Reads $RESULTS_DIR/<engine>.tsv (metric, value, unit, context). Prints one row per metric and one
# column per engine, then the context stamp of each engine's file.
#
# EXIT CODES
#   0  every required cell is non-empty for every engine AND the engines' core numbers differ
#   1  a result file is missing, or a required cell is EMPTY (the failing cell is named)
#   2  copy-paste control: for any CORE metric (bytes_per_resource, load_res_s, mix_req_s,
#      mix_p95_ms, export_res_s) two engines report the identical value. Two different engines on
#      identical hardware will not agree to the printed precision on a measured throughput or size;
#      identical numbers mean one engine's file was copied or one engine was measured twice.
#      (resources_posted is exempt: both engines load the same cohort, so equal counts are correct.)
#   3  the receipt contexts differ between engines (a sandbox number next to a local-smoke number
#      is not a comparison)
#
# Required cells (a cell is empty if the metric line is absent or its value is blank):
#   resources_posted bytes_per_resource load_res_s p95_<each ADR-008 pattern measured by the
#   query script> mix_req_s mix_p95_ms export_res_s
# The pattern list is taken from the UNION of p95_* metrics found in any engine's file, so a pattern
# one engine skipped shows as an empty cell for that engine instead of vanishing from the table.

set -euo pipefail
RESULTS_DIR="${RESULTS_DIR:-./temp/lhds-w0/results}"
ENGINES="${ENGINES:-hapi medplum}"
export RESULTS_DIR ENGINES

PY=$(
  cat <<'EOF'
import os, sys
engines = os.environ["ENGINES"].split()
d = os.environ["RESULTS_DIR"]
data, ctx, unit = {}, {}, {}
for e in engines:
    p = os.path.join(d, e + ".tsv")
    if not os.path.isfile(p):
        print("MISSING result file for engine %s: %s" % (e, p), file=sys.stderr)
        sys.exit(1)
    data[e] = {}
    for line in open(p):
        parts = line.rstrip("\r\n").split("\t")
        if len(parts) < 4:
            continue
        m, v, u, c = parts[:4]
        data[e][m] = v.strip()
        unit[m] = u
        ctx.setdefault(e, set()).add(c)
core = ["bytes_per_resource", "load_res_s", "mix_req_s", "mix_p95_ms", "export_res_s"]
p95s = sorted(set(m for e in engines for m in data[e] if m.startswith("p95_")))
required = ["resources_posted", "bytes_per_resource", "load_res_s"] + p95s + ["mix_req_s", "mix_p95_ms", "export_res_s"]
extra = ["bytes_per_resource_gross", "load_wall_s", "mix_requests", "mix_errors", "bundles_failed", "export_resources"]
rows = required + [m for m in extra if any(m in data[e] for e in engines)]

w = max(len(m) for m in rows)
print("%-*s  %-12s " % (w, "metric", "unit") + " ".join("%-14s" % e for e in engines))
empty = []
for m in rows:
    cells = []
    for e in engines:
        v = data[e].get(m, "")
        if not v and m in required:
            empty.append((e, m))
        cells.append("%-14s" % (v if v else "<EMPTY>"))
    print("%-*s  %-12s " % (w, m, unit.get(m, "")) + " ".join(cells))
print("")
for e in engines:
    print("context[%s] = %s" % (e, ",".join(sorted(ctx.get(e, {"?"})))))
if empty:
    for e, m in empty:
        print("EMPTY CELL: engine=%s metric=%s" % (e, m), file=sys.stderr)
    sys.exit(1)
cs = set(frozenset(ctx[e]) for e in engines)
if len(cs) > 1:
    print("CONTEXT MISMATCH between engines", file=sys.stderr)
    sys.exit(3)
if len(engines) > 1:
    for m in core:
        vals = [data[e][m] for e in engines]
        if len(set(vals)) < len(vals):
            print("COPY-PASTE CONTROL FAILED: core metric %s has identical values across engines: %s" % (m, vals), file=sys.stderr)
            sys.exit(2)
print("OK: all required cells non-empty; core metrics differ across engines")
EOF
)
python -I -c "$PY"
