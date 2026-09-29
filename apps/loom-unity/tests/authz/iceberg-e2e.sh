#!/usr/bin/env bash
# loom-unity — Iceberg REST Catalog E2E against the REAL image.
#
# WHY THIS EXISTS. The live Commercial console measured two different failures
# from one freshly-restarted iceberg-catalog:
#
#     GET /api/catalog/iceberg/config?warehouse=loom   -> upstream 403 (243ms)
#     GET /api/catalog/iceberg/namespaces              -> upstream 500 (539ms)
#
# ── THE 403, AND WHY THIS HARNESS DID NOT SEE IT UNTIL 2026-09-29 (#3339) ─────
# Upstream unitycatalog v0.5.0 (and v0.6.0) gates /v1/config and every other
# Iceberg REST route on `#authorize(#principal, #metastore, OWNER)`. The Console
# holds catalog-level grants on the warehouse, and metastore OWNER cannot be
# granted through the permissions API at all, so the Console's own credential is
# answered 403 PERMISSION_DENIED on the whole Iceberg surface.
#
# This harness used to report D/J/K = 200 anyway. It minted the Console's
# app-only token with `email=`, but test-idp.py parsed the query with
# parse_qs's default keep_blank_values=False, which DROPS a blank value, so the
# minter's default email applied and the "console" cases ran as a different
# principal. An earlier revision of this header, test-idp.py and the parity doc
# (RC-12) concluded from those 200s that the surface was "authentication-gated,
# not authorization-gated". That was false. Root cause, measured one variable at
# a time: https://github.com/fgarofalo56/csa-inabox/issues/3339#issuecomment-5892344942
#
# The fix is in the image (Dockerfile stage 1b): IcebergRestCatalogService is
# recompiled with upstream da911fad3951 (#1813)'s scoped expressions, and the
# entrypoint adds USE SCHEMA to the Console's catalog grants. So on the PRE-FIX
# image D, J and K go RED (403) under this harness, and on the fixed image they
# are GREEN. Section M proves the fix did not open the surface to everyone: a
# second, registered principal with NO grants is still refused.
#
#   A  warehouse auto-bind      entrypoint creates catalog + ns + grants -> log
#   B  Unity read, console      GET /catalogs                            -> 200
#   C  RAW Entra bearer         never exchanged                          -> 403
#   D  IRC config, console      exchanged app-only token                 -> 200
#   E  IRC config, ABSENT wh    warehouse that does not exist            -> 404
#   F  IRC prefix override      config body                              -> catalogs/loom
#   G  UNPREFIXED namespaces    /v1/namespaces (what the client sent)    -> 500
#   H  PREFIXED  namespaces     /v1/catalogs/loom/namespaces             -> 500
#   I1 SAME image, authz OFF    the ONE variable that moves it           -> 200
#   I2 SAME image, NO #1603 jar authz still ON — overlay exonerated      -> 500
#   J  namespace GET, console   /v1/catalogs/loom/namespaces/default     -> 200
#   K  table LIST, console      .../namespaces/default/tables            -> 200
#   L  Unity schemas, console   the LIST-namespaces fallback source      -> 200
#   N  table GET (loadTable)    console: non-Iceberg table 404, UniForm 200
#   M  a principal with NO grants: config / namespace / table GET -> 403,
#      and the table LIST filters the UniForm table out
#
# C: the AuthDecorator rejects any bearer whose `iss` is not its own `internal`
# issuer, so an unexchanged bearer is 403 before authorization runs.
#
# G+H+I are the live 500 and are NOT fixed here (#3339 backports only the read
# gates; listNamespaces still requires metastore OWNER). G: there is no
# /v1/namespaces route, and because UnityAccessDecorator is bound as a ROUTE
# DECORATOR over the whole /api/2.1/unity-catalog/ prefix, an unmatched path
# still enters it and dies "Couldn't unwrap service." H: even the CORRECT
# prefixed route 500s, for EVERY principal including the metastore owner —
#   {"error":{"message":"Authorization filter not initialized — ensure the
#     request goes through UnityAccessDecorator.","code":500}}
#
# ── THE I CONTROL WAS BROKEN ONCE, AND IT PRODUCED A WRONG DIAGNOSIS (2026-08-10)
# Row I used to be "the same call on the BARE upstream v0.5.0 image answers 200",
# and the conclusion drawn from it was "so the regression arrives with the v0.5.1
# unitycatalog-server OVERLAY". That control moved TWO variables at once: the bare
# image has no overlay AND runs with server.authorization DISABLED. It is now a
# pair of SINGLE-variable controls:
#   I1  the same Loom image, authorization DISABLED  -> 200   (moves the flag only)
#   I2  the same Loom image with the #1603 overlay jar STRIPPED off the classpath,
#       authorization still ENABLED                  -> 500   (moves the overlay only)
# The real cause of H is upstream, in BOTH releases: AuthorizedService.
# applyResponseFilter runs only `if (isAuthorizationEnabled())` and then requires
# the RESULT_FILTER attribute UnityAccessDecorator installs for
# @ResponseAuthorizeFilter routes; IcebergRestCatalogService.listNamespaces reaches
# SchemaService.listSchemas IN-PROCESS, under the Iceberg route's context, where
# that attribute was never set.
#
# Every assertion below names the value that would break it (assertion-design.md).
#
# Runs entirely in Docker against the throwaway OIDC issuer. No Azure, no Entra.
# Not run by any CI workflow today.
#
#   usage:  bash apps/loom-unity/tests/authz/iceberg-e2e.sh [image]
#           LOOM_E2E_SKIP_BUILD=1 bash .../iceberg-e2e.sh <prebuilt-image>
#
# LOOM_E2E_SKIP_BUILD=1 runs against an image that is already built (the pre-fix
# image, or a mutation build) instead of building this tree into [image]. The
# throwaway issuer is always rebuilt from this directory.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${HERE}/../.." && pwd)"
IMAGE="${1:-loom-unity:iceberg-e2e}"
SKIP_BUILD="${LOOM_E2E_SKIP_BUILD:-0}"
NOOVL_IMAGE="${IMAGE%%:*}:iceberg-e2e-no-overlay"
NET=loom-unity-iceberg-e2e
IDP=loom-unity-iceberg-idp
UC=loom-unity-iceberg-uc
UC_OPEN=loom-unity-iceberg-open
NOOVL=loom-unity-iceberg-nooverlay
NOOVL_DIR="$(mktemp -d)"
AUD='api://loom-unity'
WAREHOUSE='loom'
NS='default'
# The Console managed identity's OBJECT ID shape (an Entra GUID) — the `sub` of
# the app-only token it mints, and the value bicep passes as consolePrincipalId.
PRINCIPAL='11111111-2222-3333-4444-555555555555'
# A second app-only principal, registered as a Unity Catalog user but granted
# NOTHING. It is what "the fix did not open the surface" is measured against.
OUTSIDER='99999999-8888-7777-6666-555555555555'
# Two tables in loom.default: one plain Delta (no UniForm metadata) and one
# UniForm-Iceberg. Only the second is visible to the Iceberg surface.
T_PLAIN='t_plain'
T_UNI='t_uniform'
IRC='/api/2.1/unity-catalog/iceberg'
DELTA='/api/2.1/unity-catalog/delta'
UC_PORT=18090
OPEN_PORT=18091
NOOVL_PORT=18092

