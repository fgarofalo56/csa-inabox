# AKS in Azure Government: Federal Migration Guide

**Status:** Authored 2026-04-30
**Audience:** Federal CISOs, ISSOs, platform engineers, and ATO assessors evaluating AKS for federal workloads on Azure Government.
**Scope:** FedRAMP High, IL4/IL5, STIG hardening, FIPS 140-2, container compliance, image provenance, and agency-specific deployment patterns.

---

## 1. AKS availability in Azure Government

### Regions and impact levels

| Azure Government region | AKS availability | Impact levels      | Notes                                           |
| ----------------------- | ---------------- | ------------------ | ----------------------------------------------- |
| **US Gov Virginia**     | GA               | IL2, IL4, IL5      | Primary region for most federal AKS deployments |
| **US Gov Texas**        | GA               | IL2, IL4, IL5      | Secondary / DR region                           |
| **US Gov Arizona**      | GA               | IL2, IL4, IL5      | Alternative primary                             |
| **US DoD Central**      | GA               | IL2, IL4, IL5, IL6 | DoD-specific workloads                          |
| **US DoD East**         | GA               | IL2, IL4, IL5, IL6 | DoD-specific workloads                          |

### Service availability in Azure Government

| AKS feature                | Commercial Azure | Azure Government  | Notes                     |
| -------------------------- | ---------------- | ----------------- | ------------------------- |
| AKS managed control plane  | GA               | GA                | Full parity               |
| Azure CNI Overlay          | GA               | GA                | Full parity               |
| Azure CNI + Cilium         | GA               | GA                | Full parity               |
| Private clusters           | GA               | GA                | Recommended for federal   |
| Entra ID integration       | GA               | GA                | Azure Gov Entra ID        |
| Workload Identity          | GA               | GA                | Full parity               |
| Defender for Containers    | GA               | GA                | Full parity               |
| Container Insights         | GA               | GA                | Full parity               |
| Managed Prometheus         | GA               | GA                | Full parity               |
| Managed Grafana            | GA               | GA                | Full parity               |
| Key Vault Secrets Provider | GA               | GA                | Full parity               |
| Azure Policy for K8s       | GA               | GA                | Full parity               |
| Flux GitOps extension      | GA               | GA                | Full parity               |
| KEDA addon                 | GA               | GA                | Full parity               |
| Istio addon                | GA               | GA (Preview)      | Check current status      |
| AKS Automatic              | Preview          | Limited           | Check availability        |
| GPU node pools (NC/ND)     | GA               | GA (limited SKUs) | Check region availability |

---

## 2. FedRAMP High inheritance

### What AKS inherits

AKS on Azure Government inherits Azure Government's FedRAMP High Provisional Authorization to Operate (P-ATO). This means:

- **Physical and environmental controls** (PE family): inherited from Azure Government data centers
- **Personnel security** (PS family): inherited from Microsoft operations staff screening
- **Media protection** (MP family): inherited from Azure Government data handling
- **System and communications protection** (SC family): partially inherited (encryption at rest, encryption in transit)
- **Audit and accountability** (AU family): partially inherited (Azure Activity Log, Azure Monitor)

### Customer responsibilities for AKS

| NIST 800-53 control family   | Customer responsibility                                  | AKS implementation                                                                 |
| ---------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **AC (Access Control)**      | Configure RBAC, Entra ID integration, Conditional Access | Entra ID groups mapped to K8s RBAC; disable local accounts; PIM for admin access   |
| **AU (Audit)**               | Configure audit logging, retention, alerting             | Container Insights logs to Log Analytics; AKS audit logs; 90-day minimum retention |
| **CA (Assessment)**          | Continuous monitoring, vulnerability management          | Defender for Containers scans; Azure Policy compliance reports                     |
| **CM (Config Management)**   | Baseline configurations, change control                  | GitOps (Flux/ArgoCD); Azure Policy for K8s; Pod Security Standards                 |
| **IA (Identification/Auth)** | Strong authentication for users and services             | Entra ID with MFA; Workload Identity for pods; certificate-based auth              |
| **IR (Incident Response)**   | Incident detection and response procedures               | Defender for Containers alerts; Container Insights; Azure Sentinel                 |
| **RA (Risk Assessment)**     | Vulnerability scanning, risk analysis                    | Defender vulnerability scanning; ACR image scanning                                |
| **SA (System Acquisition)**  | Supply chain risk management                             | Image provenance (Notation); approved registries (Azure Policy)                    |
| **SC (Sys/Comm Protection)** | Encryption, network segmentation                         | TLS everywhere; network policies; private clusters; Private Link                   |
| **SI (System Integrity)**    | Software integrity verification, malware protection      | Image signing (Notary v2); Defender runtime protection; FIPS modules               |

