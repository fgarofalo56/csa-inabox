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
# is the same defect one level down, so the COUNT FIELD distinguishes:
#     unset/empty → unreadable → ::warning::, exit 0
#     "0"         → really zero → OK
#     "3"         → hits present → recency decides (see #3498 below)
#
# ONE QUERY, NOT TWO — WHY THE RECENCY READ MOVED (#3498)
# -------------------------------------------------------
# #3160 (below) taught this script to ORDER the last hit against the newest
# credential. The workflow fed it that timestamp from a SECOND
# `az monitor log-analytics query`, and that second query came back EMPTY on
# every run while the count query returned 4 — with its stderr sent to
# /dev/null, so nothing anywhere recorded why. The gate printed
#
#     LOGIN BROKEN — 4 auth/callback invalid_client errors in the last 7d
#     (AADSTS7000215). Recency could NOT be established
#     (last-hit=<unread>, newest-credential=2026-08-15T17:44:37Z) …
#
# and failed closed forever. loom-ui-verify's last green run was 2026-08-10; a
# credential rotation landed 2026-08-15T17:44:37Z inside that day's Commercial
# deploy window and the gate STILL could not say whether sign-in worked. While
# the lane is red no G1 browser receipt is obtainable for any surface.
#
# Two reads of the same population can disagree about whether they ran. One read
# cannot: `summarize hits = count(), newest = max(TimeGenerated)` puts both facts
# in the SAME ROW, so a readable count implies a readable timestamp and the
# `<unread>` state is no longer reachable from a query that worked.
#
# The `<unread>` state is NOT deleted — an unreadable timestamp must never
# silently pass, which would be #2837 wearing the recency hat. It is made rare,
# given its OWN verdict token (`unproven`), and labelled honestly: per
# deploy-integrity.md R7 the old annotation asserted "LOGIN BROKEN" and then
# disclaimed that very conclusion two lines later, which is an error message
# stating something the code did not establish.
#
# INPUTS (all optional; absent means "could not determine")
#   LH_LAW         resolved Log Analytics customerId ('' = unresolvable)
#   LH_HITS_ROW    PREFERRED. ONE tsv row from the ONE query that reads both
#                  facts: "<count><TAB><newest-hit-iso>". When set it is
#                  AUTHORITATIVE for both, and LH_HITS_RAW / LH_HITS_LAST are
#                  ignored — the split inputs cannot then disagree.
#   LH_HITS_RAW    fallback: raw az output for the count alone ('' = unreadable)
#   LH_HITS_LAST   fallback: ISO8601 timestamp of the MOST RECENT hit
#                  ('' = unreadable -> the gate fails closed, see #3160)
#   LH_HITS_ERR    stderr from the hits query, quoted back VERBATIM when the read
#                  failed. `2>/dev/null` is what made #3498 undiagnosable: an
#                  unread value with no reason attached sent two investigations
#                  at the credential instead of at the query.
#   LH_HITS_RC     az's own exit status for that query. This, NOT stderr being
#                  empty, is the failure signal — the log-analytics extension
#                  banners to stderr on every success (run 31351602478).
#   LH_CRED_NEWEST ISO8601 startDateTime of the NEWEST MSAL app credential
#                  ('' = unreadable -> the gate fails closed)
#   LH_CRED_ERR    stderr from the credential read, same purpose
#   LH_CRED_RC     az's exit status for the credential read, same purpose
#   LH_MIN_END     soonest MSAL credential expiry, ISO-8601 ('' or 'None' =
#                  unreadable — the verify SP likely lacks Application.Read.All)
#   LH_APP_ID      MSAL app id, for the remediation command in the annotation
#   LH_CONSOLE_RG  console resource group, same
#   LH_NOW_EPOCH   override for "now" (tests only; defaults to `date -u +%s`)
#   LH_WARN_DAYS   runway below which to warn but not fail (default 30)
#
# EXIT: 1 if sign-in is demonstrably broken (invalid_client hits that POSTDATE
#       the newest credential, or an already-expired credential) OR if hits are
#       present and their recency could not be established. 0 otherwise,
#       including every "could not determine" path that carries no hits.
#
# RECORDED VERDICT (refs #2871, extended #3498)
# ---------------------------------------------
# The exit status above is unchanged and remains the contract. In ADDITION this
# script emits an EXPLICIT token — `ok` / `unknown` / `unproven` / `broken` — on
# stdout and, when running under Actions, as `verdict=` in $GITHUB_OUTPUT.
#
# `unproven` is the fourth state and it is NOT a softer `broken`. It means: hits
# are present, and this run could not order them against the credential. It
# BLOCKS exactly as `broken` does (exit 1, and ui-verify-gate-verdict.sh fails
# the run on it) — the token exists so the annotation and the job summary can
# stop asserting "sign-in is down" when what actually happened is "this gate
# could not read a timestamp". Folding the two together is the recorded local
# defect class of reporting an UNKNOWN as a NEGATIVE.
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

