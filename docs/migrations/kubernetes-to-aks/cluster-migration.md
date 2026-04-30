# Cluster Configuration Migration: On-Premises to AKS

**Status:** Authored 2026-04-30
**Audience:** Platform engineers and infrastructure architects migrating cluster-level configuration from self-managed Kubernetes or OpenShift to AKS.
**Scope:** Node pools, VM sizing, availability zones, CNI selection, kubelet configuration, cluster autoscaler, node auto-provisioning, and maintenance windows.

---

## 1. Cluster design decisions

Before creating your first AKS cluster, make these design decisions. Each maps to a configuration that is difficult or impossible to change after cluster creation.

### Cluster identity

| Decision                  | Options                                                          | Recommendation                                                                             |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Cluster identity type** | System-assigned managed identity, User-assigned managed identity | User-assigned managed identity for production (portable, pre-configurable RBAC)            |
| **Entra ID integration**  | Enabled, Disabled                                                | Always enable for production. Maps Entra ID groups to K8s RBAC                             |
| **Azure RBAC for K8s**    | Enabled (Azure RBAC), Disabled (K8s-native RBAC)                 | Azure RBAC for centralized management; K8s-native RBAC if migrating existing RBAC policies |
| **Local accounts**        | Enabled, Disabled                                                | Disable local accounts for production (force Entra ID auth)                                |

### Networking (immutable after creation)

| Decision            | Options                                                          | Recommendation                                                                                         |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Network plugin**  | Azure CNI Overlay, Azure CNI (VNet), Azure CNI + Cilium, kubenet | Azure CNI Overlay for most workloads; Azure CNI + Cilium for advanced network policy and observability |
| **Network policy**  | Azure (Azure NPM), Calico, Cilium                                | Cilium (if using Azure CNI + Cilium); Calico for existing Calico policy migration                      |
| **Pod CIDR**        | Custom (default: 10.244.0.0/16)                                  | Size for growth. /16 provides 65K pod IPs per cluster. Overlay mode does not consume VNet IPs          |
| **Service CIDR**    | Custom (default: 10.0.0.0/16)                                    | Non-overlapping with VNet and pod CIDR                                                                 |
| **DNS service IP**  | Within service CIDR                                              | Default is typically fine                                                                              |
| **Private cluster** | Enabled (no public API endpoint), Disabled                       | Enable for production / federal workloads. API server accessible only via Private Link                 |
| **Outbound type**   | Load balancer, User-defined routing, NAT Gateway, None           | User-defined routing with Azure Firewall for federal (egress control)                                  |

### SKU and SLA

| Decision          | Options                      | Recommendation                                                            |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------- |
| **AKS SKU**       | Free, Standard, Premium      | Standard for production (99.95% SLA). Premium for LTS + advanced features |
| **Uptime SLA**    | Included in Standard/Premium | Standard tier includes financially-backed SLA                             |
| **AKS Automatic** | Enabled, Disabled            | Consider for new clusters where opinionated defaults are acceptable       |

---

## 2. Node pool configuration

### System node pool

Every AKS cluster requires at least one system node pool running critical system pods (CoreDNS, metrics-server, kube-proxy, Azure CNI, CSI drivers).

```bash
# Create AKS cluster with system node pool
az aks create \
  --resource-group rg-aks-prod \
  --name aks-prod-eastus2 \
  --location eastus2 \
  --kubernetes-version 1.30 \
  --network-plugin azure \
  --network-plugin-mode overlay \
  --network-dataplane cilium \
  --enable-managed-identity \
  --assign-identity /subscriptions/.../resourceGroups/.../providers/Microsoft.ManagedIdentity/userAssignedIdentities/umi-aks-prod \
  --enable-aad \
  --enable-azure-rbac \
  --disable-local-accounts \
  --enable-private-cluster \
  --private-dns-zone system \
  --outbound-type userDefinedRouting \
  --node-count 3 \
  --node-vm-size Standard_D4s_v5 \
  --nodepool-name system \
  --nodepool-labels nodepool=system \
  --nodepool-taints CriticalAddonsOnly=true:NoSchedule \
  --zones 1 2 3 \
  --enable-cluster-autoscaler \
  --min-count 3 \
  --max-count 5 \
  --tier standard \
  --enable-defender \
  --enable-workload-identity \
  --enable-oidc-issuer \
  --attach-acr /subscriptions/.../resourceGroups/.../providers/Microsoft.ContainerRegistry/registries/csainaboxacr \
  --tags environment=production team=platform
```

