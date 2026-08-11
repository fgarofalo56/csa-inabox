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
# EVERYTHING IS DISCOVERED FROM THE HOST. This takes a resource group and a
# hostname; the profile, custom domain, endpoints and routes are all resolved
# from Azure. It does NOT accept an endpoint or route NAME, deliberately:
# scripts/ci/check-afd-endpoint-discovery.mjs exists because addressing a CDN
# endpoint by a name CI never discovered is how you act on the wrong endpoint on
# an estate that differs. It also makes this check STRONGER for its purpose — it
# asserts SOME route in the profile carries the domain, so it sees the unbinding
# no matter which route was meant to carry it, and survives a rename or a split.
#
# WHAT THIS CHECKS, AND WHY BOTH HALVES
#
#   1. CONTROL PLANE — some route in the profile lists the custom domain. This is
#      the real defect and it is visible IMMEDIATELY, with no edge-propagation
#      lag. Re-binding took ~25 minutes to reach the edge both times, so a
#      data-plane-only check would call a just-repaired estate broken for 25
#      minutes and would miss a fresh break for as long as the edge cached.
#
#   2. DATA PLANE — the vanity host serves a certificate that is NOT the
#      `*.azureedge.net` fallback. This is what the operator experiences, and it
#      catches breakage the control plane cannot explain.
#
# FAIL CLOSED (deploy-integrity.md R7). An unreadable control plane is UNKNOWN,
# not healthy, and says so. A `2>/dev/null` here would convert "I could not read
# the routes" into "no route carries the domain" — a false outage report — and
# the inverse mistake would hide a real one.
#
# NOTE: this script's header is `set -uo pipefail` — it never enables -e. A bare
# `set -e` here would TURN IT ON rather than restore it, and every later non-zero
# command would abort with THAT command's exit code, bypassing the exit contract
# below. Measured on an earlier draft: an unparseable route JSON exited 5 (jq's
# parse-error code) instead of the contracted 2. See check-set-e-restore.mjs.
#
# USAGE
#   bash scripts/ci/check-vanity-edge-health.sh --rg <rg> --host <vanity host>
#
# Exit codes:
#   0  a route carries the domain AND the edge serves a non-fallback certificate
#   1  BROKEN — no route carries the domain, or the edge serves the fallback
#   2  UNKNOWN — the control plane could not be read (never reported as broken)
#   3  usage
# -----------------------------------------------------------------------------
set -uo pipefail

RG=""; HOST=""; SKIP_EDGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --rg) RG="${2:-}"; shift 2 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --skip-edge) SKIP_EDGE=1; shift ;;
    -h|--help) sed -n '1,72p' "$0"; exit 0 ;;
    *) echo "check-vanity-edge-health: unknown argument '$1'" >&2; exit 3 ;;
  esac
done

if [ -z "$RG" ] || [ -z "$HOST" ]; then
  echo "::error::check-vanity-edge-health: --rg and --host are both required." >&2
  exit 3
fi

RC=0

