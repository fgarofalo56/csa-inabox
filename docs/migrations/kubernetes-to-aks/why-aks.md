# Why AKS: Executive Brief for Container Platform Modernization

**Status:** Authored 2026-04-30
**Audience:** Federal CIOs, CTOs, and platform engineering leadership evaluating Azure Kubernetes Service against self-managed Kubernetes and Red Hat OpenShift.
**Purpose:** Provide an evidence-based business case for AKS adoption, with an honest assessment of where self-managed Kubernetes and OpenShift retain advantages.

---

## The container platform inflection point

Kubernetes won the container orchestration war. It is the undisputed standard for running containerized workloads at scale. But operating Kubernetes clusters is not the same as using Kubernetes. The operational burden of running production Kubernetes -- etcd management, control-plane patching, certificate rotation, upgrade planning, CNI troubleshooting, storage driver maintenance -- consumes 40--60% of a typical platform engineering team's capacity.

This is the core value proposition of AKS: **eliminate the undifferentiated heavy lifting of Kubernetes operations so platform teams can focus on developer productivity, application reliability, and data platform integration**.

AKS is the fastest-growing service on Azure. Microsoft reports over 29,000 AKS clusters running in Azure Government alone. The service processes over 15 million Kubernetes API requests per second globally. It is not a niche offering -- it is the primary container platform for Azure-native organizations.

---

## 1. Managed control plane: the operational argument

### What AKS manages for you

| Control plane component      | Self-managed K8s                                  | OpenShift                              | AKS                                                      |
| ---------------------------- | ------------------------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| **API server**               | Customer provisions, patches, scales              | Red Hat manages (OCP)                  | Microsoft manages                                        |
| **etcd**                     | Customer manages backup, compaction, defrag       | Red Hat manages                        | Microsoft manages (99.95% SLA)                           |
| **Scheduler**                | Customer configures and monitors                  | Red Hat manages                        | Microsoft manages                                        |
| **Controller manager**       | Customer patches and tunes                        | Red Hat manages                        | Microsoft manages                                        |
| **Cloud controller manager** | Customer integrates                               | Red Hat manages                        | Microsoft manages (Azure-native)                         |
| **Certificate rotation**     | Customer automates (cert-manager or manual)       | Automated (OCP)                        | Automated (AKS)                                          |
| **Kubernetes upgrades**      | Customer plans, tests, executes (4-month cadence) | Red Hat release cadence (OCP versions) | Auto-upgrade channels (patch, stable, rapid, node-image) |
| **etcd backup**              | Customer scripts and verifies                     | Automated (OCP)                        | Microsoft manages                                        |
| **API server scaling**       | Customer sizes and scales                         | Red Hat manages                        | Auto-scales based on load                                |
| **Control plane HA**         | Customer configures multi-master                  | Built-in (3+ masters)                  | Built-in (Azure-managed, SLA-backed)                     |
| **Control plane cost**       | Hardware/VM cost + labor                          | Included in OCP subscription           | **Free** (free tier)                                     |

### The control plane cost: free

AKS free tier provides a fully managed control plane at zero cost. The standard tier ($0.10/cluster/hour, ~$73/month) adds a financially backed 99.95% uptime SLA for the control plane and additional features like long-term support (LTS) Kubernetes versions and cluster autoscaler improvements.

Compare this to self-managed Kubernetes where the control plane runs on 3--5 dedicated servers (or VMs) that must be provisioned, patched, backed up, and replaced. Or OpenShift, where the control plane is managed by Red Hat but the subscription cost for 50 worker nodes ranges from $200K to $500K per year depending on the support tier and deployment model.

### Upgrade automation

Kubernetes releases every four months. Each release has a 14-month support window. Self-managed clusters require teams to plan, test, and execute upgrades manually -- a process that typically takes 2--4 weeks per cluster, including staging validation, workload compatibility testing, and production rollout.

AKS auto-upgrade channels reduce this to a configuration choice:

| Channel      | Behavior                                             | Best for                                     |
| ------------ | ---------------------------------------------------- | -------------------------------------------- |
| `none`       | No automatic upgrades                                | Teams wanting full control                   |
| `patch`      | Auto-applies patch versions (e.g., 1.29.2 to 1.29.4) | Most production clusters                     |
| `stable`     | Auto-upgrades to latest stable minor version         | Teams comfortable with minor version changes |
| `rapid`      | Auto-upgrades to latest supported version            | Dev/test environments                        |
| `node-image` | Auto-updates node OS images weekly                   | Security-focused teams                       |

