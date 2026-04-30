# Tutorial: Migrate a Stateful Application to AKS

**Status:** Authored 2026-04-30
**Audience:** Application developers and platform engineers migrating a stateful application (PostgreSQL + API tier) from on-premises Kubernetes to AKS.
**Duration:** 6--8 hours for full end-to-end migration with validation.
**Prerequisites:** Source K8s cluster accessible, AKS cluster deployed with node pools and Ingress (see [Cluster Migration](cluster-migration.md)), ACR configured, cert-manager installed.

---

## Overview

This tutorial migrates a representative three-tier application from on-premises Kubernetes to AKS:

- **PostgreSQL StatefulSet** (3 replicas with persistent storage)
- **API server Deployment** (Python/FastAPI with 3 replicas)
- **Worker Deployment** (background job processor)

The migration covers container image migration, storage class conversion, Ingress setup, TLS configuration, secrets management, monitoring, and validation.

```mermaid
flowchart TB
    subgraph Source["Source Cluster (On-Prem)"]
        S_API[API Server<br>3 replicas]
        S_WORKER[Worker<br>2 replicas]
        S_PG[PostgreSQL<br>StatefulSet 3 replicas]
        S_ROUTE[OpenShift Route<br>api.app.internal]
        S_SECRET[K8s Secrets]
        S_PV[Ceph PVs<br>3x100GB]
    end

    subgraph Target["AKS Cluster"]
        T_API[API Server<br>3 replicas]
        T_WORKER[Worker<br>2 replicas]
        T_PG[PostgreSQL<br>StatefulSet 3 replicas]
        T_ING[NGINX Ingress<br>api.app.gov]
        T_KV[Key Vault Secrets]
        T_DISK[Azure Premium SSD<br>3x100GB]
        T_MON[Container Insights]
    end

    Source -->|Migration| Target
```

---

## Step 1: Assess the source application

### Inventory application resources

```bash
# Switch to source cluster
kubectl config use-context source-cluster

# List all resources in the application namespace
kubectl get all,configmap,secret,ingress,pvc,networkpolicy -n app-prod

# Export all resources for analysis
kubectl get all,configmap,secret,pvc -n app-prod -o yaml > app-prod-export.yaml
```

### Document the application architecture

Capture the following from the source cluster:

```bash
# Container images
kubectl get pods -n app-prod -o jsonpath='{range .items[*]}{.spec.containers[*].image}{"\n"}{end}' | sort -u

# Storage classes and PVC sizes
kubectl get pvc -n app-prod -o custom-columns=NAME:.metadata.name,SIZE:.spec.resources.requests.storage,CLASS:.spec.storageClassName,STATUS:.status.phase

# Services and ports
kubectl get svc -n app-prod -o custom-columns=NAME:.metadata.name,TYPE:.spec.type,PORTS:.spec.ports[*].port,SELECTOR:.spec.selector

# Environment variables and secrets
kubectl get deployment api-server -n app-prod -o jsonpath='{.spec.template.spec.containers[0].env[*].name}' | tr ' ' '\n'

# Resource requests and limits
kubectl get deployment -n app-prod -o custom-columns=NAME:.metadata.name,CPU_REQ:.spec.template.spec.containers[0].resources.requests.cpu,MEM_REQ:.spec.template.spec.containers[0].resources.requests.memory
```

---

## Step 2: Push container images to ACR

```bash
# Login to ACR
az acr login --name csainaboxacr

# Pull images from source registry and push to ACR
SOURCE_REGISTRY="registry.internal.gov"
TARGET_REGISTRY="csainaboxacr.azurecr.io"

# API server
az acr import \
  --name csainaboxacr \
  --source $SOURCE_REGISTRY/team/api-server:v2.3.1 \
  --image team/api-server:v2.3.1 \
  --username "$REG_USER" --password "$REG_PASS"

# Worker
az acr import \
  --name csainaboxacr \
  --source $SOURCE_REGISTRY/team/worker:v2.3.1 \
  --image team/worker:v2.3.1 \
  --username "$REG_USER" --password "$REG_PASS"

# PostgreSQL (use official image from MCR or Docker Hub)
az acr import \
  --name csainaboxacr \
  --source docker.io/library/postgres:15.7 \
  --image postgres:15.7

# Verify images in ACR
az acr repository list --name csainaboxacr -o table
```

---

## Step 3: Migrate secrets to Azure Key Vault