# Sub-checks that produced EVIDENCE OF BREAKAGE. Distinct from every counter
# below it: this is the only one that licenses the words "sign-in is down".
BROKEN=0
# Hits are present and this run could NOT establish whether they postdate the
# newest credential (#3498). Blocks like BROKEN — an unreadable timestamp must
# never silently pass — but it is a different claim and gets a different one.
UNPROVEN=0
# Number of sub-checks that could NOT be evaluated. Distinct from the two above:
# this is "no evidence either way", which must never become a failure (that
# tolerance is the original, legitimate reason the step carried
# continue-on-error) but must equally never be reported as health (#2837).
UNKNOWN=0

APP_ID="${LH_APP_ID:-<msal-app-id>}"
RG="${LH_CONSOLE_RG:-<console-rg>}"
WARN_DAYS="${LH_WARN_DAYS:-30}"

# The rotation command is printed on both error paths — an annotation that names
# the fix is the difference between a page and a scramble.
ROTATE_CMD="az containerapp secret set -n loom-console -g ${RG} --secrets \"loom-msal-client-secret=\$(az ad app credential reset --id ${APP_ID} --append --years 2 --query password -o tsv)\" then roll a new revision"

# Diagnostics for the two reads that feed this verdict, attached only where a
# read actually failed. Silent on the happy path.
#
# THE EXIT CODE IS THE FAILURE SIGNAL, NEVER STDERR-EMPTINESS. The az
# log-analytics extension writes "This command is from the following extension"
# to stderr on every SUCCESSFUL call, so an emptiness test reports a good query
# as failed — measured on run 31351602478 and commented at the sibling call site
# in loom-synthetic-monitor.yml. With the rc in hand these say something a
# stderr-only diagnosis cannot: an rc of 0 next to an unusable value means the
# problem is the SHAPE of the output, not a permission or a network.
note_for() { # <rc> <stderr> <what>
  _rc="$1"; _err="$2"; _what="$3"
  if [ -z "$_rc" ]; then
    printf ' The %s reported no exit status, so even its success is unknown.' "$_what"
  elif [ "$_rc" != "0" ]; then
    printf ' The %s FAILED (az exited %s)%s.' "$_what" "$_rc" "${_err:+: [$_err]}"
  else
    printf ' The %s itself exited 0.' "$_what"
  fi
}
HITS_ERR_NOTE="$(note_for "${LH_HITS_RC:-}" "${LH_HITS_ERR:-}" "hits query")"
CRED_ERR_NOTE="$(note_for "${LH_CRED_RC:-}" "${LH_CRED_ERR:-}" "credential read")"

# --- (a) recent auth/callback invalid_client in the console logs -------------
echo "== (a) recent auth/callback invalid_client in the console logs =="

