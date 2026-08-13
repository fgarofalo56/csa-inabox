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
# WHY THE BUDGET IS 180s AND NOT 60s (#3383, raised 2026-08-13).
#
# The original 6x10s was a guess, and it was too small. loom-roll-and-validate run
# 31732873272 exhausted it and rolled the estate back, pinning production two
# commits behind main:
#
#     18:54:09  [acr-dataplane-ready] READY after 1 attempt(s) — HTTP 401     (+37s)
#     18:55:09  acr-login-retry: could NOT authenticate … after 6 attempts    (+97s)
#
# The sibling roll 31730667086 minted its token in ~3s off an identically-timed
# probe (+37s READY, +40s cosign) — same code path, same registry, same identity,
# different outcome. That is the token-exchange tail this script was written for,
# just longer than the budget it was given.
#
# So the two propagation windows now get the SAME budget. The SC1 gate already
# allows the network probe 180s (loom-roll-and-validate.yml, --timeout-seconds
# 180); allowing the token exchange 60s while documenting it as a separate window
# with its own tail was the defect. 12 attempts x 15s covers ~165s of backoff.
#
# Raising it costs nothing on the failure paths that matter: a non-transient error
# still exits on attempt 1. The one case that does get slower is a genuine RBAC
# denial, which also presents as 403 — it now takes ~3min to say so instead of
# ~1min. That trade is deliberate: a slow true answer beats a fast false one, and
# the exhaustion message names both possibilities rather than asserting one (R7).
#
# The defaults are covered by scripts/ci/test-acr-login-retry.sh, which measures
# them THROUGH the retry loop rather than grepping for the literals — so silently
# lowering them back fails a test instead of quietly re-arming this incident.
#
# NOTE: this script's header is `set -uo pipefail` — it never enables -e, and a
# bare `set -e` here would TURN IT ON rather than restore it
# (scripts/ci/check-set-e-restore.mjs).
#
# USAGE
#   bash scripts/ci/acr-login-retry.sh --acr <name> [--attempts 12] [--backoff 15]
#
# Exit codes:
#   0  logged in
#   1  a NON-transient failure, or the retry budget was exhausted (fails closed)
#   3  usage
# -----------------------------------------------------------------------------
set -uo pipefail

ACR=""
# Sized to the ACR token-exchange propagation tail — see the #3383 note above.
# Keep in lockstep with the SC1 gate's --timeout-seconds 180 network probe.
ATTEMPTS=12
BACKOFF=15

while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    --attempts) ATTEMPTS="${2:-12}"; shift 2 ;;
    --backoff) BACKOFF="${2:-15}"; shift 2 ;;
    -h|--help) sed -n '1,80p' "$0"; exit 0 ;;
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
# Report the time this actually took, not ATTEMPTS*BACKOFF — the loop never
# sleeps after the final attempt, so the arithmetic would overstate it, and an
# error that asserts a duration it did not measure is exactly what R7 forbids.
SECONDS=0
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

echo "::error::acr-login-retry: could NOT authenticate to '${ACR}' after ${ATTEMPTS} attempts over ${SECONDS}s (budget ${ATTEMPTS}x${BACKOFF}s). Every attempt failed with a transient-looking auth error, so this is either a token-exchange window far longer than expected or a permission problem wearing a transient's clothes. LAST ERROR: $(printf '%s' "$LAST" | tr -d '\r' | tr '\n' ' ' | cut -c1-400)" >&2
exit 1