```bash
# Create Key Vault (if not exists)
az keyvault create \
  --name kv-app-prod \
  --resource-group rg-aks-prod \
  --location eastus2 \
  --enable-rbac-authorization

# Extract secrets from source cluster and store in Key Vault
DB_PASSWORD=$(kubectl get secret postgres-credentials -n app-prod -o jsonpath='{.data.password}' | base64 -d)
API_KEY=$(kubectl get secret api-secrets -n app-prod -o jsonpath='{.data.api-key}' | base64 -d)
DB_CONN_STRING="postgresql://app:${DB_PASSWORD}@postgres.app-prod.svc.cluster.local:5432/appdb?sslmode=require"

az keyvault secret set --vault-name kv-app-prod --name db-password --value "$DB_PASSWORD"
az keyvault secret set --vault-name kv-app-prod --name api-key --value "$API_KEY"
az keyvault secret set --vault-name kv-app-prod --name db-connection-string --value "$DB_CONN_STRING"

# Create managed identity for the application
az identity create \
  --name umi-app-prod \
  --resource-group rg-aks-prod

APP_IDENTITY_CLIENT_ID=$(az identity show -n umi-app-prod -g rg-aks-prod --query clientId -o tsv)
APP_IDENTITY_PRINCIPAL_ID=$(az identity show -n umi-app-prod -g rg-aks-prod --query principalId -o tsv)

# Grant Key Vault access
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee-principal-type ServicePrincipal \
  --assignee-object-id $APP_IDENTITY_PRINCIPAL_ID \
  --scope $(az keyvault show -n kv-app-prod --query id -o tsv)

# Create federated credential for Workload Identity
AKS_OIDC_ISSUER=$(az aks show -g rg-aks-prod -n aks-prod-eastus2 --query oidcIssuerProfile.issuerUrl -o tsv)

az identity federated-credential create \
  --name fc-app-prod \
  --identity-name umi-app-prod \
  --resource-group rg-aks-prod \
  --issuer $AKS_OIDC_ISSUER \
  --subject system:serviceaccount:app-prod:app-sa \
  --audience api://AzureADTokenExchange
```

---

## Step 4: Deploy PostgreSQL StatefulSet on AKS

### Create namespace and service account

```bash
kubectl apply -f - << 'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: app-prod
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/warn: restricted
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-sa
  namespace: app-prod
  annotations:
    azure.workload.identity/client-id: "REPLACE_WITH_APP_IDENTITY_CLIENT_ID"
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: postgres-sa
  namespace: app-prod
  annotations:
    azure.workload.identity/client-id: "REPLACE_WITH_APP_IDENTITY_CLIENT_ID"
EOF
```

### Create SecretProviderClass

```bash
kubectl apply -f - << 'EOF'
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: kv-app-secrets
  namespace: app-prod
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    clientID: "REPLACE_WITH_APP_IDENTITY_CLIENT_ID"
    keyvaultName: kv-app-prod
    tenantId: "REPLACE_WITH_TENANT_ID"
    objects: |
      array:
        - |
          objectName: db-password
          objectType: secret
        - |
          objectName: api-key
          objectType: secret
        - |
          objectName: db-connection-string
          objectType: secret
  secretObjects:
    - secretName: app-secrets
      type: Opaque
      data:
        - objectName: db-password
          key: POSTGRES_PASSWORD
        - objectName: api-key
          key: API_KEY
        - objectName: db-connection-string
          key: DATABASE_URL
EOF
```

### Deploy PostgreSQL StatefulSet

```bash
kubectl apply -f - << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: app-prod
  labels:
    app: postgres
spec:
  clusterIP: None
  selector:
    app: postgres
  ports:
    - port: 5432
      targetPort: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: app-prod
spec:
  serviceName: postgres
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: postgres-sa
      securityContext:
        runAsUser: 999
        runAsGroup: 999
        fsGroup: 999
      containers:
        - name: postgres
          image: csainaboxacr.azurecr.io/postgres:15.7
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_DB
              value: appdb
            - name: POSTGRES_USER
              value: app
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          envFrom:
            - secretRef:
                name: app-secrets
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
            - name: secrets-store
              mountPath: /mnt/secrets
              readOnly: true
          resources:
            requests:
              cpu: "1000m"
              memory: "2Gi"
            limits:
              cpu: "4000m"
              memory: "8Gi"
          livenessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - app
                - -d
                - appdb
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - app
                - -d
                - appdb
            initialDelaySeconds: 5
            periodSeconds: 5
      volumes:
        - name: secrets-store
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: kv-app-secrets
      nodeSelector:
        agentpool: workload
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: postgres
  volumeClaimTemplates:
    - metadata:
        name: pgdata
      spec:
        storageClassName: managed-csi-premium
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 100Gi
EOF
```

### Migrate data to PostgreSQL on AKS

```bash
# Option A: pg_dump / pg_restore (small databases < 50 GB)
# On source cluster: dump the database
kubectl exec -n app-prod postgres-0 --context=source-cluster -- \
  pg_dump -U app -Fc appdb > /tmp/appdb.dump

# Copy dump to AKS pod
kubectl cp /tmp/appdb.dump app-prod/postgres-0:/tmp/appdb.dump

# Restore on AKS
kubectl exec -n app-prod postgres-0 -- \
  pg_restore -U app -d appdb --clean --if-exists /tmp/appdb.dump

# Option B: Streaming replication (large databases, near-zero downtime)
# Configure source as primary, AKS postgres-0 as standby
# See storage-migration.md for detailed replication setup
```

---

## Step 5: Deploy API server and worker

