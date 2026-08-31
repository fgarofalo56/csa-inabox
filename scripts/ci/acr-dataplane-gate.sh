#!/usr/bin/env bash
# =============================================================================
# acr-dataplane-gate.sh — run the ACR data-plane probe and CONSUME its verdict.
# =============================================================================
#
# USAGE
#   bash scripts/ci/acr-dataplane-gate.sh --acr <name> [--timeout-seconds 180]
#                                         [--on-unconfirmed warn|fail]
#
# EXIT
#   0  the data plane answered — proceed
#   1  NOT confirmed, and --on-unconfirmed=fail was requested
#   0  NOT confirmed, and --on-unconfirmed=warn (the default) — proceed, having
#      said precisely WHICH kind of not-confirmed it was
#
# WHY THIS EXISTS (#4079)
#
# `acr-dataplane-ready.sh` returns THREE distinguishable verdicts:
#
#   0  answered (401/200) on N consecutive samples — ready
#   1  never sustained N consecutive answers before the budget ran out
#   2  never got an HTTP response at all (DNS/connect) within the budget
#
# and every Azure Government caller threw all of that away:
#
#   bash …/acr-dataplane-ready.sh --acr "$ACR" --timeout-seconds 180 \
#     || echo "::warning::ACR data plane not confirmed reachable; …"
#
# Measured on main, 2026-08-31 — 17 real call sites:
#
#   Gov:         branch=0   swallow=12
#   Commercial:  branch=3   swallow=2
#
# #4067 hardened the probe so it no longer calls one anonymous 401 an
# observation. In Gov that changed the LOG and nothing about BEHAVIOUR: the probe
# correctly refuses to declare READY, the caller discards the refusal, and the
# step proceeds into the very `az acr build` / pull the probe existed to protect.
# That is the cloud-parity gap — Commercial got the protection, the sovereign
# boundaries got a warning line — and it made #4067 read as more protective than
# it was.
#
# ── WHY THE DEFAULT IS `warn` AND NOT `fail` ─────────────────────────────────
#
# Because `1` and `2` are not the same claim, and neither is "the registry
# refused you".
#
#   1 is a PROPAGATION answer. ACR firewall rules propagate per-frontend and
#     asynchronously, so a caller that could not sustain N consecutive answers
#     may still be admitted seconds later — which is exactly why
#     acr-login-retry.sh retries a denial rather than trusting it. Failing the
#     step here would convert a transient into a red deploy that a retry would
#     have cleared.
#   2 is an UNKNOWN. No HTTP response at all means DNS or connect never
#     completed, so NOTHING was established about the registry's willingness to
#     serve this runner. Reporting an unknown as a refusal is the exact shape
#     deploy-integrity R7 forbids.
#
# So the honest default is: say which one happened, in words that do not assert
# more than was measured, and proceed to the step whose own retry helper
# (acr-login-retry.sh) fails closed on a real denial. `--on-unconfirmed fail` is
# there for a caller that would rather stop, and the SC1 signature gate on the
# Commercial roll path is the precedent for choosing differently per call site —
# it treats unreachable as "skip the gate", not "the image is unsigned".
#
# The parity this restores is STRUCTURAL: every boundary now branches on the
# verdict and says what it means. What a given lane DOES with it stays that
# lane's decision, which is the same latitude Commercial already had.
#
# NOTE: this script's header is `set -uo pipefail` — it never enables -e, and a
# bare `set -e` here would TURN IT ON rather than restore it
# (scripts/ci/check-set-e-restore.mjs).
# -----------------------------------------------------------------------------
set -uo pipefail

ACR=""
TIMEOUT=180
ON_UNCONFIRMED="warn"
PROBE="${LOOM_ACR_DATAPLANE_READY_SCRIPT:-scripts/ci/acr-dataplane-ready.sh}"

while [ $# -gt 0 ]; do
  case "$1" in
    --acr)              ACR="${2:-}"; shift 2 ;;
    --timeout-seconds)  TIMEOUT="${2:-180}"; shift 2 ;;
    --on-unconfirmed)   ON_UNCONFIRMED="${2:-warn}"; shift 2 ;;
    *) echo "::error::acr-dataplane-gate: unknown argument '$1'" >&2; exit 3 ;;
  esac
done

if [ -z "$ACR" ]; then
  echo "::error::acr-dataplane-gate: --acr is required." >&2
  exit 3
fi
case "$ON_UNCONFIRMED" in
  warn|fail) : ;;
  *) echo "::error::acr-dataplane-gate: --on-unconfirmed must be 'warn' or 'fail', got '${ON_UNCONFIRMED}'." >&2; exit 3 ;;
esac

bash "$PROBE" --acr "$ACR" --timeout-seconds "$TIMEOUT"
RC=$?

if [ "$RC" -eq 0 ]; then
  exit 0
fi

# Each message states ONLY what its exit code established. None of them says the
# registry denied this runner, because none of these codes establishes that.
case "$RC" in
  1)
    MSG="ACR '${ACR}' data plane did NOT sustain the required consecutive answers within ${TIMEOUT}s. ACR firewall rules propagate per-frontend and asynchronously, so this is consistent with propagation still in flight and NOT with a permanent refusal — acr-login-retry.sh treats a denial as retryable for the same reason."
    ;;
  2)
    MSG="ACR '${ACR}' data plane returned NO HTTP response at all within ${TIMEOUT}s (DNS or connect never completed). This establishes NOTHING about whether the registry would serve this runner — it is an UNKNOWN, not a refusal, and must not be reported as one."
    ;;
  3)
    MSG="acr-dataplane-ready.sh refused its own arguments for '${ACR}' (usage / sampling below the #4067 floor / unresolvable cloud suffix). That is a configuration fault in the CALLER, not a verdict about the registry."
    ;;
  *)
    MSG="acr-dataplane-ready.sh exited ${RC} for '${ACR}', which this gate does not have a classification for. Treating it as NOT CONFIRMED rather than guessing."
    ;;
esac

if [ "$ON_UNCONFIRMED" = "fail" ]; then
  echo "::error::${MSG} Refusing to continue (--on-unconfirmed=fail)." >&2
  exit 1
fi

echo "::warning::${MSG} Continuing — the next data-plane call goes through acr-login-retry.sh, which fails closed on a real denial."
exit 0
