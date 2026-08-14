# shellcheck shell=bash
# _grant-role-if-absent.sh — ONE implementation of "grant this role unless it is
# already granted". Sourced, never executed; `_`-prefixed like the JS shared
# libraries under scripts/ci/ so guard-population rules do not treat it as a
# control.
#
# WHY (issue #3439, deploy-integrity.md R6/R7)
#
#   `az role assignment create` with no `--name` mints a RANDOM v4 GUID. ARM
#   enforces uniqueness on the (scope, principalId, roleDefinitionId) TRIPLE and
#   NOT on the name, and the bicep declares many of the same triples under
#   deterministic v5 `guid()` names. So a CLI grant and a template grant of one
#   triple can never agree on a name, and whichever writer lands first blocks the
#   other with RoleAssignmentExists on EVERY future run.
#
#   Measured: deploy-fiab-commercial run 31780698652 (2026-08-14) failed on
#   AcrPull for uami-loom-directlake on the admin-plane ACR — grant already in
#   place, under a v4 name, so the template's v5 name could never be created.
#
# WHAT THE PROBE DOES AND DOES NOT PREVENT — stated honestly (R7)
#
#   It does NOT prevent the first mint. If the triple is genuinely absent, this
#   still creates it, and that create still mints a v4 name the template will
#   later collide with. Preventing THAT is the converger's job
#   (scripts/csa-loom/converge-role-assignment.mjs), which makes the collision
#   self-healing instead of permanent.
#
#   What the probe buys is narrower and worth having: in the normal case — the
#   template granted in phase 1, before any of these scripts run in phase 2 —
#   the workflow stops writing at all, and when it DOES have to mint it says so
#   loudly instead of swallowing the outcome into `| grep -vi already || true`.
#   That warning is how this class becomes visible the next time rather than
#   surfacing a fortnight later as a dead deploy lane.
#
# THE CONTRACT
#
#   grant_role_if_absent <principal-object-id> <role-definition-guid> <scope> <label>
#
#   Returns 0 when the grant is in place or was attempted; 1 only on a usage
#   error. It never returns non-zero for an unreadable probe — see below.
#
# WHY AN UNREADABLE PROBE STILL CREATES
#
#   The first cut of this helper skipped the create when it could not read the
#   probe, on the reasoning that "an unreadable read is not an established
#   absence". That was a NEW fail-open introduced by the very change that fixed
#   #3439, and a reviewer caught it before merge:
#
#     - the probe folded stderr into the value with `2>&1`, so a single CLI
#       update notice or extension auto-install line made `$EXISTING` neither
#       "0" nor a positive integer;
#     - the value then fell through to the "could not read" branch;
#     - so on any run where az wrote to stderr, a genuinely-absent AcrPull was
#       NEVER granted and the Container App could not pull its image.
#
#   The prior code always created (`|| true`), so that was a regression on both
#   the Commercial and the Gov path.
#
#   The fix is two-part. The probe now captures stderr SEPARATELY and decides on
#   az's EXIT STATUS, so a stderr line can no longer corrupt the value. And when
#   the probe genuinely cannot be read, it CREATES rather than skipping, because
#   the two outcomes are not symmetric:
#
#     - creating when the grant already exists is HARMLESS. ARM refuses a
#       duplicate triple with RoleAssignmentExists, so a redundant create cannot
#       mint a second name — the thing we are trying to avoid is impossible in
#       this direction.
#     - skipping when the grant is absent is an OUTAGE, and a self-inflicted one.
#
#   Failing open on image pull is worse than a name that needs converging.
#
# THE CALLERS RUN DIFFERENT SHELLS — AND THAT BROKE THIS ONCE ALREADY
#
#   full-app-deploy-commercial.yml's step opens `set +e`.
#   gov-provision-streaming-migrate.yml's step opens `set -euo pipefail`.
#
#   Under `errexit` a BARE command substitution assignment carries the
#   substitution's exit status, so
#
#       existing=$(az … )      # az exits 1
#       rc=$?                  # never reached — the shell already exited
#
#   killed the whole step. The "could not read → create anyway" branch could
#   never run on Gov, and the Storage Blob Data Contributor block AFTER the loop
#   never ran either. A reviewer reproduced it: the suite's own
#   "a FAILED probe creates anyway" case fails the moment the driver switches to
#   `set -euo pipefail`, and a minimal repro produces NO output at all.
#
#   The abort itself was not new — the previous shape was a pipeline and the step
#   sets `pipefail`. What was new was the CLAIM: the header, the commit message
#   and a passing test all asserted create-on-unreadable, under a shell one
#   caller does not use. A fixture that models one caller's environment while a
#   second caller runs a different one is the same class of defect as the bug it
#   was written to catch.
#
#   So every az call here is captured with `if cmd; then rc=0; else rc=$?; fi` —
#   a condition context, where `errexit` is suppressed and the status survives —
#   and the suite drives BOTH `set -uo pipefail` and `set -euo pipefail`.
#
# WHAT THE RETURN CODE MEANS, AND WHY A DENIED GRANT IS STILL 0
#
#   Returns non-zero ONLY for a usage error. A denied or failed create reports
#   loudly and returns 0, deliberately: the callers loop over identities under
#   `errexit`, so a non-zero return would abort the step and skip everything
#   after it — re-creating, in a new place, exactly the sovereign-lane failure
#   described above. `main`'s behaviour here was `|| true`, i.e. silent; this is
#   strictly better because the OUTCOME is in the message. What it must never do
#   is print a ✓ for a grant that was refused — see below.

