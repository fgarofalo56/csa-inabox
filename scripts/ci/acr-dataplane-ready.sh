#!/usr/bin/env bash
# =============================================================================
# acr-dataplane-ready.sh — wait until the ACR DATA PLANE actually answers this
#                          runner, on the same HTTP path the tools will use.
# =============================================================================
#
# WHY (loom-roll-and-validate run 31454217160, 2026-08-11 — a P0 roll failure).
# The SC1 cosign gate opened the ACR via the firewall lease and then polled
# `az acr login` to decide the data plane was reachable:
#
#     03:05:48.748  [acr-lease] opening ACR (publicNetworkAccess=Enabled, defaultAction=Allow) ...
#     03:05:48.748  ACR data plane reachable after 1 attempt(s).      <-- ZERO seconds later
#     03:05:50.762  Verifying cosign signature on …@sha256:3dc79f53 ...
#     03:05:51.221  Error: POST https://…/oauth2/token: DENIED: client with IP
#                   '20.3.215.35' is not allowed access.
#
# `az acr login` returned 0 two seconds after the ARM write, while the registry
# was still denying by IP. ACR firewall changes take 30–90s to reach the data
# plane — this repo's own comment block in that very step says so, and the step
# was already hardened against the RE-LOCK direction of exactly this lag. The
# OPEN direction had the mirror-image bug, and `az acr login` is the wrong
# oracle in BOTH directions: it authenticates through an ARM-mediated token
# exchange that does not exercise the anonymous registry endpoint cosign hits.
#
# The consequence was worse than a retry: the gate then declared the image
# "has NO valid cosign signature from a trusted build workflow" — a fact it had
# not established. It could not READ the signature. That is deploy-integrity.md
# R7 ("an error must not state as fact something it did not establish") and the
# same UNKNOWN-as-NEGATIVE class as #2819/#2982.
#
# THE ORACLE. Poll `GET https://<acr><suffix>/v2/` with plain curl — same host,
# same TCP path as the signing/pulling tools use. The registry discriminates
# cleanly PER REQUEST, measured on both sides on 2026-08-11:
#
#   firewall CLOSED to this IP -> HTTP 403, body: DENIED … is not allowed access
#   firewall OPEN              -> HTTP 401, body: UNAUTHORIZED … authentication required
#
# 401 means that request reached the registry's auth layer, which is precisely
# as far as an unauthenticated probe can get and exactly the point cosign's
# token request fails when the firewall is shut.
#
# WHY ONE SAMPLE IS NOT AN OBSERVATION (#4067, 2026-08-25).
#
# The first version of this script exited READY on the FIRST 401/200 — typically
# in under 150 ms — and printed "the registry is evaluating auth, not blocking
# by IP". That second clause was a claim about the REGISTRY made from a single
# request, and it was falsified three times, on the SAME URL, ~2s later:
#
#   run 31564296050  deploy-loom-sharing     READY 04:48:12.008 -> denied 04:48:13.821 (1.81s)
#   run 32248671357  loom-roll-and-validate  READY 11:46:35.621 -> denied 11:46:37.254 (1.63s)
#   run 32819789544  loom-roll-and-validate  READY 07:13:27.818 -> denied 07:13:29.912 (2.09s)
#
# Every one of those denials was `Get "https://<acr>/v2/": denied: … client with
# IP '<ip>' is not allowed access` — the exact path this probe hits, from the
# same runner. 32248671357 is the cleanest: that job held the firewall lease
# exclusively, with no contention and no re-lock until 11:46:40.
#
# The mechanism is documented, not inferred: "Configure public IP network rules"
# (learn.microsoft.com/azure/container-registry/container-registry-access-selected-networks)
# says twice to "wait a few minutes for the rule to take effect". Propagation is
# ASYNCHRONOUS and PER-FRONTEND. One sample tells you what ONE frontend served
# ONE request; the next connection can land on a frontend that has not caught up.
#
# So the probe now requires CONSECUTIVE_REQUIRED positive samples, each from a
# fresh curl process (new connection, new DNS resolution — no keep-alive reuse),
# spaced SAMPLE_INTERVAL apart, and ANY 403 resets the streak to zero. Do not
# lower --consecutive-samples below 3 or --sample-interval-seconds below 2 in a
# caller: that re-arms #4067, and scripts/ci/test-acr-dataplane-ready.sh measures
# the DEFAULTS through the sampling loop (by counting probe requests and elapsed
# time) rather than grepping for the literals, so lowering them here fails a test.
#
# WHAT THIS STILL CANNOT PROVE. N consecutive answers are evidence that the rule
# has reached the frontends this runner reached, in that window — not a guarantee
# about the next call. Callers must still treat an IP denial as transient and
# retry it (scripts/ci/acr-login-retry.sh). The READY message says exactly that
# and claims nothing more.
#
# FAIL CLOSED, AND TELL THE TRUTH. On budget exhaustion this exits non-zero and
# prints the LAST OBSERVED status and body, plus the sample tally (positives,
# denials, longest streak). It never reports ready on a state it did not observe,
# and it never converts "I could not reach it" into "it is not there".
#
# USAGE
#   bash scripts/ci/acr-dataplane-ready.sh --acr <acrName> [--timeout-seconds 180]
#        [--interval-seconds 10] [--sample-interval-seconds 2] [--consecutive-samples 3]
#
# Exit codes:
#   0  data plane answered (401/200) on N consecutive samples — ready
#   1  never sustained N consecutive answers before the budget ran out
#   2  never got an HTTP response at all (DNS/connect) within the budget
#   3  usage / could not determine the cloud's registry suffix
# -----------------------------------------------------------------------------
set -uo pipefail