PASS=0
FAIL=0

cleanup() {
  docker rm -f "$IDP" "$UC" "$UC_OPEN" "$NOOVL" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$NOOVL_DIR" >/dev/null 2>&1
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

body() { # body <port> <path> <bearer>
  curl -s -m 20 -H "Authorization: Bearer $3" "http://127.0.0.1:$1$2"
}

wait_ready() { # wait_ready <port>
  for _ in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$1/api/2.1/unity-catalog/catalogs" || true)
    [ -n "$code" ] && [ "$code" != "000" ] && return 0
    sleep 3
  done
  return 1
}

exchange() { # exchange <port> <raw-id-token>  -> prints the internal access token, or nothing
  curl -s -m 30 -X POST "http://127.0.0.1:$1/api/1.0/unity-control/auth/tokens" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
    --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
    --data-urlencode 'subject_token_type=urn:ietf:params:oauth:token-type:id_token' \
    --data-urlencode "subject_token=$2" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
}

echo "== build =="
if [ "$SKIP_BUILD" = "1" ]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "LOOM_E2E_SKIP_BUILD=1 but $IMAGE does not exist"; exit 1; }
  echo "  using prebuilt $IMAGE (not rebuilt from this tree)"
else
  docker build -q -t "$IMAGE" "$APP_DIR" >/dev/null || { echo "image build failed"; exit 1; }
