#!/usr/bin/env bash
# LHDS W2-2: run the per-tenant engine config (config/application.yaml) against the PINNED HAPI image and a
# real PostgreSQL 16, and check the behaviours the W2-2 acceptance names. Local Docker only; nothing here
# touches Azure. Every check names the value that would make it fail.
#
#   sh config/probe/engine-config-probe.sh            # up, check, down; exit 0 only if every check passed
#   LHDS_PROBE_KEEP=yes ...                           # leave the containers up (debug)
#
# Checks (FAIL text names the breaking value):
#   C1 partition mode is ON         log must say "Database Partition Mode Enabled: true" (a misplaced key logs false)
#   C2 no partition segment = 400   fail closed: a request outside any partition must not reach the default one
#   C3 validation on write          Observation with no `status` -> 422; the same body with status -> 201
#   C4 RI on write                  Observation -> Patient/<missing> rejected; -> existing Patient accepted
#   C5 RI on delete                 delete of a referenced Patient rejected; accepted once the referrer is gone
#   C6 conditional create           50 parallel If-None-Exist creates -> exactly 1 resource (fails at 2)
#   C7 history is bounded           statements for a 40-version history read - for a 5-version one <= BOUND
#   C8 multi-delete / expunge off   DELETE /Patient?... is rejected; $expunge is rejected
#   C9 env caps bind over the file  restart with max 5 / default 3 (file: 200 / 20) -> 5 / 3 entries
# Controls (each makes a check able to fail): C3b, C4b, C5b, C6-control (50 unconditional creates -> 50),
# C7-fixture (history really has 40 versions), C7-control (counter sees 35 extra reads), C9-control (file default 20).
# KNOWN BLIND ARM: conditional_create_duplicate_identifiers_enabled=true does NOT turn C6 red (measured in a
# sandbox mutation run), so C6 witnesses the engine's behaviour, not that one flag.
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# LHDS_PROBE_CONFIG_DIR: point at a SANDBOX COPY of config/ to run a mutation (assertion-design: never mutate the tracked tree).
CONF="${LHDS_PROBE_CONFIG_DIR:-$(cd "$HERE/.." && pwd)}"
IMAGE="${LHDS_HAPI_IMAGE:-hapiproject/hapi@sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e}"
PORT="${LHDS_PROBE_PORT:-18931}"
NET=lhdsprobe; PG=lhds-pg; HAPI=lhds-hapi
BASE="http://127.0.0.1:$PORT/fhir"
BOUND="${LHDS_HISTORY_STATEMENT_BOUND:-10}"
FAILS=0
JSON='Content-Type: application/fhir+json'

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
# The HTTP status is the datum; curl's own exit code (e.g. 22/56 on some resets) must not abort the probe,
# and a transport failure prints 000, which no check accepts.
code() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }

