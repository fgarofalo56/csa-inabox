#!/usr/bin/env bash
# CSA Loom — grant the Console UAMI the subscription-scoped ARM roles every
# Monitor / Cost / Security surface needs, so a fresh deploy works without the
# operator hunting for grants. Idempotent (re-running is a no-op).
#
# Roles (built-in):
#   Security Reader            — Monitor → Security (Defender for Cloud) reads
#   Resource Policy Contributor— Defender "Fix via Loom" (Policy remediations)
#   Cost Management Reader     — Monitor → Cost
#   Monitoring Contributor     — diagnostics-on + Monitor metrics/alerts writes
#   Reader                     — inventory / health probes (baseline)
#
# REQUIRES: az logged in as a principal that can write roleAssignments on the
#   target subscription(s) (the limitlessdata_deploy SP, Owner/User Access Admin).
#
# USAGE:
#   ./scripts/csa-loom/grant-console-rbac.sh
#   CONSOLE_UAMI_PRINCIPAL=<oid> SUBS="sub1,sub2" ./scripts/csa-loom/grant-console-rbac.sh
set -uo pipefail

UAMI="${CONSOLE_UAMI_PRINCIPAL:-e61f3eb3-c646-4183-8198-4c4a34cd9a01}"
# Comma- or space-separated subscription list; default to the current account.
SUBS="${SUBS:-${LOOM_SUBSCRIPTION_ID:-$(az account show --query id -o tsv 2>/dev/null)}}"
SUBS="${SUBS//,/ }"

ROLES=(
  "Reader"
  "Security Reader"
  "Resource Policy Contributor"
  "Cost Management Reader"
  "Monitoring Contributor"
)

rc=0
for SUB in $SUBS; do
  [ -z "$SUB" ] && continue
  echo "== subscription $SUB =="
  for ROLE in "${ROLES[@]}"; do
    if MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' az role assignment create \
        --assignee-object-id "$UAMI" --assignee-principal-type ServicePrincipal \
        --role "$ROLE" --scope "/subscriptions/$SUB" -o none 2>/dev/null; then
      echo "   granted: $ROLE"
    else
      # Already-exists is success; a real failure (no UAA rights) is a warning.
      if MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' az role assignment list \
          --assignee "$UAMI" --scope "/subscriptions/$SUB" \
          --query "[?roleDefinitionName=='$ROLE'] | [0]" -o tsv 2>/dev/null | grep -q .; then
        echo "   present: $ROLE"
      else
        echo "::warning::could not grant '$ROLE' on $SUB — the running principal needs Owner / User Access Administrator there."
        rc=1
      fi
    fi
  done
done
exit $rc