fi
docker build -q -f "$HERE/Dockerfile.test-idp" -t loom-unity-test-idp:e2e "$HERE" >/dev/null \
  || { echo "test-idp build failed"; exit 1; }
# `--entrypoint sh`, not `/bin/sh`: Git Bash rewrites a leading-slash argument
# into a Windows path, which made this line report a false "does NOT carry".
if docker run --rm --entrypoint sh "$IMAGE" -c 'test -f /home/unitycatalog/lib-loom-override/loom-uc-3339-iceberg-authz.jar'; then
  echo "  image carries the #3339 Iceberg authorization backport"
else
  echo "  image does NOT carry the #3339 backport (pre-fix image: expect D/J/K and N to fail)"
fi
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
# The minted token must carry NO email claim. Breaks if test-idp.py drops the
# blank `email=` again (parse_qs without keep_blank_values) and falls back to its
# default, which is how this harness measured the wrong principal until #3339.
RAW_PAYLOAD="$(printf '%s' "$RAW" | cut -d. -f2 | tr '_-' '/+')"
while [ $(( ${#RAW_PAYLOAD} % 4 )) -ne 0 ]; do RAW_PAYLOAD="${RAW_PAYLOAD}="; done
RAW_CLAIMS="$(printf '%s' "$RAW_PAYLOAD" | base64 -d 2>/dev/null)"
case "$RAW_CLAIMS" in
  *"\"sub\":\"${PRINCIPAL}\""*"\"email\""*|*"\"email\""*"\"sub\":\"${PRINCIPAL}\""*)
    check "app-only token has sub=oid and NO email claim" "yes" "no (email claim present)" ;;
  *"\"sub\":\"${PRINCIPAL}\""*) check "app-only token has sub=oid and NO email claim" "yes" "yes" ;;
  *) check "app-only token has sub=oid and NO email claim" "yes" "no (sub missing)" ;;
esac
CONSOLE="$(exchange "$UC_PORT" "$RAW")"
check "console token exchange succeeds (the SCIM auto-bind works)" "yes" \
  "$([ -n "$CONSOLE" ] && echo yes || echo no)"
ADMIN="$(docker exec "$UC" sh -c 'cat /home/unitycatalog/etc/conf/token.txt' | tr -d '\r\n')"

echo "== B-F. what the two live statuses mean =="
check "B  Unity  GET /catalogs                       [console]" "200" \
  "$(status "$UC_PORT" /api/2.1/unity-catalog/catalogs "$CONSOLE")"
# Breaks (-> 200) if the AuthDecorator ever accepted a foreign-issuer bearer.
check "C  IRC    /v1/config                          [RAW bearer]" "403" \
  "$(status "$UC_PORT" "$IRC/v1/config?warehouse=$WAREHOUSE" "$RAW")"
# THE LIVE 403. Breaks (-> 403) on the pre-fix image, where config requires
# metastore OWNER; 200 needs the #3339 GET_CATALOG expression + USE CATALOG.
check "D  IRC    /v1/config?warehouse=loom           [console]" "200" \
  "$(status "$UC_PORT" "$IRC/v1/config?warehouse=$WAREHOUSE" "$CONSOLE")"
# An absent warehouse is no longer a silent 200: the CATALOG resource key is
# resolved before the policy runs, so a name that is not a catalog is 404.
# Breaks (-> 200) if config stops keying on the catalog; -> 403 on the pre-fix
# image, which never looks at the warehouse at all. NOT broken by restoring the
# OWNER expression alone on the fixed image (measured 2026-09-29: still 404,
# because the key resolves before the policy runs) — D is the OWNER witness.
check "E  IRC    /v1/config?warehouse=<absent>       [console]" "404" \
  "$(status "$UC_PORT" "$IRC/v1/config?warehouse=no-such-warehouse" "$CONSOLE")"
CFG="$(body "$UC_PORT" "$IRC/v1/config?warehouse=$WAREHOUSE" "$CONSOLE")"
# Breaks if the prefix override changes or config is denied (403 body).
case "$CFG" in
  *"\"prefix\":\"catalogs/${WAREHOUSE}\""*) check "F  IRC config declares prefix=catalogs/loom" "yes" "yes" ;;
  *) check "F  IRC config declares prefix=catalogs/loom" "yes" "no ($CFG)" ;;