cleanup() { docker rm -f "$HAPI" "$PG" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
if [ "${LHDS_PROBE_KEEP:-}" != yes ]; then trap cleanup EXIT; fi
cleanup
docker network create "$NET" >/dev/null
# log_statement=all so C7 can count the SQL the engine really issues.
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=probe -e POSTGRES_DB=lhds_probe postgres:16 -c log_statement=all >/dev/null
for _ in $(seq 1 30); do docker exec "$PG" pg_isready -U postgres -d lhds_probe >/dev/null 2>&1 && break; sleep 1; done
start_hapi() { # extra `-e K=V` args follow; the file policy is the same each time, the env is the per-tenant half
  docker rm -f "$HAPI" >/dev/null 2>&1 || true
  docker run -d --name "$HAPI" --network "$NET" -p "127.0.0.1:$PORT:8080" \
    -v "$CONF:/opt/loom/fhir/config:ro" \
    -e SPRING_CONFIG_ADDITIONAL_LOCATION=optional:file:/opt/loom/fhir/config/application.yaml \
    -e SPRING_DATASOURCE_URL="jdbc:postgresql://$PG:5432/lhds_probe" \
    -e SPRING_DATASOURCE_USERNAME=postgres -e SPRING_DATASOURCE_PASSWORD=probe \
    -e SPRING_DATASOURCE_DRIVERCLASSNAME=org.postgresql.Driver \
    -e SPRING_JPA_PROPERTIES_HIBERNATE_DIALECT=ca.uhn.fhir.jpa.model.dialect.HapiFhirPostgresDialect \
    "$@" "$IMAGE" >/dev/null
  ready=no
  for _ in $(seq 1 60); do [ "$(code "$BASE/metadata")" = 200 ] && { ready=yes; break; }; sleep 5; done
  [ "$ready" = yes ] || { echo "FAIL engine never answered /metadata with 200 within 300 s"; docker logs "$HAPI" 2>&1 | tail -20; exit 1; }
}
start_hapi

# C1
if docker logs "$HAPI" 2>&1 | grep -q 'Database Partition Mode Enabled: true'; then pass "C1 partition mode on"; else fail "C1 engine did not log 'Database Partition Mode Enabled: true' (key misplaced or ignored)"; fi

# create the two facility partitions the checks use
for p in "1 site-a" "2 site-b"; do
  set -- $p
  c=$(code -X POST -H "$JSON" "$BASE/DEFAULT/\$partition-management-create-partition" \
    -d "{\"resourceType\":\"Parameters\",\"parameter\":[{\"name\":\"id\",\"valueInteger\":$1},{\"name\":\"name\",\"valueCode\":\"$2\"}]}")
  [ "$c" = 200 ] || fail "partition $2 create returned $c, expected 200"
done
A="$BASE/site-a"

# C2
c=$(code "$BASE/Patient")
[ "$c" = 400 ] && pass "C2 request with no partition segment -> 400" || fail "C2 /Patient with no partition returned $c, expected 400 (fail closed)"

# C3
OBS_NO_STATUS='{"resourceType":"Observation","code":{"text":"x"}}'
c=$(code -X POST -H "$JSON" "$A/Observation" -d "$OBS_NO_STATUS")
[ "$c" = 422 ] && pass "C3a Observation without required status -> 422" || fail "C3a status-less Observation returned $c, expected 422 (validation on write is off)"
c=$(code -X POST -H "$JSON" "$A/Observation" -d '{"resourceType":"Observation","status":"final","code":{"text":"x"}}')
[ "$c" = 201 ] && pass "C3b same Observation with status -> 201 (positive control)" || fail "C3b valid Observation returned $c, expected 201"

# C4 / C5
PID=$(curl -s -X POST -H "$JSON" "$A/Patient" -d '{"resourceType":"Patient","name":[{"family":"RiProbe"}]}' | sed -n 's/.*"id": *"\([0-9]*\)".*/\1/p' | head -1)
[ -n "$PID" ] || { fail "C4 could not create the RI target Patient"; PID=0; }
obs() { echo "{\"resourceType\":\"Observation\",\"status\":\"final\",\"code\":{\"text\":\"x\"},\"subject\":{\"reference\":\"Patient/$1\"}}"; }
c=$(code -X POST -H "$JSON" "$A/Observation" -d "$(obs 99999999)")
case "$c" in 4??) pass "C4a Observation -> Patient/99999999 (dangling) rejected ($c)";; *) fail "C4a dangling reference accepted with $c (RI on write is off)";; esac
OID=$(curl -s -X POST -H "$JSON" "$A/Observation" -d "$(obs "$PID")" | sed -n 's/.*"id": *"\([0-9]*\)".*/\1/p' | head -1)
[ -n "$OID" ] && pass "C4b Observation -> existing Patient accepted (positive control)" || fail "C4b Observation with a valid subject was refused"
c=$(code -X DELETE "$A/Patient/$PID")
case "$c" in 409) pass "C5a delete of referenced Patient -> 409";; *) fail "C5a delete of a referenced Patient returned $c, expected 409 (RI on delete is off)";; esac
code -X DELETE "$A/Observation/${OID:-0}" >/dev/null
c=$(code -X DELETE "$A/Patient/$PID")
case "$c" in 200|204) pass "C5b delete accepted once the referrer is gone ($c)";; *) fail "C5b delete after removing the referrer returned $c";; esac

