#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# login-health-verdict.sh — the VERDICT half of loom-ui-verify's login-health
# preflight (#2837). Pure: no `az`, no network, no clock reads it cannot be
# told about. Everything it needs arrives as an environment variable, so the
# decision it makes is unit-testable — see
# scripts/ci/__tests__/login-health-verdict.test.mjs.
#
# WHY THIS EXISTS (#2837)
# ----------------------
# The preflight was added after the 2026-07-19 P0: an expired MSAL client
# secret (AADSTS7000215) broke EVERY real sign-in while the cookie-minted
# `verify` harness stayed green. The step it lived in carried BOTH
# `continue-on-error: true` and a trailing hard `exit 0`, so it printed
#     ::error::LOGIN BROKEN — N auth/callback invalid_client errors …
# and then concluded success. On the weekly cron the job conclusion is the
# entire signal, so a live sign-in outage rendered as a green check. Same class
# as #2787, two steps away in the same file.
#
# THE DISTINCTION THIS SCRIPT KEEPS (and the old code threw away)
# --------------------------------------------------------------
#   COULD NOT CHECK  → ::warning::, exit 0.  A missing workspace or a missing
#                      Graph permission is not evidence that sign-in is broken,
#                      and it must never fail the verify. This was the original
#                      (legitimate) reason for continue-on-error.
#   CHECKED, BROKEN  → ::error::,  exit 1.  Evidence in hand. This is a P0.
# Collapsing the second into the first is what made the control unable to fail.
#
# A THIRD STATE THE OLD CODE ALSO COLLAPSED
# -----------------------------------------
# `HITS=$(az … 2>/dev/null); if [ "${HITS:-0}" -gt 0 ]` mapped an EMPTY result
# (the query errored — no permission, wrong table, az failure) onto 0 (the query
# ran and found nothing) and printed "OK". A check that passes by failing to run
# is the same defect one level down, so `LH_HITS_RAW` distinguishes:
#     unset/empty → unreadable → ::warning::, exit 0
#     "0"         → really zero → OK
#     "3"         → broken     → ::error::, exit 1
#
# INPUTS (all optional; absent means "could not determine")
#   LH_LAW         resolved Log Analytics customerId ('' = unresolvable)
#   LH_HITS_RAW    raw az output for the invalid_client count ('' = unreadable)
#   LH_MIN_END     soonest MSAL credential expiry, ISO-8601 ('' or 'None' =
#                  unreadable — the verify SP likely lacks Application.Read.All)
#   LH_APP_ID      MSAL app id, for the remediation command in the annotation
#   LH_CONSOLE_RG  console resource group, same
#   LH_NOW_EPOCH   override for "now" (tests only; defaults to `date -u +%s`)
#   LH_WARN_DAYS   runway below which to warn but not fail (default 30)
#
# EXIT: 1 if and only if sign-in is demonstrably broken (invalid_client hits in
#       the window, or an already-expired credential). 0 otherwise, including
#       every "could not determine" path.
#
# RECORDED VERDICT (refs #2871)
# ----------------------------
# The exit status above is unchanged and remains the contract. In ADDITION this
# script now emits an EXPLICIT three-state token — `ok` / `unknown` / `broken` —
# on stdout and, when running under Actions, as `verdict=` in $GITHUB_OUTPUT.
#
# Why an explicit flag and not an inferred one: the caller needs to tell "the
# checks ran and found nothing" from "the checks could not run", and the only
# other way to recover that from here is to grep this script's own stdout for
# `::warning::` — which would also match the benign "expires in 12d" runway
# warning and mislabel a healthy estate as indeterminate. An inferred predicate
# over log text is how a gate ends up classifying the wrong population; the
# state is known precisely at the point each branch is taken, so it is recorded
# there instead.
#
# The token exists so the loom-ui-verify job can RUN THE BROWSER SUITE ANYWAY
# and still fail the run: a failing preflight used to be an early hard step, so
# it aborted the job and no browser E2E receipt could be obtained for main at
# all while the estate had a live AADSTS7000215 signal. Enforcement is deferred
# to scripts/ci/ui-verify-gate-verdict.sh at the END of that job — deferred,
# never dropped. This is exactly the second remedy check-annotation-teeth.mjs
# names ("record the verdict (GITHUB_OUTPUT) and have a LATER step enforce it").
# ---------------------------------------------------------------------------
set -uo pipefail

RC=0
# Number of sub-checks that could NOT be evaluated. Distinct from RC: this is
# "no evidence either way", which must never become a failure (that tolerance is
# the original, legitimate reason the step carried continue-on-error) but must
# equally never be reported as health (#2837).
UNKNOWN=0

APP_ID="${LH_APP_ID:-<msal-app-id>}"
RG="${LH_CONSOLE_RG:-<console-rg>}"
WARN_DAYS="${LH_WARN_DAYS:-30}"