esac

echo "== G-I. the 500: a wrong path, and an UPSTREAM defect (not the overlay) =="
check "G  IRC    /v1/namespaces (UNPREFIXED)         [admin]  " "500" \
  "$(status "$UC_PORT" "$IRC/v1/namespaces" "$ADMIN")"
check "H  IRC    /v1/catalogs/loom/namespaces        [admin]  " "500" \
  "$(status "$UC_PORT" "$IRC/v1/catalogs/$WAREHOUSE/namespaces" "$ADMIN")"
NSBODY="$(body "$UC_PORT" "$IRC/v1/catalogs/$WAREHOUSE/namespaces" "$ADMIN")"
case "$NSBODY" in
  *"Authorization filter not initialized"*) check "H2 …with the applyResponseFilter signature" "yes" "yes" ;;
  *) check "H2 …with the applyResponseFilter signature" "yes" "no ($NSBODY)" ;;
esac

# CONTROL I1 — the SAME image, the SAME warehouse, authorization DISABLED. This
# moves exactly one variable, and it is the one that moves the status.
docker run -d --name "$UC_OPEN" --network "$NET" -p "$OPEN_PORT:8080" \
  -e LOOM_UNITY_AUTH=disable -e LOOM_UNITY_DB_LOCAL=1 \
  -e "LOOM_ICEBERG_WAREHOUSE=$WAREHOUSE" "$IMAGE" >/dev/null
wait_ready "$OPEN_PORT" || { echo "authz-disabled control never answered"; exit 1; }
sleep 20
check "I1 SAME image, authz DISABLED                 [no authz]" "200" \
  "$(status "$OPEN_PORT" "$IRC/v1/catalogs/$WAREHOUSE/namespaces" "")"

# CONTROL I2 — the SAME image with the #1603 overlay jar STRIPPED off every
# classpath file, authorization still ENABLED. This moves the OTHER variable on
# its own, and it does NOT move the status: the overlay is not the cause. Built
# here so the claim is measured on this tree rather than quoted from a doc.
#
# Only the #1603 jar is stripped. The #3339 jar lives in the same
# lib-loom-override directory, so the check below names the 1603 jar rather than
# the directory (a directory-level check would fail on every fixed image).
#
# NOTE: `sed -i` truncates these classpath files to 0 bytes (mode 0550, busybox),
# which is how the first attempt at this control silently produced an unbootable
# image. Read-modify-`cat >` instead, and assert on BYTE COUNT so an emptied
# classpath can never masquerade as a passing control.
mkdir -p "$NOOVL_DIR"   # the early cleanup() call removes it; recreate before use
cat > "$NOOVL_DIR/Dockerfile" <<DOCKERFILE
FROM $IMAGE
USER root
RUN set -eu; \
    OVERRIDE=/home/unitycatalog/lib-loom-override/loom-uc-1603-fix.jar; \
    for CP_FILE in \$(find /home/unitycatalog -type f -name classpath); do \
      NEW="\$(tr ':' '\n' < "\${CP_FILE}" | grep -v "^\${OVERRIDE}\$" | tr '\n' ':' | sed 's/:\$//')"; \
      printf '%s' "\${NEW}" > /tmp/cp-new; \
      cat /tmp/cp-new > "\${CP_FILE}"; \
      rm -f /tmp/cp-new; \
    done; \
    SCP=/home/unitycatalog/server/target/classpath; \
    BYTES="\$(wc -c < "\${SCP}")"; \
    [ "\${BYTES}" -gt 30000 ] || { echo "FATAL: classpath truncated (\${BYTES} bytes)"; exit 1; }; \
    ! grep -q 'loom-uc-1603-fix.jar' "\${SCP}" || { echo "FATAL: #1603 overlay still present"; exit 1; }; \
    grep -q 'server/target/classes' "\${SCP}" || { echo "FATAL: v0.5.0 server classes lost"; exit 1; }