Combined with planned maintenance windows, AKS upgrade automation eliminates the single most time-consuming operational task for Kubernetes platform teams.

---

## 2. Azure integration: the ecosystem argument

### Identity: Entra ID native

AKS integrates natively with Entra ID (formerly Azure AD) for both cluster administration and workload identity:

- **Cluster RBAC**: Entra ID groups map directly to Kubernetes ClusterRoleBindings and RoleBindings. No separate identity provider configuration. No OIDC federation setup. No LDAP connector maintenance.
- **Workload Identity**: Pods authenticate to Azure services (Key Vault, Storage, SQL, Cosmos DB) using federated identity credentials -- no secrets, no managed identity pods, no token refresh logic. The pod's service account token is exchanged for an Entra ID token transparently.
- **Conditional Access**: Apply Entra Conditional Access policies to `kubectl` access -- require MFA, compliant devices, specific network locations, or risk-based evaluation before allowing cluster administration.
- **Privileged Identity Management (PIM)**: Just-in-time elevation for cluster-admin access with approval workflows, time-limited activation, and audit trails.

Compare this to self-managed Kubernetes where identity integration requires deploying and maintaining an OIDC provider (Dex, Keycloak), configuring API server flags, managing certificate rotation for OIDC endpoints, and building custom webhook authenticators.

### Secrets: Azure Key Vault integration

The Azure Key Vault Secrets Provider (CSI driver) mounts Key Vault secrets, keys, and certificates directly into pods as volumes or environment variables. Secrets rotate automatically. No sidecar containers. No init containers pulling secrets at startup. No custom operators watching Secret resources.

```yaml
# Secrets sync from Key Vault to pod
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
    name: azure-kv-secrets
spec:
    provider: azure
    parameters:
        keyvaultName: "kv-csa-prod"
        tenantId: "your-tenant-id"
        objects: |
            array:
              - |
                objectName: db-connection-string
                objectType: secret
              - |
                objectName: tls-cert
                objectType: secret
    secretObjects:
        - secretName: app-secrets
          type: Opaque
          data:
              - objectName: db-connection-string
                key: DATABASE_URL
```

### Container Registry: ACR integration

Azure Container Registry integrates with AKS through managed identity -- no imagePullSecrets, no registry credential rotation, no Docker config secrets to manage. AKS authenticates to ACR automatically. ACR Tasks provide cloud-native image builds (replacing Jenkins-based Docker builds or OpenShift Source-to-Image). Defender for Containers scans images in ACR automatically and blocks deployment of vulnerable images through admission control.

### Monitoring: Azure Monitor Container Insights

Container Insights provides out-of-the-box monitoring for AKS clusters:

- **Metrics**: node CPU/memory/disk, pod CPU/memory/network, container restarts, OOMKills
- **Logs**: container stdout/stderr, Kubernetes events, audit logs
- **Live data**: real-time container logs and metrics in the Azure Portal
- **Prometheus integration**: AKS Managed Prometheus for native Prometheus metric collection without running your own Prometheus server
- **Grafana integration**: AKS Managed Grafana for dashboards without running your own Grafana instance
- **Alerts**: pre-built alert rules for common failure modes (node not ready, pod crash loops, high CPU/memory)
- **Cost analysis**: per-namespace and per-workload cost allocation

Compare this to self-managed clusters where monitoring requires deploying the kube-prometheus-stack (Prometheus Operator, Alertmanager, Grafana, node-exporter, kube-state-metrics), sizing persistent storage for metrics retention, managing Prometheus federation for multi-cluster, and maintaining Grafana dashboards.

### Networking: Azure-native

- **Azure CNI Overlay**: high-performance pod networking without consuming VNet IP addresses per pod
- **Azure CNI powered by Cilium**: eBPF-based networking with advanced network policy, observability, and encryption
- **Azure Load Balancer**: automatic provisioning for Service type: LoadBalancer
- **Application Gateway Ingress Controller (AGIC)**: L7 load balancing with WAF, SSL termination, and URL-based routing integrated with Azure Application Gateway
- **Private clusters**: API server accessible only through Private Link -- no public endpoint
- **Azure Private Link**: connect AKS pods to Azure PaaS services (Storage, SQL, Cosmos, Key Vault) through private endpoints

