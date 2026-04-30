# CI/CD Pipeline Migration: Jenkins, GitLab CI, and Tekton to AKS-Native Pipelines

**Status:** Authored 2026-04-30
**Audience:** DevOps engineers migrating CI/CD pipelines from on-premises tooling to AKS-integrated pipelines.
**Scope:** Jenkins, GitLab CI, and Tekton migration to GitHub Actions and Azure DevOps, GitOps with Flux and ArgoCD, ACR Build Tasks, and deployment strategies.

---

## 1. CI/CD landscape mapping

| Source tool                      | Recommended AKS equivalent                      | Alternative                     | Migration effort          |
| -------------------------------- | ----------------------------------------------- | ------------------------------- | ------------------------- |
| **Jenkins** (on-prem)            | GitHub Actions or Azure DevOps Pipelines        | Jenkins on AKS (lift-and-shift) | M--L                      |
| **GitLab CI** (on-prem or SaaS)  | GitHub Actions or Azure DevOps Pipelines        | GitLab Runner on AKS            | M                         |
| **Tekton** (on OCP or K8s)       | Tekton on AKS (unchanged)                       | GitHub Actions / Azure DevOps   | XS (if staying on Tekton) |
| **OCP Pipelines** (Tekton-based) | Tekton on AKS or GitHub Actions                 | Azure DevOps                    | S--M                      |
| **ArgoCD** (GitOps)              | ArgoCD on AKS (unchanged) or AKS Flux extension | --                              | XS                        |
| **Flux v2** (GitOps)             | AKS Flux extension (managed)                    | Self-managed Flux on AKS        | XS                        |
| **Source-to-Image (S2I)**        | Dockerfile + ACR Build Tasks                    | GitHub Actions Docker build     | M                         |
| **OCP BuildConfig**              | ACR Build Tasks or GitHub Actions               | Azure DevOps build pipeline     | M                         |
| **Docker-in-Docker builds**      | ACR Build Tasks (no Docker daemon)              | Kaniko on AKS                   | S                         |
| **Spinnaker**                    | Flux / ArgoCD + GitHub Actions                  | Azure DevOps + deployment slots | M                         |

---

## 2. Image build migration

### From Source-to-Image (S2I) to Dockerfile + ACR Tasks

OpenShift S2I builds images from source code using builder images. The AKS equivalent is Dockerfile + ACR Build Tasks.

```bash
# OpenShift S2I build (before)
oc new-build python:3.11~https://github.com/org/api-server.git \
  --name=api-server

# ACR Build Tasks (after)
# Step 1: Create Dockerfile (if not exists)
cat > Dockerfile << 'EOF'
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8080
CMD ["gunicorn", "-b", "0.0.0.0:8080", "app:app"]
EOF

# Step 2: Build and push with ACR Tasks (no Docker daemon needed)
az acr build \
  --registry csainaboxacr \
  --image team/api-server:{{.Run.ID}} \
  --file Dockerfile \
  .

# Step 3: Set up automatic builds on git push
az acr task create \
  --name build-api-server \
  --registry csainaboxacr \
  --image team/api-server:{{.Run.ID}} \
  --context https://github.com/org/api-server.git \
  --file Dockerfile \
  --git-access-token $GITHUB_PAT \
  --commit-trigger-enabled true \
  --base-image-trigger-enabled true
```

### From Docker-in-Docker to ACR Tasks or Kaniko

Replace Docker-in-Docker (DinD) builds with ACR Tasks (preferred) or Kaniko (for in-cluster builds):

```yaml
# Kaniko build (in-cluster, no Docker daemon)
apiVersion: batch/v1
kind: Job
metadata:
    name: build-api-server
spec:
    template:
        spec:
            containers:
                - name: kaniko
                  image: gcr.io/kaniko-project/executor:latest
                  args:
                      - "--dockerfile=Dockerfile"
                      - "--context=git://github.com/org/api-server.git"
                      - "--destination=csainaboxacr.azurecr.io/team/api-server:latest"
                  volumeMounts:
                      - name: docker-config
                        mountPath: /kaniko/.docker
            volumes:
                - name: docker-config
                  secret:
                      secretName: acr-credentials
            restartPolicy: Never
```

---

## 3. Pipeline migration: Jenkins to GitHub Actions

### Jenkins pipeline (before)