# C6
export A JSON
seq 1 50 | xargs -P 50 -I{} sh -c 'curl -s -o /dev/null -X POST -H "$JSON" -H "If-None-Exist: identifier=urn:lhds:probe|CC-1" "$A/Patient" -d "{\"resourceType\":\"Patient\",\"identifier\":[{\"system\":\"urn:lhds:probe\",\"value\":\"CC-1\"}]}"' || true
N=$(curl -s "$A/Patient?identifier=urn:lhds:probe|CC-1&_summary=count" | sed -n 's/.*"total": *\([0-9]*\).*/\1/p')
[ "$N" = 1 ] && pass "C6 50 parallel conditional creates -> exactly 1 resource" || fail "C6 50 parallel conditional creates produced ${N:-?} resources, expected exactly 1 (fails at 2)"

# C6-control: the SAME 50 parallel creates without If-None-Exist must make 50 resources, or the count above
# could not have seen a duplicate.
seq 1 50 | xargs -P 50 -I{} sh -c 'curl -s -o /dev/null -X POST -H "$JSON" "$A/Patient" -d "{\"resourceType\":\"Patient\",\"identifier\":[{\"system\":\"urn:lhds:probe\",\"value\":\"CC-2\"}]}"' || true
N2=$(curl -s "$A/Patient?identifier=urn:lhds:probe|CC-2&_summary=count" | sed -n 's/.*"total": *\([0-9]*\).*/\1/p')
[ "${N2:-0}" -ge 2 ] && pass "C6-control 50 parallel creates WITHOUT If-None-Exist -> $N2 resources (the count can see duplicates)" || fail "C6-control unconditional creates produced ${N2:-?}, so C6 could not have seen a duplicate"

# C7: statements issued by a history read, 5 versions vs 40 versions of one resource
loglines() { docker logs "$PG" 2>&1 | wc -l; }
# SELECTs the engine issued after line $1. BEGIN/COMMIT framing is not what an N+1 multiplies; the idle
# engine issues no SELECT apart from its own scheduler (measured: 0 in 3 s on the pinned image).
selects_after() { docker logs "$PG" 2>&1 | tail -n +$(($1 + 1)) | grep -cE 'LOG:  execute [^:]*: select' || true; }
mkhist() { # $1 = versions
  id=$(curl -s -X POST -H "$JSON" "$A/Patient" -d '{"resourceType":"Patient","name":[{"family":"H0"}]}' | sed -n 's/.*"id": *"\([0-9]*\)".*/\1/p' | head -1)
  for i in $(seq 1 $(($1 - 1))); do code -X PUT -H "$JSON" "$A/Patient/$id" -d "{\"resourceType\":\"Patient\",\"id\":\"$id\",\"name\":[{\"family\":\"H$i\"}]}" >/dev/null; done
  echo "$id"
}
measure() { # $1 = id ; prints statements for one history read
  b=$(loglines); curl -s "$A/Patient/$1/_history?_count=100&_since=2000-01-01T00:00:$(printf '%02d' $((RANDOM % 60)))Z" > /dev/null; # unique _since each call: a cached search must not make the count look small
 sleep 2; selects_after "$b"
}
control() { # $1 = id, $2 = reads: a read that DOES issue one SELECT-bearing request per call
  b=$(loglines); for _ in $(seq 1 "$2"); do curl -s "$A/Patient/$1" > /dev/null; done; sleep 2; selects_after "$b"
}
quiesce() { # wait until the engine's own background SELECTs (post-write indexing) stop, so they are not counted as ours
  for _ in $(seq 1 30); do b=$(loglines); sleep 3; [ "$(selects_after "$b")" -le 2 ] && return 0; done
  echo "WARN engine never went quiet; C7 numbers are noisy"
}
H5=$(mkhist 5); H40=$(mkhist 40)
quiesce
measure "$H5" >/dev/null; measure "$H40" >/dev/null # warm caches
S5=$(measure "$H5"); S40=$(measure "$H40")
T40=$(curl -s "$A/Patient/$H40/_history?_count=100" | sed -n 's/^  "total": *\([0-9]*\).*/\1/p' | head -1)
[ "$T40" = 40 ] && pass "C7-fixture the 40-version history really holds 40 versions" || fail "C7-fixture history total is ${T40:-?}, expected 40: the read measured is not the one the check names"
# Positive control: the counter must see a scaling read (40 reads vs 5 reads of one resource).
K5=$(control "$H5" 5); K40=$(control "$H5" 40)
echo "INFO C7 selects: history 5 versions=$S5, 40 versions=$S40 (bound on the difference: $BOUND); control 5 reads=$K5, 40 reads=$K40"
if [ $((K40 - K5)) -ge 35 ]; then pass "C7-control the counter sees 35 extra reads as >=35 extra SELECTs"; else fail "C7-control counter is blind: 35 extra reads added only $((K40 - K5)) SELECTs, so C7 proves nothing"; fi
if [ $((S40 - S5)) -le "$BOUND" ]; then pass "C7 history read statements do not scale with version count"; else fail "C7 history read issued $((S40 - S5)) more statements for 35 more versions (N+1)"; fi