ACR=""
BUDGET=180
INTERVAL=10
SAMPLE_INTERVAL=2
CONSECUTIVE_REQUIRED=3

while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    --timeout-seconds) BUDGET="${2:-180}"; shift 2 ;;
    --interval-seconds) INTERVAL="${2:-10}"; shift 2 ;;
    --sample-interval-seconds) SAMPLE_INTERVAL="${2:-2}"; shift 2 ;;
    --consecutive-samples) CONSECUTIVE_REQUIRED="${2:-3}"; shift 2 ;;
    -h|--help) sed -n '1,95p' "$0"; exit 0 ;;
    *) echo "acr-dataplane-ready: unknown argument '$1'" >&2; exit 3 ;;
  esac
done

if [ -z "$ACR" ]; then
  echo "::error::acr-dataplane-ready: --acr <registryName> is required." >&2
  exit 3
fi

# Reject a non-numeric or non-positive sampling config rather than coercing it.
# A silent coercion is how a "3 consecutive samples" gate becomes a 1-sample gate
# without anything going red.
for pair in "BUDGET:$BUDGET" "INTERVAL:$INTERVAL" "SAMPLE_INTERVAL:$SAMPLE_INTERVAL" "CONSECUTIVE_REQUIRED:$CONSECUTIVE_REQUIRED"; do
  name="${pair%%:*}"; val="${pair#*:}"
  case "$val" in
    ''|*[!0-9]*)
      echo "::error::acr-dataplane-ready: ${name} must be a non-negative integer, got '${val}'." >&2
      exit 3 ;;
  esac
done
if [ "$CONSECUTIVE_REQUIRED" -lt 1 ]; then
  echo "::error::acr-dataplane-ready: --consecutive-samples must be >= 1, got '${CONSECUTIVE_REQUIRED}'." >&2
  exit 3
fi

# Suffix from the ACTIVE CLOUD, never a literal — Gov registries are .azurecr.us
# and a Commercial literal here reproduces #3209 (a Gov mirror whose read-back
# was refused before it ever reached the network).
ACR_SUFFIX="$(az cloud show --query 'suffixes.acrLoginServerEndpoint' -o tsv 2>/dev/null | tr -d '[:space:]')"
if [ -z "$ACR_SUFFIX" ]; then
  echo "::error::acr-dataplane-ready: could not read suffixes.acrLoginServerEndpoint from 'az cloud show'. Refusing to guess a registry suffix." >&2
  exit 3
fi

HOST="${ACR}${ACR_SUFFIX}"
URL="https://${HOST}/v2/"
STARTED=$(date +%s)
DEADLINE=$(( STARTED + BUDGET ))
ATTEMPT=0
STREAK=0
MAX_STREAK=0
POSITIVE_TOTAL=0
DENIED_TOTAL=0
NORESPONSE_TOTAL=0
OTHER_TOTAL=0
STREAK_START=0
STREAK_CODES=""
LAST_CODE=""
LAST_BODY=""

# The minimum wall time the happy path needs. Saying this up front makes a budget
# that CANNOT satisfy the sampling config diagnosable from the log, instead of
# presenting as an unexplained fail-closed after the budget burns.
MIN_SPAN=$(( (CONSECUTIVE_REQUIRED - 1) * SAMPLE_INTERVAL ))
if [ "$BUDGET" -lt "$MIN_SPAN" ]; then
  echo "::warning::acr-dataplane-ready: budget ${BUDGET}s is shorter than the ${MIN_SPAN}s minimum needed for ${CONSECUTIVE_REQUIRED} samples spaced ${SAMPLE_INTERVAL}s. This configuration can only fail closed."