grant_role_if_absent() {
  local principal="$1" role="$2" scope="$3" label="${4:-role}"
  local existing rc errfile createout createrc

  if [ -z "$principal" ] || [ -z "$role" ] || [ -z "$scope" ]; then
    echo "  ! $label: grant_role_if_absent needs <principal> <role> <scope>; refusing to guess." >&2
    return 1
  fi

  errfile=$(mktemp)
  # stderr goes to its OWN file. Folding it into the value (`2>&1`) is what made
  # a CLI update notice look like an unreadable count.
  #
  # The `if` is load-bearing, not style: a bare assignment would abort the whole
  # step under the Gov caller's `set -euo pipefail`.
  if existing=$(MSYS_NO_PATHCONV=1 az role assignment list \
    --assignee-object-id "$principal" --scope "$scope" --role "$role" \
    --query "length(@)" -o tsv 2>"$errfile"); then
    rc=0
  else
    rc=$?
  fi
  # tsv still carries a trailing newline, and Git Bash adds CR.
  existing=$(printf '%s' "$existing" | tr -d '[:space:]')

  if [ "$rc" -eq 0 ] && [ -n "$existing" ] && [ "$existing" -gt 0 ] 2>/dev/null; then
    rm -f "$errfile"
    echo "  ✓ $label (already granted — existing assignment left alone)"
    return 0
  fi

  if [ "$rc" -ne 0 ] || [ "$existing" != "0" ]; then
    # NOT an established absence — but see the header: creating over an existing
    # triple is refused by ARM and cannot mint a duplicate, while skipping a real
    # absence is an outage. So this reports and proceeds.
    echo "::warning::${label}: could NOT read whether the grant exists (az exit ${rc}: $(tr -d '\r' <"$errfile" | head -c 300)). Attempting the grant anyway — a redundant create is refused by ARM, a skipped one is an outage."
  else
    echo "::warning::${label}: the grant is ABSENT, so it is being created here. That mints a CLI name, not the template's; scripts/csa-loom/converge-role-assignment.mjs converges it on the next infra deploy (#3439)."
  fi
  rm -f "$errfile"

  if createout=$(MSYS_NO_PATHCONV=1 az role assignment create \
    --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
    --role "$role" --scope "$scope" -o none 2>&1); then
    createrc=0
  else
    createrc=$?
  fi

  # R7: the ✓ is now CONDITIONAL on what actually happened. The previous shape
  # piped the create through `grep -viE "already exists"` and then printed
  # "✓ $label" unconditionally — so an AuthorizationFailed printed its error and
  # was immediately followed by a tick, and the caller could not tell a granted
  # role from a denied one. In a change whose whole thesis is that a message
  # must not assert what the code did not establish, that was the same defect
  # one level down.
  if [ "$createrc" -eq 0 ]; then
    echo "  ✓ $label (granted)"
    return 0
  fi
  if printf '%s' "$createout" | grep -qiE "already exists|RoleAssignmentExists"; then
    # ARM refusing a duplicate triple is the EXPECTED no-op, not a failure: it is
    # the proof that a redundant create cannot mint a competing name.
    echo "  ✓ $label (already granted — ARM refused a duplicate triple)"
    return 0
  fi
  echo "::warning::${label}: the grant was NOT created (az exit ${createrc}): $(printf '%s' "$createout" | tr -d '\r' | head -c 300). Returning 0 so the rest of this step still runs — but this role is MISSING, and whatever needed it will fail until it is granted."
  return 0
}