```groovy
// Jenkinsfile
pipeline {
    agent {
        kubernetes {
            yaml '''
            apiVersion: v1
            kind: Pod
            spec:
              containers:
              - name: docker
                image: docker:latest
                command: ['cat']
                tty: true
                volumeMounts:
                - name: docker-sock
                  mountPath: /var/run/docker.sock
              volumes:
              - name: docker-sock
                hostPath:
                  path: /var/run/docker.sock
            '''
        }
    }
    stages {
        stage('Build') {
            steps {
                container('docker') {
                    sh 'docker build -t registry.internal.gov/team/api:${BUILD_NUMBER} .'
                    sh 'docker push registry.internal.gov/team/api:${BUILD_NUMBER}'
                }
            }
        }
        stage('Deploy') {
            steps {
                sh 'kubectl set image deployment/api api=registry.internal.gov/team/api:${BUILD_NUMBER} -n production'
            }
        }
    }
}
```

### GitHub Actions (after)

```yaml
# .github/workflows/deploy.yml
name: Build and Deploy to AKS
on:
    push:
        branches: [main]

permissions:
    id-token: write # Required for OIDC
    contents: read

jobs:
    build-and-deploy:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4

            - name: Azure Login (OIDC)
              uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }}
                  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
                  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

            - name: Build and push to ACR
              uses: azure/docker-login@v2
              with:
                  login-server: csainaboxacr.azurecr.io
            - run: |
                  docker build -t csainaboxacr.azurecr.io/team/api:${{ github.sha }} .
                  docker push csainaboxacr.azurecr.io/team/api:${{ github.sha }}

            - name: Set AKS context
              uses: azure/aks-set-context@v4
              with:
                  resource-group: rg-aks-prod
                  cluster-name: aks-prod-eastus2

            - name: Deploy to AKS
              uses: azure/k8s-deploy@v5
              with:
                  namespace: production
                  manifests: k8s/
                  images: csainaboxacr.azurecr.io/team/api:${{ github.sha }}
                  strategy: canary
                  percentage: 20
```

### Azure DevOps Pipeline (alternative)

```yaml
# azure-pipelines.yml
trigger:
    branches:
        include:
            - main

pool:
    vmImage: ubuntu-latest

variables:
    acrName: csainaboxacr
    imageName: team/api
    aksCluster: aks-prod-eastus2
    aksResourceGroup: rg-aks-prod

stages:
    - stage: Build
      jobs:
          - job: BuildAndPush
            steps:
                - task: Docker@2
                  inputs:
                      containerRegistry: acr-connection
                      repository: $(imageName)
                      command: buildAndPush
                      Dockerfile: Dockerfile
                      tags: $(Build.SourceVersion)

    - stage: Deploy
      dependsOn: Build
      jobs:
          - deployment: DeployToAKS
            environment: production
            strategy:
                runOnce:
                    deploy:
                        steps:
                            - task: KubernetesManifest@1
                              inputs:
                                  action: deploy
                                  connectionType: azureResourceManager
                                  azureSubscriptionConnection: azure-connection
                                  azureResourceGroup: $(aksResourceGroup)
                                  kubernetesCluster: $(aksCluster)
                                  namespace: production
                                  manifests: k8s/
                                  containers: $(acrName).azurecr.io/$(imageName):$(Build.SourceVersion)
```

---

## 4. GitOps migration

### Flux (AKS extension -- recommended)

AKS provides Flux as a managed extension with first-class Azure integration.

```bash
# Install Flux extension on AKS
az k8s-configuration flux create \
  --resource-group rg-aks-prod \
  --cluster-name aks-prod-eastus2 \
  --cluster-type managedClusters \
  --name cluster-config \
  --namespace flux-system \
  --scope cluster \
  --url https://github.com/org/aks-gitops \
  --branch main \
  --kustomization name=infrastructure path=./infrastructure prune=true \
  --kustomization name=applications path=./applications prune=true dependsOn=infrastructure
```

Flux repository structure:

```
aks-gitops/
  infrastructure/
    namespaces.yaml
    network-policies.yaml
    ingress-nginx/
      kustomization.yaml
      release.yaml
    cert-manager/
      kustomization.yaml
      release.yaml
  applications/
    production/
      api-server/
        kustomization.yaml
        deployment.yaml
        service.yaml
        ingress.yaml
      worker/
        kustomization.yaml
        deployment.yaml
```

### ArgoCD (self-managed on AKS)

ArgoCD runs on AKS identically to on-prem. No migration required for the ArgoCD deployment itself.

```bash
# Install ArgoCD on AKS
helm repo add argo https://argoproj.github.io/argo-helm
helm install argocd argo/argo-cd \
  --namespace argocd --create-namespace \
  --set server.ingress.enabled=true \
  --set server.ingress.ingressClassName=nginx \
  --set server.ingress.hosts[0]=argocd.app.gov \
  --set server.ingress.tls[0].secretName=argocd-tls \
  --set server.ingress.tls[0].hosts[0]=argocd.app.gov
```

Migrate ArgoCD Application resources:

```yaml
# Update ArgoCD Application to target AKS
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
    name: api-server
    namespace: argocd
spec:
    project: default
    source:
        repoURL: https://github.com/org/app-manifests
        targetRevision: main
        path: apps/api-server/overlays/aks # AKS-specific overlay
    destination:
        server: https://kubernetes.default.svc # In-cluster AKS
        namespace: production
    syncPolicy:
        automated:
            prune: true
            selfHeal: true
        syncOptions:
            - CreateNamespace=true
```

---

## 5. Deployment strategies on AKS

### Canary deployment with Flux Flagger

```yaml
# Flagger Canary resource
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
    name: api-server
    namespace: production
spec:
    targetRef:
        apiVersion: apps/v1
        kind: Deployment
        name: api-server
    service:
        port: 8080
        targetPort: 8080
    analysis:
        interval: 1m
        threshold: 5
        maxWeight: 50
        stepWeight: 10
        metrics:
            - name: request-success-rate
              thresholdRange:
                  min: 99
              interval: 1m
            - name: request-duration
              thresholdRange:
                  max: 500
              interval: 1m
```

### Blue-green deployment with ArgoCD

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
    name: api-server
    namespace: production
spec:
    replicas: 5
    strategy:
        blueGreen:
            activeService: api-server-active
            previewService: api-server-preview
            autoPromotionEnabled: false
            prePromotionAnalysis:
                templates:
                    - templateName: smoke-tests
                args:
                    - name: service-name
                      value: api-server-preview
    selector:
        matchLabels:
            app: api-server
    template:
        metadata:
            labels:
                app: api-server
        spec:
            containers:
                - name: api
                  image: csainaboxacr.azurecr.io/team/api:v2.3.1
```

### Rolling update (default)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
    name: api-server
spec:
    strategy:
        type: RollingUpdate
        rollingUpdate:
            maxUnavailable: 1
            maxSurge: 1
    minReadySeconds: 30
```

---

## 6. ACR integration patterns

### Multi-stage builds with ACR Tasks

```yaml
# acr-task.yaml
version: v1.1.0
steps:
    - build: -t csainaboxacr.azurecr.io/team/api:{{.Run.ID}} -t csainaboxacr.azurecr.io/team/api:latest .
    - push:
          - csainaboxacr.azurecr.io/team/api:{{.Run.ID}}
          - csainaboxacr.azurecr.io/team/api:latest
    - cmd: csainaboxacr.azurecr.io/team/api:{{.Run.ID}} python -m pytest tests/
```

### Base image auto-update

```bash
# Trigger rebuild when base image updates
az acr task create \
  --name rebuild-on-base-update \
  --registry csainaboxacr \
  --image team/api:{{.Run.ID}} \
  --context https://github.com/org/api-server.git \
  --file Dockerfile \
  --base-image-trigger-enabled true \
  --base-image-trigger-type All \
  --git-access-token $GITHUB_PAT
```

### Geo-replication for multi-region

```bash
# Replicate ACR across regions (for multi-region AKS)
az acr replication create \
  --registry csainaboxacr \
  --location westus2

az acr replication create \
  --registry csainaboxacr \
  --location usgovvirginia  # Azure Government
```

---

## 7. Secret management in CI/CD

### GitHub Actions with OIDC (recommended)

No stored credentials. GitHub Actions uses OIDC federation with Entra ID:

```bash
# Create Entra ID app registration for GitHub Actions
az ad app create --display-name "github-actions-aks"

# Create federated credential
az ad app federated-credential create \
  --id $APP_ID \
  --parameters '{
    "name": "github-main",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:org/repo:ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

### Azure DevOps with service connections

```bash
# Create service connection in Azure DevOps
# Uses Entra ID workload identity federation (no secrets)
az devops service-endpoint create \
  --name azure-aks-connection \
  --type azurerm \
  --authorization-scheme WorkloadIdentityFederation
```

---

## 8. CI/CD migration checklist

- [ ] Container images pushed to ACR (not on-prem registry)
- [ ] Build pipelines using ACR Tasks, GitHub Actions, or Azure DevOps (not Jenkins DinD)
- [ ] OIDC authentication configured (no stored credentials)
- [ ] GitOps configured (Flux or ArgoCD)
- [ ] Deployment strategy chosen (rolling, canary, blue-green)
- [ ] Base image auto-update configured (ACR Tasks)
- [ ] Image scanning in pipeline (Defender for Containers or Trivy)
- [ ] Integration tests running against AKS staging cluster
- [ ] Rollback procedure tested
- [ ] Pipeline secrets stored in Key Vault or GitHub Secrets (not in code)
- [ ] Branch protection and approval gates configured
- [ ] Pipeline monitoring and alerting configured

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
**Related:** [Workload Migration](workload-migration.md) | [Security Migration](security-migration.md) | [Best Practices](best-practices.md)