```bash
kubectl apply -f - << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: app-prod
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: app-sa
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: api
          image: csainaboxacr.azurecr.io/team/api-server:v2.3.1
          ports:
            - containerPort: 8080
          envFrom:
            - secretRef:
                name: app-secrets
          volumeMounts:
            - name: secrets-store
              mountPath: /mnt/secrets
              readOnly: true
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2000m"
              memory: "2Gi"
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 20
      volumes:
        - name: secrets-store
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: kv-app-secrets
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: api-server
---
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: app-prod
spec:
  selector:
    app: api-server
  ports:
    - port: 8080
      targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: app-prod
spec:
  replicas: 2
  selector:
    matchLabels:
      app: worker
  template:
    metadata:
      labels:
        app: worker
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: app-sa
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: worker
          image: csainaboxacr.azurecr.io/team/worker:v2.3.1
          envFrom:
            - secretRef:
                name: app-secrets
          volumeMounts:
            - name: secrets-store
              mountPath: /mnt/secrets
              readOnly: true
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "1000m"
              memory: "1Gi"
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: secrets-store
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: kv-app-secrets
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
  namespace: app-prod
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
EOF
```

---

## Step 6: Configure Ingress with TLS

```bash
# Create ClusterIssuer for Let's Encrypt (if not exists)
kubectl apply -f - << 'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@app.gov
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
EOF

# Create Ingress
kubectl apply -f - << 'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: app-prod
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/rate-limit-window: "1m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.app.gov
      secretName: api-tls
  rules:
    - host: api.app.gov
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
EOF
```

---

## Step 7: Configure monitoring

```bash
# Deploy network policy
kubectl apply -f - << 'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-network-policy
  namespace: app-prod
spec:
  podSelector:
    matchLabels:
      app: postgres
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api-server
        - podSelector:
            matchLabels:
              app: worker
      ports:
        - protocol: TCP
          port: 5432
EOF

# Container Insights is already enabled (cluster-level)
# Verify logs are flowing
kubectl logs deployment/api-server -n app-prod --tail=10

# Create PrometheusRule for custom alerts (if Managed Prometheus is enabled)
kubectl apply -f - << 'EOF'
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: app-alerts
  namespace: app-prod
spec:
  groups:
    - name: app-prod-alerts
      rules:
        - alert: HighErrorRate
          expr: rate(http_requests_total{namespace="app-prod",status=~"5.."}[5m]) / rate(http_requests_total{namespace="app-prod"}[5m]) > 0.05
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "High error rate in app-prod"
            description: "Error rate is {{ $value | humanizePercentage }} over the last 5 minutes"
        - alert: PostgresReplicationLag
          expr: pg_replication_lag{namespace="app-prod"} > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PostgreSQL replication lag > 30s"
EOF
```

---

## Step 8: Validate and cutover

### Comprehensive validation

```bash
# 1. Pod health
kubectl get pods -n app-prod -o wide
# All pods should be Running and Ready

# 2. Database connectivity
kubectl exec -it deployment/api-server -n app-prod -- \
  python -c "import psycopg2; conn = psycopg2.connect(dsn='$DATABASE_URL'); print('DB connected')"

# 3. API health
INGRESS_IP=$(kubectl get ingress api-ingress -n app-prod -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -H "Host: api.app.gov" https://$INGRESS_IP/health --resolve api.app.gov:443:$INGRESS_IP -k

# 4. Data integrity
kubectl exec postgres-0 -n app-prod -- psql -U app -d appdb -c "SELECT count(*) FROM users;"
# Compare with source cluster count

# 5. TLS certificate
echo | openssl s_client -servername api.app.gov -connect $INGRESS_IP:443 2>/dev/null | openssl x509 -noout -subject -dates

# 6. Performance baseline
kubectl run load-test --rm -it \
  --image=csainaboxacr.azurecr.io/tools/hey:latest \
  --namespace app-prod \
  -- hey -n 1000 -c 50 http://api-service:8080/api/v1/status
```

### DNS cutover

```bash
# Update DNS to point to AKS Ingress
az network dns record-set a add-record \
  --resource-group rg-dns \
  --zone-name app.gov \
  --record-set-name api \
  --ipv4-address $INGRESS_IP

# Verify DNS propagation
dig api.app.gov A
```

### Post-cutover monitoring

Monitor the application for 24--48 hours after cutover:

- Container Insights: CPU, memory, restarts, OOMKills
- Application logs: error rates, response times
- PostgreSQL: connection count, query latency, replication lag
- Ingress: request rate, error rate, latency percentiles

---

## Summary

This tutorial demonstrated a complete stateful application migration from on-premises Kubernetes to AKS, including:

1. Container image migration to ACR
2. Secret migration to Azure Key Vault with Workload Identity
3. PostgreSQL StatefulSet deployment with Azure Premium SSD storage
4. API and worker deployment with security hardening (PSS restricted)
5. Ingress with TLS via cert-manager
6. Network policies for database access control
7. Monitoring with Container Insights and Managed Prometheus
8. DNS cutover and validation

The same pattern applies to any stateful application on Kubernetes. Adjust the database, storage class, and secrets management for your specific workload.

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
**Related:** [Tutorial: Velero Migration](tutorial-velero-migration.md) | [Storage Migration](storage-migration.md) | [Security Migration](security-migration.md)