### Evidence mapping for ATO packages

```yaml
# Example: ATO evidence artifact mapping
controls:
    AC-2: # Account Management
        implementation: "Entra ID groups with automated provisioning"
        evidence:
            - "Azure RBAC role assignments export"
            - "Entra ID group membership report"
            - "kubectl get clusterrolebindings -o yaml"
    AC-6: # Least Privilege
        implementation: "Namespace-scoped RBAC, Pod Security Standards restricted"
        evidence:
            - "Azure Policy compliance report (PSS restricted)"
            - "kubectl get rolebindings -A -o yaml"
    AU-2: # Audit Events
        implementation: "Container Insights + AKS audit logs to Log Analytics"
        evidence:
            - "Log Analytics query: AKSAudit | summarize count() by Category"
            - "Diagnostic settings configuration export"
    SC-8: # Transmission Confidentiality
        implementation: "TLS 1.2+ for all ingress; mTLS via Istio; Private Link for PaaS"
        evidence:
            - "Ingress TLS configuration"
            - "Istio PeerAuthentication policies"
            - "Private endpoint configuration export"
```

---

## 3. DoD IL4 and IL5 deployment

### IL4 configuration requirements

IL4 is the baseline for CUI (Controlled Unclassified Information) on Azure Government:

```bash
# IL4 AKS cluster configuration
az aks create \
  --resource-group rg-aks-il4 \
  --name aks-il4-govva \
  --location usgovvirginia \
  --kubernetes-version 1.30 \
  --network-plugin azure \
  --network-plugin-mode overlay \
  --network-dataplane cilium \
  --enable-private-cluster \
  --private-dns-zone system \
  --outbound-type userDefinedRouting \
  --enable-aad \
  --enable-azure-rbac \
  --disable-local-accounts \
  --enable-defender \
  --enable-workload-identity \
  --enable-oidc-issuer \
  --tier standard \
  --node-vm-size Standard_D8s_v5 \
  --node-count 3 \
  --zones 1 2 3
```

### IL5 additional requirements

IL5 adds requirements beyond IL4 for higher-sensitivity CUI and National Security Systems:

| Requirement                           | Implementation                                               |
| ------------------------------------- | ------------------------------------------------------------ |
| **FIPS 140-2 validated cryptography** | `--enable-fips-image` on all node pools                      |
| **Data-at-rest encryption with CMK**  | Azure Disk encryption with customer-managed key in Key Vault |
| **Enhanced logging**                  | Extended audit log categories; 1-year retention              |
| **Dedicated hosts** (optional)        | Azure Dedicated Hosts for physical isolation                 |
| **Approved images only**              | Azure Policy: restrict to ACR + MCR images only              |

```bash
# IL5 additions: FIPS-enabled node pool
az aks nodepool add \
  --resource-group rg-aks-il5 \
  --cluster-name aks-il5-govva \
  --name fipspool \
  --enable-fips-image \
  --node-vm-size Standard_D8s_v5 \
  --node-count 3 \
  --zones 1 2 3
```

---

## 4. STIG-hardened deployments

### DISA STIG baselines for Kubernetes

The DISA Kubernetes STIG provides security configuration guidance for Kubernetes clusters. AKS addresses many STIG requirements at the platform level.

| STIG requirement                                         | AKS implementation                                  | Status       |
| -------------------------------------------------------- | --------------------------------------------------- | ------------ |
| **V-242376**: API server must use TLS 1.2+               | AKS API server uses TLS 1.2                         | Automatic    |
| **V-242377**: API server must verify client certificates | Entra ID authentication with certificate-based auth | Configurable |
| **V-242381**: API server audit logging must be enabled   | AKS diagnostic settings for audit logs              | Configurable |
| **V-242383**: etcd must use TLS for communication        | AKS managed etcd uses TLS                           | Automatic    |
| **V-242386**: Limit use of privileged containers         | Pod Security Standards + Azure Policy               | Configurable |
| **V-242387**: Network policies must be implemented       | Azure NPM / Calico / Cilium                         | Configurable |
| **V-242393**: Secrets must be encrypted at rest          | AKS etcd encryption at rest                         | Automatic    |
| **V-242395**: RBAC must be enabled                       | AKS RBAC always enabled                             | Automatic    |
| **V-242400**: Anonymous authentication must be disabled  | AKS disables anonymous auth by default              | Automatic    |

### CIS Kubernetes Benchmark

AKS provides Azure Policy initiative for CIS Kubernetes Benchmark compliance:

