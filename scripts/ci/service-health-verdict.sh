#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# service-health-verdict.sh — the VERDICT half of csa-loom-validate.yml
# (refs #2860). Pure: no `az`, no network, no clock. Everything arrives as an
# environment variable, so the decision is unit-testable — see
# scripts/ci/__tests__/service-health-verdict.test.mjs. Same shape as
# login-health-verdict.sh, for the same reason.
#
# WHY THIS EXISTS
# ---------------
# The workflow ran the live probe and then scraped its own log for a verdict:
#
#     node tests/service-health.mjs | tee /tmp/health.txt
#     FAILS=$(grep -oE '[0-9]+ fail' /tmp/health.txt | head -1 | grep -oE '[0-9]+' || echo 0)
#     if [ "${FAILS:-0}" -gt 0 ]; then … exit 1; fi
#
# Two defects, both of which resolve to "reports green while broken":
#
#  1. `head -1` takes the FIRST line in the whole log matching `<n> fail` — and
#     the per-probe result table is printed BEFORE the summary, with the
#     BACKEND'S OWN ERROR TEXT in the last column. Any error body containing a
#     digit followed by "fail" wins the match. Demonstrated:
#         Synapse | /api/x | 500 | FAIL - Job aborted: 0 failed tasks, retry
#         === 4 pass · 1 not-configured · 6 fail (of 11) ===
#     parses to FAILS=0. Six hard failures, green job. The verdict was being
#     read out of prose the failing service controls.
#  2. `|| echo 0` maps "no summary line at all" onto "zero failures". A probe
#     that dies after printing the header, a truncated log, a renamed summary
#     format — every one of those is scored as a clean run.
#
# So: parse ONLY the anchored summary line, take the LAST one, and require it
# to exist. "I could not find the verdict" is a failure, never a pass.
#
# WHAT COUNTS AS BROKEN (exit 1), and why each is not tolerance:
#   SH_RC != 0        the probe process itself failed. Its status used to be
#                     load-bearing only via `pipefail`; now it is explicit, so
#                     nothing downstream can quietly re-swallow it.
#   no summary line   the run never concluded — see (2) above.
#   fail > 0          a real backend/RBAC/network error, which is the whole
#                     point of the workflow.
#   total == 0        zero probes executed. A validation that validated nothing
#                     must not report success (2026-07-28 "gates that measure
#                     nothing" class).
#   pass == 0         nothing returned real data. The workflow's own header
#                     claims it "proves the BFF -> Azure REST chain works
#                     end-to-end"; an all-NOTE run proves the opposite and used
#                     to be green, because NOTEs are not failures.
#
# NOT broken (exit 0): honest not-configured NOTEs alongside at least one PASS.
# That tolerance is the original, legitimate reason the job did not simply
# `exit $?`, and it is preserved exactly.
#
# INPUTS
#   SH_LOG   path to the probe's captured stdout+stderr   (required)
#   SH_RC    the probe's exit status, as a string          (required)
#
# EXIT: 0 = healthy, 1 = broken/indeterminate.
# ---------------------------------------------------------------------------
set -uo pipefail

LOG="${SH_LOG:-}"
RC="${SH_RC:-}"

fail() { echo "::error::$1"; exit 1; }

# An unset RC means the caller never captured the probe's status — exactly the
# masking this script exists to remove. Refuse rather than assume success.
if [ -z "$RC" ]; then
  fail "service-health verdict: SH_RC was not supplied, so the probe's exit status was never captured. Treating as BROKEN."
fi

if [ -z "$LOG" ] || [ ! -f "$LOG" ]; then
  fail "service-health verdict: probe log '${LOG}' is missing. Nothing to judge; treating as BROKEN."
fi

if [ "$RC" != "0" ]; then
  fail "service-health verdict: the probe exited ${RC} — it CRASHED rather than reporting. Live console state is unknown; treating as BROKEN. (tail of the log is above)"
fi

# The one line the verdict may come from. Anchored to the summary's exact shape
# so no probe result text can impersonate it; `tail -1` because the summary is
# printed last and a future re-run in the same log must not be shadowed by an
# earlier one. The separator between counters is a literal middle dot in the
# probe output; matched loosely so an encoding change cannot silently unmatch.
SUMMARY="$(grep -aE '^=== [0-9]+ pass .* [0-9]+ fail \(of [0-9]+\) ===$' "$LOG" | tail -1 || true)"

if [ -z "$SUMMARY" ]; then
  fail "service-health verdict: the probe log has NO summary line ('=== N pass … N fail (of N) ==='). The run never concluded (crash, truncation, or a changed output format). This is NOT zero failures; treating as BROKEN."
fi

echo "Summary line: ${SUMMARY}"

PASSES="$(printf '%s' "$SUMMARY" | sed -E 's/^=== ([0-9]+) pass .*/\1/')"
FAILS="$(printf '%s' "$SUMMARY" | sed -E 's/.* ([0-9]+) fail \(of [0-9]+\) ===$/\1/')"
TOTAL="$(printf '%s' "$SUMMARY" | sed -E 's/.*\(of ([0-9]+)\) ===$/\1/')"

case "${PASSES}${FAILS}${TOTAL}" in
  *[!0-9]*|'') fail "service-health verdict: could not parse counters out of the summary line. Treating as BROKEN rather than guessing." ;;
esac

echo "Parsed: pass=${PASSES} fail=${FAILS} of ${TOTAL} probes"

if [ "$TOTAL" -eq 0 ]; then
  fail "service-health verdict: ZERO probes ran. A validation that validated nothing is not a pass."
fi

if [ "$FAILS" -gt 0 ]; then
  fail "CSA Loom live validation found ${FAILS} hard failure(s) of ${TOTAL} probes — see the job summary."
fi

if [ "$PASSES" -eq 0 ]; then
  fail "service-health verdict: ${TOTAL} probes ran and NOT ONE returned real data (all not-configured NOTEs). The BFF -> Azure chain is unproven; treating as BROKEN."
fi

echo "[service-health] OK — ${PASSES}/${TOTAL} probes returned real data, 0 hard failures."
exit 0
