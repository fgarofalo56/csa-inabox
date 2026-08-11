#!/usr/bin/env bash
# =============================================================================
# check-vanity-edge-health.sh — is the URL the OPERATOR opens actually serving?
# =============================================================================
#
# WHY (two production outages, neither detected by anything we run).
#
# `csa-loom.limitlessdata.ai` has now lost its Front Door route binding TWICE —
# 2026-08-10 (reported by the operator) and again 2026-08-11 (found by hand while
# draining unrelated work). Both times the signature was identical:
#
#     vanity host  -> subject=CN=*.azureedge.net   http=000 (TLS refused)
#     *.azurefd.net-> subject=CN=*.azurefd.net     http=200
#     route console-route: customDomains = 0
#     custom domain csa-loom-limitlessdata: Approved / Succeeded / ManagedCertificate
#
# The custom domain reads PERFECTLY HEALTHY throughout. The ROUTE is what breaks:
# with `customDomains: []` the vanity host has no route, so the edge answers its
# SNI with the fallback `*.azureedge.net` certificate and every browser refuses.
#
# NOTHING WE RUN COULD SEE IT. Measured 2026-08-11:
#   * loom-synthetic-monitor's ACA job probes LOOM_URL=`http://loom-console` —
#     the IN-CLUSTER name. It never leaves the Container Apps environment, so it
#     is blind to Front Door, to the vanity binding, and to TLS entirely. It
#     reported success at 02:52, 04:20 and 05:35 across this outage.
#   * loom-uat's job probes the `*.azurefd.net` host, which stays healthy while
#     the vanity host is dead — that is the CONTROL, not the subject.
#
# So the one URL a human actually opens is the one URL nothing checks.
#
# WHAT THIS CHECKS, AND WHY BOTH HALVES
#
#   1. CONTROL PLANE — the route's `customDomains` is non-empty. This is the
#      real defect and it is visible IMMEDIATELY, with no edge-propagation lag.
#      (Re-binding took ~25 minutes to reach the edge both times; a data-plane-
#      only check would call a just-repaired estate broken for 25 minutes, and
#      would not notice a fresh break for however long the edge cached.)
#
#   2. DATA PLANE — the vanity host serves a certificate that is NOT the
#      `*.azureedge.net` fallback. This is what the operator experiences, and it
#      catches breakage the control plane cannot explain.
#
# FAIL CLOSED (deploy-integrity.md R7). An unreadable control plane is UNKNOWN,
# not healthy, and says so. A `2>/dev/null` here would convert "I could not read
# the route" into "the route has no custom domains" — a false outage report —
# and the inverse mistake would hide a real one.
#
# USAGE
#   bash scripts/ci/check-vanity-edge-health.sh \
#     --profile <fdProfile> --rg <rg> --endpoint <afdEndpoint> --route <route> \
#     --host csa-loom.limitlessdata.ai
#
# Exit codes:
#   0  bound at the control plane AND serving its own certificate
#   1  BROKEN — the route has no custom domains, or the edge serves the fallback
#   2  UNKNOWN — the control plane could not be read (never reported as broken)
#   3  usage
# -----------------------------------------------------------------------------
set -uo pipefail

PROFILE=""; RG=""; ENDPOINT=""; ROUTE=""; HOST=""
SKIP_EDGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --rg) RG="${2:-}"; shift 2 ;;
    --endpoint) ENDPOINT="${2:-}"; shift 2 ;;
    --route) ROUTE="${2:-}"; shift 2 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --skip-edge) SKIP_EDGE=1; shift ;;
    -h|--help) sed -n '1,60p' "$0"; exit 0 ;;
    *) echo "check-vanity-edge-health: unknown argument '$1'" >&2; exit 3 ;;
  esac
done

if [ -z "$PROFILE" ] || [ -z "$RG" ] || [ -z "$ENDPOINT" ] || [ -z "$ROUTE" ] || [ -z "$HOST" ]; then
  echo "::error::check-vanity-edge-health: --profile, --rg, --endpoint, --route and --host are all required." >&2
  exit 3
