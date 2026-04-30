# Migration -- On-Premises Kubernetes / OpenShift to AKS

**Status:** Authored 2026-04-30
**Audience:** Federal CIO / CTO / Platform Engineering leads running self-managed Kubernetes clusters or Red Hat OpenShift on-premises and moving container workloads to Azure.
**Scope:** Full migration from self-managed Kubernetes (kubeadm, Rancher, Tanzu) and Red Hat OpenShift (OCP 4.x) to Azure Kubernetes Service (AKS), Azure Red Hat OpenShift (ARO), or AKS on Azure Stack HCI for hybrid scenarios. CSA-in-a-Box integration for containerized data pipelines, Spark on Kubernetes, and model serving.

---

!!! tip "Expanded Migration Center Available"
This playbook is the core migration reference. For the complete Kubernetes-to-AKS migration package -- including architecture deep-dives, networking guides, tutorials, benchmarks, and federal-specific guidance -- visit the **[Kubernetes to AKS Migration Center](kubernetes-to-aks/index.md)**.

    **Quick links:**

    - [Why AKS (Executive Brief)](kubernetes-to-aks/why-aks.md)
    - [Total Cost of Ownership Analysis](kubernetes-to-aks/tco-analysis.md)
    - [Complete Feature Mapping (50+ features)](kubernetes-to-aks/feature-mapping-complete.md)
    - [Federal Migration Guide](kubernetes-to-aks/federal-migration-guide.md)
    - [Tutorials & Walkthroughs](kubernetes-to-aks/index.md#tutorials)
    - [Benchmarks & Performance](kubernetes-to-aks/benchmarks.md)
    - [Best Practices](kubernetes-to-aks/best-practices.md)

    **Migration guides by domain:** [Cluster Migration](kubernetes-to-aks/cluster-migration.md) | [Workload Migration](kubernetes-to-aks/workload-migration.md) | [Storage](kubernetes-to-aks/storage-migration.md) | [Networking](kubernetes-to-aks/networking-migration.md) | [Security](kubernetes-to-aks/security-migration.md) | [CI/CD](kubernetes-to-aks/cicd-migration.md)

---

## 1. Executive summary

Container platform modernization is accelerating across the federal landscape. Organizations running self-managed Kubernetes on bare metal or VMs -- or Red Hat OpenShift in their data centers -- face escalating operational costs: control-plane patching, etcd backup management, certificate rotation, CNI plugin maintenance, and the constant burden of keeping clusters current with upstream Kubernetes releases that ship every four months.

AKS eliminates the control-plane operations tax. Microsoft manages the API server, etcd, scheduler, and controller-manager. The control plane is free. Upgrades, patches, and certificate rotation are automated. AKS is CNCF conformant -- every standard Kubernetes manifest, Helm chart, and operator that runs on self-managed clusters runs on AKS without modification to the workload layer.

For Red Hat shops with significant OpenShift investment, Azure Red Hat OpenShift (ARO) provides a fully managed OpenShift 4.x experience on Azure, co-managed by Microsoft and Red Hat. Organizations that want to preserve their OpenShift tooling (Routes, DeploymentConfigs, BuildConfigs, OperatorHub) can migrate to ARO with minimal application changes while still gaining Azure-native integration.

CSA-in-a-Box extends the AKS story for data platform teams. Containerized data pipelines (Spark on Kubernetes via the Spark Operator, dbt runners, Airflow/ADF orchestration), model serving endpoints (Triton, TorchServe, vLLM on AKS with GPU node pools), and event-driven data processing (KEDA-scaled consumers pulling from Event Hubs) all run on AKS and integrate with the broader CSA-in-a-Box governance, lineage, and compliance framework.

This playbook is honest. Self-managed Kubernetes gives you total control. OpenShift gives you a mature enterprise platform with integrated CI/CD (Source-to-Image), a developer console, and an operator ecosystem. AKS trades some of that control for operational simplicity, Azure-native integration, and cost reduction. For workloads that require bare-metal performance, custom kernel tuning, or air-gapped environments without any Azure connectivity, self-managed Kubernetes or OpenShift may remain the right choice. This document is for teams that have decided to move.

### Federal considerations -- self-managed K8s/OpenShift vs AKS

| Consideration      | Self-managed / OpenShift today        | AKS on Azure Gov                                 | Notes                                             |
| ------------------ | ------------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| FedRAMP High       | Customer responsibility               | Inherited through Azure Gov                      | AKS inherits Azure Government FedRAMP High P-ATO  |
| DoD IL4            | Customer responsibility               | Covered on Azure Gov                             | AKS available in all Azure Gov regions            |
| DoD IL5            | Customer responsibility               | Covered on Azure Gov                             | AKS supports IL5 in Azure Gov IL5 regions         |
| STIG compliance    | Manual DISA STIG application          | AKS CIS benchmarks + Azure Policy STIG baselines | AKS Ubuntu/Mariner images align with CIS L1       |
| FIPS 140-2         | Manual kernel + library configuration | AKS FIPS-enabled node pools (native)             | `--enable-fips-image` flag on node pool creation  |
| Container scanning | Manual (Trivy, Clair, Anchore)        | Defender for Containers (integrated)             | Automated vulnerability scanning in ACR + runtime |
| CMMC 2.0 Level 2   | Customer-managed                      | Controls mapped in CSA-in-a-Box compliance YAMLs | Inherits from Azure Gov baseline                  |
| ITAR               | Data-center level controls            | Azure Government tenant-binding                  | Data residency guaranteed                         |

---

## 2. Decide first: migration target

| Your situation                                        | Recommended target           | Why                                                                   |
| ----------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| Standard Kubernetes (kubeadm, Rancher, k3s)           | **AKS**                      | Free control plane, full CNCF conformance, lowest cost                |
| Red Hat OpenShift with heavy OCP-specific tooling     | **ARO**                      | Preserves Routes, SCC, OperatorHub; co-managed by Microsoft + Red Hat |
| Hybrid requirement (some workloads must stay on-prem) | **AKS Hybrid (Arc-enabled)** | Single management plane across on-prem + Azure                        |
| Edge or disconnected scenarios                        | **AKS on Azure Stack HCI**   | Kubernetes at the edge with Azure management                          |
| VMware Tanzu on vSphere                               | **AKS**                      | Tanzu → AKS; combine with VMware-to-Azure migration                   |
| Data platform containerized workloads                 | **AKS + CSA-in-a-Box**       | Spark on K8s, model serving, event-driven pipelines                   |
| Federal/DoD with STIG + FIPS requirements             | **AKS on Azure Gov**         | FIPS node pools, Defender for Containers, Azure Policy                |

---

## 3. Capability mapping -- Self-managed K8s / OpenShift to AKS

### Core platform

| Source capability                             | AKS equivalent                        | Effort | Notes                                            |
| --------------------------------------------- | ------------------------------------- | ------ | ------------------------------------------------ |
| Control plane (self-managed etcd, API server) | AKS managed control plane (free tier) | N/A    | Microsoft manages; customer configures           |
| kubeadm cluster bootstrap                     | `az aks create` / Bicep / Terraform   | XS     | Single command or IaC template                   |
| Manual Kubernetes upgrades                    | AKS auto-upgrade channels             | XS     | Channels: none, patch, stable, rapid, node-image |
| etcd backup + restore                         | AKS-managed etcd (automatic)          | N/A    | Microsoft handles backup/restore                 |
| Certificate management                        | AKS-managed certificates              | N/A    | Auto-rotation for cluster certificates           |
| Node OS patching                              | AKS node image upgrades + kured       | XS     | Automatic with node-image channel                |

### OpenShift-specific

| OpenShift feature            | AKS equivalent                            | Effort | Notes                                            |
| ---------------------------- | ----------------------------------------- | ------ | ------------------------------------------------ |
| Routes                       | Ingress (NGINX/AGIC) + cert-manager       | S      | Standard Kubernetes Ingress replaces Routes      |
| DeploymentConfig             | Deployment (standard K8s)                 | XS     | 1:1 mapping; remove OCP-specific fields          |
| BuildConfig / S2I            | Dockerfile + ACR Build Tasks              | S      | ACR Tasks replaces Source-to-Image               |
| ImageStreams                 | ACR repositories + tags                   | S      | ACR provides equivalent image management         |
| Security Context Constraints | Pod Security Standards + Azure Policy     | M      | PSS replaces SCC; Gatekeeper for custom policies |
| OperatorHub / OLM            | Helm charts + AKS extensions              | M      | Most operators available as Helm charts          |
| OpenShift Console            | Azure Portal + kubectl + Lens/K9s         | S      | Azure Portal provides cluster management UI      |
| OpenShift Service Mesh       | Istio on AKS (AKS addon)                  | S      | Same Istio upstream; managed by AKS              |
| OpenShift Pipelines (Tekton) | GitHub Actions / Azure Pipelines / Tekton | S      | Tekton runs on AKS unchanged                     |
| OpenShift GitOps (ArgoCD)    | ArgoCD / Flux (AKS extension)             | XS     | Both GitOps tools run on AKS natively            |

### Networking

| Source                                 | AKS equivalent                         | Effort | Notes                                                  |
| -------------------------------------- | -------------------------------------- | ------ | ------------------------------------------------------ |
| Calico / Flannel / Cilium CNI          | Azure CNI Overlay / Azure CNI + Cilium | S      | Azure CNI Overlay for most; Cilium for advanced policy |
| MetalLB (bare-metal LB)                | Azure Load Balancer (integrated)       | XS     | Automatic provisioning via Service type: LoadBalancer  |
| HAProxy / F5 Ingress                   | NGINX Ingress / AGIC / Contour         | S      | AGIC for Application Gateway integration               |
| CoreDNS (self-managed)                 | CoreDNS (AKS-managed)                  | N/A    | AKS manages CoreDNS automatically                      |
| Network policies (self-managed Calico) | Azure NPM / Calico / Cilium on AKS     | XS     | Existing Calico policies work on AKS                   |

### Storage

| Source                | AKS equivalent                                  | Effort | Notes                                         |
| --------------------- | ----------------------------------------------- | ------ | --------------------------------------------- |
| Local NVMe / hostPath | Azure Disk (Premium/Ultra) or local NVMe (LSv3) | S      | Local NVMe available on storage-optimized VMs |
| NFS server            | Azure Files NFS / Azure NetApp Files            | S      | Managed NFS with CSI driver                   |
| Ceph / Rook           | Azure Disk / Azure Files / Azure Blob CSI       | M      | Replace Ceph with managed Azure storage       |
| GlusterFS             | Azure Files SMB/NFS                             | S      | Direct replacement for shared storage         |
| Velero backups        | Velero on AKS + Azure Blob storage              | XS     | Same Velero; Azure Blob as backup target      |

---

## 4. Migration sequence (phased project plan)

A mid-size Kubernetes/OpenShift to AKS migration runs 16--24 weeks depending on workload complexity, stateful service count, and compliance requirements.

### Phase 0 -- Discovery (Weeks 1--2)

- Inventory all clusters: node counts, Kubernetes versions, namespaces, workloads, CRDs, operators, custom controllers.
- Catalog storage: PV types, storage classes, data volumes, backup strategies.
- Map networking: CNI plugin, Ingress controllers, Service Mesh, network policies, DNS, load balancers, external IPs.
- Assess OpenShift-specific dependencies: Routes, DeploymentConfigs, BuildConfigs, ImageStreams, SCCs, OperatorHub operators.
- Identify stateful workloads requiring data migration planning.
- Map RBAC: cluster roles, service accounts, namespace-level bindings to Entra ID groups.
- Tag each workload: migrate as-is, refactor, retire, or keep on-prem.

**Success criteria:** Full workload inventory; prioritized wave plan; known blockers surfaced.

### Phase 1 -- Landing zone (Weeks 3--5)

- Deploy AKS cluster(s) via Bicep or Terraform.
- Configure node pools: system pool, user pools (CPU, GPU, memory-optimized).
- Enable Azure CNI Overlay or Cilium.
- Configure Azure Container Registry (ACR) and enable Defender for Containers.
- Deploy Ingress controller (NGINX or AGIC).
- Configure Azure Key Vault Secrets Provider.
- Enable Azure Monitor Container Insights + Managed Prometheus + Managed Grafana.
- Set up GitOps (Flux or ArgoCD) for cluster configuration.

**Success criteria:** AKS cluster operational; CI/CD pipeline deploying to cluster; monitoring active.

### Phase 2 -- Pilot workload (Weeks 5--8)

Port a single stateless application end-to-end:

1. Convert OpenShift manifests to standard Kubernetes (remove DeploymentConfig, Route, SCC).
2. Push container images to ACR.
3. Deploy via Helm or Kustomize.
4. Configure Ingress with TLS (cert-manager + Let's Encrypt or Azure Key Vault).
5. Validate functionality, performance, monitoring.
6. Dual-run for 1 week; compare metrics.

**Success criteria:** Pilot application running on AKS; performance parity; monitoring operational.

### Phase 3 -- Stateless workload migration (Weeks 8--14)

- Migrate stateless workloads in waves (5--10 applications per wave).
- Convert manifests, update Helm charts, migrate CRDs.
- Update CI/CD pipelines to target AKS + ACR.
- Cut over DNS per application.

### Phase 4 -- Stateful workload migration (Weeks 12--18)

- Migrate StatefulSets with persistent storage.
- Use Velero for backup/restore across clusters.
- For databases: use application-level replication where possible; Velero PV snapshots as fallback.
- Validate data integrity post-migration.

### Phase 5 -- Data platform integration (Weeks 16--22)

- Deploy Spark Operator on AKS for containerized Spark workloads.
- Configure model serving (Triton / vLLM) on GPU node pools.
- Set up KEDA autoscaling for Event Hubs consumers.
- Integrate with CSA-in-a-Box governance (Purview scanning of AKS workloads, Unity Catalog for Spark on K8s).

### Phase 6 -- Decommission (Weeks 20--24)

- Verify all workloads running on AKS with production traffic.
- Decommission on-prem clusters.
- Archive etcd backups.
- Publish cost comparison (on-prem vs AKS).

---

## 5. Worked example -- PostgreSQL + API tier migration

### Source state (on-prem K8s)

```yaml
# PostgreSQL StatefulSet on on-prem cluster
apiVersion: apps/v1
kind: StatefulSet
metadata:
    name: postgres
    namespace: app-prod
spec:
    replicas: 3
    selector:
        matchLabels:
            app: postgres
    template:
        spec:
            containers:
                - name: postgres
                  image: registry.internal.gov/postgres:15.4
                  ports:
                      - containerPort: 5432
                  volumeMounts:
                      - name: pgdata
                        mountPath: /var/lib/postgresql/data
    volumeClaimTemplates:
        - metadata:
              name: pgdata
          spec:
              storageClassName: ceph-block
              accessModes: ["ReadWriteOnce"]
              resources:
                  requests:
                      storage: 100Gi
```

### Target state (AKS)

```yaml
# PostgreSQL StatefulSet on AKS
apiVersion: apps/v1
kind: StatefulSet
metadata:
    name: postgres
    namespace: app-prod
spec:
    replicas: 3
    selector:
        matchLabels:
            app: postgres
    template:
        spec:
            containers:
                - name: postgres
                  image: csainaboxacr.azurecr.io/postgres:15.4 # ACR
                  ports:
                      - containerPort: 5432
                  env:
                      - name: PGPASSWORD
                        valueFrom:
                            secretKeyRef:
                                name: postgres-secrets
                                key: password
                  volumeMounts:
                      - name: pgdata
                        mountPath: /var/lib/postgresql/data
            nodeSelector:
                agentpool: dbpool # Dedicated node pool for databases
    volumeClaimTemplates:
        - metadata:
              name: pgdata
          spec:
              storageClassName: managed-premium # Azure Managed Disk Premium SSD
              accessModes: ["ReadWriteOnce"]
              resources:
                  requests:
                      storage: 100Gi
```

**Key changes:** Container registry (internal registry to ACR), storage class (Ceph to Azure Managed Disk), node selector (dedicated DB node pool), secrets (migrated to Azure Key Vault via Secrets Provider).

---

## 6. Cost comparison summary

For a typical mid-size federal Kubernetes estate (6 clusters, 120 nodes, 800 pods):

| Cost category                 | Self-managed K8s (on-prem)         | OpenShift (on-prem)            | AKS (Azure Gov)                    |
| ----------------------------- | ---------------------------------- | ------------------------------ | ---------------------------------- |
| **Control plane**             | $0 (self-managed labor)            | Included in OCP sub            | Free (AKS free tier)               |
| **Infrastructure**            | $800K--$1.5M/yr (servers + DC)     | $800K--$1.5M/yr (servers + DC) | $400K--$900K/yr (VMs)              |
| **OpenShift subscription**    | N/A                                | $400K--$800K/yr                | N/A                                |
| **Platform engineering FTEs** | 6--8 FTEs ($900K--$1.3M/yr)        | 4--6 FTEs ($600K--$900K/yr)    | 2--3 FTEs ($300K--$500K/yr)        |
| **Networking**                | $100K--$200K/yr                    | $100K--$200K/yr                | ExpressRoute: $100K--$200K/yr      |
| **Container registry**        | $50K--$100K/yr (Harbor/Quay)       | Included (Quay)                | ACR: $20K--$50K/yr                 |
| **Monitoring**                | $100K--$200K/yr (Prometheus stack) | $100K--$200K/yr                | Container Insights: $50K--$100K/yr |
| **3-year total**              | $5.8M--$10.2M                      | $6.0M--$10.8M                  | $2.6M--$5.2M                       |

!!! note "Cost model is illustrative"
Actual costs depend on node sizes, workload density, storage volumes, network egress, reserved instance commitments, and Azure Government pricing (~25% premium over commercial). Use the [detailed TCO analysis](kubernetes-to-aks/tco-analysis.md) for a rigorous comparison.

---

## 7. How CSA-in-a-Box fits

The Kubernetes-to-AKS migration is a container platform migration. CSA-in-a-Box is a data platform. They are complementary and deeply integrated:

1. **Spark on Kubernetes**: CSA-in-a-Box data pipelines can run Spark jobs on AKS via the Spark Operator, sharing the same cluster infrastructure with application workloads while connecting to ADLS Gen2, Unity Catalog, and Purview for governance.

2. **Model serving**: AI models trained in Azure ML or Databricks deploy to AKS GPU node pools using Triton Inference Server, vLLM, or custom serving containers, registered in AI Foundry and governed by Purview.

3. **Event-driven data processing**: KEDA on AKS auto-scales data consumers based on Event Hubs queue depth, enabling elastic ingestion pipelines that feed the CSA-in-a-Box medallion architecture.

4. **dbt runners**: Containerized dbt jobs run on AKS as Kubernetes Jobs or CronJobs, executing transformations against Databricks SQL Warehouses or Fabric SQL endpoints.

5. **Data API layer**: Containerized APIs on AKS serve data products from the CSA-in-a-Box data marketplace, with traffic management via AGIC, authentication via Entra Workload Identity, and observability via Container Insights.

---

## 8. Federal considerations

- **AKS in Azure Government**: available in US Gov Arizona, US Gov Virginia, US Gov Texas, DoD Central, DoD East
- **FIPS 140-2**: native FIPS-enabled node pools (`--enable-fips-image`)
- **STIG compliance**: CIS benchmarks enforced via Azure Policy; DISA STIG baselines for container hardening
- **Defender for Containers**: runtime threat protection, vulnerability scanning, admission control
- **Image provenance**: Notary v2 (Notation) for container image signing and verification
- **Private clusters**: AKS private clusters with Private Link for API server access
- **Air-gapped options**: AKS on Azure Stack HCI for disconnected/DDIL environments

For detailed federal guidance, see the [Federal Migration Guide](kubernetes-to-aks/federal-migration-guide.md).

---

## 9. Gaps and roadmap

| Gap                          | Description                                                                                               | Planned remediation                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **OpenShift feature parity** | Some OCP-specific CRDs (DeploymentConfig triggers, ImageStream auto-import) have no direct AKS equivalent | Manual conversion; ARO for teams needing full OCP compatibility          |
| **Air-gapped AKS**           | Full air-gapped AKS requires Azure Stack HCI; cloud-connected AKS needs outbound connectivity             | AKS outbound type `none` + private clusters reduce exposure              |
| **GPU availability**         | GPU node pool SKUs may have limited availability in Azure Gov regions                                     | Check regional availability; quota requests may be needed                |
| **Operator migration**       | No automated tool for converting OLM-managed operators to Helm-based deployments                          | Manual conversion per operator; community Helm charts available for most |

---

## 10. Related resources

- **Migration index:** [docs/migrations/README.md](README.md)
- **Kubernetes to AKS Migration Center:** [kubernetes-to-aks/index.md](kubernetes-to-aks/index.md)
- **AKS Documentation:** [Microsoft Learn - Azure Kubernetes Service](https://learn.microsoft.com/azure/aks/)
- **ARO Documentation:** [Microsoft Learn - Azure Red Hat OpenShift](https://learn.microsoft.com/azure/openshift/)
- **CSA-in-a-Box Architecture:** [docs/ARCHITECTURE.md](../ARCHITECTURE.md)
- **Government Service Matrix:** [docs/GOV_SERVICE_MATRIX.md](../GOV_SERVICE_MATRIX.md)
- **Cost Management:** [docs/COST_MANAGEMENT.md](../COST_MANAGEMENT.md)
- **Companion playbooks:** [vmware-to-azure.md](vmware-to-azure.md), [aws-to-azure.md](aws-to-azure.md)

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
