# Complete Feature Mapping: Kubernetes / OpenShift to AKS

**Status:** Authored 2026-04-30
**Audience:** Federal CTOs, platform architects, and DevOps engineers evaluating the migration surface from self-managed Kubernetes and Red Hat OpenShift to Azure Kubernetes Service (AKS).
**Methodology:** Every mapping includes the source feature, AKS equivalent, migration complexity (XS/S/M/L/XL), and implementation notes. Features are organized by domain. OpenShift-specific features are marked with **(OCP)**.

---

## How to read this document

- **XS** = configuration change only, no code or manifest changes
- **S** = minor manifest or Helm chart updates, < 1 day per workload
- **M** = moderate effort, requires testing and validation, 1--5 days per workload
- **L** = significant effort, architecture or tooling changes, 1--3 weeks
- **XL** = major effort, may require redesign, 3+ weeks
- **(OCP)** = OpenShift-specific feature, not present in standard Kubernetes
- **N/A** = AKS handles this automatically, no customer action needed

---

## 1. Control plane and cluster management (10 features)

| #   | Source feature                                     | AKS equivalent                                                 | Effort | Notes                                                                                |
| --- | -------------------------------------------------- | -------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| 1   | **Self-managed API server**                        | AKS managed API server                                         | N/A    | Microsoft manages provisioning, patching, and scaling                                |
| 2   | **Self-managed etcd** (backup, defrag, compaction) | AKS managed etcd                                               | N/A    | Automatic backup, compaction, and HA                                                 |
| 3   | **Self-managed scheduler + controller-manager**    | AKS managed                                                    | N/A    | Microsoft manages; customer cannot modify scheduler config directly                  |
| 4   | **kubeadm init / join**                            | `az aks create` / `az aks nodepool add`                        | XS     | CLI, Bicep, Terraform, or ARM template                                               |
| 5   | **Manual Kubernetes version upgrades**             | AKS auto-upgrade channels (none/patch/stable/rapid/node-image) | XS     | Configure upgrade channel; optionally set maintenance window                         |
| 6   | **kubelet configuration** (custom flags)           | AKS kubelet custom configuration (JSON)                        | S      | Supported via `--kubelet-config` on node pool creation                               |
| 7   | **Cluster federation** (KubeFed)                   | Azure Arc-enabled Kubernetes                                   | M      | Arc provides multi-cluster management; Fleet Manager for multi-cluster orchestration |
| 8   | **Cluster API (CAPI)** provisioning                | AKS + Bicep / Terraform                                        | S      | Replace CAPI providers with AKS resource provisioning                                |
| 9   | **(OCP) ClusterVersion operator**                  | AKS upgrade management                                         | N/A    | AKS manages cluster lifecycle; no OCP ClusterVersion equivalent needed               |
| 10  | **(OCP) Machine / MachineSet**                     | AKS node pools + cluster autoscaler                            | S      | Node pool replaces MachineSet; autoscaler replaces machine-health-check              |

---

## 2. Workload resources (10 features)

| #   | Source feature                                                  | AKS equivalent                                 | Effort | Notes                                                                                                                                                                                       |
| --- | --------------------------------------------------------------- | ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11  | **Deployment**                                                  | Deployment (identical)                         | XS     | No changes required; standard K8s resource                                                                                                                                                  |
| 12  | **StatefulSet**                                                 | StatefulSet (identical)                        | XS     | Update storage class references to Azure CSI classes                                                                                                                                        |
| 13  | **DaemonSet**                                                   | DaemonSet (identical)                          | XS     | No changes required                                                                                                                                                                         |
| 14  | **Job / CronJob**                                               | Job / CronJob (identical)                      | XS     | No changes required                                                                                                                                                                         |
| 15  | **ReplicaSet**                                                  | ReplicaSet (identical)                         | XS     | No changes required                                                                                                                                                                         |
| 16  | **(OCP) DeploymentConfig**                                      | Deployment                                     | S      | Remove triggers, lifecycle hooks, and `oc rollout` usage. Convert `rollingParams` to Deployment `strategy`. Remove `imageChangeParams` triggers -- use CI/CD pipeline image updates instead |
| 17  | **(OCP) DeploymentConfig triggers** (ImageChange, ConfigChange) | CI/CD pipeline triggers (GitHub Actions, Flux) | M      | No K8s-native equivalent for ImageChange triggers; implement in CI/CD pipeline or use Flux image automation                                                                                 |
| 18  | **Horizontal Pod Autoscaler (HPA)**                             | HPA (identical) + KEDA                         | XS     | HPA works unchanged; KEDA adds event-driven scaling (Event Hubs, queue depth, custom metrics)                                                                                               |
| 19  | **Vertical Pod Autoscaler (VPA)**                               | VPA on AKS                                     | XS     | Install VPA addon; works identically                                                                                                                                                        |
| 20  | **Pod Disruption Budget (PDB)**                                 | PDB (identical)                                | XS     | No changes required                                                                                                                                                                         |