USER unitycatalog
DOCKERFILE
if docker build -q -t "$NOOVL_IMAGE" "$NOOVL_DIR" >/dev/null 2>&1; then
  docker run -d --name "$NOOVL" --network "$NET" -p "$NOOVL_PORT:8080" \
    -e LOOM_UNITY_AUTH=enable -e LOOM_UNITY_ALLOWED_ISSUERS=http://idp:8000 \
    -e "LOOM_UNITY_AUDIENCES=$AUD" -e LOOM_UNITY_DB_LOCAL=1 \
    -e "LOOM_ICEBERG_WAREHOUSE=$WAREHOUSE" \
    -e "LOOM_UNITY_CONSOLE_PRINCIPAL_ID=$PRINCIPAL" "$NOOVL_IMAGE" >/dev/null
  if wait_ready "$NOOVL_PORT"; then
    sleep 20
    NOOVL_ADMIN="$(docker exec "$NOOVL" sh -c 'cat /home/unitycatalog/etc/conf/token.txt' | tr -d '\r\n')"
    check "I2 SAME image, #1603 STRIPPED, authz ON    [admin]  " "500" \
      "$(status "$NOOVL_PORT" "$IRC/v1/catalogs/$WAREHOUSE/namespaces" "$NOOVL_ADMIN")"
    # And the #1603 fix must be GONE without the overlay — that is what proves the
    # stripped image really lost it, i.e. that I2 tested what it claims to test.
    NOOVL_CONSOLE="$(exchange "$NOOVL_PORT" "$RAW")"
    check "I3 …and #1603 IS back once stripped (500)  [console]" "500" \
      "$(status "$NOOVL_PORT" /api/2.1/unity-catalog/permissions/catalog/unity "$NOOVL_CONSOLE")"
  else
    check "I2 SAME image, #1603 STRIPPED, authz ON    [admin]  " "500" "control-never-answered"
  fi
else
  check "I2 SAME image, #1603 STRIPPED, authz ON    [admin]  " "500" "control-image-build-failed"
fi

echo "== J-L. the receipt: the Console's own principal reads the Iceberg surface =="
# Breaks (-> 403) on the pre-fix image (metastore OWNER), and on the fixed image
# if the Console lacks USE SCHEMA (GET_SCHEMA needs it on the schema; the
# entrypoint grants it on the catalog and it inherits).
check "J  IRC    /v1/catalogs/loom/namespaces/default        [console]" "200" \
  "$(status "$UC_PORT" "$IRC/v1/catalogs/$WAREHOUSE/namespaces/$NS" "$CONSOLE")"
# Breaks (-> 403) on the pre-fix image. On its own a 200 here is WEAK: the list
# route has no pre-gate, so any principal gets 200. K2 and M4 are what witness it.
check "K  IRC    /v1/catalogs/loom/namespaces/default/tables [console]" "200" \
  "$(status "$UC_PORT" "$IRC/v1/catalogs/$WAREHOUSE/namespaces/$NS/tables" "$CONSOLE")"
check "L  Unity  /schemas?catalog_name=loom (fallback source)[console]" "200" \
  "$(status "$UC_PORT" "/api/2.1/unity-catalog/schemas?catalog_name=$WAREHOUSE" "$CONSOLE")"

echo "== setup: two tables in ${WAREHOUSE}.${NS} (admin), and an ungranted principal =="
NOW_MS="$(date +%s)000"
COLS='{"type":"struct","fields":[{"name":"id","type":"long","nullable":false,"metadata":{}}]}'
PROTO='{"min-reader-version":1,"min-writer-version":2}'
mk_table() { # mk_table <name> <properties-json> <uniform-json-or-empty>
  local uni=""
  [ -n "$3" ] && uni=",\"uniform\":$3"
  curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST \
    "http://127.0.0.1:$UC_PORT$DELTA/v1/catalogs/$WAREHOUSE/schemas/$NS/tables" \
    -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$1\",\"location\":\"file:///tmp/loom-e2e/$1\",\"table-type\":\"EXTERNAL\",\"columns\":$COLS,\"protocol\":$PROTO,\"properties\":$2,\"last-commit-timestamp-ms\":$NOW_MS$uni}"
}
check "S1 create ${T_PLAIN} (plain Delta, no UniForm)       [admin]" "200" \
  "$(mk_table "$T_PLAIN" '{}' '')"
