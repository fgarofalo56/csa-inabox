#!/usr/bin/env bash
# Grant the Loom Console UAMI the "API Management Service Contributor" role
# on the APIM service apim-csa-loom-eastus2. Idempotent — re-running is a no-op.
#
# Requires: az CLI logged in to the FedCiv subscription that owns the APIM,
# with permissions to create role assignments on the APIM service scope.
#
# Re-run AFTER the APIM service finishes provisioning (~30-45 min from 'apim create').
set -euo pipefail

SUB="${SUB:-00000000-0000-0000-0000-000000000001}"
RG="${RG:-rg-csa-loom-admin-eastus2}"
APIM="${APIM:-apim-csa-loom-eastus2}"
UAMI_PRINCIPAL_ID="${UAMI_PRINCIPAL_ID:-00000000-0000-0000-0000-00000000000a}"
ROLE="${ROLE:-API Management Service Contributor}"

SCOPE="/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.ApiManagement/service/${APIM}"

echo "Checking APIM provisioning state…"
STATE="$(MSYS_NO_PATHCONV=1 az apim show -n "${APIM}" -g "${RG}" --query provisioningState -o tsv 2>/dev/null || echo 'NotFound')"
echo "  APIM ${APIM} state: ${STATE}"

if [[ "${STATE}" != "Succeeded" ]]; then
  echo "APIM not ready yet (state=${STATE}). Re-run when provisioningState=Succeeded."
  exit 1
fi

EXISTING="$(MSYS_NO_PATHCONV=1 az role assignment list \
  --assignee "${UAMI_PRINCIPAL_ID}" \
  --scope "${SCOPE}" \
  --role "${ROLE}" \
  --query '[0].id' -o tsv 2>/dev/null || true)"

if [[ -n "${EXISTING}" ]]; then
  echo "Role assignment already exists: ${EXISTING}"
  exit 0
fi

echo "Creating role assignment: ${ROLE} for ${UAMI_PRINCIPAL_ID} at ${SCOPE}"
MSYS_NO_PATHCONV=1 az role assignment create \
  --assignee "${UAMI_PRINCIPAL_ID}" \
  --role "${ROLE}" \
  --scope "${SCOPE}"

echo "Done."