### User node pools

Create separate node pools for different workload types. This replaces the "one big cluster" pattern common in self-managed Kubernetes with targeted node pools.

```bash
# General-purpose workload pool
az aks nodepool add \
  --resource-group rg-aks-prod \
  --cluster-name aks-prod-eastus2 \
  --name workload \
  --node-vm-size Standard_D8s_v5 \
  --node-count 5 \
  --zones 1 2 3 \
  --enable-cluster-autoscaler \
  --min-count 3 \
  --max-count 20 \
  --labels workload-type=general \
  --max-pods 110 \
  --mode User

# Memory-optimized pool (for data-intensive workloads)
az aks nodepool add \
  --resource-group rg-aks-prod \
  --cluster-name aks-prod-eastus2 \
  --name highmem \
  --node-vm-size Standard_E16s_v5 \
  --node-count 2 \
  --zones 1 2 3 \
  --enable-cluster-autoscaler \
  --min-count 2 \
  --max-count 10 \
  --labels workload-type=memory-intensive \
  --node-taints workload=memory-intensive:NoSchedule \
  --mode User

# GPU pool (for ML inference / model serving)
az aks nodepool add \
  --resource-group rg-aks-prod \
  --cluster-name aks-prod-eastus2 \
  --name gpu \
  --node-vm-size Standard_NC24ads_A100_v4 \
  --node-count 0 \
  --zones 1 \
  --enable-cluster-autoscaler \
  --min-count 0 \
  --max-count 4 \
  --labels workload-type=gpu accelerator=nvidia-a100 \
  --node-taints nvidia.com/gpu=present:NoSchedule \
  --mode User

# Spot pool (for batch / fault-tolerant workloads)
az aks nodepool add \
  --resource-group rg-aks-prod \
  --cluster-name aks-prod-eastus2 \
  --name spot \
  --node-vm-size Standard_D8s_v5 \
  --node-count 0 \
  --enable-cluster-autoscaler \
  --min-count 0 \
  --max-count 30 \
  --priority Spot \
  --eviction-policy Delete \
  --spot-max-price -1 \
  --labels workload-type=batch kubernetes.azure.com/scalesetpriority=spot \
  --node-taints kubernetes.azure.com/scalesetpriority=spot:NoSchedule \
  --mode User

# FIPS-enabled pool (for federal compliance)
az aks nodepool add \
  --resource-group rg-aks-prod \
  --cluster-name aks-prod-eastus2 \
  --name fips \
  --node-vm-size Standard_D8s_v5 \
  --node-count 3 \
  --zones 1 2 3 \
  --enable-cluster-autoscaler \
  --min-count 3 \
  --max-count 15 \
  --enable-fips-image \
  --labels workload-type=fips-required \
  --mode User
```

### VM size mapping: on-prem to Azure

| On-prem server profile         | Azure VM size            | vCPU | Memory  | Notes                         |
| ------------------------------ | ------------------------ | ---- | ------- | ----------------------------- |
| General worker (4C/16GB)       | Standard_D4s_v5          | 4    | 16 GB   | System pool, light workloads  |
| General worker (8C/32GB)       | Standard_D8s_v5          | 8    | 32 GB   | Most application workloads    |
| General worker (16C/64GB)      | Standard_D16s_v5         | 16   | 64 GB   | Higher-density workloads      |
| Memory-optimized (8C/64GB)     | Standard_E8s_v5          | 8    | 64 GB   | Caching, in-memory processing |
| Memory-optimized (16C/128GB)   | Standard_E16s_v5         | 16   | 128 GB  | Spark executors, large caches |
| Compute-optimized (8C/16GB)    | Standard_F8s_v2          | 8    | 16 GB   | CPU-intensive batch jobs      |
| Storage-optimized (local NVMe) | Standard_L8s_v3          | 8    | 64 GB   | Local SSD for databases, etcd |
| GPU (single GPU)               | Standard_NC6s_v3         | 6    | 112 GB  | ML inference (V100)           |
| GPU (A100)                     | Standard_NC24ads_A100_v4 | 24   | 220 GB  | ML training and inference     |
| GPU (H100)                     | Standard_ND96isr_H100_v5 | 96   | 1900 GB | Large-scale ML training       |

