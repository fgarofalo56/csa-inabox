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
#   Swallowing the error (`| grep -vi already || true`) makes the CLI call look
#   idempotent. It is idempotent with respect to ITSELF and not with respect to
#   the template, and that distinction is the entire bug.
#
# THE CONTRACT
#
#   grant_role_if_absent <principal-object-id> <role-definition-guid> <scope> <label>
#
#   - PROBES first. Already granted => no-op, and the existing assignment (which
#     may be the template's) is left alone.
#   - Creates ONLY on an established absence. Dropping a grant that is genuinely
#     missing is worse than a name that needs converging, and a minted name is
#     now self-healing: deploy-retry --remediate runs
#     scripts/csa-loom/converge-role-assignment.mjs on the next infra deploy.
#   - An UNREADABLE probe is not an absent grant (R7). It reports and does not
#     create — creating on an unreadable read is how the stray got minted.
#
#   Returns 0 on no-op/create, 1 when the probe could not be read.

grant_role_if_absent() {
  local principal="$1" role="$2" scope="$3" label="${4:-role}"
  local existing

  existing=$(MSYS_NO_PATHCONV=1 az role assignment list \
    --assignee-object-id "$principal" --scope "$scope" --role "$role" \
    --query "length(@)" -o tsv 2>&1 | tr -d '\r')

  if [ "$existing" = "0" ]; then
    echo "  $label: ABSENT — creating. This mints a CLI name, not the template's; scripts/csa-loom/converge-role-assignment.mjs converges it on the next infra deploy (#3439)."
    MSYS_NO_PATHCONV=1 az role assignment create \
      --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
      --role "$role" --scope "$scope" -o none 2>&1 \
      | grep -viE "already exists|RoleAssignmentExists" || true
    echo "  ✓ $label"
    return 0
  fi

  if [ -n "$existing" ] && [ "$existing" -gt 0 ] 2>/dev/null; then
    echo "  ✓ $label (already granted — existing assignment left alone)"
    return 0
  fi

  echo "  ! $label: could NOT read whether the grant exists (az said: ${existing}). NOT creating one on an unestablished absence." >&2
  return 1
}
