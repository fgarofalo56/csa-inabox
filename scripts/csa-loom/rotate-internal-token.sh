#!/usr/bin/env bash
# rotate-internal-token.sh — rotate LOOM_INTERNAL_TOKEN across EVERY live holder.
#
# SAFE BY DEFAULT: this script DRY-RUNS unless you pass --apply.
#
#   Why the default is inverted: on 2026-08-26 an earlier version of this script
#   defaulted to WRITING. It was run against the live estate to test whether it
#   leaked the token, with a dummy 36-char value. The length check passed,
#   pre-flight passed, and it wrote that dummy value to FOUR of seven live
#   holders before being killed — leaving the estate in exactly the mixed state
#   this script's warnings exist to prevent. The dangerous action must be the one
#   you opt into, never the one you get by default.
#
# WHY IT EXISTS
#   The estate OWNS this token; bicep only ADOPTS it. There are SEVEN live Azure
#   holders plus the GitHub secret. Rotating by hand strands whichever holder you
#   miss — that is the 2026-08-06/07/08 outage.
#
# THE VALUE NEVER APPEARS ANYWHERE
#   Read from LOOM_NEW_TOKEN only. Never echoed, never written to a file, never
#   passed on a visible command line, never logged. Only lengths and resource
#   names appear in the output.
#
# USAGE
#   export LOOM_NEW_TOKEN="$(python -c 'import uuid; print(uuid.uuid4())')"
#   bash scripts/csa-loom/rotate-internal-token.sh            # DRY RUN — writes nothing
#   bash scripts/csa-loom/rotate-internal-token.sh --apply    # actually rotates
#   gh secret set LOOM_INTERNAL_TOKEN --body "$LOOM_NEW_TOKEN"
#   unset LOOM_NEW_TOKEN
#
#   Then redeploy. The deploy ADOPTS the live console value — it does not mint.
#   NEVER pass a fresh value to bicep's loomInternalTokenValue to "rotate", and
#   NEVER leave it empty on an estate that already has a console.
#
# See docs/fiab/runbooks/internal-token-ownership.md

set -uo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

SUB="${LOOM_ADMIN_SUB:-e093f4fd-5047-4ee4-968d-a56942c665f3}"
RG="${LOOM_ADMIN_RG:-rg-csa-loom-admin-centralus}"
SECRET_NAME="loom-internal-token"

APPS=(loom-console)
JOBS=(
  loom-copilot-evaluator
  loom-asset-reconciler
  loom-cost-anomaly-monitor
  loom-access-sweep
  loom-access-group-sync
  loom-access-review-sweep
)

if [ -z "${LOOM_NEW_TOKEN:-}" ]; then
  echo "REFUSED: LOOM_NEW_TOKEN is not set." >&2
  echo "  export LOOM_NEW_TOKEN=\"\$(python -c 'import uuid; print(uuid.uuid4())')\"" >&2
  exit 2
fi