---

## 3. Networking (12 features)

| #   | Source feature                           | AKS equivalent                                                  | Effort | Notes                                                                                                              |
| --- | ---------------------------------------- | --------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| 21  | **Calico CNI**                           | Azure CNI + Calico network policy / Azure CNI powered by Cilium | S      | Calico network policies work on AKS; Cilium is the strategic direction                                             |
| 22  | **Flannel CNI**                          | Azure CNI Overlay                                               | S      | Azure CNI Overlay provides similar overlay networking without per-pod VNet IPs                                     |
| 23  | **Cilium CNI**                           | Azure CNI powered by Cilium (native)                            | XS     | First-class AKS integration; eBPF dataplane, network policy, observability                                         |
| 24  | **Weave Net CNI**                        | Azure CNI Overlay                                               | S      | Replace with Azure CNI Overlay; functionally equivalent                                                            |
| 25  | **(OCP) OpenShift SDN / OVN-Kubernetes** | Azure CNI Overlay / Azure CNI + Cilium                          | M      | Replace OCP-specific CNI with Azure-native; update any network policy using OCP-specific selectors                 |
| 26  | **(OCP) Routes** (HAProxy-based)         | Ingress (NGINX Ingress Controller / AGIC / Contour)             | S      | Convert Route YAML to Ingress YAML. `host` and `path` map directly. TLS termination via cert-manager or AGIC       |
| 27  | **Ingress (NGINX)**                      | NGINX Ingress Controller on AKS                                 | XS     | Same NGINX Ingress Controller; install via Helm. Existing Ingress resources work unchanged                         |
| 28  | **Ingress (Traefik)**                    | Traefik on AKS / NGINX / AGIC                                   | XS     | Traefik runs on AKS unchanged; alternatively migrate to NGINX or AGIC                                              |
| 29  | **MetalLB** (bare-metal load balancer)   | Azure Load Balancer                                             | XS     | AKS automatically provisions Azure LB for Service type: LoadBalancer. Remove MetalLB                               |
| 30  | **Network Policies** (Calico/Cilium)     | Network Policies on AKS (Azure NPM / Calico / Cilium)           | XS     | Existing NetworkPolicy resources work on AKS with Calico or Cilium. Azure NPM supports standard NetworkPolicy spec |
| 31  | **(OCP) EgressNetworkPolicy / EgressIP** | Azure Firewall / NAT Gateway + Cilium egress policy             | M      | Use Azure Firewall or NAT Gateway for egress control; Cilium CiliumNetworkPolicy for pod-level egress              |
| 32  | **Service Mesh (Istio)**                 | Istio-based service mesh addon for AKS                          | S      | AKS Istio addon provides managed Istio. Existing VirtualService, DestinationRule, Gateway resources work unchanged |

---

## 4. Storage (8 features)

| #   | Source feature                          | AKS equivalent                                                 | Effort | Notes                                                                                         |
| --- | --------------------------------------- | -------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| 33  | **Local storage (hostPath, local PV)**  | Azure Disk (Premium SSD, Ultra) or local NVMe (LSv3, Lsv2 VMs) | S      | Use local NVMe for ephemeral high-IOPS; Azure Disk for persistent                             |
| 34  | **Ceph RBD (Rook-Ceph)**                | Azure Disk CSI driver (managed disks)                          | M      | Replace Ceph storage class with Azure Disk storage class. Migrate data via Velero or rsync    |
| 35  | **CephFS (Rook-Ceph)**                  | Azure Files CSI driver (NFS or SMB)                            | M      | Replace CephFS with Azure Files NFS for ReadWriteMany workloads                               |
| 36  | **NFS server (in-cluster or external)** | Azure Files NFS / Azure NetApp Files                           | S      | Azure Files NFS for general use; Azure NetApp Files for high-performance NFS                  |
| 37  | **GlusterFS**                           | Azure Files SMB or NFS                                         | M      | Replace GlusterFS with Azure Files; migrate data                                              |
| 38  | **Longhorn**                            | Azure Disk CSI driver                                          | S      | Replace Longhorn with Azure Disk; Longhorn can also run on AKS if desired                     |
| 39  | **CSI driver (custom)**                 | Azure Disk / Azure Files / Azure Blob CSI (built-in)           | S      | AKS pre-installs Azure CSI drivers. Custom CSI drivers can be installed additionally          |
| 40  | **Velero (backup/restore)**             | Velero on AKS with Azure Blob backend                          | XS     | Same Velero; configure Azure Blob as backup storage location. Use for cross-cluster migration |

