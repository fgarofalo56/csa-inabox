# Kubernetes Portal Deployment

> **Last Updated:** 2026-04-14 | **Status:** Active | **Audience:** Frontend Developers

## Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Helm Chart](#helm-chart)
- [Helm Values](#helm-values)
- [Docker Images](#docker-images)
- [GitOps with ArgoCD](#gitops-with-argocd)
- [Azure Government](#azure-government)
- [Scaling Characteristics](#scaling-characteristics)
- [Related Documentation](#related-documentation)

A production-grade, highly scalable deployment of the data onboarding portal
on Azure Kubernetes Service (AKS). This option provides maximum control over
infrastructure, auto-scaling, and multi-region deployment.

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                    AKS Cluster                               │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Ingress Controller (NGINX)                 │  │
│  │              + TLS Termination (cert-manager)           │  │
│  └───────────┬──────────────────────────┬─────────────────┘  │
│              │                          │                     │
│  ┌───────────┴──────────┐  ┌───────────┴──────────────┐     │
│  │   Frontend (React)   │  │   Backend API (FastAPI)   │     │
│  │   Deployment: 2-10   │  │   Deployment: 2-10        │     │
│  │   HPA: CPU 70%       │  │   HPA: CPU 70%            │     │
│  │   Port: 3000         │  │   Port: 8000               │     │
│  └──────────────────────┘  └───────────┬──────────────┘     │
│                                         │                     │
│                            ┌───────────┴──────────────┐     │
│                            │   Redis (Session Cache)   │     │
│                            │   StatefulSet: 3          │     │
│                            └──────────────────────────┘     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │   Monitoring: Prometheus + Grafana                      │  │
│  │   Logging: Fluentd → Azure Monitor / Log Analytics      │  │
│  │   Secrets: Azure Key Vault CSI Driver                   │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Prerequisites: helm, kubectl, az cli

# Login to Azure
az login
az aks get-credentials --resource-group rg-csa-aks --name csa-aks-cluster

# Install from Helm chart
helm install csa-portal ./helm/csa-portal \
  --namespace csa-portal \
  --create-namespace \
  --values helm/csa-portal/values.yaml \
  --set global.azureAdTenantId=<TENANT_ID> \
  --set global.azureAdClientId=<CLIENT_ID> \
  --set api.apiUrl=http://csa-api:8000/api/v1
```

## Helm Chart

```text
portal/kubernetes/
├── README.md
├── helm/
│   └── csa-portal/
│       ├── Chart.yaml
│       ├── values.yaml
│       ├── templates/
│       │   ├── _helpers.tpl
│       │   ├── namespace.yaml
│       │   ├── frontend-deployment.yaml
│       │   ├── frontend-service.yaml
│       │   ├── frontend-hpa.yaml
│       │   ├── backend-deployment.yaml
│       │   ├── backend-service.yaml
│       │   ├── backend-hpa.yaml
│       │   ├── ingress.yaml
│       │   ├── configmap.yaml
│       │   ├── secret.yaml
│       │   └── servicemonitor.yaml
│       └── charts/
│           └── redis/              # Redis subchart
├── docker/
│   ├── Dockerfile.frontend         # React build
│   ├── Dockerfile.backend          # FastAPI build
│   └── .dockerignore
├── argocd/
│   ├── application.yaml            # ArgoCD Application
│   └── project.yaml                # ArgoCD Project
├── manifests/                       # Raw K8s manifests (alternative to Helm)
│   ├── namespace.yaml
│   ├── frontend.yaml
│   ├── backend.yaml
│   ├── ingress.yaml
│   └── hpa.yaml
└── scripts/
    ├── setup-aks.sh                # AKS cluster provisioning
    ├── install-prereqs.sh          # Install cert-manager, nginx, etc.
    └── deploy.sh                   # Deployment script
```

## Helm Values

```yaml
# helm/csa-portal/values.yaml

global:
  environment: production
  azureAdTenantId: ""
  azureAdClientId: ""
  domain: portal.csa-inabox.example.com

frontend:
  image:
    repository: csaregistry.azurecr.io/csa-portal-frontend
    tag: latest
    pullPolicy: Always
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilization: 70
  service:
    port: 3000

backend:
  image:
    repository: csaregistry.azurecr.io/csa-portal-backend
    tag: latest
    pullPolicy: Always
  replicas: 2
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: "1"
      memory: 512Mi
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilization: 70
  service:
    port: 8000
  env:
    - name: AZURE_CLIENT_ID
      valueFrom:
        secretKeyRef:
          name: csa-portal-secrets
          key: azure-client-id
    - name: AZURE_TENANT_ID
      valueFrom:
        secretKeyRef:
          name: csa-portal-secrets
          key: azure-tenant-id

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
  hosts:
    - host: portal.csa-inabox.example.com
      paths:
        - path: /
          pathType: Prefix
          service: frontend
        - path: /api
          pathType: Prefix
          service: backend
  tls:
    - secretName: portal-tls
      hosts:
        - portal.csa-inabox.example.com

redis:
  enabled: true
  architecture: standalone
  auth:
    enabled: true
    existingSecret: csa-portal-secrets
    existingSecretPasswordKey: redis-password

monitoring:
  serviceMonitor:
    enabled: true
    interval: 30s
  grafanaDashboard:
    enabled: true
```

## Docker Images

### Frontend

```dockerfile
# docker/Dockerfile.frontend
FROM node:18-alpine AS builder
WORKDIR /app
COPY portal/react-webapp/package*.json ./
RUN npm ci
COPY portal/react-webapp/ .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/.next/static /usr/share/nginx/html/_next/static
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
```

### Backend

```dockerfile
# docker/Dockerfile.backend
FROM python:3.12-slim
WORKDIR /app
COPY portal/shared/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY portal/shared/ .
EXPOSE 8000
CMD ["uvicorn", "api.app:app", "--host", "0.0.0.0", "--port", "8000"]
```

## GitOps with ArgoCD

```yaml
# argocd/application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: csa-portal
  namespace: argocd
spec:
  project: csa-inabox
  source:
    repoURL: https://github.com/your-org/csa-inabox.git
    targetRevision: main
    path: portal/kubernetes/helm/csa-portal
    helm:
      valueFiles:
        - values.yaml
        - values.prod.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: csa-portal
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

## Azure Government

AKS is fully available in Azure Government:

```bash
# Set cloud to Gov
az cloud set --name AzureUSGovernment

# Create AKS cluster in Gov
az aks create \
  --resource-group rg-csa-aks \
  --name csa-aks-cluster \
  --location usgovvirginia \
  --node-count 3 \
  --enable-managed-identity \
  --enable-azure-rbac \
  --enable-fips-image \
  --network-plugin azure \
  --network-policy calico
```

FIPS 140-2 compliant nodes are enabled by default in the Gov deployment.

## Scaling Characteristics

| Metric | Value |
|---|---|
| Min pods (frontend) | 2 |
| Max pods (frontend) | 10 |
| Min pods (backend) | 2 |
| Max pods (backend) | 10 |
| Scale trigger | CPU > 70% |
| Node autoscaler | 3-20 nodes |
| Cold start | ~5s (container pull) |
| Warm request latency | <100ms |

This is the most scalable portal option, suitable for enterprise and
multi-region deployments.

---

## Related Documentation

- [Portal Implementations](../README.md) - Portal implementation index
- [Shared Backend](../shared/README.md) - Shared backend API
- [Architecture](../../docs/ARCHITECTURE.md) - Overall system architecture