fi

RC=0

# ── 1. CONTROL PLANE ─────────────────────────────────────────────────────────
echo "== (1) Front Door route binding =="
set +e
ROUTE_JSON="$(az afd route show --profile-name "$PROFILE" -g "$RG" \
  --endpoint-name "$ENDPOINT" --route-name "$ROUTE" -o json 2>&1)"
ROUTE_RC=$?
if [ $ROUTE_RC -ne 0 ]; then
  echo "::error::check-vanity-edge-health: could NOT read route '${ROUTE}' on endpoint '${ENDPOINT}' (az exit ${ROUTE_RC}): $(printf '%s' "$ROUTE_JSON" | tr -d '\r' | tr '\n' ' ' | cut -c1-300). This is an UNKNOWN — it does NOT establish that the vanity domain is unbound. Grant the probe identity CDN Profile Reader on the profile's resource group." >&2
  exit 2
fi

N_DOMAINS="$(printf '%s' "$ROUTE_JSON" | jq '.customDomains | length' 2>/dev/null)"
if [ -z "$N_DOMAINS" ]; then
  echo "::error::check-vanity-edge-health: az returned output with no readable .customDomains for route '${ROUTE}'. Refusing to infer a count from it: $(printf '%s' "$ROUTE_JSON" | tr -d '\r' | tr '\n' ' ' | cut -c1-200)" >&2
  exit 2
fi

if [ "$N_DOMAINS" -eq 0 ]; then
  echo "::error::VANITY DOMAIN UNBOUND — route '${ROUTE}' on endpoint '${ENDPOINT}' has customDomains: []. '${HOST}' therefore has NO route, so the edge answers its SNI with the fallback *.azureedge.net certificate and every browser refuses the connection. NOTE: the custom-domain resource itself will still read Approved/Succeeded with a valid ManagedCertificate — check the ROUTE, not the domain. Repair: az afd route update --profile-name ${PROFILE} -g ${RG} --endpoint-name ${ENDPOINT} --route-name ${ROUTE} --formatted-custom-domains \"[{id:<customDomainId>}]\" (NOT --custom-domains, which does not exist). Edge propagation of the re-bind takes ~25 minutes."
  RC=1
else
  echo "  OK — ${N_DOMAINS} custom domain(s) bound to the route."
fi

# ── 2. DATA PLANE ────────────────────────────────────────────────────────────
if [ "$SKIP_EDGE" = "1" ]; then
  echo "== (2) edge certificate — SKIPPED (--skip-edge) =="
  exit $RC
fi

echo "== (2) certificate served at the edge for ${HOST} =="
set +e
SUBJECT="$(echo | timeout 25 openssl s_client -servername "$HOST" -connect "${HOST}:443" 2>/dev/null | grep -m1 '^subject=')"
if [ -z "$SUBJECT" ]; then
  echo "::warning::could not complete a TLS handshake with ${HOST}, so the served certificate is UNKNOWN. That is not by itself proof of an outage — a runner-side network or DNS fault produces the same silence. The control-plane verdict above is the authoritative one."
else
  echo "  served: ${SUBJECT}"
  # The FD fallback certificate is the SIGNATURE of an unbound host. Matching on
  # it (rather than trying to prove the right cert is present) is deliberate:
  # a correct estate can legitimately serve several different subjects over time
  # as managed certificates rotate, but it can never serve the fallback.
  if printf '%s' "$SUBJECT" | grep -qi 'azureedge\.net'; then
    echo "::error::EDGE SERVING THE FRONT DOOR FALLBACK CERTIFICATE for ${HOST} (${SUBJECT}). A browser reports ERR_CERT_COMMON_NAME_INVALID and refuses to load the console. If the route binding above reads OK, this is edge propagation still catching up from a recent re-bind (~25 min); if it also reads unbound, the binding is the cause."
    RC=1
  else
    echo "  OK — not the *.azureedge.net fallback."
  fi
fi

exit $RC
