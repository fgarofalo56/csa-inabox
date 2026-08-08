#!/usr/bin/env bash
# loom-unity — Iceberg REST Catalog E2E against the REAL image.
#
# WHY THIS EXISTS. The live Commercial console measured two different failures
# from one freshly-restarted iceberg-catalog:
#
#     GET /api/catalog/iceberg/config?warehouse=loom   -> upstream 403 (243ms)
#     GET /api/catalog/iceberg/namespaces              -> upstream 500 (539ms)
#
# and the working assumption was "authorized principal, ABSENT OBJECT" — i.e.
# provision the warehouse and both clear. Every assertion below was MEASURED
# against the real image before it was written, and the premise did not survive:
# neither status is about the warehouse existing.
#
# The distinction the sibling authz-e2e.sh cannot make: it mints every token with
# `email=admin` (test-idp.py's default), which upstream resolves to the bootstrap
# admin user — the ONLY holder of metastore OWNER. A Microsoft Entra APP-ONLY
# token has no `email` claim at all, so the real Console resolves to its object
# id. Cases here run as BOTH principals, plus the raw (unexchanged) bearer,
# because that is the axis the live failures actually sit on.
#
#   A  warehouse auto-bind      entrypoint creates catalog + namespace  -> log
#   B  Unity read, console      GET /catalogs                           -> 200
#   C  RAW Entra bearer         never exchanged (THE LIVE 403)          -> 403
#   D  IRC config, console      exchanged token                         -> 200
#   E  IRC config, ABSENT wh    warehouse that does not exist           -> 200
#   F  IRC prefix override      config body                             -> catalogs/loom
#   G  UNPREFIXED namespaces    /v1/namespaces (what the client sent)   -> 500
#   H  PREFIXED  namespaces     /v1/catalogs/loom/namespaces            -> 500
#   I  bare v0.5.0 control      same call, NO Loom overlay              -> 200
#   J  namespace GET            /v1/catalogs/loom/namespaces/default    -> 200
#   K  table LIST, console      .../namespaces/default/tables           -> 200
#   L  Unity schemas, console   the LIST-namespaces fallback source     -> 200
#
# C is the live 403: the AuthDecorator rejects any bearer whose `iss` is not its
# own `internal` issuer. E proves the 403 is NOT about an absent warehouse —
# config never checks (upstream's own source carries `// TODO: check catalog
# exists`).
#
# G+H+I are the live 500. G: there is no /v1/namespaces route, and because
# UnityAccessDecorator is bound as a ROUTE DECORATOR over the whole
# /api/2.1/unity-catalog/ prefix, an unmatched path still enters it and dies
# "Couldn't unwrap service." H: even the CORRECT prefixed route 500s, for EVERY
# principal including the metastore owner —
#   {"error":{"message":"Authorization filter not initialized — ensure the
#     request goes through UnityAccessDecorator.","code":500}}
# I is the control that names the cause: the identical call on the bare upstream
# v0.5.0 image answers 200, so the regression arrives with the v0.5.1
# unitycatalog-server OVERLAY this image applies for upstream #1603. v0.5.1 added
# @ResponseAuthorizeFilter + AuthorizedService.applyResponseFilter, and
# IcebergRestCatalogService.listNamespaces calls SchemaService.listSchemas
# IN-PROCESS — under the Iceberg route's context, which has no ResultFilter.
#
# J+K are the receipt that matters: an AUTHENTICATED Iceberg read returning 200,
# as the Console's own principal, against a warehouse the platform provisioned
# by itself.
#
# Runs entirely in Docker against the throwaway OIDC issuer. No Azure, no Entra.
#
#   usage:  bash apps/loom-unity/tests/authz/iceberg-e2e.sh [image]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${HERE}/../.." && pwd)"
IMAGE="${1:-loom-unity:iceberg-e2e}"
BARE_IMAGE="unitycatalog/unitycatalog:v0.5.0"
NET=loom-unity-iceberg-e2e
IDP=loom-unity-iceberg-idp
UC=loom-unity-iceberg-uc
BARE=loom-unity-iceberg-bare
AUD='api://loom-unity'
WAREHOUSE='loom'
NS='default'
# The Console managed identity's OBJECT ID shape (an Entra GUID) — the `sub` of
# the app-only token it mints, and the value bicep passes as consolePrincipalId.
PRINCIPAL='11111111-2222-3333-4444-555555555555'
IRC='/api/2.1/unity-catalog/iceberg'
UC_PORT=18090
BARE_PORT=18093