# STDOUT IS THE VALUE, STDERR IS THE EVIDENCE — never `2>&1` into a value.
#
# The first live run (loom-synthetic-monitor 31481444420) died with:
#
#   could NOT list custom domains on profile 'WARNING: Preview version of
#   extension is disabled by default for extension installation…'
#
# `az` prints extension-install notices, and `2>&1` folded them INTO the captured
# profile list, so a warning line was read as a profile NAME. It did not happen
# locally because the `afd` extension was already installed here — the classic
# shape where a clean workstation hides a runner-only fault.
#
# Fixed two ways, belt and braces: `--only-show-errors` suppresses the notices,
# and stderr goes to a FILE so a message can still be quoted in an error without
# ever contaminating the value. (Note the inverse mistake is also recorded in this
# repo: treating non-empty stderr as failure, when az writes notices there
# routinely. The exit CODE is the verdict; stderr is only ever evidence.)
ERRF="$(mktemp)"
trap 'rm -f "$ERRF"' EXIT
azerr() { tr -d '' < "$ERRF" | tr '
' ' ' | cut -c1-300; }

# ── 1. CONTROL PLANE — discovered end to end from $HOST ──────────────────────
echo "== (1) Front Door route binding for ${HOST} =="

PROFILES="$(az afd profile list -g "$RG" --query "[].name" -o tsv --only-show-errors 2>"$ERRF")"
PROF_RC=$?
if [ $PROF_RC -ne 0 ]; then
  echo "::error::check-vanity-edge-health: could NOT list Front Door profiles in '${RG}' (az exit ${PROF_RC}): $(printf '%s' "$PROFILES" | tr -d '\r' | tr '\n' ' ' | cut -c1-300). This is an UNKNOWN — it does NOT establish that ${HOST} is unbound. Grant the probe identity CDN Profile Reader on ${RG}." >&2
  exit 2
fi

PROFILES="$(printf '%s' "$PROFILES" | tr -d '\r')"
if [ -z "$PROFILES" ]; then
  echo "::error::check-vanity-edge-health: no Front Door profile exists in '${RG}', so ${HOST} cannot be served from this resource group at all. If the estate is meant to have one, the deploy did not create it; if the host moved, point this check at the right resource group." >&2
  exit 1
fi

FOUND_PROFILE=""
FOUND_DOMAIN=""
while IFS= read -r P; do
  [ -z "$P" ] && continue
  CD="$(az afd custom-domain list --profile-name "$P" -g "$RG" --query "[?hostName=='${HOST}'].name | [0]" -o tsv --only-show-errors 2>"$ERRF")"
  CD_RC=$?
  CD="$(printf '%s' "$CD" | tr -d '\r')"
  if [ $CD_RC -ne 0 ]; then
    echo "::error::check-vanity-edge-health: could NOT list custom domains on profile '${P}' (az exit ${CD_RC}): $(printf '%s' "$CD" | tr '\n' ' ' | cut -c1-200). UNKNOWN, not unbound." >&2
    exit 2
  fi
  if [ -n "$CD" ] && [ "$CD" != "None" ]; then
    FOUND_PROFILE="$P"; FOUND_DOMAIN="$CD"; break
  fi
done <<< "$PROFILES"

if [ -z "$FOUND_PROFILE" ]; then
  echo "::error::check-vanity-edge-health: NO custom domain for ${HOST} exists on any Front Door profile in '${RG}'. The host is not configured at the edge at all — a deploy gap, not a binding that came loose. Profiles searched: $(printf '%s' "$PROFILES" | tr '\n' ' ')." >&2
  exit 1
fi
echo "  discovered: profile='${FOUND_PROFILE}' customDomain='${FOUND_DOMAIN}'"

# Which route — if any — carries it? Enumerate rather than assume a name: the
# BINDING is what breaks, so a check that needed the binding to find the route
# could never see the outage.
ENDPOINTS="$(az afd endpoint list --profile-name "$FOUND_PROFILE" -g "$RG" --query "[].name" -o tsv --only-show-errors 2>"$ERRF")"
EP_RC=$?
ENDPOINTS="$(printf '%s' "$ENDPOINTS" | tr -d '\r')"
if [ $EP_RC -ne 0 ]; then
  echo "::error::check-vanity-edge-health: could NOT list endpoints on '${FOUND_PROFILE}' (az exit ${EP_RC}): $(printf '%s' "$ENDPOINTS" | tr '\n' ' ' | cut -c1-200). UNKNOWN, not unbound." >&2
  exit 2
fi

CARRIER=""
ROUTES_SEEN=0
while IFS= read -r EP; do
  [ -z "$EP" ] && continue
  # $EP is EVERY endpoint name read out of the `az afd endpoint list` above —
  # this loop enumerates what Azure returned, it does not address a name someone
  # chose. The guard's tracer follows a variable to its `az ... list|show`
  # assignment but cannot follow one through a `while read` loop, so it sees $EP
  # as untraced. The value it distrusts IS the discovered list.
  # afd-endpoint-discovery-ok: $EP is read from `az afd endpoint list` 8 lines above
  ROUTES_JSON="$(az afd route list --profile-name "$FOUND_PROFILE" -g "$RG" --endpoint-name "$EP" -o json --only-show-errors 2>"$ERRF")"
  R_RC=$?
  if [ $R_RC -ne 0 ]; then
    echo "::error::check-vanity-edge-health: could NOT list routes on endpoint '${EP}' (az exit ${R_RC}): $(printf '%s' "$ROUTES_JSON" | tr -d '\r' | tr '\n' ' ' | cut -c1-200). UNKNOWN, not unbound." >&2
    exit 2
  fi
  N="$(printf '%s' "$ROUTES_JSON" | jq 'length' 2>/dev/null)"
  if [ -z "$N" ]; then
    echo "::error::check-vanity-edge-health: the route list for '${EP}' is not readable JSON. Refusing to infer a binding from it: $(printf '%s' "$ROUTES_JSON" | tr -d '\r' | tr '\n' ' ' | cut -c1-200)" >&2
    exit 2
  fi
  ROUTES_SEEN=$(( ROUTES_SEEN + N ))
  HIT="$(printf '%s' "$ROUTES_JSON" | jq -r --arg d "$FOUND_DOMAIN" '.[] | select([.customDomains[]?.id | select(. != null) | split("/") | last] | index($d)) | .name' 2>/dev/null | head -1)"
  if [ -n "$HIT" ]; then CARRIER="${EP}/${HIT}"; break; fi
done <<< "$ENDPOINTS"

if [ "$ROUTES_SEEN" -eq 0 ]; then
  echo "::error::check-vanity-edge-health: profile '${FOUND_PROFILE}' has NO routes at all, so nothing can serve ${HOST}." >&2
  RC=1
elif [ -z "$CARRIER" ]; then
  echo "::error::VANITY DOMAIN UNBOUND — no route in profile '${FOUND_PROFILE}' lists custom domain '${FOUND_DOMAIN}' (${ROUTES_SEEN} route(s) checked). '${HOST}' therefore has NO route, so the edge answers its SNI with the fallback *.azureedge.net certificate and every browser refuses the connection. NOTE: the custom-domain resource itself will still read Approved/Succeeded with a valid ManagedCertificate — check the ROUTE, not the domain. Repair: az afd route update --profile-name ${FOUND_PROFILE} -g ${RG} --endpoint-name <endpoint> --route-name <route> --formatted-custom-domains \"[{id:<customDomainId>}]\" (NOT --custom-domains, which does not exist). Edge propagation of the re-bind takes ~25 minutes."
  RC=1
else
  echo "  OK — carried by route '${CARRIER}'."
fi

# ── 2. DATA PLANE ────────────────────────────────────────────────────────────
if [ "$SKIP_EDGE" = "1" ]; then
  echo "== (2) edge certificate — SKIPPED (--skip-edge) =="
  exit $RC
fi

echo "== (2) certificate served at the edge for ${HOST} =="
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