```bash
# Assign CIS benchmark policy initiative
az policy assignment create \
  --name "aks-cis-benchmark" \
  --display-name "CIS Microsoft Azure Kubernetes Service Benchmark" \
  --policy-set-definition "0a914e76-4921-4c19-b460-a2d36003525a" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-aks-prod/providers/Microsoft.ContainerService/managedClusters/aks-prod-eastus2" \
  --enforcement-mode Default
```

### STIG-hardened container images

Use hardened base images from approved sources:

| Image source                    | Hardening level    | Use case                |
| ------------------------------- | ------------------ | ----------------------- |
| **Microsoft CBL-Mariner**       | CIS L1 hardened    | AKS node OS (default)   |
| **Iron Bank (DoD)**             | DISA STIG hardened | DoD container workloads |
| **Chainguard**                  | Minimal + CVE-free | Secure base images      |
| **Red Hat UBI**                 | STIG hardened      | RHEL-based workloads    |
| **Azure Linux** (CBL-Mariner 3) | CIS L1 hardened    | AKS node OS (next-gen)  |

```bash
# Use Iron Bank images (DoD)
# 1. Mirror from Iron Bank to ACR
az acr import \
  --name csainaboxacr \
  --source registry1.dso.mil/ironbank/opensource/postgres/postgresql:15.7 \
  --image ironbank/postgres:15.7 \
  --username "$IRONBANK_USER" --password "$IRONBANK_PAT"

# 2. Azure Policy: require approved registries
# See security-migration.md for policy configuration
```

---

## 5. FIPS 140-2 crypto modules

### Enable FIPS on AKS node pools

```bash
# Create FIPS-enabled node pool
az aks nodepool add \
  --resource-group rg-aks-prod \
  --cluster-name aks-prod-eastus2 \
  --name fipspool \
  --enable-fips-image \
  --node-vm-size Standard_D8s_v5 \
  --node-count 3 \
  --zones 1 2 3

# Verify FIPS is enabled on nodes
kubectl get nodes -l agentpool=fipspool -o jsonpath='{.items[0].status.nodeInfo.kernelVersion}'
# Should show FIPS-enabled kernel

# Verify FIPS mode on a node
kubectl debug node/aks-fipspool-12345 -it --image=mcr.microsoft.com/cbl-mariner/busybox:2.0 -- cat /proc/sys/crypto/fips_enabled
# Output: 1
```

### FIPS considerations for containers

- Node-level FIPS: the Linux kernel and system libraries use FIPS-validated crypto modules
- Container-level FIPS: container applications must also use FIPS-validated crypto libraries
- Common FIPS-validated libraries: OpenSSL (FIPS Object Module), BoringSSL (BoringCrypto), NSS

```dockerfile
# Example: FIPS-compliant Python application
FROM mcr.microsoft.com/cbl-mariner/python:3.11
# CBL-Mariner includes FIPS-validated OpenSSL
RUN tdnf install -y openssl-fips-provider
COPY . /app
WORKDIR /app
RUN pip install -r requirements.txt
CMD ["python", "app.py"]
```

---

## 6. Container image provenance

### Notation (Notary v2) for image signing

```bash
# Install Notation CLI
az acr notation install

# Generate signing key (or use Azure Key Vault)
notation key generate-test "federal-signing-key"

# Sign an image
notation sign \
  --key "federal-signing-key" \
  csainaboxacr.azurecr.io/team/api:v2.3.1

# Verify signature
notation verify csainaboxacr.azurecr.io/team/api:v2.3.1

# Deploy Ratify on AKS for admission control
helm install ratify ratify/ratify \
  --namespace gatekeeper-system \
  --set featureFlags.RATIFY_CERT_ROTATION=true \
  --set provider.tls.cabundle="$(cat ca-cert.pem | base64)"
```

### Enforce signed images

```yaml
# Gatekeeper constraint: require signed images
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sImageRequireSignature
metadata:
    name: require-signed-images
spec:
    match:
        kinds:
            - apiGroups: [""]
              kinds: ["Pod"]
        excludedNamespaces:
            - kube-system
            - gatekeeper-system
            - velero
    parameters:
        verifier: notation
        trustPolicy: "federal-trust-policy"
```

---

## 7. Azure Policy for container compliance

### Federal policy initiatives

```bash
# NIST SP 800-53 Rev 5 for containers
az policy assignment create \
  --name "aks-nist-800-53" \
  --display-name "NIST SP 800-53 Rev. 5 for AKS" \
  --policy-set-definition "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
  --scope "/subscriptions/$SUBSCRIPTION_ID" \
  --enforcement-mode Default

# FedRAMP High for containers
az policy assignment create \
  --name "aks-fedramp-high" \
  --display-name "FedRAMP High for AKS" \
  --policy-set-definition "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
  --scope "/subscriptions/$SUBSCRIPTION_ID" \
  --enforcement-mode Default
```

