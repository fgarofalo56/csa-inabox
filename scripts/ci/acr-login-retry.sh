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
# Those two runs failed on the AAD token exchange — `CONNECTIVITY_REFRESH_TOKEN_ERROR`,
# then `Response code: 403` — which is a genuinely different call from the anonymous
# `GET /v2/` the probe makes, and gov-console-roll succeeded in the same window on
# the same day, which is the signature of a transient rather than a permission
# defect. So the RETRY this script adds was, and remains, the right response.
#
# WHAT WAS WRONG HERE, AND IS NOW STRUCK (#4067, 2026-08-25).
#
# This block used to generalise from those two runs to the claim that a
# READY-then-denied pair is "not a contradiction" because "the token exchange is a
# different surface". That reasoning does not hold, and it was the stated reason
# the probe itself was left alone. Three runs denied on the SAME surface, the same
# path, ~2s after the probe reported READY:
#
#   31564296050  deploy-loom-sharing     READY 04:48:12.008 -> denied 04:48:13.821
#   32248671357  loom-roll-and-validate  READY 11:46:35.621 -> denied 11:46:37.254
#   32819789544  loom-roll-and-validate  READY 07:13:27.818 -> denied 07:13:29.912
#
# Every one of those denials reads `Get "https://<acr>/v2/": denied: … client with
# IP '<ip>' is not allowed access` — the exact URL the probe had just polled, from
# the same runner. What they establish is NOT the same for all three, and stating
# one mechanism for all three would be the same over-general claim this block was
# rewritten to strike (deploy-integrity.md R7):
#
#   31564296050 and 32248671357 support the propagation reading. 32248671357 is
#     the strongest: it held the firewall lease EXCLUSIVELY — no contention, no
#     re-lock until 11:46:40 — so nothing closed the registry between the 401 and
#     the denial. A denial on `/v2/` seconds after a 401 on `/v2/` in THAT job is
#     not two surfaces disagreeing; it is one surface whose firewall rule had not
#     finished propagating across frontends.
#   32819789544 does NOT support it. #4067's own "Caveat on (A)" records that this
#     job held no lease (`ACR_LEASE_STATE: none`) and rode another run's open
#     window, so a concurrent RE-LOCK by the lease holder is an equally consistent
#     explanation — and re-sampling cannot fix that one. If you hit an ACR denial
#     in a no-lease job, look for a concurrent re-lock BEFORE concluding
#     propagation; the probe's consecutive sampling does not address it.
#
# The real defect was that the probe treated ONE sample as an observation. It now
# requires 3 consecutive fresh-connection samples spaced >=2s, with any 403, any
# connect failure and any other status resetting the count, and that floor is
# ENFORCED rather than merely defaulted — dropping below it, or asking for a
# sample count the budget cannot fit (which can only ever fail closed, and at 14
# of the 17 call sites is discarded anyway), needs
# `--unsafe-sampling-below-4067-floor "<reason>"`
# (scripts/ci/acr-dataplane-ready.sh). Note that this changed its READY line: the
# `READY after 1 attempt(s) — HTTP 401 …` text quoted above and below is a
# historical log excerpt, not a string the script emits any more.
#
# None of that weakens the case for retrying here. Propagation is asynchronous,
# so even N consecutive answers cannot promise the next call will be allowed —
# which is precisely why a denial must be ridden out rather than trusted as a
# permanent verdict.
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
#
# THE IP-DENIAL SHAPE (loom-roll-and-validate run 32819789544, 2026-08-25 - a P0
# roll failure that froze the Commercial estate mid-roll). `az acr login` shells
# out to the Docker daemon when one is present, and the daemon reports a firewall
# refusal in ITS words, not the AAD client's:
#
#   [acr-dataplane-ready] READY after 1 attempt(s) - HTTP 401 ...   <- probe: open
#   WARNING: Error response from daemon: Get "https://<acr>/v2/": denied:
#     {"errors":[{"code":"DENIED","message":"client with IP '<ip>' is not allowed
#      access. Refer https://aka.ms/acr/firewall to grant access."}]}
#   ERROR: Login failed.
#
# That text contains NO `Response code: 403` and none of the other needles below,
# so the set classified the CANONICAL post-open propagation failure as permanent
# and exited on attempt 1 - the precise outcome this script exists to prevent.
#
# `is not allowed access` is the right needle. It is emitted by ACR's NETWORK
# RULE path; acr-dataplane-ready.sh:33-36 measured it on 2026-08-11, but what it
# measured was firewall-CLOSED (403 DENIED ... is not allowed access) vs
# firewall-OPEN (401 UNAUTHORIZED), with an anonymous `curl GET /v2/`. A probe
# with no principal cannot produce an RBAC denial, so that measurement does NOT
# establish that an RBAC denial never carries this phrase. Do not cite it for
# that.
#
# It does not need to. The narrowness claim is NOT load-bearing here: the
# canonical RBAC denial ("Access to registry 'x' was denied. Response code:
# 403.") already matches `Response code: 403` in the set below, so it is
# ALREADY retried today, pre-this-change. Even if `is not allowed access` did
# appear in some RBAC wording, this needle changes nothing about how that case
# is classified. The behaviour this line adds is confined to the daemon-worded
# firewall refusal above, which matched nothing at all.
#
# COST OF BEING WRONG. If the lease genuinely never opened the registry, this now
# takes ~165s to say so instead of ~0s. That is the SAME trade #3383 already made
# deliberately for a true RBAC denial: a slow true answer beats a fast false one,
# and the exhaustion message names both possibilities rather than asserting one.
# #4055 — THE SET WAS NARROWER THAN THE SIBLING GUARD ON THE SAME ROLL PATH.
#
# Forty lines from this `az acr login`, `.github/workflows/loom-roll-and-validate.yml`
# retries cosign on `DENIED|is not allowed access|no route to host|TLS handshake|
# connection refused|i/o timeout|502 Bad Gateway|503 Service`. Two guards, one
# registry, one propagation window - and whichever is NARROWER decides how the
# roll actually fails. This one was.
#
# WHAT WAS ADDED, and why each is safe:
#
#   status: 403 Forbidden   Microsoft's own troubleshooting page
#                           (container-registry-troubleshoot-access) documents
#                           `Error response from daemon: login attempt failed
#                           with status: 403 Forbidden`. Note it is NOT the
#                           string `Response code: 403` the AAD client emits, so
#                           the existing needle did not cover it - the same
#                           daemon-in-its-own-words miss as #4052.
#   aka.ms/acr/firewall     ACR appends this link to NETWORK-RULE refusals only.
#                           Its permission denials point at aka.ms/acr/authorization.
#   host is not reachable   The private-endpoint / DNS wording. DECIDED: TRANSIENT.
#                           The reasoning, stated because the issue asked for a
#                           recorded decision either way - a PE record and its
#                           DNS propagate asynchronously after a deploy or a
#                           firewall lease, which is the same class of window
#                           this script already rides out, and the sibling guard
#                           already retries `no route to host` for the same
#                           registry. Cost of being wrong is bounded and known:
#                           ~165s to say so instead of ~0s, and the exhaustion
#                           message names every possibility rather than asserting
#                           one (R7). If a genuinely permanent DNS gap starts
#                           costing 3 minutes a roll, REVERSE THIS, do not widen
#                           it further.
#   no route to host        Convergence with the sibling's transport needles.
#   TLS handshake, connection refused, i/o timeout, 502 Bad Gateway
#                           Same - all transport, none of them a verdict about
#                           authorization.
#
# WHAT IS DELIBERATELY *NOT* ADOPTED FROM THE SIBLING, so the divergence is
# documented rather than left for the next reader to diff (#4055 acceptance):
# bare `DENIED`. `grep -qiE` is case-insensitive, so `DENIED` also matches
#     denied: requested access to the resource is denied
# which is ACR's REPO-PERMISSION denial. No amount of retrying grants a role, so
# that must stay permanent - and `test-acr-login-retry.sh`'s PERMDENY_MSG /
# PERMDENY_LINK_MSG fixtures go red if anyone widens a needle far enough to
# swallow it. The sibling can afford bare `DENIED` because its own failure mode
# is "report unreachable and continue"; this one exits 1 and stops the roll.
TRANSIENT='CONNECTIVITY_REFRESH_TOKEN_ERROR|Response code: 403|status: 403 Forbidden|is not allowed access|aka\.ms/acr/firewall|try running .az login. again|TooManyRequests|temporarily unavailable|Connection aborted|connection reset|connection refused|no route to host|host is not reachable|TLS handshake|i/o timeout|ServiceUnavailable|GatewayTimeout|502 Bad Gateway|504|503'

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

echo "::error::acr-login-retry: could NOT authenticate to '${ACR}' after ${ATTEMPTS} attempts over ${SECONDS}s (budget ${ATTEMPTS}x${BACKOFF}s). Every attempt failed with a transient-looking auth error, so this is either a token-exchange window far longer than expected, a registry whose network rules never admitted this runner (the firewall lease may have been erased mid-run - see #3676), or a permission problem wearing a transient's clothes. LAST ERROR: $(printf '%s' "$LAST" | tr -d '\r' | tr '\n' ' ' | cut -c1-400)" >&2
exit 1