# Resolve the (count, last-hit) PAIR. LH_HITS_ROW is one row from one query and
# is authoritative for both, so the two facts cannot disagree about whether the
# query ran (#3498). The split inputs stay as a fallback.
HITS_RAW="${LH_HITS_RAW:-}"
LAST_HIT="${LH_HITS_LAST:-}"
# WHY the timestamp is missing, when it is. A bare "<unread>" is what sent this
# investigation at the credential twice; these are different bugs with different
# fixes, so the annotation has to be able to tell them apart.
LAST_WHY="no last-hit timestamp was supplied to the verdict"
if [ -n "${LH_HITS_ROW:-}" ]; then
  TAB="$(printf '\t')"
  ROW="$(printf '%s' "$LH_HITS_ROW" | tr -d '\r' | head -1)"
  HITS_RAW="$(printf '%s' "$ROW" | cut -f1)"
  case "$ROW" in
    *"$TAB"*)
      LAST_HIT="$(printf '%s' "$ROW" | cut -s -f2)"
      LAST_WHY="the query returned its timestamp column EMPTY"
      ;;
    *)
      LAST_HIT=""
      LAST_WHY="the query returned a count with NO timestamp column — it is not the two-column query this gate expects"
      ;;
  esac
fi

# A count is the WHOLE field or it is unreadable. The previous
# `grep -oE '[0-9]+' | head -1` also turned an az error into a count:
# "ERROR: (403) Forbidden" reads as 403 invalid_client hits and pages someone
# for an outage that is really a missing role assignment.
HITS="$(printf '%s' "$HITS_RAW" | tr -d '\r' | tr -d '[:space:]')"
case "$HITS" in
  ''|*[!0-9]*) HITS="" ;;
esac

if [ -z "${LH_LAW:-}" ]; then
  echo "::warning::could not resolve the console Log Analytics workspace in ${RG} — the callback-error check did NOT run (this is 'unknown', not 'healthy')."
  UNKNOWN=$((UNKNOWN + 1))
else
  if [ -z "$HITS" ]; then
    echo "::warning::resolved the workspace but could NOT read the invalid_client count (query error / no Log Analytics Reader on it) — the callback-error check did NOT run. Not treated as zero.${HITS_ERR_NOTE}"
    UNKNOWN=$((UNKNOWN + 1))
  elif [ "$HITS" -gt 0 ]; then
    # RECENCY (#3160). A 7-day count with no recency test cannot tell
    # 'sign-in is down' from 'sign-in WAS down and someone fixed it' — so a
    # rotation that worked still failed this gate for a week, and an operator
    # who has seen it cry wolf twice stops believing the third one. Worse, the
    # two states produce byte-identical output.
    #
    # The discriminator is whether any hit SURVIVED the newest credential: an
    # invalid_client after the most recent `az ad app credential reset` means
    # the console is still presenting something the app does not hold. Every
    # hit before it is evidence about a fixed outage.
    CRED_NEW="${LH_CRED_NEWEST:-}"
    LAST_SEC=""; CRED_SEC=""
    [ -n "$LAST_HIT" ] && LAST_SEC="$(date -u -d "$LAST_HIT" +%s 2>/dev/null || true)"
    [ -n "$CRED_NEW" ] && CRED_SEC="$(date -u -d "$CRED_NEW" +%s 2>/dev/null || true)"

    if [ -n "$LAST_SEC" ] && [ -n "$CRED_SEC" ]; then
      if [ "$LAST_SEC" -le "$CRED_SEC" ]; then
        # HISTORICAL. The one deliberate fail-OPEN, and it is narrow: BOTH
        # timestamps were read AND they order. Both are recorded in the note so
        # the claim can be re-checked from the log alone.
        echo "::warning::${HITS} auth/callback invalid_client error(s) in the last 7d, but the most recent one (${LAST_HIT}) PREDATES the newest MSAL credential (${CRED_NEW}) — this is evidence about an outage that has since been rotated, not a current one. Not failing the gate on it. It will age out of the 7d window on its own."
        echo "  recency ESTABLISHED: last-hit ${LAST_HIT} <= newest-credential ${CRED_NEW} — no invalid_client since the credential reset."
      else
        # LIVE. Both timestamps read, and a hit survived the rotation.
        echo "::error::LOGIN BROKEN — ${HITS} auth/callback invalid_client errors in the last 7d (AADSTS7000215). The most recent error (${LAST_HIT}) is NEWER than the newest MSAL credential (${CRED_NEW}), so the console is still presenting a secret the app does not hold — a rotation has not fixed it. Rotate: ${ROTATE_CMD}."
        BROKEN=$((BROKEN + 1))
      fi
    else
      # UNPROVEN. Name WHICH read failed and why — "<unread>" on its own is the
      # thing that cost a week.
      LAST_DESC="${LAST_HIT}"
      if [ -z "$LAST_HIT" ]; then
        LAST_DESC="<unread: ${LAST_WHY}>"
      elif [ -z "$LAST_SEC" ]; then
        LAST_DESC="'${LAST_HIT}' <unparseable as a date>"
      fi
      CRED_DESC="${CRED_NEW}"
      if [ -z "$CRED_NEW" ]; then
        CRED_DESC="<unread: no newest-credential startDateTime was supplied (the verify SP likely lacks Application.Read.All on the MSAL app)>"
      elif [ -z "$CRED_SEC" ]; then
        CRED_DESC="'${CRED_NEW}' <unparseable as a date>"
      fi
      # Attach the diagnosis for the read(s) that actually failed, and only
      # those — a note about a read that worked is noise on an annotation people
      # already find long.
      DIAG=""
      [ -z "$LAST_SEC" ] && DIAG="${DIAG}${HITS_ERR_NOTE}"
      [ -z "$CRED_SEC" ] && DIAG="${DIAG}${CRED_ERR_NOTE}"
      echo "::error::LOGIN HEALTH UNPROVEN — ${HITS} auth/callback invalid_client error(s) (AADSTS7000215) are in the 7d window, but this gate could not read the last-hit timestamp that orders them: last-hit=${LAST_DESC}, newest-credential=${CRED_DESC}. It therefore CANNOT tell a live outage from one an earlier rotation already fixed. This is NOT a finding that sign-in is down — it is a refusal to guess, and it fails closed because assuming 'historical' is exactly how a real AADSTS7000215 outage renders green. FIX THE READ, not the credential: the hits query must return count and newest-TimeGenerated as ONE row, and the verify identity needs Log Analytics Reader on the console workspace plus Application.Read.All on the MSAL app.${DIAG} If sign-in IS in fact down, the rotation is: ${ROTATE_CMD}."
      UNPROVEN=$((UNPROVEN + 1))
    fi
  else
    echo "  OK — no invalid_client callback errors in the last 7d."
  fi