### Policy: Azure Policy for Kubernetes

Azure Policy for Kubernetes (built on OPA Gatekeeper) provides:

- Pre-built policy initiatives for CIS benchmarks, Pod Security Standards, and STIG baselines
- Custom policy definitions using Rego
- Compliance reporting in Azure Portal
- Audit and deny enforcement modes
- Policy exemptions for specific namespaces or workloads

---

## 3. CNCF conformance: the portability argument

AKS is CNCF Certified Kubernetes. Every standard Kubernetes API, resource type, and behavior works exactly as specified. This means:

- **Helm charts** that run on self-managed Kubernetes run on AKS without modification
- **Kubernetes operators** (Prometheus Operator, cert-manager, external-dns, Strimzi, Spark Operator) deploy and operate identically
- **kubectl**, **Kustomize**, **Skaffold**, **Tilt**, and every standard Kubernetes toolchain work without changes
- **CRDs and custom controllers** work without modification
- **Network policies** (Calico, Cilium) work without modification
- **CSI drivers** (beyond Azure-native) can be installed for specialized storage needs

The migration path from self-managed Kubernetes to AKS is workload-transparent for standard Kubernetes resources. The effort is in infrastructure configuration (networking, storage classes, identity), not in application changes.

For OpenShift, the effort is higher because OpenShift extends Kubernetes with non-standard resources (Routes, DeploymentConfigs, BuildConfigs, ImageStreams, SCCs). These require conversion to standard Kubernetes equivalents. See the [Feature Mapping](feature-mapping-complete.md) for detailed conversion guidance.

---

## 4. Cost: the financial argument

### AKS control plane pricing

| Tier         | Control plane cost               | SLA                          | Key features                                            |
| ------------ | -------------------------------- | ---------------------------- | ------------------------------------------------------- |
| **Free**     | $0                               | No SLA (99.5% design target) | Managed control plane, 10 agents free                   |
| **Standard** | $0.10/cluster/hour (~$73/month)  | 99.95% uptime SLA            | LTS versions, cluster autoscaler, Uptime SLA            |
| **Premium**  | $0.60/cluster/hour (~$438/month) | 99.95% uptime SLA            | Long-term support + advanced networking + AKS Automatic |

### Savings sources

1. **Control plane infrastructure**: eliminate 3--5 control plane servers per cluster (~$50K--$100K/year per cluster in hardware + hosting)
2. **Platform engineering FTEs**: reduce from 6--8 FTEs (self-managed) to 2--3 FTEs (AKS) -- the team shifts from "keep Kubernetes alive" to "make developers productive"
3. **OpenShift subscription elimination**: $200K--$500K/year for a 50-node deployment
4. **Container registry**: ACR ($0.167/day for Standard SKU) replaces self-hosted Harbor or Quay ($50K--$100K/year)
5. **Monitoring infrastructure**: Container Insights + Managed Prometheus replaces self-hosted Prometheus stack (~$100K--$200K/year in infrastructure + labor)
6. **Spot instances**: AKS supports Azure Spot VMs for batch and fault-tolerant workloads at up to 90% discount
7. **Reserved Instances**: 1-year (up to 38% savings) or 3-year (up to 56% savings) commitments on worker node VMs
8. **Cluster autoscaler + node auto-provisioning**: right-size infrastructure automatically, avoiding persistent over-provisioning

### Cost comparison: 50-node deployment (3-year TCO)

| Component             | Self-managed K8s         | OpenShift 4.x        | AKS Standard               |
| --------------------- | ------------------------ | -------------------- | -------------------------- |
| Control plane         | $450K (hardware + ops)   | Included in sub      | $2.6K (standard tier)      |
| Worker nodes          | $1.8M (servers + DC)     | $1.8M (servers + DC) | $1.2M (Azure VMs, 1yr RI)  |
| Platform subscription | N/A                      | $1.2M (OCP Premium)  | N/A                        |
| Registry              | $300K (Harbor)           | Included (Quay)      | $18K (ACR Standard)        |
| Monitoring            | $450K (Prometheus stack) | $300K                | $150K (Container Insights) |
| FTEs (platform team)  | $3.0M (8 FTEs)           | $2.1M (6 FTEs)       | $1.2M (3 FTEs)             |
| Networking            | $300K                    | $300K                | $200K (ExpressRoute)       |
| **3-year total**      | **$6.3M**                | **$5.7M**            | **$2.8M**                  |

