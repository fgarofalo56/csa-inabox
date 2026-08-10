#!/usr/bin/env bash
# loom-unity — authorization E2E against the REAL image.
#
# WHY THIS EXISTS. The svc-loom-unity-authz change turns Entra authorization on
# by default and makes the container fail closed. Three rounds of review passed
# with that resting on an ASSERTION: nothing anywhere demonstrated that upstream
# unitycatalog honours `server.authorization` at all, so the sealed design could
# equally have been theatre (everything gets 200) or a permanent outage
# (everything gets 401). This script settles it by running the image and proving
# BOTH directions — a valid credential gets 200, an absent/invalid/wrong-issuer
# one does not — plus the two limitations that only a live run reveals.
#
#   1  boot fail-closed        nothing wired            -> exits 1, names the var
#   2  anonymous read          no Authorization header  -> 401
#   3  malformed bearer        "Bearer not-a-jwt"       -> 401
#   4  external IdP bearer     valid RS256, exact aud   -> 403  (!!)
#   5  token exchange          same token, /auth/tokens -> 200 + internal token
#   6  authenticated read      internal token           -> 200 with real JSON
#   7  service token           etc/conf/token.txt       -> 200
#   8  SEALED audience         sentinel .invalid aud    -> exchange 401, read 401
#   9  permissions GET         authz ENABLED            -> 200 (upstream #1603,
#                                                         fixed by the 3-class
#                                                         v0.5.1 overlay in the
#                                                         Dockerfile)
#  10  permissions GET         authz DISABLED           -> 200 (the control: this
#                                                         route always answered 200
#                                                         with authz off; case 9
#                                                         proves the overlay closed
#                                                         the authz-ENABLED 500)
#
# Case 4 is the important one: it is exactly what lib/azure/uc-backend.ts
# ossUcAuthHeader() sends. Upstream AuthDecorator — identical in v0.5.0 and
# v0.5.1 — rejects any token whose `iss` is not its own `internal` issuer, so the
# Console's credential cannot work until it performs the exchange in case 5.
#
# Runs entirely in Docker against a throwaway OIDC issuer (./test-idp.py). No
# Azure, no Entra, no network egress beyond the base-image pulls. The issuer
# stands in for Entra faithfully because UC does plain OIDC discovery against
# whatever is in `server.allowed-issuers`.
#
#   usage:  bash apps/loom-unity/tests/authz/authz-e2e.sh [image]
#   default image: loom-unity:authz-e2e (built from apps/loom-unity by this script)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${HERE}/../.." && pwd)"
IMAGE="${1:-loom-unity:authz-e2e}"
NET=loom-unity-authz-e2e
IDP=loom-unity-authz-idp
UC_ENFORCED=loom-unity-authz-enforced
UC_OPEN=loom-unity-authz-open
UC_SEALED=loom-unity-authz-sealed
AUD='api://loom-unity'
SEALED_AUD='api://loom-unity-sealed-abc123def.invalid'

PASS=0
FAIL=0

cleanup() {
  docker rm -f "$IDP" "$UC_ENFORCED" "$UC_OPEN" "$UC_SEALED" >/dev/null 2>&1
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

status() { # status <port> <path> [auth-header-value]
  if [ -n "${3:-}" ]; then
    curl -s -o /dev/null -w '%{http_code}' -m 20 -H "Authorization: $3" "http://127.0.0.1:$1$2"
  else
    curl -s -o /dev/null -w '%{http_code}' -m 20 "http://127.0.0.1:$1$2"
  fi
}

wait_ready() { # wait_ready <port>
  for _ in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$1/api/2.1/unity-catalog/catalogs" 2>/dev/null || true)
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

echo "== 1. boot fail-closed with nothing wired =="
BOOT="$(docker run --rm "$IMAGE" 2>&1)"
BOOT_RC=$?
check "boot exit code" "1" "$BOOT_RC"
case "$BOOT" in
  *"no token issuer is pinned"*) check "boot names the missing var" "yes" "yes" ;;
  *) check "boot names the missing var" "yes" "no" ;;
esac

echo "== bring up the issuer + three catalogs =="
docker run -d --name "$IDP" --network "$NET" --network-alias idp -p 18000:8000 loom-unity-test-idp:e2e >/dev/null
sleep 5
docker run -d --name "$UC_ENFORCED" --network "$NET" -p 18080:8080 \
  -e LOOM_UNITY_AUTH=enable -e LOOM_UNITY_ALLOWED_ISSUERS=http://idp:8000 \
  -e "LOOM_UNITY_AUDIENCES=$AUD" -e LOOM_UNITY_DB_LOCAL=1 "$IMAGE" >/dev/null