fi

# --- (b) MSAL app credential expiry ------------------------------------------
echo "== (b) MSAL app credential expiry =="
MINEND="${LH_MIN_END:-}"
if [ -z "$MINEND" ] || [ "$MINEND" = "None" ]; then
  echo "::warning::could not read MSAL app ${APP_ID} credentials (the verify SP likely lacks Application.Read.All / owner) — grant it to enable the expiry check. The expiry check did NOT run.${CRED_ERR_NOTE}"
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
      BROKEN=$((BROKEN + 1))
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
# Order matters, twice over:
#   - evidence of breakage outranks an unprovable sibling: a run that PROVED
#     sign-in is down is BROKEN even if the other half was unorderable;
#   - an unprovable recency outranks an unevaluated check, because it blocks and
#     `unknown` does not.
RC=0
if [ "$BROKEN" -ne 0 ] || [ "$UNPROVEN" -ne 0 ]; then
  RC=1
fi

if [ "$BROKEN" -ne 0 ]; then
  VERDICT=broken
elif [ "$UNPROVEN" -ne 0 ]; then
  VERDICT=unproven
elif [ "$UNKNOWN" -ne 0 ]; then
  VERDICT=unknown
else
  VERDICT=ok
fi

if [ "$VERDICT" = broken ]; then
  echo "login-health verdict: BROKEN (see the ::error:: annotations above)."
elif [ "$VERDICT" = unproven ]; then
  echo "login-health verdict: UNPROVEN — invalid_client hits are present and this run could not establish whether they postdate the newest credential. Failing closed. This is NOT a finding that sign-in is down, and it is not evidence of health either."
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