# The rotation command is printed on both error paths — an annotation that names
# the fix is the difference between a page and a scramble.
ROTATE_CMD="az containerapp secret set -n loom-console -g ${RG} --secrets \"loom-msal-client-secret=\$(az ad app credential reset --id ${APP_ID} --append --years 2 --query password -o tsv)\" then roll a new revision"

# --- (a) recent auth/callback invalid_client in the console logs -------------
echo "== (a) recent auth/callback invalid_client in the console logs =="
if [ -z "${LH_LAW:-}" ]; then
  echo "::warning::could not resolve the console Log Analytics workspace in ${RG} — the callback-error check did NOT run (this is 'unknown', not 'healthy')."
  UNKNOWN=$((UNKNOWN + 1))
else
  HITS_RAW="${LH_HITS_RAW:-}"
  # Keep only a leading integer; anything else is not a count we can trust.
  HITS="$(printf '%s' "$HITS_RAW" | tr -d '\r' | grep -oE '[0-9]+' | head -1 || true)"
  if [ -z "$HITS" ]; then
    echo "::warning::resolved the workspace but could NOT read the invalid_client count (query error / no Log Analytics Reader on it) — the callback-error check did NOT run. Not treated as zero."
    UNKNOWN=$((UNKNOWN + 1))
  elif [ "$HITS" -gt 0 ]; then
    echo "::error::LOGIN BROKEN — ${HITS} auth/callback invalid_client errors in the last 7d (AADSTS7000215). The MSAL secret has drifted/expired. Rotate: ${ROTATE_CMD}."
    RC=1
  else
    echo "  OK — no invalid_client callback errors in the last 7d."
  fi
fi

# --- (b) MSAL app credential expiry ------------------------------------------
echo "== (b) MSAL app credential expiry =="
MINEND="${LH_MIN_END:-}"
if [ -z "$MINEND" ] || [ "$MINEND" = "None" ]; then
  echo "::warning::could not read MSAL app ${APP_ID} credentials (the verify SP likely lacks Application.Read.All / owner) — grant it to enable the expiry check. The expiry check did NOT run."
  UNKNOWN=$((UNKNOWN + 1))
else
  NOWSEC="${LH_NOW_EPOCH:-$(date -u +%s)}"
  # An unparseable timestamp is 'unknown', NOT 'expires today'. The previous
  # code fell back to NOWSEC, which silently rendered as 0 days of runway.
  if ENDSEC="$(date -u -d "$MINEND" +%s 2>/dev/null)" && [ -n "$ENDSEC" ]; then
    DAYS=$(( (ENDSEC - NOWSEC) / 86400 ))
    echo "  soonest MSAL secret expiry: ${MINEND} (${DAYS}d)"
    if [ "$DAYS" -lt 0 ]; then
      echo "::error::MSAL secret is EXPIRED — sign-in is down. Rotate now: ${ROTATE_CMD}."
      RC=1
    elif [ "$DAYS" -lt "$WARN_DAYS" ]; then
      echo "::warning::MSAL secret expires in ${DAYS}d — rotate before it lapses to avoid a login outage."
    else
      echo "  OK — >${WARN_DAYS} days of runway."
    fi
  else
    echo "::warning::could not parse the MSAL credential expiry '${MINEND}' — the expiry check did NOT run."
    UNKNOWN=$((UNKNOWN + 1))
  fi
fi

# --- the explicit, recorded verdict ------------------------------------------
# Order matters: evidence of breakage outranks an unevaluated sibling check. A
# run that proved sign-in is down is BROKEN even if the other half was
# unreadable.
if [ "$RC" -ne 0 ]; then
  VERDICT=broken
elif [ "$UNKNOWN" -ne 0 ]; then
  VERDICT=unknown
else
  VERDICT=ok
fi

if [ "$VERDICT" = broken ]; then
  echo "login-health verdict: BROKEN (see the ::error:: annotations above)."
elif [ "$VERDICT" = unknown ]; then
  echo "login-health verdict: INDETERMINATE — ${UNKNOWN} check(s) could not run. This is not evidence of health."
else
  echo "login-health verdict: no evidence of a broken sign-in path."
fi

# Machine-readable, on stdout for humans/logs and in $GITHUB_OUTPUT for the
# enforcing step. Appending to $GITHUB_OUTPUT must never change the exit status
# of this script, so its own failure is tolerated explicitly.
echo "login-health-verdict=${VERDICT}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "verdict=${VERDICT}" >> "$GITHUB_OUTPUT" || \
    echo "::warning::could not append the verdict to \$GITHUB_OUTPUT; the enforcing step fails closed on a missing verdict."
fi

exit "$RC"