fi

echo "[acr-dataplane-ready] probing ${URL} — need ${CONSECUTIVE_REQUIRED} consecutive 401/200 samples spaced ${SAMPLE_INTERVAL}s (budget ${BUDGET}s, ${INTERVAL}s backoff after a denial)"

while :; do
  ATTEMPT=$(( ATTEMPT + 1 ))
  BODY_FILE="$(mktemp)"
  # Each sample is a FRESH curl process: new TCP connection, new DNS resolution,
  # no keep-alive reuse. That is the point — ACR rule propagation is per-frontend,
  # so re-using one warm connection would re-ask the SAME frontend N times and
  # measure nothing that a single sample did not already measure (#4067).
  #
  # NOT `$(curl … || echo 000)`: curl already prints `000` on a connect failure
  # AND exits non-zero, so the fallback CONCATENATES and yields `000000` — which
  # then misses the `000` case below and reports a DNS failure as a firewall
  # refusal. That is the very UNKNOWN-as-NEGATIVE bug this script exists to kill,
  # reproduced inside the fix; caught by the negative test in
  # scripts/ci/test-acr-dataplane-ready.sh.
  CODE="$(curl -s -o "$BODY_FILE" -w '%{http_code}' --max-time 20 "$URL" 2>/dev/null)"
  [ -n "$CODE" ] || CODE="000"
  BODY="$(head -c 400 "$BODY_FILE" 2>/dev/null | tr -d '\r\n')"
  rm -f "$BODY_FILE"
  LAST_CODE="$CODE"
  LAST_BODY="$BODY"

  # WAIT is the pause before the NEXT sample. A positive sample uses the short
  # sampling spacing; anything else uses the longer backoff, because there is
  # nothing to gain from hammering a registry that is refusing us.
  WAIT=$INTERVAL

  case "$CODE" in
    401|200)
      POSITIVE_TOTAL=$(( POSITIVE_TOTAL + 1 ))
      STREAK=$(( STREAK + 1 ))
      [ "$STREAK" -eq 1 ] && STREAK_START=$(date +%s) && STREAK_CODES=""
      STREAK_CODES="${STREAK_CODES}${STREAK_CODES:+,}${CODE}"
      [ "$STREAK" -gt "$MAX_STREAK" ] && MAX_STREAK=$STREAK
      WAIT=$SAMPLE_INTERVAL
      if [ "$STREAK" -ge "$CONSECUTIVE_REQUIRED" ]; then
        SPAN=$(( $(date +%s) - STREAK_START ))
        # R7: state ONLY what was observed, and its scope. No claim that the
        # registry "is not blocking by IP" — three runs (31564296050,
        # 32248671357, 32819789544) falsified exactly that claim ~2s later on
        # this same URL.
        echo "[acr-dataplane-ready] READY — HTTP ${STREAK_CODES} on ${STREAK} consecutive fresh-connection samples over ${SPAN}s from ${HOST} (${ATTEMPT} sample(s) total, ${DENIED_TOTAL} IP-denied). ACR firewall-rule propagation is per-frontend and asynchronous, so a later call to this registry can still be IP-denied; callers must retry a denial as transient (scripts/ci/acr-login-retry.sh) rather than treat it as permanent."
        exit 0
      fi
      echo "[acr-dataplane-ready] sample ${ATTEMPT}: HTTP ${CODE} — ${STREAK}/${CONSECUTIVE_REQUIRED} consecutive."
      ;;
    403)
      DENIED_TOTAL=$(( DENIED_TOTAL + 1 ))
      STREAK=0
      STREAK_CODES=""
      echo "[acr-dataplane-ready] sample ${ATTEMPT}: HTTP 403 — firewall has not propagated yet (streak reset to 0): ${BODY:0:160}"
      ;;
    000)
      NORESPONSE_TOTAL=$(( NORESPONSE_TOTAL + 1 ))
      STREAK=0
      STREAK_CODES=""
      echo "[acr-dataplane-ready] sample ${ATTEMPT}: no HTTP response (connect/DNS) — streak reset to 0."
      ;;
    *)
      OTHER_TOTAL=$(( OTHER_TOTAL + 1 ))
      STREAK=0
      STREAK_CODES=""
      echo "[acr-dataplane-ready] sample ${ATTEMPT}: HTTP ${CODE} (not a readiness signal; streak reset to 0): ${BODY:0:160}"
      ;;
  esac

  NOW=$(date +%s)
  if [ "$NOW" -ge "$DEADLINE" ]; then break; fi
  SLEEP=$WAIT
  REMAIN=$(( DEADLINE - NOW ))
  [ "$REMAIN" -lt "$SLEEP" ] && SLEEP=$REMAIN
  sleep "$SLEEP"