# C8
# Two Patients match family=MultiDel, so the conditional delete is a MULTI delete (one match would not exercise the flag).
for _ in 1 2; do code -X POST -H "$JSON" "$A/Patient" -d '{"resourceType":"Patient","name":[{"family":"MultiDel"}]}' > /dev/null; done
c=$(code -X DELETE "$A/Patient?family=MultiDel")
{ [ "$c" = 412 ] || [ "$c" = 400 ]; } && pass "C8a conditional delete matching 2 resources refused ($c)" || fail "C8a delete matching 2 resources returned $c, expected 412 or 400 (allow_multiple_delete is on)"
c=$(code -X POST -H "$JSON" "$A/Patient/$H5/\$expunge" -d '{"resourceType":"Parameters","parameter":[{"name":"limit","valueInteger":1}]}')
case "$c" in 4??) pass "C8b \$expunge refused ($c)";; *) fail "C8b \$expunge returned $c, expected 4xx (history erasure must be unavailable)";; esac

# C9: the rendered caps (env, W2-2 renderEngineConfig) bind over the file. Restart with max 5 / default 3 (the
# 200 / 20 of application.yaml are in force before); many Patients exist in the same database by now.
Dbefore=$(curl -s "$A/Patient" | grep -c '"fullUrl"' || true)
start_hapi -e HAPI_FHIR_MAX_PAGE_SIZE=5 -e HAPI_FHIR_DEFAULT_PAGE_SIZE=3
D=$(curl -s "$A/Patient" | grep -c '"fullUrl"' || true)
M=$(curl -s "$A/Patient?_count=50" | grep -c '"fullUrl"' || true)
[ "$Dbefore" = 20 ] && pass "C9-control file default page = 20 before the env cap" || fail "C9-control default page was $Dbefore, expected 20: the file default is not what C9a is compared against"
[ "$D" = 3 ] && pass "C9a default page = 3 (HAPI_FHIR_DEFAULT_PAGE_SIZE bound)" || fail "C9a default page returned $D entries, expected 3 (env cap not applied)"
[ "$M" = 5 ] && pass "C9b _count=50 capped to 5 (HAPI_FHIR_MAX_PAGE_SIZE bound)" || fail "C9b _count=50 returned $M entries, expected 5 (env cap not applied)"

echo "RESULT failures=$FAILS"
[ "$FAILS" = 0 ]