check "S2 create ${T_UNI} (UniForm-Iceberg)                [admin]" "200" \
  "$(mk_table "$T_UNI" '{"delta.universalFormat.enabledFormats":"iceberg"}' \
     "{\"iceberg\":{\"metadata-location\":\"file:///tmp/loom-e2e/${T_UNI}/metadata/00000.metadata.json\",\"converted-delta-version\":0,\"converted-delta-timestamp\":$NOW_MS}}")"
SCIM_OUT="$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST \
  "http://127.0.0.1:$UC_PORT/api/1.0/unity-control/scim2/Users" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/scim+json' \
  -d "{\"schemas\":[\"urn:ietf:params:scim:schemas:core:2.0:User\"],\"userName\":\"${OUTSIDER}\",\"displayName\":\"ungranted e2e principal\",\"emails\":[{\"value\":\"${OUTSIDER}\",\"primary\":true}],\"active\":true}")"
check "S3 register the ungranted principal (SCIM)          [admin]" "201" "$SCIM_OUT"
OUT_RAW="$(curl -s -m 20 "http://127.0.0.1:18010/mint?sub=${OUTSIDER}&aud=${AUD}&email=&iss=http://idp:8000")"
OUTSIDER_TOK="$(exchange "$UC_PORT" "$OUT_RAW")"
# Without this, every M case below would be a 401/403 for the WRONG reason
# (no token at all) and could not tell a working gate from a missing principal.
check "S4 ungranted principal's token exchange succeeds" "yes" \
  "$([ -n "$OUTSIDER_TOK" ] && echo yes || echo no)"


# The UniForm table's Iceberg metadata file, so loadTable has something real to
# read. A minimal, valid format-version 2 TableMetadata: one long column, no
# snapshots. Written inside the catalog container at the metadata-location S2
# registered (a file: path under the table location, as validateCreate requires).
UNI_META="{\"format-version\":2,\"table-uuid\":\"6b1f4e8a-3c2d-4f5e-9a1b-7c8d9e0f1a2b\",\"location\":\"file:///tmp/loom-e2e/${T_UNI}\",\"last-sequence-number\":0,\"last-updated-ms\":$NOW_MS,\"last-column-id\":1,\"current-schema-id\":0,\"schemas\":[{\"type\":\"struct\",\"schema-id\":0,\"fields\":[{\"id\":1,\"name\":\"id\",\"required\":true,\"type\":\"long\"}]}],\"default-spec-id\":0,\"partition-specs\":[{\"spec-id\":0,\"fields\":[]}],\"last-partition-id\":999,\"default-sort-order-id\":0,\"sort-orders\":[{\"order-id\":0,\"fields\":[]}],\"properties\":{},\"current-snapshot-id\":-1,\"snapshots\":[],\"snapshot-log\":[],\"metadata-log\":[]}"
printf '%s' "$UNI_META" | docker exec -i "$UC" sh -c "mkdir -p /tmp/loom-e2e/${T_UNI}/metadata && cat > /tmp/loom-e2e/${T_UNI}/metadata/00000.metadata.json"
check "S5 write ${T_UNI}'s Iceberg metadata file" "yes" \
  "$(docker exec "$UC" sh -c "test -s /tmp/loom-e2e/${T_UNI}/metadata/00000.metadata.json" && echo yes || echo no)"

TABLES_PATH="$IRC/v1/catalogs/$WAREHOUSE/namespaces/$NS/tables"
echo "== N. the Console reaches the table handlers (GET_TABLE via inherited SELECT) =="
# Iceberg loadTable (GET). HEAD tableExists carries the same gate but is not
# usable as a witness: measured 2026-09-29, a HEAD whose handler throws gets NO
# response at all (curl times out, status 000) for every principal, on the
# pre-fix image as well as the fixed one. That is upstream behaviour, not this
# fix; it is printed below as information and not asserted.
#
# N1: 404 is the HANDLER's answer (the table exists but has no Iceberg
# metadata), so reaching it proves the gate passed. Breaks (-> 403) on the
# pre-fix image, or if the TABLE resource key / USE SCHEMA / SELECT does not
# resolve for the Console.
check "N1 GET  tables/${T_PLAIN}   (not Iceberg)            [console]" "404" \
  "$(status "$UC_PORT" "$TABLES_PATH/$T_PLAIN" "$CONSOLE")"