done

TALLY="${ATTEMPT} sample(s) in ${BUDGET}s: ${POSITIVE_TOTAL} answered 401/200, ${DENIED_TOTAL} were 403 IP-denials, ${NORESPONSE_TOTAL} got no HTTP response, ${OTHER_TOTAL} returned some other status; longest consecutive run ${MAX_STREAK} of the ${CONSECUTIVE_REQUIRED} required"

# Exit 2 is reserved for "never got an HTTP response AT ALL" — keyed on the
# TALLY, not on the last sample's code. Keying it on LAST_CODE alone would call a
# run that saw real 403s an UNKNOWN just because its final sample timed out.
if [ "$POSITIVE_TOTAL" -eq 0 ] && [ "$DENIED_TOTAL" -eq 0 ] && [ "$OTHER_TOTAL" -eq 0 ] && [ "$NORESPONSE_TOTAL" -gt 0 ]; then
  echo "::error::acr-dataplane-ready: ${HOST} never returned an HTTP response within ${BUDGET}s (${ATTEMPT} attempts) — DNS or TCP, not a firewall verdict. This is an UNKNOWN: do not report anything as missing or unsigned on the strength of it." >&2
  exit 2
fi

# Say what the CONTROL plane actually reports rather than assuming it says open.
# The first draft of this message asserted "the firewall lease reports the
# registry as open at the control plane" — which this script had never read.
CP="$(az acr show -n "$ACR" --query '{pna:publicNetworkAccess,da:networkRuleSet.defaultAction}' -o tsv 2>/dev/null | tr '\t' '/' | tr -d '[:space:]')"
if [ -n "$CP" ]; then
  CP_NOTE="The control plane currently reports ${CP} (publicNetworkAccess/defaultAction)."
else
  CP_NOTE="The control-plane state could not be read, so this message does not claim one."
fi

if [ "$MAX_STREAK" -gt 0 ] && [ "$DENIED_TOTAL" -eq 0 ] && [ "$NORESPONSE_TOTAL" -eq 0 ] && [ "$OTHER_TOTAL" -eq 0 ]; then
  # Every sample answered 401/200 and nothing was denied — the registry was not
  # refusing us; the budget simply expired before the required run completed.
  # Saying "still refusing this runner" here would assert something the script
  # did not observe (deploy-integrity.md R7).
  echo "::error::acr-dataplane-ready: ${HOST} answered every sample but the ${BUDGET}s budget expired before ${CONSECUTIVE_REQUIRED} consecutive samples completed — ${TALLY}. That is a budget/sampling-configuration problem, NOT an observed refusal: ${CONSECUTIVE_REQUIRED} samples spaced ${SAMPLE_INTERVAL}s need at least ${MIN_SPAN}s. Last response: HTTP ${LAST_CODE} ${LAST_BODY:0:200}. ${CP_NOTE}" >&2
  exit 1
fi

if [ "$MAX_STREAK" -gt 0 ]; then
  echo "::error::acr-dataplane-ready: ${HOST} answered INTERMITTENTLY and never sustained ${CONSECUTIVE_REQUIRED} consecutive samples within ${BUDGET}s — ${TALLY}. A mix of answers and denials is the signature of an ACR firewall rule that has reached some frontends and not others; it is still propagating. Last response: HTTP ${LAST_CODE} ${LAST_BODY:0:200}. ${CP_NOTE} This is an UNKNOWN about reachability, not a verdict about the registry's contents." >&2
  exit 1
fi

if [ "$DENIED_TOTAL" -eq 0 ]; then
  # No 403 was ever observed, so this run cannot call it a refusal either.
  echo "::error::acr-dataplane-ready: ${HOST} never answered 401/200 within ${BUDGET}s and never returned a 403 either — ${TALLY}. No IP denial was observed, so this is an UNKNOWN about reachability, not a firewall verdict and not a verdict about the registry's contents. Last response: HTTP ${LAST_CODE} ${LAST_BODY:0:200}. ${CP_NOTE}" >&2
  exit 1
fi

echo "::error::acr-dataplane-ready: ${HOST} was still refusing this runner after ${BUDGET}s — ${TALLY}. Last response: HTTP ${LAST_CODE} ${LAST_BODY:0:200}. ${CP_NOTE} If it reports Enabled/Allow this is propagation taking longer than the budget or an Azure Policy reverting the toggle. Either way this is an UNKNOWN, not a verdict about the registry's contents." >&2
exit 1
