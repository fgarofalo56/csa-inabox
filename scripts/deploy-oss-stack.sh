#!/usr/bin/env bash
# Deploy the CSA-in-a-Box OSS data platform stack to AKS
# Part of CSA-in-a-Box: Cloud-Scale Analytics Platform
#
# Deploys open-source alternatives (Atlas, Trino, Superset, Airflow, OpenSearch)
# on AKS for Azure Government regions where PaaS services have limited features.
#
# Usage:
#   ./deploy-oss-stack.sh -g <resource-group> -l <location> [-n <prefix>] [--services <list>]
#
# Examples:
#   ./deploy-oss-stack.sh -g rg-csa-oss -l usgovvirginia -n csaoss
#   ./deploy-oss-stack.sh -g rg-csa-oss -l usgovvirginia --services atlas,trino,superset
#
# Prerequisites:
#   - Azure CLI (az) logged in
#   - Helm 3.x installed
#   - kubectl configured

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────
PREFIX="csaoss"
LOCATION="usgovvirginia"
RESOURCE_GROUP=""
SERVICES="all"
AKS_NODE_COUNT=3
AKS_NODE_SIZE="Standard_D4s_v5"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELM_DIR="$PROJECT_ROOT/csa_platform/oss_alternatives/helm"
NAMESPACE="csa-oss"
TOTAL_STEPS=6

ALL_SERVICES=("atlas" "trino" "superset" "airflow" "opensearch")

# ─── Parse Arguments ─────────────────────────────────────────────
usage() {
    echo "Usage: $0 -g <resource-group> -l <location> [-n <prefix>] [--services <list>]"
    echo ""
    echo "Options:"
    echo "  -g  Resource group name (required)"
    echo "  -l  Azure region (default: usgovvirginia)"
    echo "  -n  Naming prefix (default: csaoss)"
    echo "  --services  Comma-separated list of services to deploy (default: all)"
    echo "              Available: atlas,trino,superset,airflow,opensearch"
    echo "  -h  Show this help"
    echo ""
    echo "Examples:"
    echo "  $0 -g rg-csa-oss -l usgovvirginia -n csaoss"
    echo "  $0 -g rg-csa-oss -l usgovvirginia --services atlas,trino"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -g) RESOURCE_GROUP="$2"; shift 2 ;;
        -l) LOCATION="$2"; shift 2 ;;
        -n) PREFIX="$2"; shift 2 ;;
        --services) SERVICES="$2"; shift 2 ;;
        -h) usage ;;
        *) echo "ERROR: Unknown option $1"; usage ;;
    esac
done

if [[ -z "$RESOURCE_GROUP" ]]; then
    echo "ERROR: Resource group (-g) is required"
    usage
fi

# Parse services list
if [[ "$SERVICES" == "all" ]]; then
    DEPLOY_SERVICES=("${ALL_SERVICES[@]}")
else
    IFS=',' read -ra DEPLOY_SERVICES <<< "$SERVICES"
    for svc in "${DEPLOY_SERVICES[@]}"; do
        VALID=false
        for valid_svc in "${ALL_SERVICES[@]}"; do
            if [[ "$svc" == "$valid_svc" ]]; then VALID=true; break; fi
        done
        if [[ "$VALID" != "true" ]]; then
            echo "ERROR: Unknown service '$svc'. Available: ${ALL_SERVICES[*]}"
            exit 1
        fi
    done
fi

AKS_NAME="${PREFIX}-aks"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  CSA-in-a-Box: OSS Stack Deployment                        ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Resource Group: $RESOURCE_GROUP"
echo "║  Location:       $LOCATION"
echo "║  Prefix:         $PREFIX"
echo "║  AKS Cluster:    $AKS_NAME"
echo "║  Services:       ${DEPLOY_SERVICES[*]}"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Helper ──────────────────────────────────────────────────────
should_deploy() {
    local svc="$1"
    for s in "${DEPLOY_SERVICES[@]}"; do
        if [[ "$s" == "$svc" ]]; then return 0; fi
    done
    return 1
}

# ─── Step 1: Create AKS Cluster ─────────────────────────────────
echo ">>> Step 1/$TOTAL_STEPS: Creating AKS cluster (if not exists)..."
az group create \
    --name "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --tags "project=csa-inabox" "component=oss-stack" \
    --output none 2>/dev/null || true

if ! az aks show --resource-group "$RESOURCE_GROUP" --name "$AKS_NAME" &>/dev/null; then
    az aks create \
        --resource-group "$RESOURCE_GROUP" \
        --name "$AKS_NAME" \
        --node-count "$AKS_NODE_COUNT" \
        --node-vm-size "$AKS_NODE_SIZE" \
        --enable-managed-identity \
        --enable-addons monitoring \
        --network-plugin azure \
        --generate-ssh-keys \
        --output none
    echo "    ✓ AKS cluster created"
else
    echo "    ✓ AKS cluster already exists"
fi

az aks get-credentials \
    --resource-group "$RESOURCE_GROUP" \
    --name "$AKS_NAME" \
    --overwrite-existing \
    --output none
echo "    ✓ kubectl configured"

# ─── Step 2: Install Ingress Controller ──────────────────────────
echo ">>> Step 2/$TOTAL_STEPS: Installing ingress-nginx..."
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx 2>/dev/null || true
helm repo update >/dev/null 2>&1

