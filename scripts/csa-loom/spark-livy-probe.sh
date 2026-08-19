#!/usr/bin/env bash
# spark-livy-probe.sh — Synapse Spark Livy session probe (in-VNET diagnostic).
# ---------------------------------------------------------------------------
# Invoked by .github/workflows/csa-loom-spark-livy-probe.yml and
# csa-loom-spark-probe2.yml (identical probes; one script so they cannot
# drift). Extracted from their `run:` blocks per #3034: the embedded Python
# one-liners sat at column 0 inside the YAML block scalar, which terminated
# the scalar and made BOTH workflow files invalid YAML — GitHub created runs
# with jobs=0 and the probe never executed once. Python belongs in a script
# file, not escaped into a workflow.
#
# What it does: creates a Synapse Spark Livy session IN-VNET (the dev API is
# private-endpoint-locked, 403 from a public runner) with a MINIMAL config,
# polls it to idle/dead, and dumps the session state + driver log so we can
# see the REAL reason interactive Spark sessions fail to start. Read-only
# probe; it shuts the session down after.
#
# Required env (the workflow provides these):
#   SYN_WS   Synapse workspace name (e.g. syn-loom-default-centralus)
#   POOL     Spark pool name (e.g. loompool)
#   WITH_LA  "true" to include the Log Analytics emitter conf in the A/B probe
set -uo pipefail
# NOT `set -e`, and that is a decision rather than an omission. This is a
# DIAGNOSTIC probe whose entire value is reaching the driver-log dump at the
# bottom; the poll loops deliberately tolerate one malformed body and retry on
# the next turn, so a blanket `-e` would abort mid-poll and throw away the very
# output the probe exists to collect.
#
# The cost of that choice is that a failing command in a `$(...)` or a plain
# statement is SILENTLY DISCARDED — which is exactly how #3689's review found
# this file still swallowing the census's brand-new non-zero exit: both callers
# invoke it as `bash spark-livy-probe.sh`, so deleting the census's `|| true`
# moved the swallow up one level instead of removing it. Measured before the
# fix: a 500ing census printed three `::error::` lines, `deleted 0 stale
# sessions`, and the script still exited 0.
#
# So instead of a blanket flag, EVERY command whose failure would make the
# output a LIE is checked explicitly. Audited one-by-one in #3689: both census
# calls, all five token acquisitions, the census helper's own path, and both
# session-create ids. The remaining unchecked substitutions are the in-loop
# state polls, which are retried by design and whose failure is visible in the
# printed `state=` line.

: "${SYN_WS:?SYN_WS (Synapse workspace name) must be set by the caller}"
: "${POOL:?POOL (Spark pool name) must be set by the caller}"
WITH_LA="${WITH_LA:-false}"

DEV="https://${SYN_WS}.dev.azuresynapse.net"
API="livyApi/versions/2019-11-01-preview/sparkPools/${POOL}/sessions"
# Livy caps the sessions list at `size=20` per request ("By default it is 20 and
# that is the maximum" — Learn), so the `size=100` this probe used was either
# 400ing or being silently clamped. Combined with the `|| true` / `2>/dev/null`
# on those lines, a failed census printed as `by state: {}` — i.e. the probe
# built to diagnose the #1796 700-session jam would have reported no jam. A bare
# clamp to 20 would be no better (the first 20 of 700 presented as the total),
# so the census pages properly and declares completeness. See #3568.
CENSUS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/livy-session-census.py"
[ -f "$CENSUS" ] || { echo "::error::census helper not found at '$CENSUS' — refusing to run a probe that cannot enumerate the pool" >&2; exit 1; }
export DEV API