---

## 3. Availability zones

AKS supports spreading node pools across Azure availability zones for high availability. This replaces the rack-aware scheduling and failure-domain configuration in self-managed clusters.

### Zone-redundant deployment

```bash
# Node pool spread across all 3 zones
az aks nodepool add \
  --name workload \
  --zones 1 2 3 \
  --node-count 6  # 2 nodes per zone
```

### Zone topology constraints

Use pod topology spread constraints to ensure even pod distribution across zones:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
    name: api-server
spec:
    replicas: 6
    template:
        spec:
            topologySpreadConstraints:
                - maxSkew: 1
                  topologyKey: topology.kubernetes.io/zone
                  whenUnsatisfiable: DoNotSchedule
                  labelSelector:
                      matchLabels:
                          app: api-server
```

### Zone-aware storage

Azure Managed Disks are zonal resources. For StatefulSets using Azure Disk, the pod and disk must be in the same zone. AKS handles this automatically with the `volumeBindingMode: WaitForFirstConsumer` storage class.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: managed-premium-zrs
provisioner: disk.csi.azure.com
parameters:
    skuName: Premium_ZRS # Zone-redundant storage
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

---

## 4. CNI selection guide

### Azure CNI Overlay (recommended for most)

- Pods get IPs from a private CIDR (not VNet IPs)
- Scales to thousands of pods without VNet exhaustion
- Lower IP planning overhead
- Compatible with Calico and Cilium network policies

### Azure CNI (VNet)

- Every pod gets a VNet IP address
- Pods are directly reachable from VNet-peered networks
- Higher IP planning overhead (need large subnets)
- Best when: pods must be directly addressable from VNet or on-prem

### Azure CNI powered by Cilium

- eBPF-based dataplane (replaces iptables/ipvs)
- Advanced network policy (L7 policy, DNS policy, FQDN policy)
- Network observability (Hubble)
- Better performance than iptables-based CNI
- Best when: advanced network policy, observability, or high-performance networking required

### kubenet (legacy, not recommended)

- Basic overlay networking
- Limited to 400 nodes per cluster
- No network policy support without Calico addon
- Only use when: migrating from kubenet-based clusters and not ready to change CNI

---

## 5. Kubelet configuration

AKS supports custom kubelet configuration via JSON. This replaces the kubelet flags and configuration files in self-managed clusters.

```bash
# Create kubelet config file
cat > kubelet-config.json << 'EOF'
{
  "cpuManagerPolicy": "static",
  "cpuCfsQuota": true,
  "cpuCfsQuotaPeriod": "100ms",
  "topologyManagerPolicy": "best-effort",
  "allowedUnsafeSysctls": [
    "net.core.somaxconn",
    "net.ipv4.tcp_keepalive_time"
  ],
  "containerLogMaxSizeMB": 100,
  "containerLogMaxFiles": 5,
  "podMaxPids": 4096,
  "imageGcHighThreshold": 85,
  "imageGcLowThreshold": 80
}
EOF

# Apply to node pool
az aks nodepool add \
  --name highperf \
  --kubelet-config kubelet-config.json \
  --node-vm-size Standard_D16s_v5 \
  --node-count 3
