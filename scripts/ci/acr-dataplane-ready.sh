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
# ...AND THE HIGH SIDE HAS ITS OWN FLOOR, because the check above is arithmetic
# and bash arithmetic wraps. `--consecutive-samples 9223372036854775807` is a
# VALID bash integer: it clears the low floor, and then `(N-1)*2` overflows to
# -4, so `budget < MIN_SPAN` is false and the unsatisfiability check never fires.
# Measured 2026-08-26 on the previous commit: that config was accepted and run
# with no warning and no error whatsoever. Values past INT64_MAX fail the same
# way for a different reason — `[` cannot compare them, returns 2, and the `if`
# reads that as "not below the floor", an UNKNOWN treated as a NEGATIVE. Both are
# closed by a DIGIT-COUNT bound tested on the string before any arithmetic runs.
#
# scripts/ci/test-acr-dataplane-ready.sh proves each half — that the DEFAULTS
# still take >= 3 samples >= 2s apart (measured through the sampling loop by
# counting the probe's own requests and reading the argument it hands `sleep`, not
# by grepping this file for the literals), that a bare caller override below the
# floor is REFUSED with exit 3, that a whitespace-only reason is refused, that
# an unsatisfiable budget is refused rather than merely warned about, and that
# an overflowing sample count is refused rather than silently accepted.
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
# ...AND THE EXHAUSTION MESSAGE IS DERIVED FROM THE TALLY, NOT CHOSEN AHEAD OF
# IT (review of #4090, 2026-08-26). The intermittent branch is the catch-all for
# any positive/non-positive mix, and it used to assert ONE fixed cause for all of
# them: "a mix of answers and denials … an ACR firewall rule that has reached
# some frontends and not others". Measured on the previous commit, `401 000` and
# `401 500` each printed that denial/propagation claim right next to the same
# message's own tally reading "0 were 403 IP-denials" — an error stating as fact
# something it had not established, which is R7, inside the script written to
# enforce R7. Each observed class now contributes its own clause and a class with
# a ZERO count contributes nothing, so no mix — including one nobody enumerated —
# can name a cause that did not occur.
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
#      config that cannot fit its own budget without the opt-out / a numeric
#      argument past the digit bound where bash arithmetic stops being sound /
#      could not determine the cloud's registry suffix
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
#
# THE MAGNITUDE BOUND, and why it is a STRING test done FIRST. Every check below
# this point is bash arithmetic, and bash arithmetic is signed 64-bit and wraps
# SILENTLY. Measured 2026-08-26 against the previous commit, which had both the
# low floor and the high-side unsatisfiability check in place:
#
#   --consecutive-samples 9223372036854775807   (INT64_MAX — a VALID bash integer)
#     [ N -lt 3 ]                 -> false, so the low floor does not fire
#     MIN_SPAN=$(( (N-1)*2 ))     -> wraps to -4
#     [ BUDGET -lt -4 ]           -> false, so UNSATISFIABLE does not fire either
#     => the probe ACCEPTED a config needing 9.2 quintillion consecutive samples
#        inside a 1s budget and ran it, printing NO warning and NO error at all.
#
#   --consecutive-samples 99999999999999999999  (past INT64_MAX)
#     bash prints `[: 99999999999999999999: integer expected` and `[` returns 2,
#     which an `if` reads as FALSE — so a value bash CANNOT COMPARE was treated
#     as "above the floor" and the probe ran the full 180s budget (RC=2).
#     An UNKNOWN read as a NEGATIVE, which is its own recorded failure class.
#
# Both shapes land where the high-side check exists to prevent: a probe that can
# only ever exit 1, at the 14-of-17 call sites that discard the exit status, and
# reached WITHOUT typing the greppable opt-out. So the bound is enforced on the
# DIGIT STRING, before any `[ -lt ]` or `$(( ))` touches the value — a test that
# cannot itself overflow. 9 digits keeps the worst case
# (999999998 * 999999999 ~= 1.0e18) an order of magnitude below INT64_MAX
# (~9.2e18), so MIN_SPAN can no longer wrap for ANY accepted input.
#
# There is deliberately no opt-out for this one, unlike the floor: a 10-digit
# sample count has no operational use, and past this bound the script cannot even
# describe the config truthfully (the exhaustion message would quote a negative
# MIN_SPAN), which deploy-integrity R7 forbids.
MAX_ARG_DIGITS=9
for pair in "BUDGET:$BUDGET" "INTERVAL:$INTERVAL" "SAMPLE_INTERVAL:$SAMPLE_INTERVAL" "CONSECUTIVE_REQUIRED:$CONSECUTIVE_REQUIRED"; do
  name="${pair%%:*}"; val="${pair#*:}"
  case "$val" in
    ''|*[!0-9]*)
      echo "::error::acr-dataplane-ready: ${name} must be a non-negative integer, got '${val}'." >&2
      exit 3 ;;
  esac
  # Strip leading zeros before measuring, so `0000000003` is the integer 3 and
  # not a 10-digit refusal. An all-zero string collapses to a single "0".
  significant="${val#"${val%%[!0]*}"}"
  [ -z "$significant" ] && significant="0"
  if [ "${#significant}" -gt "$MAX_ARG_DIGITS" ]; then
    # R7: name the mechanism THIS argument breaks, not one that did not occur.
    # The first version of this message printed the consecutive-samples overflow
    # story for all four arguments, so `--timeout-seconds 1234567890` was told
    # about "INT64_MAX consecutive samples" — a true sentence about a run that
    # never happened. Each clause below was MEASURED on 2026-08-26 rather than
    # reasoned about; the numbers quoted are the observed ones.
    case "$name" in
      CONSECUTIVE_REQUIRED|SAMPLE_INTERVAL)
        WHY="MIN_SPAN=(consecutive-1)*sample-interval wraps NEGATIVE at this magnitude — measured, 9223372036854775807 samples gives MIN_SPAN -4, and spacing 9223372036854775807 at 3 samples gives -2 — so '[ budget -lt MIN_SPAN ]' is false and the unsatisfiable-budget check never fires. The value clears the #4067 floor AND that check, and the probe runs a sampling configuration it can never satisfy." ;;
      BUDGET)
        WHY="DEADLINE=now+budget wraps NEGATIVE at this magnitude — measured, 1756000000+9223372036854775807 gives -9223372035098775809 — so the deadline is already in the past, the loop breaks after its FIRST sample, and the result is a one-sample probe: #4067 itself, reinstated through the budget." ;;
      INTERVAL)
        WHY="the backoff is clamped to the budget that remains by '[ remain -lt sleep ]', and past INT64_MAX '[' cannot compare the value at all: measured, it prints 'integer expected' and returns 2, which an 'if' reads as 'no clamp needed'. The backoff would then sleep past the probe's own deadline." ;;
      *)
        WHY="every check below this point is bash arithmetic, which is signed 64-bit and wraps silently, so a value this large makes them stop measuring what they say they measure." ;;
    esac
    echo "::error::acr-dataplane-ready: ${name} has ${#significant} digits ('${val}'), above the ${MAX_ARG_DIGITS}-digit bound. Past this bound bash's signed 64-bit arithmetic stops being sound for THIS argument: ${WHY} There is no legitimate value this large." >&2
    exit 3
  fi
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
# THE SECOND HOP (#4053). `/v2/` is the CHALLENGE; it is not where the tools
# failed. Run 32819789544 reported READY on a 401 from `/v2/` and the next step
# was refused at a DIFFERENT endpoint:
#
#   Error: POST https://…/oauth2/token: DENIED: client with IP … is not allowed access
#
# ACR rule propagation is per-frontend AND the token endpoint is a separate
# path, so "the challenge answered" does not establish "the token exchange will
# be admitted". A probe that samples only `/v2/` returns a TRUE answer that
# callers reasonably read as a stronger guarantee than it is — deploy-integrity.md
# R7. So every sample now probes BOTH, and a sample counts only if BOTH answer.
#
# THE URL IS NOT GUESSED. `/v2/` advertises the realm to use, and it names this
# exact endpoint. Measured against a real registry on 2026-08-28:
#
#   Www-Authenticate: Bearer realm="https://<host>/oauth2/token",service="<host>"
#
# GET, NOT POST, and that is load-bearing. The incident line above is cosign's
# POST, which carries a refresh token in its body. Measured on the same registry
# the same day, a POST without that body returns 400 REQUEST_BODY_INVALID — a
# status this script correctly treats as "not a readiness signal", so a POST
# probe could never go positive and the whole check would be dead on arrival.
# The anonymous GET is what a `docker pull` issues after the challenge, and it
# discriminates the same way `/v2/` does. Both sides measured 2026-08-28:
#
#   firewall OPEN to this IP   -> HTTP 401, {"errors":[{"code":"UNAUTHORIZED"…
#   firewall CLOSED to this IP -> HTTP 403, DENIED … is not allowed access
#                                 (the incident log above, same endpoint)
TOKEN_URL="https://${HOST}/oauth2/token?service=${HOST}&scope=registry:catalog:*"
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