# Fail-closed token acquisition. An empty TOK is NOT a benign default: every
# call below it 401s, the session never starts, and the probe's closing line
# blames Spark ("pool cannot launch ANY app") for what was actually a missing
# credential — `deploy-integrity.md` R7, an error asserting a cause the code
# never established. Assigns the global rather than echoing, because an `exit`
# inside a `$(...)` only kills the SUBSHELL and would leave the same swallow in
# place one level down.
TOK=""
acquire_token() {
  local t rc
  t=$(az account get-access-token --resource https://dev.azuresynapse.net --query accessToken -o tsv)
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "::error::could not acquire a Synapse dev-plane token (az exited $rc) — aborting the probe rather than 401ing every call below and reporting it as a Spark failure" >&2
    return 1
  fi
  t=$(printf '%s' "$t" | tr -d '\r')
  if [ -z "$t" ]; then
    echo "::error::az returned an EMPTY access token — aborting the probe rather than 401ing every call below and reporting it as a Spark failure" >&2
    return 1
  fi
  TOK="$t"
}

# The census is the probe's ground truth: every line after it describes a pool
# it claims to have read. If it could not read the pool, there is nothing
# honest left to print, so this aborts instead of continuing on unknowns.
run_census() {
  if ! TOK="$TOK" python3 "$CENSUS" census; then
    echo "::error::livy session census FAILED — aborting the probe. A probe that cannot enumerate the pool cannot tell a 700-session jam (#1796) from an empty pool, and every line below would be describing a pool it never read." >&2
    exit 1
  fi
}

acquire_token || exit 1
echo "== list existing sessions (count by state) =="
run_census

echo "== CLEAN leaked/error/dead sessions (free the pool) =="
IDS=$(TOK="$TOK" python3 "$CENSUS" ids) || {
  echo "::error::could not enumerate reapable session ids — aborting rather than printing 'deleted 0 stale sessions', which reads as a clean pool" >&2
  exit 1
}
N=0
for id in $IDS; do
  acquire_token || exit 1
  curl -s -X DELETE -H "Authorization: Bearer $TOK" "${DEV}/${API}/${id}" -o /dev/null && N=$((N+1))
done
echo "  deleted $N stale sessions"
sleep 10
acquire_token || exit 1
echo "  after clean —"
run_census

echo "== MINIMAL session (1 exec / 1 core / 512m driver) — is it a quota issue? =="
MINRESP=$(curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" "${DEV}/${API}" -d '{"name":"loom-min-probe","kind":"pyspark","numExecutors":1,"executorCores":1,"executorMemory":"1g","driverCores":1,"driverMemory":"1g"}')
MID=$(echo "$MINRESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
echo "  minimal session id=$MID resp=$(echo "$MINRESP" | head -c 200)"
MSTATE=""
if [ -z "$MID" ]; then
  # No id means the create never happened. The old code polled `${DEV}/${API}/`
  # — a trailing slash and no id, i.e. the session LIST, whose body has no
  # `state` — so MSTATE stayed empty for 60 turns and the probe concluded
  # "MINIMAL also failed → Spark vCore quota exhausted". That asserts a quota
  # cause for what was actually a failed REQUEST. R7: report what we know.
  echo "::warning::minimal session was NOT created (no id in the response above) — the quota question is UNANSWERED, not answered 'no'."
else
  for i in $(seq 1 60); do
    acquire_token || exit 1
    MSTATE=$(curl -s -H "Authorization: Bearer $TOK" "${DEV}/${API}/${MID}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('state',''))" 2>/dev/null)
    echo "  [min $i] state=$MSTATE"; case "$MSTATE" in idle|dead|error|killed) break;; esac; sleep 10
  done
  echo "  MINIMAL FINAL=$MSTATE"
  [ "$MSTATE" = "idle" ] && echo "MINIMAL WORKS → the standard sizing exceeds available Spark vCore quota (raise quota / lower pool max)." || echo "::warning::MINIMAL also failed ($MSTATE) → pool cannot launch ANY app (Spark vCore quota exhausted/zero, or pool fault)."
  curl -s -X DELETE -H "Authorization: Bearer $TOK" "${DEV}/${API}/${MID}" -o /dev/null || true
fi

CONF='{}'
if [ "$WITH_LA" = "true" ]; then CONF='{"spark.synapse.logAnalytics.enabled":"true"}'; fi
echo "== create a probe session (conf=$CONF) =="
BODY=$(printf '{"name":"loom-livy-probe-%s","kind":"pyspark","numExecutors":2,"executorCores":4,"executorMemory":"4g","driverCores":4,"driverMemory":"4g","conf":%s}' "$RANDOM" "$CONF")
acquire_token || exit 1
RESP=$(curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" "${DEV}/${API}" -d "$BODY")
echo "$RESP" | head -c 500; echo ""
SID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -z "$SID" ] && { echo "::error::session create returned no id — see body above"; exit 1; }
echo "== poll session $SID (up to ~14 min) =="
STATE=""
for i in $(seq 1 84); do
  acquire_token || exit 1
  J=$(curl -s -H "Authorization: Bearer $TOK" "${DEV}/${API}/${SID}")
  STATE=$(echo "$J" | python3 -c "import sys,json;print(json.load(sys.stdin).get('state',''))" 2>/dev/null)
  echo "[$i] state=$STATE"
  case "$STATE" in idle|dead|error|killed|success) break;; esac
  sleep 10
done
echo "== FINAL state=$STATE =="
echo "== driver log (the real error) =="
curl -s -H "Authorization: Bearer $TOK" "${DEV}/${API}/${SID}/log?from=0&size=200" | python3 -c "import sys,json;d=json.load(sys.stdin);[print(l) for l in (d.get('log') or [])[-120:]]" 2>/dev/null || echo "(no log)"
echo "== full session object =="
curl -s -H "Authorization: Bearer $TOK" "${DEV}/${API}/${SID}" | python3 -m json.tool | head -60 || true
echo "== cleanup: delete probe session =="
curl -s -X DELETE -H "Authorization: Bearer $TOK" "${DEV}/${API}/${SID}" -o /dev/null -w "delete HTTP %{http_code}\n" || true
[ "$STATE" = "idle" ] && echo "PROBE: session reached IDLE (Spark works; the slowness is cold-start/keep-warm)" || echo "::warning::PROBE: session did NOT reach idle (state=$STATE) — the driver log above has the reason"
