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
# same runner. What each run establishes is NOT the same, and this comment does
# not pretend otherwise (deploy-integrity.md R7):
#
#   31564296050, 32248671357 — the clean propagation cases. 32248671357 is the
#     strongest: that job held the firewall lease EXCLUSIVELY, no contention and
#     no re-lock until 11:46:40, so nothing closed the registry between the 401
#     and the denial. Consecutive sampling is aimed at exactly this shape.
#   32819789544 — held NO lease (`ACR_LEASE_STATE: none`); it rode another run's
#     open window. A concurrent RE-LOCK by the lease holder is an equally
#     consistent explanation for that denial, and re-sampling cannot fix that
#     one. It is listed because the timing matches, not as evidence of the
#     propagation mechanism.
#
# The mechanism behind the first two is documented, not inferred: "Configure
# public IP network rules"
# (learn.microsoft.com/azure/container-registry/container-registry-access-selected-networks)
# says twice to "wait a few minutes for the rule to take effect". Propagation is
# ASYNCHRONOUS and PER-FRONTEND. One sample tells you what ONE frontend served
# ONE request; the next connection can land on a frontend that has not caught up.
#
# So the probe now requires CONSECUTIVE_REQUIRED positive samples, each from a
# fresh curl process (new connection, new DNS resolution — no keep-alive reuse),
# spaced SAMPLE_INTERVAL apart. ANY non-positive sample resets the streak to
# zero — a 403, a connect/DNS failure, or any other status. "Three consecutive
# answers" means three, not "three ignoring the 500 in the middle".
#
# THE FLOOR IS ENFORCED, NOT MERELY DEFAULTED (review of #4067, 2026-08-25).
#
# 3 samples spaced 2s is a MINIMUM, not a default a caller may dial away. The
# first version of this fix pinned those numbers only as defaults, and a caller
# passing `--consecutive-samples 1` or `--sample-interval-seconds 0` restored the
# exact pre-#4067 single-sample behaviour with the whole suite still green. A
# safety property that any caller can switch off is not a guard — it is a default.
#
# Values below the floor are now REJECTED (exit 3) unless the caller ALSO passes
# `--unsafe-sampling-below-4067-floor "<reason>"`. That flag is deliberately ugly
# and greppable: one `grep -rn unsafe-sampling-below-4067-floor` over
# .github/workflows and scripts finds every weakening in the repo, the reason must
# contain at least one NON-WHITESPACE character (a lone space bought the whole
# override in the first version of this fix), and the run log carries a
# `::warning::` naming #4067 and the reason.
#
# THE HIGH SIDE IS A WEAKENING TOO. `--consecutive-samples 1000` clears both floor
# checks and then needs 1998s inside a 180s budget, so the probe can only ever
# exit 1 — and 14 of the 17 call sites discard the exit status with
# `|| echo "::warning::"` (measured 2026-08-25; every Azure Government call site
# is in that 14 — see #4079). Permanently-failing and ignored is switched off. A
# sampling config that cannot fit its own budget is therefore refused (exit 3)
# through the SAME opt-out flag, so one grep still finds every weakening.
#
# scripts/ci/test-acr-dataplane-ready.sh proves each half — that the DEFAULTS
# still take >= 3 samples >= 2s apart (measured through the sampling loop by
# counting the probe's own requests and reading the argument it hands `sleep`, not
# by grepping this file for the literals), that a bare caller override below the
# floor is REFUSED with exit 3, that a whitespace-only reason is refused, and that
# an unsatisfiable budget is refused rather than merely warned about.
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
#        [--unsafe-sampling-below-4067-floor "<reason>"]
#
# Exit codes:
#   0  data plane answered (401/200) on N consecutive samples — ready
#   1  never sustained N consecutive answers before the budget ran out
#   2  never got an HTTP response at all (DNS/connect) within the budget
#   3  usage / sampling below the #4067 floor without the opt-out / a sampling
#      config that cannot fit its own budget without the opt-out / could not
#      determine the cloud's registry suffix
# -----------------------------------------------------------------------------
set -uo pipefail

ACR=""
BUDGET=180
INTERVAL=10
SAMPLE_INTERVAL=2
CONSECUTIVE_REQUIRED=3
UNSAFE_REASON=""

# The #4067 floor. Below these, the probe is measuring what a single request
# measured, which is what the incident was. See the header block.
FLOOR_CONSECUTIVE=3
FLOOR_SAMPLE_INTERVAL=2

# A value-taking flag passed as the LAST argument would leave `shift 2` unable to
# shift (bash returns non-zero and shifts NOTHING with `set -u` but no `set -e`),
# spinning this parser forever. A CI job that hangs is worse than one that fails,
# so every value-taking flag checks it has a value first.
need_val() {
  if [ "$1" -lt 2 ]; then
    echo "::error::acr-dataplane-ready: $2 requires a value." >&2
    exit 3
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --acr) need_val $# "$1"; ACR="$2"; shift 2 ;;
    --timeout-seconds) need_val $# "$1"; BUDGET="$2"; shift 2 ;;
    --interval-seconds) need_val $# "$1"; INTERVAL="$2"; shift 2 ;;
    --sample-interval-seconds) need_val $# "$1"; SAMPLE_INTERVAL="$2"; shift 2 ;;
    --consecutive-samples) need_val $# "$1"; CONSECUTIVE_REQUIRED="$2"; shift 2 ;;
    --unsafe-sampling-below-4067-floor) need_val $# "$1"; UNSAFE_REASON="$2"; shift 2 ;;
    # Print the header block and stop at the first line of code. A hard-coded
    # line number drifts the moment the header is edited — the first version of
    # this said `1,95p` while the header ended at 92, so `--help` printed three
    # lines of executable script.
    -h|--help) awk 'NR > 1 && $0 !~ /^#/ { exit } { print }' "$0"; exit 0 ;;
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