# N2: a real Iceberg loadTable, as the Console, returning the table's metadata.
# Breaks (-> 403) on the pre-fix image; breaks the body check if the response
# is not the metadata S5 wrote.
check "N2 GET  tables/${T_UNI} (UniForm loadTable)      [console]" "200" \
  "$(status "$UC_PORT" "$TABLES_PATH/$T_UNI" "$CONSOLE")"
N2BODY="$(body "$UC_PORT" "$TABLES_PATH/$T_UNI" "$CONSOLE")"
case "$N2BODY" in
  *"\"metadata-location\""*"6b1f4e8a-3c2d-4f5e-9a1b-7c8d9e0f1a2b"*|*"6b1f4e8a-3c2d-4f5e-9a1b-7c8d9e0f1a2b"*"\"metadata-location\""*)
    check "N2b …and returns that table's metadata" "yes" "yes" ;;
  *) check "N2b …and returns that table's metadata" "yes" "no ($(printf '%s' "$N2BODY" | head -c 300))" ;;
esac
echo "  info  HEAD tables/${T_UNI} [console] -> $(curl -s -o /dev/null -w '%{http_code}' -m 10 -I -H "Authorization: Bearer $CONSOLE" "http://127.0.0.1:$UC_PORT$TABLES_PATH/$T_UNI") (not asserted; see above)"
K2BODY="$(body "$UC_PORT" "$TABLES_PATH" "$CONSOLE")"
# Positive half of the list filter: the granted Console SEES the UniForm table.
# Breaks if the filter drops tables the caller may read (or the list is denied).
case "$K2BODY" in
  *"\"name\":\"${T_UNI}\""*) check "K2 table LIST shows ${T_UNI}                   [console]" "yes" "yes" ;;
  *) check "K2 table LIST shows ${T_UNI}                   [console]" "yes" "no ($K2BODY)" ;;
esac

echo "== M. a registered principal with NO grants is still refused =="
# Each breaks (-> 200/404) if the backported expressions were loosened to
# "any authenticated principal" (e.g. `#principal != null`).
check "M1 IRC  /v1/config?warehouse=loom                [ungranted]" "403" \
  "$(status "$UC_PORT" "$IRC/v1/config?warehouse=$WAREHOUSE" "$OUTSIDER_TOK")"
check "M2 IRC  /v1/catalogs/loom/namespaces/default     [ungranted]" "403" \
  "$(status "$UC_PORT" "$IRC/v1/catalogs/$WAREHOUSE/namespaces/$NS" "$OUTSIDER_TOK")"
# 403, not the 404/200 the Console gets: an ungranted caller must not learn
# whether a table exists, or read its metadata.
check "M3 GET  tables/${T_PLAIN}                         [ungranted]" "403" \
  "$(status "$UC_PORT" "$TABLES_PATH/$T_PLAIN" "$OUTSIDER_TOK")"
check "M3b GET tables/${T_UNI}                       [ungranted]" "403" \
  "$(status "$UC_PORT" "$TABLES_PATH/$T_UNI" "$OUTSIDER_TOK")"
# The list route has no pre-gate (upstream's @ResponseAuthorizeFilter design):
# an ungranted caller gets 200 and a FILTERED list. The UniForm table must be
# absent. Breaks (-> present) if listTables stops running the ResultFilter over
# the real list. Paired with K2, which proves the table is there to be filtered.
M4CODE="$(status "$UC_PORT" "$TABLES_PATH" "$OUTSIDER_TOK")"
M4BODY="$(body "$UC_PORT" "$TABLES_PATH" "$OUTSIDER_TOK")"
check "M4 table LIST status                             [ungranted]" "200" "$M4CODE"
case "$M4BODY" in
  *"\"name\":\"${T_UNI}\""*) check "M4b table LIST hides ${T_UNI}               [ungranted]" "hidden" "LEAKED ($M4BODY)" ;;
  *"\"identifiers\""*) check "M4b table LIST hides ${T_UNI}               [ungranted]" "hidden" "hidden" ;;
  *) check "M4b table LIST hides ${T_UNI}               [ungranted]" "hidden" "no list body ($M4BODY)" ;;
esac

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