---

## 5. Security and identity (12 features)

| #   | Source feature                               | AKS equivalent                                              | Effort | Notes                                                                                                                                           |
| --- | -------------------------------------------- | ----------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 41  | **RBAC (ClusterRole, RoleBinding)**          | AKS RBAC + Entra ID integration                             | M      | Map cluster roles to Entra ID groups. Use Azure RBAC for Kubernetes or native K8s RBAC with Entra ID authentication                             |
| 42  | **Service accounts + secrets**               | Entra Workload Identity                                     | M      | Replace service account token-based auth with Entra Workload Identity for Azure service access. K8s service accounts remain for in-cluster auth |
| 43  | **Pod Security Policies (deprecated)**       | Pod Security Standards (PSS) + Pod Security Admission (PSA) | M      | PSP → PSS migration. AKS enforces PSS at namespace level. Use Azure Policy for additional constraints                                           |
| 44  | **(OCP) Security Context Constraints (SCC)** | Pod Security Standards + Azure Policy (Gatekeeper)          | L      | Map each SCC to PSS level (privileged/baseline/restricted). Custom SCCs → custom Gatekeeper constraints. Most complex OCP→AKS conversion        |
| 45  | **(OCP) SCC `anyuid`**                       | PSS `baseline` + specific securityContext overrides         | M      | Configure pods with explicit `runAsUser` and `runAsGroup` instead of relying on SCC `anyuid`                                                    |
| 46  | **Secrets (K8s Secret resources)**           | Azure Key Vault Secrets Provider (CSI driver)               | M      | Migrate secrets to Key Vault. Mount via CSI driver. Secrets sync to K8s Secret resources for backward compatibility                             |
| 47  | **cert-manager**                             | cert-manager on AKS (unchanged)                             | XS     | cert-manager runs on AKS identically. Configure ACME issuers for Let's Encrypt or Azure Key Vault issuer                                        |
| 48  | **Image scanning (Trivy, Clair, Anchore)**   | Defender for Containers                                     | S      | Defender scans ACR images automatically. Also provides runtime threat detection. Trivy can still run as supplementary                           |
| 49  | **OPA / Gatekeeper**                         | Azure Policy for Kubernetes (built on Gatekeeper)           | S      | Existing Gatekeeper ConstraintTemplates work on AKS. Azure Policy provides additional pre-built policies. Can use both                          |
| 50  | **(OCP) OPA/Gatekeeper + SCC combined**      | Azure Policy + PSS                                          | M      | Consolidate OCP SCC + Gatekeeper into Azure Policy + PSS. Azure Policy initiative for CIS benchmarks covers most cases                          |
| 51  | **Pod identity (aad-pod-identity)**          | Entra Workload Identity (replacement)                       | M      | aad-pod-identity is deprecated. Migrate to Workload Identity (federated credentials). See security-migration.md                                 |
| 52  | **Network Policy (deny-all default)**        | Network Policy + Azure Policy                               | XS     | Same NetworkPolicy spec. Azure Policy can enforce "must have network policy" per namespace                                                      |

---

## 6. CI/CD and image management (8 features)

