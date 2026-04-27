#!/usr/bin/env bash
# Fabric workspace + lakehouse + shortcut + semantic model deploy.
#
# Prereq: Bicep already provisioned the capacity (see ../bicep/main.bicep).
#         Service principal with Fabric Administrator role + access to
#         target ADLS storage account.
#
# Usage:
#   ./deploy.sh <env> <capacity-name> <storage-account> <storage-sas-token>
#
# Idempotent — re-running upserts the workspace, lakehouse, and shortcut.

set -euo pipefail

ENV="${1:?env name required}"
CAPACITY_NAME="${2:?capacity name required}"
STORAGE_ACCOUNT="${3:?storage account name required}"
STORAGE_SAS="${4:?storage SAS token required}"

WORKSPACE_NAME="csa-retail-sales-${ENV}"
LAKEHOUSE_NAME="lh_retail_sales_gold"
SHORTCUT_NAME="adls_gold_shortcut"
SEMANTIC_MODEL_NAME="retail-sales"

FABRIC_API="https://api.fabric.microsoft.com/v1"
TOKEN=$(az account get-access-token --resource https://api.fabric.microsoft.com/.default --query accessToken -o tsv)

# ---------------------------------------------------------------------------
# 1. Get capacity id
# ---------------------------------------------------------------------------
echo "==> Resolving capacity ID for '${CAPACITY_NAME}'"
CAPACITY_ID=$(curl -sS -H "Authorization: Bearer ${TOKEN}" \
  "${FABRIC_API}/capacities" | jq -r ".value[] | select(.displayName==\"${CAPACITY_NAME}\") | .id")
if [[ -z "${CAPACITY_ID}" ]]; then
  echo "ERROR: capacity '${CAPACITY_NAME}' not found." >&2
  exit 1
fi
echo "    capacity ID: ${CAPACITY_ID}"

# ---------------------------------------------------------------------------
# 2. Upsert workspace
# ---------------------------------------------------------------------------
echo "==> Upserting workspace '${WORKSPACE_NAME}'"
WORKSPACE_ID=$(curl -sS -H "Authorization: Bearer ${TOKEN}" \
  "${FABRIC_API}/workspaces" | jq -r ".value[] | select(.displayName==\"${WORKSPACE_NAME}\") | .id")
if [[ -z "${WORKSPACE_ID}" ]]; then
  WORKSPACE_ID=$(curl -sS -X POST -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    "${FABRIC_API}/workspaces" \
    -d "{\"displayName\":\"${WORKSPACE_NAME}\",\"description\":\"Retail Sales E2E (${ENV}) — provisioned by csa-inabox\",\"capacityId\":\"${CAPACITY_ID}\"}" \
    | jq -r .id)
  echo "    created workspace: ${WORKSPACE_ID}"
else
  echo "    workspace exists: ${WORKSPACE_ID}"
  curl -sS -X PATCH -H "Authorization: Bearer ${TOKEN}" \
    "${FABRIC_API}/workspaces/${WORKSPACE_ID}" \
    -H "Content-Type: application/json" \
    -d "{\"capacityId\":\"${CAPACITY_ID}\"}" >/dev/null
fi

# ---------------------------------------------------------------------------
# 3. Upsert lakehouse
# ---------------------------------------------------------------------------
echo "==> Upserting lakehouse '${LAKEHOUSE_NAME}'"
LAKEHOUSE_ID=$(curl -sS -H "Authorization: Bearer ${TOKEN}" \
  "${FABRIC_API}/workspaces/${WORKSPACE_ID}/lakehouses" \
  | jq -r ".value[] | select(.displayName==\"${LAKEHOUSE_NAME}\") | .id")
if [[ -z "${LAKEHOUSE_ID}" ]]; then
  LAKEHOUSE_ID=$(curl -sS -X POST -H "Authorization: Bearer ${TOKEN}" \
    "${FABRIC_API}/workspaces/${WORKSPACE_ID}/lakehouses" \
    -H "Content-Type: application/json" \
    -d "{\"displayName\":\"${LAKEHOUSE_NAME}\"}" \
    | jq -r .id)
  echo "    created lakehouse: ${LAKEHOUSE_ID}"
else
  echo "    lakehouse exists: ${LAKEHOUSE_ID}"
fi

# ---------------------------------------------------------------------------
# 4. Create OneLake shortcut → ADLS gold
# ---------------------------------------------------------------------------
echo "==> Creating OneLake shortcut '${SHORTCUT_NAME}' → ${STORAGE_ACCOUNT}/gold"
curl -sS -X POST -H "Authorization: Bearer ${TOKEN}" \
  "${FABRIC_API}/workspaces/${WORKSPACE_ID}/items/${LAKEHOUSE_ID}/shortcuts" \
  -H "Content-Type: application/json" \
  -d @- <<JSON || echo "    (shortcut may already exist; skipping)"
{
  "name": "${SHORTCUT_NAME}",
  "path": "Tables",
  "target": {
    "adlsGen2": {
      "location": "https://${STORAGE_ACCOUNT}.dfs.core.windows.net",
      "subpath": "/gold/retail-sales",
      "connectionId": "00000000-0000-0000-0000-000000000000"
    }
  }
}
JSON

# ---------------------------------------------------------------------------
# 5. Import semantic model from PBIP folder
# ---------------------------------------------------------------------------
echo "==> Packaging + importing semantic model '${SEMANTIC_MODEL_NAME}'"
pushd "$(dirname "$0")/../../semantic-model" >/dev/null
TMPDIR=$(mktemp -d)
cd "${TMPDIR}"
cp -r "$(dirs +1)/retail-sales.SemanticModel" .
zip -r retail-sales.SemanticModel.zip retail-sales.SemanticModel >/dev/null

curl -sS -X POST -H "Authorization: Bearer ${TOKEN}" \
  "${FABRIC_API}/workspaces/${WORKSPACE_ID}/semanticModels" \
  -H "Content-Type: multipart/form-data" \
  -F "displayName=${SEMANTIC_MODEL_NAME}" \
  -F "definition=@retail-sales.SemanticModel.zip" \
  | jq -r '.id // "(import returned no id — see response above)"'

popd >/dev/null
rm -rf "${TMPDIR}"

echo
echo "==> Done."
echo "    Workspace: https://app.fabric.microsoft.com/groups/${WORKSPACE_ID}/list"
echo "    Lakehouse: ${LAKEHOUSE_NAME}"
echo "    Semantic Model: ${SEMANTIC_MODEL_NAME}"