if ! helm status ingress-nginx -n ingress-nginx &>/dev/null; then
    helm install ingress-nginx ingress-nginx/ingress-nginx \
        --namespace ingress-nginx \
        --create-namespace \
        --set controller.replicaCount=2 \
        --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-load-balancer-health-probe-request-path"=/healthz
    echo "    ✓ ingress-nginx installed"
else
    echo "    ✓ ingress-nginx already installed"
fi

# ─── Step 3: Install cert-manager ────────────────────────────────
echo ">>> Step 3/$TOTAL_STEPS: Installing cert-manager..."
helm repo add jetstack https://charts.jetstack.io 2>/dev/null || true

if ! helm status cert-manager -n cert-manager &>/dev/null; then
    helm install cert-manager jetstack/cert-manager \
        --namespace cert-manager \
        --create-namespace \
        --set installCRDs=true
    echo "    ✓ cert-manager installed"
else
    echo "    ✓ cert-manager already installed"
fi

# ─── Step 4: Create namespace ────────────────────────────────────
echo ">>> Step 4/$TOTAL_STEPS: Creating namespace..."
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
echo "    ✓ Namespace $NAMESPACE ready"

# ─── Step 5: Deploy OSS services ────────────────────────────────
echo ">>> Step 5/$TOTAL_STEPS: Deploying services..."

if should_deploy "atlas"; then
    echo "    Deploying Apache Atlas..."
    helm upgrade --install atlas "$HELM_DIR/atlas" \
        --namespace "$NAMESPACE" \
        --wait --timeout 10m
    echo "    ✓ Atlas deployed"
fi

if should_deploy "trino"; then
    echo "    Deploying Trino..."
    helm upgrade --install trino "$HELM_DIR/trino" \
        --namespace "$NAMESPACE" \
        --wait --timeout 10m
    echo "    ✓ Trino deployed"
fi

if should_deploy "superset"; then
    echo "    Deploying Apache Superset..."
    helm upgrade --install superset "$HELM_DIR/superset" \
        --namespace "$NAMESPACE" \
        --wait --timeout 10m
    echo "    ✓ Superset deployed"
fi

if should_deploy "airflow"; then
    echo "    Deploying Apache Airflow..."
    helm upgrade --install airflow "$HELM_DIR/airflow" \
        --namespace "$NAMESPACE" \
        --wait --timeout 10m
    echo "    ✓ Airflow deployed"
fi

if should_deploy "opensearch"; then
    echo "    Deploying OpenSearch..."
    helm upgrade --install opensearch "$HELM_DIR/opensearch" \
        --namespace "$NAMESPACE" \
        --wait --timeout 10m
    echo "    ✓ OpenSearch deployed"
fi

# ─── Step 6: Wait and output URLs ───────────────────────────────
echo ">>> Step 6/$TOTAL_STEPS: Waiting for pods and collecting service URLs..."
kubectl wait --for=condition=ready pod \
    --all -n "$NAMESPACE" \
    --timeout=300s 2>/dev/null || echo "    (Some pods may still be starting)"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Deployment Complete — Service URLs                         ║"
echo "╠══════════════════════════════════════════════════════════════╣"

if should_deploy "atlas"; then
    ATLAS_IP=$(kubectl get svc -n "$NAMESPACE" -l app.kubernetes.io/component=atlas -o jsonpath='{.items[0].spec.clusterIP}' 2>/dev/null || echo "pending")
    echo "║  Atlas:       http://$ATLAS_IP:21000"
fi

if should_deploy "trino"; then
    TRINO_IP=$(kubectl get svc -n "$NAMESPACE" -l app.kubernetes.io/component=trino-coordinator -o jsonpath='{.items[0].spec.clusterIP}' 2>/dev/null || echo "pending")
    echo "║  Trino:       http://$TRINO_IP:8080"
fi

if should_deploy "superset"; then
    SUPERSET_IP=$(kubectl get svc -n "$NAMESPACE" -l app.kubernetes.io/component=superset -o jsonpath='{.items[0].spec.clusterIP}' 2>/dev/null || echo "pending")
    echo "║  Superset:    http://$SUPERSET_IP:8088"
fi

if should_deploy "airflow"; then
    AIRFLOW_IP=$(kubectl get svc -n "$NAMESPACE" -l app.kubernetes.io/component=airflow -o jsonpath='{.items[0].spec.clusterIP}' 2>/dev/null || echo "pending")
    echo "║  Airflow:     http://$AIRFLOW_IP:8080"
fi

if should_deploy "opensearch"; then
    OS_IP=$(kubectl get svc -n "$NAMESPACE" -l app.kubernetes.io/component=opensearch -o jsonpath='{.items[0].spec.clusterIP}' 2>/dev/null || echo "pending")
    OSD_IP=$(kubectl get svc -n "$NAMESPACE" -l app.kubernetes.io/component=opensearch-dashboards -o jsonpath='{.items[0].spec.clusterIP}' 2>/dev/null || echo "pending")
    echo "║  OpenSearch:  https://$OS_IP:9200"
    echo "║  Dashboards:  http://$OSD_IP:5601"
fi

echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Use 'kubectl port-forward' for local access:              ║"
echo "║  kubectl port-forward svc/<name> <port> -n $NAMESPACE      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Done! All requested services deployed to namespace '$NAMESPACE'."