| #   | Source feature                                | AKS equivalent                                  | Effort | Notes                                                                                                                          |
| --- | --------------------------------------------- | ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 53  | **(OCP) BuildConfig / Source-to-Image (S2I)** | Dockerfile + ACR Build Tasks / GitHub Actions   | M      | Replace S2I with Dockerfile + ACR Tasks (cloud-native builds) or GitHub Actions. No on-cluster builds needed                   |
| 54  | **(OCP) ImageStreams**                        | ACR repositories + image tags                   | M      | Replace ImageStream references with direct ACR image references. Remove ImageStream triggers -- use CI/CD pipeline             |
| 55  | **(OCP) ImageStream tags + import policy**    | ACR auto-import (ACR Tasks + schedules)         | S      | ACR Tasks can auto-import base images on schedule. No ImageStream equivalent needed                                            |
| 56  | **(OCP) OperatorHub / OLM**                   | Helm charts + AKS extensions + marketplace      | M      | Most operators have Helm chart equivalents. AKS extensions provide managed operator lifecycle for key operators. No OLM on AKS |
| 57  | **Helm (v3)**                                 | Helm (identical)                                | XS     | Helm works unchanged on AKS                                                                                                    |
| 58  | **Kustomize**                                 | Kustomize (identical)                           | XS     | Kustomize works unchanged on AKS                                                                                               |
| 59  | **GitOps (ArgoCD)**                           | ArgoCD on AKS (unchanged) or AKS Flux extension | XS     | ArgoCD runs on AKS unchanged. AKS also offers Flux as a managed extension                                                      |
| 60  | **GitOps (Flux v2)**                          | AKS Flux extension (managed)                    | XS     | First-class AKS extension. Flux configuration via Azure CLI or Azure Portal                                                    |

---

## 7. Observability and monitoring (6 features)

| #   | Source feature                                 | AKS equivalent                                           | Effort | Notes                                                                                                                                |
| --- | ---------------------------------------------- | -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 61  | **Prometheus (self-managed)**                  | AKS Managed Prometheus                                   | S      | Managed Prometheus collects metrics without running your own Prometheus server. Custom scrape configs supported                      |
| 62  | **Grafana (self-managed)**                     | AKS Managed Grafana                                      | S      | Managed Grafana with pre-built AKS dashboards. Custom dashboards importable. Community dashboards supported                          |
| 63  | **Alertmanager**                               | Azure Monitor alerts + Managed Prometheus alerting rules | S      | PrometheusRule CRDs work with Managed Prometheus. Azure Monitor alerts for Azure-native alerting                                     |
| 64  | **EFK stack** (Elasticsearch, Fluentd, Kibana) | Container Insights (Azure Monitor agent)                 | M      | Container Insights collects logs natively. Log Analytics workspace replaces Elasticsearch. Azure Workbooks replace Kibana dashboards |
| 65  | **Jaeger / Zipkin (distributed tracing)**      | Application Insights (OpenTelemetry)                     | M      | Application Insights with OpenTelemetry SDK for distributed tracing. Jaeger can also run on AKS                                      |
| 66  | **(OCP) OpenShift Console (web UI)**           | Azure Portal + kubectl + Lens / K9s                      | S      | Azure Portal provides cluster overview, workload view, and logs. Lens or K9s for terminal-based cluster management                   |

---

## 8. Service mesh (4 features)

| #   | Source feature                                 | AKS equivalent                                | Effort | Notes                                                                                                           |
| --- | ---------------------------------------------- | --------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| 67  | **Istio (self-managed)**                       | AKS Istio-based service mesh addon            | S      | Managed Istio control plane. Existing VirtualService, DestinationRule, Gateway CRDs work unchanged              |
| 68  | **(OCP) OpenShift Service Mesh** (Istio-based) | AKS Istio addon                               | M      | Same Istio upstream. Migrate Istio CRDs. OCP-specific Kiali/Jaeger integration → Managed Grafana + App Insights |
| 69  | **Linkerd**                                    | Linkerd on AKS (unchanged) or AKS Istio addon | XS     | Linkerd runs on AKS unchanged. Alternatively migrate to managed Istio                                           |
| 70  | **Consul Connect**                             | Consul on AKS (unchanged) or AKS Istio addon  | S      | Consul runs on AKS unchanged. Migration to Istio is optional                                                    |

---

## 9. Autoscaling and resource management (4 features)

| #   | Source feature                         | AKS equivalent                                       | Effort | Notes                                                                                          |
| --- | -------------------------------------- | ---------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| 71  | **Cluster Autoscaler** (self-managed)  | AKS cluster autoscaler (built-in)                    | XS     | Configure via `--enable-cluster-autoscaler` with `--min-count` and `--max-count` per node pool |
| 72  | **Node auto-provisioning** (Karpenter) | AKS Node Auto-Provisioning (NAP, built on Karpenter) | S      | NAP automatically selects optimal VM sizes. AKS-native Karpenter integration                   |
| 73  | **KEDA** (self-managed)                | KEDA AKS addon                                       | XS     | AKS-managed KEDA addon. Existing ScaledObject and ScaledJob CRDs work unchanged                |
| 74  | **Resource quotas + LimitRanges**      | Resource quotas + LimitRanges (identical)            | XS     | No changes required. Azure Policy can enforce quotas                                           |