```

### Common kubelet configurations for data workloads

| Setting                              | Value                                  | Use case                                  |
| ------------------------------------ | -------------------------------------- | ----------------------------------------- |
| `cpuManagerPolicy: static`           | Guaranteed QoS pods get dedicated CPUs | Spark executors, database pods            |
| `topologyManagerPolicy: best-effort` | NUMA-aware scheduling                  | GPU workloads, high-performance computing |
| `podMaxPids: 4096`                   | Higher PID limit per pod               | Java applications, Spark (many threads)   |
| `containerLogMaxSizeMB: 100`         | Larger container log files             | Debug scenarios, verbose logging          |

---

## 6. Cluster autoscaler configuration

### Basic autoscaler

```bash
# Enable autoscaler on a node pool
az aks nodepool update \
  --resource-group rg-aks-prod \
  --cluster-name aks-prod-eastus2 \
  --name workload \
  --enable-cluster-autoscaler \
  --min-count 3 \
  --max-count 20
```

### Autoscaler profile (cluster-wide settings)

```bash
az aks update \
  --resource-group rg-aks-prod \
  --name aks-prod-eastus2 \
  --cluster-autoscaler-profile \
    scan-interval=10s \
    scale-down-delay-after-add=10m \
    scale-down-delay-after-delete=10s \
    scale-down-unneeded-time=10m \
    scale-down-utilization-threshold=0.5 \
    max-graceful-termination-sec=600 \
    balance-similar-node-groups=true \
    expander=least-waste \
    skip-nodes-with-local-storage=false \
    skip-nodes-with-system-pods=true \
    max-node-provision-time=15m \
    max-total-unready-percentage=45 \
    ok-total-unready-count=3 \
    new-pod-scale-up-delay=0s
```

### Autoscaler profile mapping from self-managed

| Self-managed flag                    | AKS profile parameter              | Notes                                                      |
| ------------------------------------ | ---------------------------------- | ---------------------------------------------------------- |
| `--scan-interval`                    | `scan-interval`                    | How often autoscaler checks for pending pods               |
| `--scale-down-delay-after-add`       | `scale-down-delay-after-add`       | Wait time before scale-down after scale-up                 |
| `--scale-down-utilization-threshold` | `scale-down-utilization-threshold` | Node utilization below which node is candidate for removal |
| `--expander`                         | `expander`                         | Options: random, most-pods, least-waste, priority          |
| `--max-node-provision-time`          | `max-node-provision-time`          | Timeout for new node to become ready                       |

---

## 7. Node auto-provisioning (NAP)

NAP, built on Karpenter, automatically selects the optimal VM size for pending pods based on their resource requests, node selectors, and tolerations. This replaces the manual VM size selection in self-managed clusters.

```bash
# Enable NAP on the cluster
az aks update \
  --resource-group rg-aks-prod \
  --name aks-prod-eastus2 \
  --enable-node-auto-provisioning \
  --nap-managed-network-plugin azure \
  --nap-managed-network-dataplane cilium
```

NAP automatically:

- Selects the cheapest VM size that satisfies pod requirements
- Uses Spot VMs when pods tolerate the `kubernetes.azure.com/scalesetpriority=spot` taint
- Consolidates underutilized nodes by rescheduling pods and removing nodes
- Respects pod topology spread constraints and anti-affinity rules

---

## 8. Maintenance windows

AKS maintenance windows replace the manual upgrade scheduling in self-managed clusters.

```bash
# Configure planned maintenance window for upgrades
az aks maintenancewindow add \
  --resource-group rg-aks-prod \
  --cluster-name aks-prod-eastus2 \
  --name default \
  --schedule-type Weekly \
  --day-of-week Saturday \
  --start-hour 2 \
  --duration 4 \
  --utc-offset -05:00

# Configure maintenance window for node OS updates
az aks maintenancewindow add \
  --resource-group rg-aks-prod \
  --cluster-name aks-prod-eastus2 \
  --name aksManagedNodeOSUpgradeSchedule \
  --schedule-type Weekly \
  --day-of-week Sunday \
  --start-hour 2 \
  --duration 4 \
  --utc-offset -05:00