### Custom federal policies

```yaml
# Require FIPS-enabled node pools for sensitive namespaces
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireFIPSNodes
metadata:
    name: require-fips-sensitive
spec:
    match:
        kinds:
            - apiGroups: [""]
              kinds: ["Pod"]
        namespaces:
            - il5-workloads
            - pii-processing
    parameters:
        requiredNodeLabel: "kubernetes.azure.com/fips_enabled"
        requiredNodeLabelValue: "true"
```

---

## 8. Agency-specific deployment patterns

### Department of Defense (DoD)

- **Platform One / Big Bang**: AKS clusters configured with DoD Big Bang baseline (Istio, Kiali, Jaeger, Twistlock/Prisma)
- **Iron Bank**: container images from registry1.dso.mil mirrored to ACR
- **STIG automation**: Azure Policy enforcing DISA Kubernetes STIG
- **cATO**: continuous ATO with automated compliance monitoring

### Intelligence Community (IC)

- **Air-gapped deployment**: AKS on Azure Stack HCI for disconnected environments
- **Private clusters only**: no public API server endpoints
- **Enhanced audit logging**: all API server audit events to dedicated Log Analytics workspace
- **Zero-trust networking**: default-deny network policies + Istio mTLS

### Civilian agencies

- **Cloud Smart alignment**: AKS adoption supports OMB M-19-26 cloud-smart strategy
- **FedRAMP inheritance**: simplifies ATO package preparation
- **Shared services**: AKS as platform for shared microservices (identity, notification, document management)
- **Data platform integration**: CSA-in-a-Box on AKS for agency data analytics

---

## 9. Compliance monitoring and reporting

### Continuous compliance with Azure Policy

```bash
# Check compliance state
az policy state list \
  --resource "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-aks-prod/providers/Microsoft.ContainerService/managedClusters/aks-prod-eastus2" \
  --filter "complianceState eq 'NonCompliant'" \
  --query "[].{policy:policyDefinitionName, resource:resourceId, compliance:complianceState}" \
  -o table
```

### Defender for Containers compliance

- Continuous vulnerability assessment of ACR images
- Runtime threat detection for AKS workloads
- Compliance score in Microsoft Defender for Cloud
- Export compliance data to Azure Sentinel for SIEM integration

### Audit log retention

```bash
# Configure diagnostic settings with extended retention
az monitor diagnostic-settings create \
  --name aks-audit-logs \
  --resource "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-aks-prod/providers/Microsoft.ContainerService/managedClusters/aks-prod-eastus2" \
  --workspace "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-monitor/providers/Microsoft.OperationalInsights/workspaces/law-federal" \
  --logs '[
    {"category": "kube-apiserver", "enabled": true},
    {"category": "kube-audit", "enabled": true},
    {"category": "kube-audit-admin", "enabled": true},
    {"category": "kube-controller-manager", "enabled": true},
    {"category": "kube-scheduler", "enabled": true},
    {"category": "cluster-autoscaler", "enabled": true},
    {"category": "guard", "enabled": true}
  ]'
```

---

## 10. Federal migration checklist

- [ ] AKS deployed in Azure Government region (US Gov Virginia / Texas / Arizona)
- [ ] Private cluster enabled (no public API server endpoint)
- [ ] Entra ID integration enabled; local accounts disabled
- [ ] FIPS-enabled node pools for IL5 / FIPS-required workloads
- [ ] Azure Policy initiatives assigned (NIST 800-53, CIS, STIG)
- [ ] Defender for Containers enabled (vulnerability scanning + runtime protection)
- [ ] Audit logs flowing to Log Analytics with 1-year retention
- [ ] Container images sourced from approved registries (ACR, Iron Bank, MCR)
- [ ] Image signing configured (Notation / Notary v2)
- [ ] Network policies enforced (default-deny baseline)
- [ ] Secrets in Azure Key Vault (not K8s Secrets)
- [ ] Workload Identity configured (no stored credentials)
- [ ] ExpressRoute configured for hybrid connectivity (if applicable)
- [ ] Egress controlled via Azure Firewall
- [ ] ATO package documentation updated with AKS-specific controls
- [ ] CSA-in-a-Box compliance YAMLs applied (FedRAMP, CMMC, HIPAA)

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
**Related:** [Security Migration](security-migration.md) | [Why AKS](why-aks.md) | [Best Practices](best-practices.md)