PASS=0
FAIL=0

cleanup() {
  docker rm -f "$IDP" "$UC" "$BARE" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  true
}
trap cleanup EXIT

check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "  PASS  $1 -> $3"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $1 -> got $3, expected $2"
    FAIL=$((FAIL + 1))
  fi
}

status() { # status <port> <path> <bearer>
  if [ -n "${3:-}" ]; then
    curl -s -o /dev/null -w '%{http_code}' -m 20 -H "Authorization: Bearer $3" "http://127.0.0.1:$1$2"
  else
    curl -s -o /dev/null -w '%{http_code}' -m 20 "http://127.0.0.1:$1$2"
  fi
}

wait_ready() { # wait_ready <port>
  for _ in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$1/api/2.1/unity-catalog/catalogs" || true)
    [ -n "$code" ] && [ "$code" != "000" ] && return 0
    sleep 3
  done
  return 1
}

echo "== build =="
docker build -q -t "$IMAGE" "$APP_DIR" >/dev/null || { echo "image build failed"; exit 1; }
docker build -q -f "$HERE/Dockerfile.test-idp" -t loom-unity-test-idp:e2e "$HERE" >/dev/null \
  || { echo "test-idp build failed"; exit 1; }
cleanup
docker network create "$NET" >/dev/null

echo "== bring up the issuer + an ENFORCED catalog carrying a warehouse =="
docker run -d --name "$IDP" --network "$NET" --network-alias idp -p 18010:8000 loom-unity-test-idp:e2e >/dev/null
sleep 5
# Exactly the env data-plane/iceberg-catalog-aca.bicep emits with authMode=entra.
docker run -d --name "$UC" --network "$NET" -p "$UC_PORT:8080" \
  -e LOOM_UNITY_AUTH=enable -e LOOM_UNITY_ALLOWED_ISSUERS=http://idp:8000 \
  -e "LOOM_UNITY_AUDIENCES=$AUD" -e LOOM_UNITY_DB_LOCAL=1 \
  -e "LOOM_ICEBERG_WAREHOUSE=$WAREHOUSE" \
  -e "LOOM_UNITY_CONSOLE_PRINCIPAL_ID=$PRINCIPAL" "$IMAGE" >/dev/null
wait_ready "$UC_PORT" || { echo "catalog never answered"; docker logs "$UC" | tail -40; exit 1; }
# The SCIM bind + warehouse provisioning run in one background job after boot.
sleep 25

echo "== A. warehouse auto-bind (auto-bind-by-default.md §1/§3/§4) =="
LOG="$(docker logs "$UC" 2>&1)"
case "$LOG" in
  *"WAREHOUSE-BIND: created name=${WAREHOUSE}"*|*"WAREHOUSE-BIND: present name=${WAREHOUSE}"*)
    check "A1 the entrypoint provisioned the warehouse catalog" "yes" "yes" ;;
  *) check "A1 the entrypoint provisioned the warehouse catalog" "yes" "no" ;;
esac
case "$LOG" in
  *"WAREHOUSE-BIND: namespace ${WAREHOUSE}.${NS} created"*|*"WAREHOUSE-BIND: namespace ${WAREHOUSE}.${NS} already present"*)
    check "A2 the entrypoint provisioned the default namespace" "yes" "yes" ;;
  *) check "A2 the entrypoint provisioned the default namespace" "yes" "no" ;;
esac
case "$LOG" in
  *"WAREHOUSE-BIND: granted"*) check "A3 grants applied to the Console principal" "yes" "yes" ;;
  *) check "A3 grants applied to the Console principal" "yes" "no" ;;
esac
case "$LOG" in
  *"ICEBERG-LIST-NAMESPACES-DEFECT"*) check "A4 the LIST-namespaces defect is STATED on boot" "yes" "yes" ;;
  *) check "A4 the LIST-namespaces defect is STATED on boot" "yes" "no" ;;
esac

echo "== mint the Console's REAL credential shape (app-only: sub=oid, NO email) =="
RAW="$(curl -s -m 20 "http://127.0.0.1:18010/mint?sub=${PRINCIPAL}&aud=${AUD}&email=&iss=http://idp:8000")"
[ -n "$RAW" ] || { echo "could not mint the console token"; exit 1; }
XCH="$(curl -s -m 30 -X POST "http://127.0.0.1:$UC_PORT/api/1.0/unity-control/auth/tokens" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
  --data-urlencode 'subject_token_type=urn:ietf:params:oauth:token-type:id_token' \
  --data-urlencode "subject_token=$RAW")"
