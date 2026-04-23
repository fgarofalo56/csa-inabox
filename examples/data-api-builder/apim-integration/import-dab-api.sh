#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# import-dab-api.sh — Import DAB OpenAPI spec into APIM and apply policy
#
# Usage:
#   ./import-dab-api.sh -g <resource-group> -n <apim-name> -e <dab-endpoint>
#
# Prerequisites:
#   - Azure CLI installed and logged in
#   - APIM instance already deployed
#   - DAB endpoint accessible (returns OpenAPI spec at /swagger/v1/swagger.json)
# ---------------------------------------------------------------------------
set -euo pipefail

usage() {
    echo "Usage: $0 -g <resource-group> -n <apim-name> -e <dab-endpoint>"
    echo ""
    echo "  -g  Azure resource group containing the APIM instance"
    echo "  -n  APIM instance name"
    echo "  -e  DAB endpoint URL (e.g., https://dab.internal.contoso.com)"
    exit 1
}

RESOURCE_GROUP=""
APIM_NAME=""
DAB_ENDPOINT=""

while getopts "g:n:e:" opt; do
    case $opt in
        g) RESOURCE_GROUP="$OPTARG" ;;
        n) APIM_NAME="$OPTARG" ;;
        e) DAB_ENDPOINT="$OPTARG" ;;
        *) usage ;;
    esac
done

[[ -z "$RESOURCE_GROUP" || -z "$APIM_NAME" || -z "$DAB_ENDPOINT" ]] && usage

SPEC_URL="${DAB_ENDPOINT}/swagger/v1/swagger.json"
API_ID="data-api-builder"
POLICY_FILE="$(dirname "$0")/../../deploy/bicep/DMLZ/modules/APIM/policies/dab-policy.xml"

echo "==> Downloading DAB OpenAPI spec from ${SPEC_URL}..."
TEMP_SPEC=$(mktemp /tmp/dab-spec-XXXXXX.json)
curl -sSf "${SPEC_URL}" -o "${TEMP_SPEC}"
echo "    Saved to ${TEMP_SPEC}"

echo "==> Importing API into APIM: ${APIM_NAME}..."
az apim api import \
    --resource-group "${RESOURCE_GROUP}" \
    --service-name "${APIM_NAME}" \
    --api-id "${API_ID}" \
    --path "dab" \
    --display-name "Data API Builder" \
    --specification-format OpenApi \
    --specification-path "${TEMP_SPEC}" \
    --protocols https \
    --service-url "${DAB_ENDPOINT}" \
    --subscription-required true

echo "==> Applying DAB policy..."
if [[ -f "${POLICY_FILE}" ]]; then
    az apim api policy create \
        --resource-group "${RESOURCE_GROUP}" \
        --service-name "${APIM_NAME}" \
        --api-id "${API_ID}" \
        --xml-file "${POLICY_FILE}"
    echo "    Policy applied from ${POLICY_FILE}"
else
    echo "    WARNING: Policy file not found at ${POLICY_FILE}. Skipping."
fi

echo "==> Creating subscription for DAB API..."
az apim subscription create \
    --resource-group "${RESOURCE_GROUP}" \
    --service-name "${APIM_NAME}" \
    --subscription-id "dab-integration-sub" \
    --display-name "DAB Integration Subscription" \
    --scope "/apis/${API_ID}" \
    --state active

echo ""
echo "==> Done. DAB API imported into APIM."
echo "    Gateway URL: https://${APIM_NAME}.azure-api.us/dab"

# Cleanup
rm -f "${TEMP_SPEC}"
