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
export DEV API
TOK=$(az account get-access-token --resource https://dev.azuresynapse.net --query accessToken -o tsv | tr -d '\r')
echo "== list existing sessions (count by state) =="
TOK="$TOK" python3 "$CENSUS" census

echo "== CLEAN leaked/error/dead sessions (free the pool) =="
IDS=$(TOK="$TOK" python3 "$CENSUS" ids)
N=0
for id in $IDS; do
  TOK=$(az account get-access-token --resource https://dev.azuresynapse.net --query accessToken -o tsv | tr -d '\r')
  curl -s -X DELETE -H "Authorization: Bearer $TOK" "${DEV}/${API}/${id}" -o /dev/null && N=$((N+1))
done
echo "  deleted $N stale sessions"
sleep 10
TOK=$(az account get-access-token --resource https://dev.azuresynapse.net --query accessToken -o tsv | tr -d '\r')
echo "  after clean —"
TOK="$TOK" python3 "$CENSUS" census

echo "== MINIMAL session (1 exec / 1 core / 512m driver) — is it a quota issue? =="
MINRESP=$(curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" "${DEV}/${API}" -d '{"name":"loom-min-probe","kind":"pyspark","numExecutors":1,"executorCores":1,"executorMemory":"1g","driverCores":1,"driverMemory":"1g"}')
MID=$(echo "$MINRESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
echo "  minimal session id=$MID resp=$(echo "$MINRESP" | head -c 200)"
MSTATE=""
for i in $(seq 1 60); do
  TOK=$(az account get-access-token --resource https://dev.azuresynapse.net --query accessToken -o tsv | tr -d '\r')
  MSTATE=$(curl -s -H "Authorization: Bearer $TOK" "${DEV}/${API}/${MID}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('state',''))" 2>/dev/null)
  echo "  [min $i] state=$MSTATE"; case "$MSTATE" in idle|dead|error|killed) break;; esac; sleep 10
done
echo "  MINIMAL FINAL=$MSTATE"
[ "$MSTATE" = "idle" ] && echo "MINIMAL WORKS → the standard sizing exceeds available Spark vCore quota (raise quota / lower pool max)." || echo "::warning::MINIMAL also failed ($MSTATE) → pool cannot launch ANY app (Spark vCore quota exhausted/zero, or pool fault)."
curl -s -X DELETE -H "Authorization: Bearer $TOK" "${DEV}/${API}/${MID}" -o /dev/null || true

CONF='{}'
if [ "$WITH_LA" = "true" ]; then CONF='{"spark.synapse.logAnalytics.enabled":"true"}'; fi
echo "== create a probe session (conf=$CONF) =="
BODY=$(printf '{"name":"loom-livy-probe-%s","kind":"pyspark","numExecutors":2,"executorCores":4,"executorMemory":"4g","driverCores":4,"driverMemory":"4g","conf":%s}' "$RANDOM" "$CONF")
RESP=$(curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" "${DEV}/${API}" -d "$BODY")
echo "$RESP" | head -c 500; echo ""
SID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -z "$SID" ] && { echo "::error::session create returned no id — see body above"; exit 1; }
echo "== poll session $SID (up to ~14 min) =="
STATE=""
for i in $(seq 1 84); do
  TOK=$(az account get-access-token --resource https://dev.azuresynapse.net --query accessToken -o tsv | tr -d '\r')
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