LEN=${#LOOM_NEW_TOKEN}
if [ "$LEN" -lt 16 ]; then
  echo "REFUSED: LOOM_NEW_TOKEN is only $LEN chars — too short to be the minted guid() shape." >&2
  exit 2
fi

if [ "$APPLY" -eq 1 ]; then
  echo "*** APPLY MODE — this WILL write to the live estate ***"
else
  echo "=== DRY RUN — nothing will be written. Pass --apply to rotate. ==="
fi
echo "Token accepted from the environment: ${LEN} chars. The value is not printed."
echo "Target: sub=${SUB} rg=${RG}"
echo ""

FAILED=0
DONE=0

# ---- PRE-FLIGHT: every holder must exist BEFORE we change any of them --------
echo "== Pre-flight: confirming every holder exists"
for A in "${APPS[@]}"; do
  az containerapp show --subscription "$SUB" -g "$RG" -n "$A" -o none 2>/tmp/pf.err
  RC=$?
  if [ $RC -ne 0 ]; then echo "  MISSING app $A (rc=$RC): $(head -c 200 /tmp/pf.err)" >&2; FAILED=1
  else echo "  ok  app $A"; fi
done
for J in "${JOBS[@]}"; do
  az containerapp job show --subscription "$SUB" -g "$RG" -n "$J" -o none 2>/tmp/pf.err
  RC=$?
  if [ $RC -ne 0 ]; then echo "  MISSING job $J (rc=$RC): $(head -c 200 /tmp/pf.err)" >&2; FAILED=1
  else echo "  ok  job $J"; fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "" >&2
  echo "REFUSED: at least one holder is unreachable. NOTHING has been changed." >&2
  echo "A partial rotation is what strands holders — fix the above and re-run." >&2
  exit 1
fi

if [ "$APPLY" -ne 1 ]; then
  echo ""
  echo "== DRY RUN: would write '${SECRET_NAME}' to these $(( ${#APPS[@]} + ${#JOBS[@]} )) holders"
  for A in "${APPS[@]}"; do echo "     app $A"; done
  for J in "${JOBS[@]}"; do echo "     job $J"; done
  echo ""
  echo "Nothing was written. Re-run with --apply to rotate."
  exit 0
fi

echo ""
echo "== Writing to all $(( ${#APPS[@]} + ${#JOBS[@]} )) holders"

for A in "${APPS[@]}"; do
  az containerapp secret set --subscription "$SUB" -g "$RG" -n "$A" \
    --secrets "${SECRET_NAME}=${LOOM_NEW_TOKEN}" -o none 2>/tmp/w.err
  RC=$?
  if [ $RC -eq 0 ]; then echo "  WROTE app $A"; DONE=$((DONE+1))
  else echo "  FAILED app $A (rc=$RC): $(head -c 200 /tmp/w.err)" >&2; FAILED=1; fi
done

for J in "${JOBS[@]}"; do
  az containerapp job secret set --subscription "$SUB" -g "$RG" -n "$J" \
    --secrets "${SECRET_NAME}=${LOOM_NEW_TOKEN}" -o none 2>/tmp/w.err
  RC=$?
  if [ $RC -eq 0 ]; then echo "  WROTE job $J"; DONE=$((DONE+1))
  else echo "  FAILED job $J (rc=$RC): $(head -c 200 /tmp/w.err)" >&2; FAILED=1; fi
done

echo ""
echo "== Verify the secret is PRESENT on every holder (names only, never values)"
for A in "${APPS[@]}"; do
  N=$(az containerapp show --subscription "$SUB" -g "$RG" -n "$A" \
        --query "length(properties.configuration.secrets[?name=='${SECRET_NAME}'])" -o tsv 2>/tmp/v.err | tr -d '\r')
  echo "  app $A: ${N:-UNREADABLE}"
  [ "${N:-0}" = "1" ] || FAILED=1
done
for J in "${JOBS[@]}"; do
  N=$(az containerapp job show --subscription "$SUB" -g "$RG" -n "$J" \
        --query "length(properties.configuration.secrets[?name=='${SECRET_NAME}'])" -o tsv 2>/tmp/v.err | tr -d '\r')
  echo "  job $J: ${N:-UNREADABLE}"
  [ "${N:-0}" = "1" ] || FAILED=1
done

echo ""
if [ "$FAILED" -ne 0 ]; then
  echo "INCOMPLETE — $DONE write(s) succeeded but at least one holder FAILED or is unverifiable." >&2
  echo "The estate is now MIXED: some holders have the new value, some the old." >&2
  echo "Re-run with --apply until every holder reports ok BEFORE setting the GitHub secret." >&2
  exit 1
fi

echo "All $DONE holders rotated and verified present."
echo ""
echo "NEXT, in order:"
echo "  1. gh secret set LOOM_INTERNAL_TOKEN --body \"\$LOOM_NEW_TOKEN\""
echo "  2. unset LOOM_NEW_TOKEN"
echo "  3. Redeploy so the deploy re-adopts the live value."
echo "     Do NOT pass a fresh value to bicep's loomInternalTokenValue."