---

## 10. CSA-in-a-Box integration features (6 features)

| #   | Source feature                           | AKS equivalent + CSA-in-a-Box                           | Effort | Notes                                                                                                                  |
| --- | ---------------------------------------- | ------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| 75  | **Spark on Kubernetes** (Spark Operator) | Spark Operator on AKS + ADLS Gen2 + Unity Catalog       | M      | Spark Operator runs on AKS unchanged. Configure Spark to use ADLS Gen2 (abfss://) and register tables in Unity Catalog |
| 76  | **ML model serving** (Triton/TorchServe) | GPU node pools (NC/ND series) + AI Foundry registration | S      | Deploy model serving containers on GPU node pools. Register endpoints in AI Foundry. Purview governs model metadata    |
| 77  | **Event-driven consumers** (custom)      | KEDA + Event Hubs + ADLS Gen2 medallion architecture    | M      | KEDA scales consumers based on Event Hubs lag. Consumers write to bronze/silver/gold on ADLS Gen2                      |
| 78  | **dbt execution** (container-based)      | CronJob + Databricks SQL / Fabric SQL endpoint          | S      | dbt container runs as K8s CronJob. `profiles.yml` targets Databricks SQL Warehouse or Fabric SQL endpoint              |
| 79  | **Data API layer** (REST/GraphQL)        | AKS Deployment + AGIC + Entra Workload Identity         | S      | APIs serve data products from CSA-in-a-Box data marketplace. Workload Identity authenticates to data stores            |
| 80  | **Notebook execution** (Papermill)       | K8s Job + ADLS Gen2 + Purview lineage                   | S      | Papermill containers execute notebooks as K8s Jobs. Output artifacts stored in ADLS Gen2. Purview tracks lineage       |

---

## Summary: migration complexity distribution

| Complexity            | Count | Percentage | Description                         |
| --------------------- | ----- | ---------- | ----------------------------------- |
| **N/A** (AKS handles) | 8     | 10%        | Control plane operations eliminated |
| **XS** (config only)  | 26    | 33%        | Configuration change, no code       |
| **S** (minor changes) | 26    | 33%        | Minor manifest or chart updates     |
| **M** (moderate)      | 17    | 21%        | Testing and validation required     |
| **L** (significant)   | 2     | 2.5%       | Architecture or tooling changes     |
| **XL** (major)        | 1     | 1.25%      | Redesign required                   |

**Key finding:** 76% of features require XS or S effort (configuration changes or minor manifest updates). The remaining 24% require moderate-to-significant effort, concentrated in OpenShift-specific features (SCCs, BuildConfigs, ImageStreams, DeploymentConfig triggers) and identity migration (service accounts to Workload Identity).

For standard Kubernetes clusters (non-OpenShift), the migration effort distribution shifts to **85% XS/S** -- most workloads run on AKS without modification.

---

## Migration priority matrix

| Priority                       | Features                                                                                | Rationale                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **P0 -- Before any workload**  | #1--5 (control plane), #41--42 (RBAC + identity), #46 (secrets), #21--24 (CNI)          | Cluster must be operational with identity and networking before workloads deploy |
| **P1 -- Pilot workload**       | #11--16 (workload resources), #26--28 (Ingress), #33--40 (storage), #47 (cert-manager)  | Basic workload deployment, ingress, storage, and TLS                             |
| **P2 -- Production workloads** | #43--45 (pod security), #48--52 (security), #61--66 (monitoring), #71--74 (autoscaling) | Security hardening, monitoring, and autoscaling for production readiness         |
| **P3 -- CI/CD and GitOps**     | #53--60 (CI/CD + image management)                                                      | Pipeline migration can happen in parallel with workload migration                |
| **P4 -- Advanced features**    | #67--70 (service mesh), #75--80 (CSA-in-a-Box integration)                              | Service mesh and data platform integration after core workloads are stable       |

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
**Related:** [Why AKS](why-aks.md) | [Cluster Migration](cluster-migration.md) | [Workload Migration](workload-migration.md) | [Security Migration](security-migration.md)