echo "[acr-dataplane-ready] probing ${URL} AND ${TOKEN_URL} — need ${CONSECUTIVE_REQUIRED} consecutive samples where BOTH answer 401/200, spaced ${SAMPLE_INTERVAL}s (budget ${BUDGET}s, ${INTERVAL}s backoff after a denial)"

# One request. Echoes "<code> <body>" so the caller reads exactly what the
# endpoint said. Factored out for #4053 so the two endpoints are probed by
# IDENTICAL code — a second hand-inlined curl would be free to drift in its
# flags, and the `000` handling below is the part that must not.
probe_once() {
  local url="$1" body_file code body
  body_file="$(mktemp)"
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
  code="$(curl -s -o "$body_file" -w '%{http_code}' --max-time 20 "$url" 2>/dev/null)"
  [ -n "$code" ] || code="000"
  body="$(head -c 400 "$body_file" 2>/dev/null | tr -d '\r\n')"
  rm -f "$body_file"
  printf '%s %s' "$code" "$body"
}

while :; do
  ATTEMPT=$(( ATTEMPT + 1 ))
  V2_RESULT="$(probe_once "$URL")"
  CODE="${V2_RESULT%% *}"
  BODY="${V2_RESULT#* }"
  [ "$BODY" = "$V2_RESULT" ] && BODY=""

  # The token endpoint is probed ONLY when the challenge answered. Not an
  # optimisation — when `/v2/` is already 403 the streak resets either way, and
  # a second request to a registry that is refusing us buys nothing. WHICH
  # endpoint produced the verdict is carried in ENDPOINT so the log never
  # attributes a refusal to the wrong URL (R7).
  ENDPOINT="/v2/"
  case "$CODE" in
    401|200)
      TOKEN_RESULT="$(probe_once "$TOKEN_URL")"
      TOKEN_CODE="${TOKEN_RESULT%% *}"
      TOKEN_BODY="${TOKEN_RESULT#* }"
      [ "$TOKEN_BODY" = "$TOKEN_RESULT" ] && TOKEN_BODY=""
      # The token endpoint's verdict REPLACES the challenge's whenever it is not
      # itself positive. A 401 on `/v2/` plus a 403 on `/oauth2/token` is exactly
      # run 32819789544, and it must read as a denial, not as a positive sample.
      case "$TOKEN_CODE" in
        401|200) ;;
        *) CODE="$TOKEN_CODE"; BODY="$TOKEN_BODY"; ENDPOINT="/oauth2/token" ;;
      esac
      ;;
  esac

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
        echo "[acr-dataplane-ready] READY — HTTP ${STREAK_CODES} on ${STREAK} consecutive fresh-connection samples over ${SPAN}s from ${HOST}, each answered by BOTH /v2/ and /oauth2/token (${ATTEMPT} sample(s) total, ${DENIED_TOTAL} IP-denied). ACR firewall-rule propagation is per-frontend and asynchronous, so a later call to this registry can still be IP-denied; callers must retry a denial as transient (scripts/ci/acr-login-retry.sh) rather than treat it as permanent."
        exit 0
      fi
      echo "[acr-dataplane-ready] sample ${ATTEMPT}: HTTP ${CODE} on /v2/ and ${TOKEN_CODE} on /oauth2/token — ${STREAK}/${CONSECUTIVE_REQUIRED} consecutive."
      ;;
    403)
      DENIED_TOTAL=$(( DENIED_TOTAL + 1 ))
      STREAK=0
      STREAK_CODES=""
      echo "[acr-dataplane-ready] sample ${ATTEMPT}: HTTP 403 from ${ENDPOINT} — firewall has not propagated yet (streak reset to 0): ${BODY:0:160}"
      ;;
    000)
      NORESPONSE_TOTAL=$(( NORESPONSE_TOTAL + 1 ))
      STREAK=0
      STREAK_CODES=""
      echo "[acr-dataplane-ready] sample ${ATTEMPT}: no HTTP response from ${ENDPOINT} (connect/DNS) — streak reset to 0."
      ;;
    *)
      OTHER_TOTAL=$(( OTHER_TOTAL + 1 ))
      STREAK=0
      STREAK_CODES=""
      echo "[acr-dataplane-ready] sample ${ATTEMPT}: HTTP ${CODE} from ${ENDPOINT} (not a readiness signal; streak reset to 0): ${BODY:0:160}"
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
  # THE PROSE IS DERIVED FROM THE TALLY, NEVER ASSERTED AHEAD OF IT.
  #
  # The first version of this branch named exactly one cause for every mix it
  # could ever see — "A mix of answers and denials is the signature of an ACR
  # firewall rule that has reached some frontends and not others; it is still
  # propagating" — and this branch is the catch-all for ANY positive/non-positive
  # mix. So whenever the non-positive samples were connect failures or 5xx, that
  # sentence printed verbatim NEXT TO ITS OWN TALLY reading "0 were 403
  # IP-denials". Measured 2026-08-26 on the previous commit: `401 000` and
  # `401 500` both produced the denial/propagation claim with ZERO denials
  # observed. An error asserting a cause it did not establish is deploy-integrity
  # R7 — the rule this probe exists to enforce — inside the probe itself.
  #
  # The fix is NOT a branch for `401+000` and another for `401+5xx`. That is
  # enumeration, and the next mix nobody enumerated (403+000, 403+5xx, all three
  # at once) would print a wrong cause again — this repo has burned three rounds
  # on exactly that. Instead each observed class contributes its OWN clause and a
  # class with a ZERO count contributes NOTHING, so the message is a function of
  # the tally. No mix, including one nobody has thought of, can name a cause that
  # did not occur.
  MIXED_WITH=""
  MIXED_CAUSE=""
  add_observed() { # $1 = count, $2 = what it was, $3 = what that class means
    [ "$1" -gt 0 ] || return 0
    MIXED_WITH="${MIXED_WITH}${MIXED_WITH:+, }$1 $2"
    MIXED_CAUSE="${MIXED_CAUSE}${MIXED_CAUSE:+ }$3"
  }
  add_observed "$DENIED_TOTAL" "403 IP-denial(s)" \
    "Answers interleaved with IP denials are the signature of an ACR firewall rule that has reached some frontends and not others; it is still propagating."
  add_observed "$NORESPONSE_TOTAL" "sample(s) that got no HTTP response" \
    "Samples that got no HTTP response are DNS or TCP failures, not a firewall verdict; this run did not establish why they failed."
  add_observed "$OTHER_TOTAL" "sample(s) that returned some other status" \
    "Statuses outside 401/200/403 are a registry-side or gateway-side condition; this run did not establish which."
  # Reaching here means MAX_STREAK > 0 and at least one non-positive class is
  # non-zero (the all-positive case exited in the branch above), so MIXED_WITH is
  # populated. The guard is here so that if that ever stops being true the
  # message degrades to saying less, rather than to saying something false.
  if [ -n "$MIXED_WITH" ]; then
    MIXED_CLAUSE=" ${POSITIVE_TOTAL} sample(s) answered 401/200, interleaved with ${MIXED_WITH}. ${MIXED_CAUSE}"
  else
    MIXED_CLAUSE=""
  fi
  echo "::error::acr-dataplane-ready: ${HOST} answered INTERMITTENTLY and never sustained ${CONSECUTIVE_REQUIRED} consecutive samples within ${BUDGET}s — ${TALLY}.${MIXED_CLAUSE} Last response: HTTP ${LAST_CODE} ${LAST_BODY:0:200}. ${CP_NOTE} This is an UNKNOWN about reachability, not a verdict about the registry's contents." >&2
  exit 1
fi

if [ "$DENIED_TOTAL" -eq 0 ]; then
  # No 403 was ever observed, so this run cannot call it a refusal either.
  echo "::error::acr-dataplane-ready: ${HOST} never answered 401/200 within ${BUDGET}s and never returned a 403 either — ${TALLY}. No IP denial was observed, so this is an UNKNOWN about reachability, not a firewall verdict and not a verdict about the registry's contents. Last response: HTTP ${LAST_CODE} ${LAST_BODY:0:200}. ${CP_NOTE}" >&2
  exit 1
fi

echo "::error::acr-dataplane-ready: ${HOST} was still refusing this runner after ${BUDGET}s — ${TALLY}. Last response: HTTP ${LAST_CODE} ${LAST_BODY:0:200}. ${CP_NOTE} If it reports Enabled/Allow this is propagation taking longer than the budget or an Azure Policy reverting the toggle. Either way this is an UNKNOWN, not a verdict about the registry's contents." >&2
exit 1