See the [detailed TCO analysis](tco-analysis.md) for a rigorous comparison across small, medium, and large deployment scenarios.

---

## 5. Copilot in AKS: the AI-assisted operations argument

Copilot in AKS brings natural-language Kubernetes operations to the Azure Portal:

- **Troubleshoot clusters**: "Why are pods in namespace production crashing?" Copilot queries cluster metrics, logs, and events to provide a diagnosis.
- **Generate YAML**: "Create a deployment for a Python Flask app with 3 replicas and a readiness probe on /health" generates valid Kubernetes YAML.
- **Explain resources**: "Explain why this pod is in CrashBackLoopOff" analyzes container logs, events, and resource limits to identify root cause.
- **Optimize configurations**: "Suggest resource limits for this deployment based on last 7 days of metrics" analyzes Container Insights data.
- **Policy guidance**: "What Azure Policies are blocking this deployment?" identifies which Gatekeeper constraints are preventing admission.

This is not a replacement for experienced platform engineers. It is a force multiplier -- reducing mean-time-to-diagnosis for common operational issues from hours to minutes, and enabling application developers to self-service basic Kubernetes operations without deep platform expertise.

---

## 6. Automatic upgrades and maintenance: the reliability argument

### AKS Automatic (Preview to GA 2025--2026)

AKS Automatic represents the fully managed AKS experience:

- Automatic node pool sizing and VM selection based on workload requirements
- Automatic scaling (node autoscaler + KEDA)
- Automatic upgrades (Kubernetes version + node image)
- Automatic security patching (node OS + runtime)
- Pre-configured with best practices (Pod Security Standards, network policy, Container Insights, Defender for Containers)
- Azure CNI Overlay with Cilium (default)

For new deployments, AKS Automatic reduces the decision surface from dozens of configuration choices to a single `az aks create --sku automatic` command.

### Long-term support (LTS)

AKS Standard and Premium tiers offer Long-Term Support Kubernetes versions with 2 years of community support + patches, compared to the standard 1 year. For federal agencies with slower upgrade cadences or certification requirements, LTS reduces the upgrade pressure from annual to biennial.

---

## 7. CSA-in-a-Box integration: the data platform argument

AKS is not just a container runtime in the CSA-in-a-Box architecture -- it is a first-class compute tier for data workloads:

| Workload                | AKS role                                                       | CSA-in-a-Box integration                                                                             |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Spark on Kubernetes** | Spark Operator runs Spark drivers and executors as pods on AKS | Jobs read/write ADLS Gen2 via managed identity; metadata in Unity Catalog; lineage in Purview        |
| **Model serving**       | Triton / vLLM / TorchServe on GPU node pools (NC, ND series)   | Models registered in AI Foundry; endpoints in data marketplace; inference logs to Container Insights |
| **Event-driven ETL**    | KEDA-scaled consumers reading Event Hubs / Kafka               | Writes to medallion architecture on ADLS Gen2; schema registry integration                           |
| **dbt execution**       | CronJobs running dbt-core containers                           | Transforms against Databricks SQL or Fabric SQL; contracts validated in CI                           |
| **Data APIs**           | REST/GraphQL APIs serving data products                        | Entra Workload Identity auth; AGIC routing; Purview-governed data access                             |
| **Notebook execution**  | Papermill / Jupyter containers for scheduled notebook runs     | Output artifacts to ADLS Gen2; metadata to Purview                                                   |

This integration means organizations migrating to AKS can simultaneously modernize their data platform -- running containerized data workloads on the same infrastructure that serves their application workloads.

---

## 8. Where self-managed Kubernetes and OpenShift still win

This section exists because an honest assessment is more useful than a sales pitch.

### Self-managed Kubernetes advantages