```

---

## 9. Bicep deployment template

For teams using infrastructure as code (recommended for CSA-in-a-Box deployments), here is a representative Bicep template:

```bicep
@description('AKS cluster configuration for CSA-in-a-Box data platform')
param clusterName string = 'aks-csa-prod'
param location string = resourceGroup().location
param kubernetesVersion string = '1.30'
param systemNodeCount int = 3
param workloadNodeCount int = 5

resource aksCluster 'Microsoft.ContainerService/managedClusters@2024-06-02-preview' = {
  name: clusterName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  sku: {
    name: 'Base'
    tier: 'Standard'
  }
  properties: {
    kubernetesVersion: kubernetesVersion
    dnsPrefix: clusterName
    enableRBAC: true
    aadProfile: {
      managed: true
      enableAzureRBAC: true
      tenantID: subscription().tenantId
    }
    disableLocalAccounts: true
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      networkDataplane: 'cilium'
      networkPolicy: 'cilium'
      podCidr: '10.244.0.0/16'
      serviceCidr: '10.0.0.0/16'
      dnsServiceIP: '10.0.0.10'
      outboundType: 'userDefinedRouting'
      loadBalancerSku: 'standard'
    }
    apiServerAccessProfile: {
      enablePrivateCluster: true
      privateDNSZone: 'system'
    }
    autoUpgradeProfile: {
      upgradeChannel: 'patch'
      nodeOSUpgradeChannel: 'NodeImage'
    }
    securityProfile: {
      defender: {
        securityMonitoring: {
          enabled: true
        }
      }
      workloadIdentity: {
        enabled: true
      }
    }
    oidcIssuerProfile: {
      enabled: true
    }
    agentPoolProfiles: [
      {
        name: 'system'
        count: systemNodeCount
        vmSize: 'Standard_D4s_v5'
        osDiskSizeGB: 128
        osDiskType: 'Managed'
        osType: 'Linux'
        mode: 'System'
        availabilityZones: ['1', '2', '3']
        enableAutoScaling: true
        minCount: 3
        maxCount: 5
        nodeTaints: ['CriticalAddonsOnly=true:NoSchedule']
        nodeLabels: { nodepool: 'system' }
        maxPods: 110
      }
      {
        name: 'workload'
        count: workloadNodeCount
        vmSize: 'Standard_D8s_v5'
        osDiskSizeGB: 256
        osDiskType: 'Managed'
        osType: 'Linux'
        mode: 'User'
        availabilityZones: ['1', '2', '3']
        enableAutoScaling: true
        minCount: 3
        maxCount: 20
        nodeLabels: { 'workload-type': 'general' }
        maxPods: 110
      }
    ]
  }
}
```

---

## 10. Post-creation cluster configuration

After creating the AKS cluster, apply these configurations:

```bash
# Get cluster credentials
az aks get-credentials --resource-group rg-aks-prod --name aks-prod-eastus2

# Install NGINX Ingress Controller
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-load-balancer-internal"="true" \
  --set controller.nodeSelector."kubernetes\.io/os"=linux

# Install cert-manager
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set installCRDs=true \
  --set nodeSelector."kubernetes\.io/os"=linux

# Enable Azure Key Vault Secrets Provider
az aks enable-addons \
  --resource-group rg-aks-prod \
  --name aks-prod-eastus2 \
  --addons azure-keyvault-secrets-provider

# Enable Azure Monitor Container Insights
az aks enable-addons \
  --resource-group rg-aks-prod \
  --name aks-prod-eastus2 \
  --addons monitoring \
  --workspace-resource-id /subscriptions/.../resourceGroups/.../providers/Microsoft.OperationalInsights/workspaces/law-csa-prod

# Enable Flux GitOps
az k8s-configuration flux create \
  --resource-group rg-aks-prod \
  --cluster-name aks-prod-eastus2 \
  --cluster-type managedClusters \
  --name cluster-config \
  --url https://github.com/org/aks-cluster-config \
  --branch main \
  --kustomization name=infra path=./infrastructure prune=true \
  --kustomization name=apps path=./applications prune=true dependsOn=infra
```

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
**Related:** [Workload Migration](workload-migration.md) | [Networking Migration](networking-migration.md) | [Feature Mapping](feature-mapping-complete.md)