docker run -d --name "$UC_OPEN" --network "$NET" -p 18081:8080 \
  -e LOOM_UNITY_AUTH=disable -e LOOM_UNITY_DB_LOCAL=1 "$IMAGE" >/dev/null
docker run -d --name "$UC_SEALED" --network "$NET" -p 18082:8080 \
  -e LOOM_UNITY_AUTH=enable -e LOOM_UNITY_ALLOWED_ISSUERS=http://idp:8000 \
  -e "LOOM_UNITY_AUDIENCES=$SEALED_AUD" -e LOOM_UNITY_DB_LOCAL=1 "$IMAGE" >/dev/null
wait_ready 18080 || { echo "enforced catalog never answered"; docker logs "$UC_ENFORCED" | tail -30; exit 1; }
wait_ready 18081 || { echo "open catalog never answered"; exit 1; }
wait_ready 18082 || { echo "sealed catalog never answered"; exit 1; }

TOK="$(curl -s -m 20 "http://127.0.0.1:18000/mint?sub=loom-console&aud=$AUD&email=admin&iss=http://idp:8000")"
[ -n "$TOK" ] || { echo "could not mint a test token"; exit 1; }

echo "== authorization ENABLED, audience pinned =="
check "2 anonymous read"     "401" "$(status 18080 /api/2.1/unity-catalog/catalogs)"
check "3 malformed bearer"   "401" "$(status 18080 /api/2.1/unity-catalog/catalogs 'Bearer not-a-jwt')"
# The Console's current credential: a valid, correctly-audienced external bearer.
check "4 external IdP bearer presented directly" "403" \
  "$(status 18080 /api/2.1/unity-catalog/catalogs "Bearer $TOK")"

XCH="$(curl -s -m 30 -X POST "http://127.0.0.1:18080/api/1.0/unity-control/auth/tokens" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
  --data-urlencode 'subject_token_type=urn:ietf:params:oauth:token-type:id_token' \
  --data-urlencode "subject_token=$TOK")"
UCT="$(printf '%s' "$XCH" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
check "5 token exchange yields an internal token" "yes" "$([ -n "$UCT" ] && echo yes || echo no)"
check "6 authenticated read with the exchanged token" "200" \
  "$(status 18080 /api/2.1/unity-catalog/catalogs "Bearer $UCT")"

SVC="$(docker exec "$UC_ENFORCED" sh -c 'cat /home/unitycatalog/etc/conf/token.txt' 2>/dev/null | tr -d '\r\n')"
check "7 server-minted service token (the LOOM_UNITY_TOKEN path)" "200" \
  "$(status 18080 /api/2.1/unity-catalog/catalogs "Bearer $SVC")"

echo "== SEALED (sentinel .invalid audience) =="
check "8a anonymous read"  "401" "$(status 18082 /api/2.1/unity-catalog/catalogs)"
SEALED_XCH="$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST \
  "http://127.0.0.1:18082/api/1.0/unity-control/auth/tokens" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
  --data-urlencode 'subject_token_type=urn:ietf:params:oauth:token-type:id_token' \
  --data-urlencode "subject_token=$TOK")"
check "8b exchange of a real-audience token" "401" "$SEALED_XCH"

echo "== upstream #1603 — permission GET routes vs server.authorization (3-class overlay) =="
# BEFORE the overlay this GET returned 500 "No authorization expression found."
# with authz enabled (upstream #1603). The Dockerfile prepends THREE classes taken
# verbatim from upstream's released v0.5.1 artifact — PermissionService (which
# gained the one annotation that IS the #1603 fix), its synthetic sibling, and
# AuthorizeExpressions (which supplies the constant that annotation names) — and
# that is enough to make this route return 200. Case 10 is the control (authz
# disabled always returned 200).
#
# This case is the reason the overlay exists, so it is also the regression gate on
# narrowing it: if a future change drops PermissionService from the overlay, or the
# base tag moves and the build's digest assertions are loosened instead of
# re-derived, THIS case goes back to 500.
check "9  GET /permissions with authz ENABLED"  "200" \
  "$(status 18080 /api/2.1/unity-catalog/permissions/catalog/unity "Bearer $UCT")"
check "10 GET /permissions with authz DISABLED" "200" \
  "$(status 18081 /api/2.1/unity-catalog/permissions/catalog/unity)"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
