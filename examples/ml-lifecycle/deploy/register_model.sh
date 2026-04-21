#!/usr/bin/env bash
# Register the locally-trained loan-default model with Azure ML.
#
# Prerequisites:
#   * az login
#   * az ml extension (v2) installed: az extension add -n ml
#   * Azure ML workspace deployed via deploy/bicep/main.bicep
#   * A local run of training/train.py producing outputs/model.pkl
#
# Usage:
#   ./register_model.sh <resource-group> <workspace-name> [<model-name>]
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <resource-group> <workspace-name> [<model-name>]" >&2
  exit 64
fi

RG="$1"
WS="$2"
MODEL_NAME="${3:-loan-default}"
OUTPUTS_DIR="$(cd "$(dirname "$0")/../training/outputs" && pwd)"

if [[ ! -f "${OUTPUTS_DIR}/model.pkl" ]]; then
  echo "ERROR: ${OUTPUTS_DIR}/model.pkl not found — run training/train.py first." >&2
  exit 66
fi

echo "Registering ${MODEL_NAME} from ${OUTPUTS_DIR} to ${WS}/${RG}..."

az ml model create \
  --resource-group "${RG}" \
  --workspace-name "${WS}" \
  --name "${MODEL_NAME}" \
  --path "${OUTPUTS_DIR}" \
  --type "custom_model" \
  --description "CSA-0115 loan-default logistic regression"

echo "Registered. List with:"
echo "  az ml model list --resource-group ${RG} --workspace-name ${WS} --name ${MODEL_NAME}"
