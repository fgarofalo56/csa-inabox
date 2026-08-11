#!/usr/bin/env bash
# =============================================================================
# acr-login-retry.sh — mint the ACR data-plane token, with bounded retry.
# =============================================================================
#
# WHY (a regression I introduced in #3209, caught by the roll path failing twice).
#
# Before #3209 the SC1 gate polled `az acr login` up to 18 times over 3 minutes
# and treated the first success as "the data plane is reachable". That oracle was
# wrong — `az acr login` authenticates through an ARM-mediated token exchange and
# returns 0 against a registry still refusing raw HTTP by IP — so #3209 replaced
# it with a real reachability probe (scripts/ci/acr-dataplane-ready.sh) followed
# by ONE `az acr login` for credentials.
#
# Replacing the oracle was right. Dropping the RETRY was not. That loop had also
# been absorbing a second, unrelated transient: the AAD -> ACR token exchange has
# its own propagation window after the firewall opens, separate from `/v2/`
# reachability. Measured on loom-roll-and-validate runs 31477166587 and
# 31478802493, both of which failed on consecutive commits:
#
#     [acr-lease] opening ACR (publicNetworkAccess=Enabled, defaultAction=Allow) ...
#     [acr-dataplane-ready] READY after 1 attempt(s) — HTTP 401 …   <- network IS open
#     WARNING: Unable to get AAD authorization tokens with message: CONNECTIVITY_REFRESH_TOKEN_ERROR
#     Access to registry '…' was denied. Response code: 403.
#     ERROR: Unable to authenticate using AAD or admin login credentials.
#
# The probe's verdict was CORRECT and the two failures are not a contradiction:
# `/v2/` answering 401 means the request reached the auth layer, which is exactly
# what it claims. The token exchange is a different surface and was still 403ing
# ~38 seconds after the open. gov-console-roll succeeded in the same window on the
# same day, which is the signature of a transient, not a permission defect.
#
# WHAT IS RETRIED, AND WHAT IS NOT. Only signals that are genuinely transient in
# this window. A registry that does not exist, or a principal with no role, fails
# on attempt 1 — retrying those buys nothing except a less accurate error
# (deploy-integrity.md R6).
#
# NOTE: this script's header is `set -uo pipefail` — it never enables -e, and a
# bare `set -e` here would TURN IT ON rather than restore it
# (scripts/ci/check-set-e-restore.mjs).
#
# USAGE
#   bash scripts/ci/acr-login-retry.sh --acr <name> [--attempts 6] [--backoff 10]
#
# Exit codes:
#   0  logged in
#   1  a NON-transient failure, or the retry budget was exhausted (fails closed)
#   3  usage
# -----------------------------------------------------------------------------
set -uo pipefail

ACR=""
ATTEMPTS=6
BACKOFF=10

while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    --attempts) ATTEMPTS="${2:-6}"; shift 2 ;;
    --backoff) BACKOFF="${2:-10}"; shift 2 ;;
    -h|--help) sed -n '1,50p' "$0"; exit 0 ;;
    *) echo "acr-login-retry: unknown argument '$1'" >&2; exit 3 ;;
  esac
done

if [ -z "$ACR" ]; then
  echo "::error::acr-login-retry: --acr <registryName> is required." >&2
  exit 3
fi

# Transient in the window right after an ACR firewall open, or under throttling.
TRANSIENT='CONNECTIVITY_REFRESH_TOKEN_ERROR|Response code: 403|try running .az login. again|TooManyRequests|temporarily unavailable|Connection aborted|connection reset|ServiceUnavailable|GatewayTimeout|504|503'

LAST=""
for i in $(seq 1 "$ATTEMPTS"); do
  OUT="$(az acr login --name "$ACR" 2>&1)"
  RC=$?
  if [ $RC -eq 0 ]; then
    [ "$i" -gt 1 ] && echo "::notice::acr-login-retry: authenticated to '${ACR}' on attempt ${i}."
    exit 0
  fi
  LAST="$OUT"
  if ! printf '%s' "$OUT" | grep -qiE "$TRANSIENT"; then
    echo "::error::acr-login-retry: could NOT authenticate to '${ACR}' and the failure is NOT transient, so retrying cannot help: $(printf '%s' "$OUT" | tr -d '\r' | tr '\n' ' ' | cut -c1-400)" >&2
    exit 1
  fi
  if [ "$i" -lt "$ATTEMPTS" ]; then
    echo "::warning::acr-login-retry: attempt ${i}/${ATTEMPTS} to authenticate to '${ACR}' hit a transient auth failure; waiting ${BACKOFF}s. $(printf '%s' "$OUT" | tr -d '\r' | tr '\n' ' ' | cut -c1-200)"
    sleep "$BACKOFF"
  fi
done

echo "::error::acr-login-retry: could NOT authenticate to '${ACR}' after ${ATTEMPTS} attempts over ~$(( ATTEMPTS * BACKOFF ))s. Every attempt failed with a transient-looking auth error, so this is either a token-exchange window far longer than expected or a permission problem wearing a transient's clothes. LAST ERROR: $(printf '%s' "$LAST" | tr -d '\r' | tr '\n' ' ' | cut -c1-400)" >&2
exit 1