# A reason made only of whitespace satisfies `[ -z ]`. The first version of this
# fix tested the raw value, so ONE SPACE bought the full single-sample override:
# measured 2026-08-25, `--consecutive-samples 1 --unsafe-sampling-below-4067-floor " "`
# exited 0 after exactly ONE curl call, and a lone tab did the same. Test the
# value with all whitespace removed.
#
# There is deliberately no MINIMUM LENGTH: any threshold is met by padding, so a
# length rule buys nothing an `x`-string does not defeat. The enforcement is that
# the flag name is ugly and greppable and that the reason is echoed into the run
# log next to it, which is what a human reads after an incident.
UNSAFE_REASON_TRIMMED="$(printf '%s' "$UNSAFE_REASON" | tr -d '[:space:]')"

# THE #4067 FLOOR — the LOW side. Enforced here rather than left to the defaults,
# because a safety property a caller can dial away is not a property.
# `--consecutive-samples 1` and `--sample-interval-seconds 0` each restore the
# exact single-sample behaviour the incident was about, so they are REFUSED unless
# the caller states a reason through a flag that is trivial to grep for across
# every workflow and script.
BELOW_FLOOR=""
if [ "$CONSECUTIVE_REQUIRED" -lt "$FLOOR_CONSECUTIVE" ]; then
  BELOW_FLOOR="--consecutive-samples ${CONSECUTIVE_REQUIRED} (floor ${FLOOR_CONSECUTIVE})"
fi
if [ "$SAMPLE_INTERVAL" -lt "$FLOOR_SAMPLE_INTERVAL" ]; then
  BELOW_FLOOR="${BELOW_FLOOR}${BELOW_FLOOR:+, }--sample-interval-seconds ${SAMPLE_INTERVAL} (floor ${FLOOR_SAMPLE_INTERVAL})"
fi

# THE HIGH SIDE, which the first version of the floor did not guard at all.
# `--consecutive-samples 1000` clears both floor checks and then needs 1998s of
# wall time inside a 180s budget, so the probe can only ever exit 1 — and 14 of
# the 17 call sites discard that exit status with `|| echo "::warning::"` (#4079).
# A gate that is permanently yellow and permanently ignored is a gate switched
# off, reached without ever typing the greppable opt-out. MIN_SPAN is also the
# number the exhaustion message quotes, so it is computed once, here, before any
# network or `az` call — a config that cannot succeed should cost nothing to
# reject.
MIN_SPAN=$(( (CONSECUTIVE_REQUIRED - 1) * SAMPLE_INTERVAL ))
UNSATISFIABLE=""
if [ "$BUDGET" -lt "$MIN_SPAN" ]; then
  UNSATISFIABLE="${CONSECUTIVE_REQUIRED} samples spaced ${SAMPLE_INTERVAL}s need at least ${MIN_SPAN}s of wall time, but --timeout-seconds is ${BUDGET}"
fi

if [ -n "$BELOW_FLOOR" ] && [ -z "$UNSAFE_REASON_TRIMMED" ]; then
  echo "::error::acr-dataplane-ready: REFUSING a sampling configuration below the #4067 floor: ${BELOW_FLOOR}. One sample, or samples with no spacing, is what run 31564296050 / 32248671357 reported READY ~2s before the same URL denied them by IP. If you genuinely need this, pass --unsafe-sampling-below-4067-floor \"<why>\" (the reason must contain a non-whitespace character) so the weakening is greppable and the reason lands in the run log." >&2
  exit 3
fi
if [ -n "$UNSATISFIABLE" ] && [ -z "$UNSAFE_REASON_TRIMMED" ]; then
  echo "::error::acr-dataplane-ready: REFUSING a sampling configuration that CANNOT succeed: ${UNSATISFIABLE}. This can only ever exit 1, and at the call sites that discard the exit status it is indistinguishable from switching the #4067 guard off. Raise --timeout-seconds, lower --consecutive-samples, or — if a permanently-failing probe is genuinely what you want — pass --unsafe-sampling-below-4067-floor \"<why>\" so it is greppable and the reason lands in the run log." >&2
  exit 3
fi
if [ -n "$BELOW_FLOOR" ]; then
  echo "::warning::acr-dataplane-ready: sampling BELOW the #4067 floor by explicit opt-out — ${BELOW_FLOOR}. Reason given: ${UNSAFE_REASON}. This weakens the guard that exists because a single 401 was falsified ~2s later on the same URL; a READY from this run is worth less than a READY from the defaults."
fi
if [ -n "$UNSATISFIABLE" ]; then
  echo "::warning::acr-dataplane-ready: proceeding with a sampling configuration that can only fail closed, by explicit opt-out — ${UNSATISFIABLE}. Reason given: ${UNSAFE_REASON}."
fi
if [ -z "$BELOW_FLOOR" ] && [ -z "$UNSATISFIABLE" ] && [ -n "$UNSAFE_REASON_TRIMMED" ]; then
  echo "::warning::acr-dataplane-ready: --unsafe-sampling-below-4067-floor was passed (\"${UNSAFE_REASON}\") but nothing is below the floor and the budget is satisfiable (${CONSECUTIVE_REQUIRED} samples spaced ${SAMPLE_INTERVAL}s in ${BUDGET}s). Drop the flag so it does not sit in a caller waiting to hide a future weakening."
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

# MIN_SPAN (the minimum wall time the happy path needs) was computed and enforced
# with the rest of the sampling configuration, above, before this script touched
# the network. A budget that cannot fit the required run is now REFUSED rather
# than warned about, so by this point the config is known to be satisfiable
# unless the caller took the explicit opt-out.

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