- **Total control**: you own every binary, configuration flag, and kernel parameter. For workloads requiring custom kernel modules, specific Linux distributions, or exotic hardware (FPGAs, custom NICs), self-managed K8s gives you control AKS cannot.
- **Air-gapped environments**: fully disconnected networks with no Azure connectivity. AKS on Azure Stack HCI addresses some of this, but the most restrictive air-gapped environments (SCIF, submarine, forward-deployed) need self-managed Kubernetes.
- **Multi-cloud portability**: if your strategy requires identical Kubernetes configurations across AWS EKS, GCP GKE, Azure AKS, and on-prem, self-managed K8s on VMs provides the highest portability (though at the highest operational cost).
- **Cost at extreme scale**: for organizations running 500+ nodes per cluster with mature operations teams, the per-node cost of self-managed K8s on bare metal can be lower than Azure VM pricing. This only applies to organizations with existing data center capacity and staff.

### OpenShift advantages

- **Developer experience**: OpenShift's integrated developer console, Source-to-Image builds, and opinionated project model provide a more complete developer experience out of the box than AKS, which is more of a building-blocks platform.
- **Operator ecosystem**: OperatorHub + OLM provides a curated, tested operator catalog with lifecycle management. AKS extensions are growing but not yet as comprehensive.
- **Enterprise Linux**: OpenShift runs on Red Hat CoreOS with automated host management. Organizations with deep Red Hat relationships and RHEL standardization may prefer this.
- **Service Mesh**: OpenShift Service Mesh (Istio-based) is deeply integrated with the platform, including the console, monitoring, and routing. AKS Istio addon is functional but less integrated.
- **Existing investment**: teams with years of OpenShift operational knowledge, custom operators built on the OCP SDK, and CI/CD pipelines using BuildConfigs and ImageStreams face real migration costs. ARO preserves this investment on Azure.

### Decision framework

- **Choose AKS** if: standard Kubernetes workloads, Azure-first strategy, cost optimization priority, small-to-medium platform team, new container platform deployment, or data platform integration with CSA-in-a-Box.
- **Choose ARO** if: deep OpenShift dependency (Routes, SCC, OLM, BuildConfigs), Red Hat enterprise agreement, existing OCP operational expertise, and willingness to pay the ARO premium for OpenShift compatibility.
- **Stay self-managed** if: air-gapped with no Azure connectivity, extreme bare-metal performance requirements, multi-cloud parity mandate, or 500+ node clusters with mature dedicated operations teams and existing data center capacity.

---

## 9. Migration risk assessment

| Risk                              | Probability | Impact | Mitigation                                                                  |
| --------------------------------- | ----------- | ------ | --------------------------------------------------------------------------- |
| OpenShift-specific CRD conversion | Medium      | Medium | Feature mapping guide + pilot migration validate conversion                 |
| Persistent volume data loss       | Low         | High   | Velero backup/restore with validation; dual-run during transition           |
| Network policy incompatibility    | Low         | Medium | Test Calico/Cilium policies on AKS before cutover                           |
| CI/CD pipeline disruption         | Medium      | Medium | Parallel pipeline execution during transition                               |
| Performance regression            | Low         | Medium | Benchmark source cluster; validate on AKS before cutover                    |
| Compliance gap during transition  | Low         | High   | Pre-deploy Azure Policy + Defender for Containers before workload migration |
| Team skill gap                    | Medium      | Medium | Microsoft FastTrack for AKS; training budget for platform team              |

---

## 10. Next steps

1. **Read the detailed analysis**: [TCO Analysis](tco-analysis.md) for cost justification, [Feature Mapping](feature-mapping-complete.md) for technical assessment
2. **Assess your current state**: inventory clusters, workloads, and dependencies using the [Cluster Migration](cluster-migration.md) discovery checklist
3. **Run a pilot**: follow the [Tutorial: App Migration](tutorial-app-migration.md) to migrate a single application end-to-end
4. **Plan the migration**: use the phased project plan in the [Migration Playbook](../kubernetes-to-aks.md) as a starting template
5. **Engage Microsoft FastTrack**: request a migration assessment from the AKS FastTrack team for clusters with 50+ nodes or complex workloads

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
**Related:** [Migration Playbook](../kubernetes-to-aks.md) | [Migration Center](index.md) | [Federal Guide](federal-migration-guide.md)
