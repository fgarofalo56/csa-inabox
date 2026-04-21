#!/usr/bin/env bash
# Deploy a managed online endpoint + deployment for the loan-default model.
#
# The endpoint itself is created by deploy/bicep/main.bicep.  This script
# creates the deployment (blue) using the registered model from
# ``register_model.sh`` and the conda environment in training/conda.yaml.
#
# Usage:
#   ./deploy_endpoint.sh <resource-group> <workspace-name> <endpoint-name> [<deployment-name>] [<model-name>]
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <resource-group> <workspace-name> <endpoint-name> [<deployment-name>] [<model-name>]" >&2
  exit 64
fi

RG="$1"
WS="$2"
ENDPOINT_NAME="$3"
DEPLOYMENT_NAME="${4:-blue}"
MODEL_NAME="${5:-loan-default}"
TRAINING_DIR="$(cd "$(dirname "$0")/../training" && pwd)"

# Resolve latest model version.
MODEL_VERSION="$(
  az ml model list \
    --resource-group "${RG}" \
    --workspace-name "${WS}" \
    --name "${MODEL_NAME}" \
    --query '[0].version' \
    --output tsv
)"
if [[ -z "${MODEL_VERSION}" ]]; then
  echo "ERROR: no versions found for model ${MODEL_NAME}. Run register_model.sh first." >&2
  exit 66
fi

echo "Deploying ${MODEL_NAME}:${MODEL_VERSION} → ${ENDPOINT_NAME}/${DEPLOYMENT_NAME}..."

tmp=$(mktemp /tmp/deployment.XXXXXX.yaml)
trap 'rm -f "${tmp}"' EXIT

cat >"${tmp}" <<YAML
\$schema: https://azuremlschemas.azureedge.net/latest/managedOnlineDeployment.schema.json
name: ${DEPLOYMENT_NAME}
endpoint_name: ${ENDPOINT_NAME}
model: azureml:${MODEL_NAME}:${MODEL_VERSION}
code_configuration:
  code: ${TRAINING_DIR}
  scoring_script: score.py
environment:
  conda_file: ${TRAINING_DIR}/conda.yaml
  image: mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu22.04:latest
instance_type: Standard_DS3_v2
instance_count: 1
request_settings:
  max_concurrent_requests_per_instance: 4
  request_timeout_ms: 5000
YAML

az ml online-deployment create \
  --resource-group "${RG}" \
  --workspace-name "${WS}" \
  --file "${tmp}"

az ml online-endpoint update \
  --resource-group "${RG}" \
  --workspace-name "${WS}" \
  --name "${ENDPOINT_NAME}" \
  --traffic "${DEPLOYMENT_NAME}=100"

echo "Deployment complete. Invoke with:"
echo "  az ml online-endpoint invoke --name ${ENDPOINT_NAME} --request-file sample.json"