CONSOLE="$(printf '%s' "$XCH" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
check "console token exchange succeeds (the SCIM auto-bind works)" "yes" \
  "$([ -n "$CONSOLE" ] && echo yes || echo no)"
ADMIN="$(docker exec "$UC" sh -c 'cat /home/unitycatalog/etc/conf/token.txt' | tr -d '\r\n')"

echo "== B-F. what the two live statuses ACTUALLY mean =="
check "B  Unity  GET /catalogs                       [console]" "200" \
  "$(status "$UC_PORT" /api/2.1/unity-catalog/catalogs "$CONSOLE")"
# THE LIVE 403: a raw Entra bearer that was never exchanged. Not the warehouse.
check "C  IRC    /v1/config                          [RAW bearer]" "403" \
  "$(status "$UC_PORT" "$IRC/v1/config?warehouse=$WAREHOUSE" "$RAW")"
check "D  IRC    /v1/config?warehouse=loom           [console]" "200" \
  "$(status "$UC_PORT" "$IRC/v1/config?warehouse=$WAREHOUSE" "$CONSOLE")"
# And the premise, falsified directly: an ABSENT warehouse is still 200, because
# upstream's config() carries `// TODO: check catalog exists` and never looks.
check "E  IRC    /v1/config?warehouse=<absent>       [console]" "200" \
  "$(status "$UC_PORT" "$IRC/v1/config?warehouse=no-such-warehouse" "$CONSOLE")"
CFG="$(curl -s -m 20 -H "Authorization: Bearer $CONSOLE" "http://127.0.0.1:$UC_PORT$IRC/v1/config?warehouse=$WAREHOUSE")"
case "$CFG" in
  *"\"prefix\":\"catalogs/${WAREHOUSE}\""*) check "F  IRC config declares prefix=catalogs/loom" "yes" "yes" ;;
  *) check "F  IRC config declares prefix=catalogs/loom" "yes" "no ($CFG)" ;;
esac

echo "== G-I. the 500: a wrong path, and an upstream-overlay regression =="
check "G  IRC    /v1/namespaces (UNPREFIXED)         [admin]  " "500" \
  "$(status "$UC_PORT" "$IRC/v1/namespaces" "$ADMIN")"
check "H  IRC    /v1/catalogs/loom/namespaces        [admin]  " "500" \
  "$(status "$UC_PORT" "$IRC/v1/catalogs/$WAREHOUSE/namespaces" "$ADMIN")"
NSBODY="$(curl -s -m 20 -H "Authorization: Bearer $ADMIN" "http://127.0.0.1:$UC_PORT$IRC/v1/catalogs/$WAREHOUSE/namespaces")"
case "$NSBODY" in
  *"Authorization filter not initialized"*) check "H2 …with the applyResponseFilter signature" "yes" "yes" ;;
  *) check "H2 …with the applyResponseFilter signature" "yes" "no ($NSBODY)" ;;
esac
# CONTROL — the same call on the BARE upstream image, no Loom overlay.
docker run -d --name "$BARE" --network "$NET" -p "$BARE_PORT:8080" "$BARE_IMAGE" >/dev/null
wait_ready "$BARE_PORT" || { echo "bare control never answered"; exit 1; }
check "I  bare v0.5.0 /v1/catalogs/unity/namespaces  [no authz]" "200" \
  "$(status "$BARE_PORT" "$IRC/v1/catalogs/unity/namespaces" "")"

echo "== J-L. the receipt: an AUTHENTICATED Iceberg read returning 200 =="
check "J  IRC    /v1/catalogs/loom/namespaces/default        [console]" "200" \
  "$(status "$UC_PORT" "$IRC/v1/catalogs/$WAREHOUSE/namespaces/$NS" "$CONSOLE")"
check "K  IRC    /v1/catalogs/loom/namespaces/default/tables [console]" "200" \
  "$(status "$UC_PORT" "$IRC/v1/catalogs/$WAREHOUSE/namespaces/$NS/tables" "$CONSOLE")"
check "L  Unity  /schemas?catalog_name=loom (fallback source)[console]" "200" \
  "$(status "$UC_PORT" "/api/2.1/unity-catalog/schemas?catalog_name=$WAREHOUSE" "$CONSOLE")"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
