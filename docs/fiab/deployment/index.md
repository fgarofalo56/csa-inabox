# CSA Loom — Deployment

Deploying CSA Loom takes about 60-100 minutes from start to a working
Loom Console URL in your tenant. The platform is shipped as
infrastructure-as-code; you deploy it into your own Azure
subscription via one of two paths.

## Deployment paths

<div class="grid cards" markdown>

-   :material-rocket: [**Quick Start (60 minutes)**](quickstart.md)

    The fastest happy path against Azure Commercial. Use this if
    you're evaluating Loom and want the shortest path to a working
    Console.

-   :material-console: [**`azd up` CLI**](azd-cli.md)

    Power-user path with full Bicep visibility. Best for platform
    engineers + production deploys.

-   :material-mouse: [**"Deploy to Azure" button**](deploy-button.md)

    Click the button in the README; the Azure portal opens with a
    pre-rendered ARM template. Best for evaluators who prefer the
    portal.

</div>

## Per-boundary guides

<div class="grid cards" markdown>

-   :material-cloud: [**Azure Commercial**](commercial.md)

    The full Loom stack; UC managed catalog; Foundry Agent Service;
    Container Apps everywhere.

-   :material-government: [**Azure Government — GCC**](gcc.md)

    GCC = Azure Commercial regions under M365 GCC identity. P-SKU
    Power BI (no F-SKU; no Direct Lake parity in GCC).

-   :material-shield-account: [**Azure Government — GCC-High / IL4**](gcc-high.md)

    Azure Government cloud. AKS instead of Container Apps; Purview-
    primary catalog; MAF + AOAI direct as orchestrator (no Foundry
    Agent Service in Gov).

-   :material-shield-star: **DoD IL5 (v1.1)**

    *Available in v1.1.* Atlas-on-AKS catalog (Purview not in IL5
    audit scope); HSM-CMK storage; customer-managed plan only.

</div>

## Tenancy modes

<div class="grid cards" markdown>

-   :material-domain: **Single-sub mode**

    Admin Plane + 1 DLZ in same subscription. Trials, small agencies,
    single-mission POCs. Convert to multi-sub later via Console.

-   :material-source-branch: [**Multi-sub mode**](multi-sub-multi-tenant.md)

    Admin Plane in sub-A; each DLZ in its own subscription. Production
    federal pattern; aligns with CAF Data Landing Zone model.

</div>

## Lifecycle

<div class="grid cards" markdown>

-   :material-update: [**Upgrade lifecycle**](upgrade.md)

    `azd up` re-run picks up new module versions. Console "Updates"
    pane shows release notes.

-   :material-storefront: [**Marketplace (deferred)**](marketplace.md)

    Azure Marketplace Managed Application listing is deferred to
    backlog per locked decision LD-4. See page for context + future
    pricing model placeholder.

</div>

## Prerequisites checklist

Before you start, you need:

| Item | Notes |
|---|---|
| Azure subscription with **Contributor + User Access Administrator** on the target sub | Single-sub mode needs one sub; multi-sub needs one per DLZ |
| Microsoft Entra tenant with admin rights to create Entra groups + role assignments | Loom uses Entra groups for FiaB Admins / Workspace Admins / Domain Stewards |
| Available **/16 IP range per DLZ** (private address space, peerable to Admin Plane hub) | Hub default `10.0.0.0/16`; DLZ defaults `10.N.0.0/16` |
| `az` CLI installed (latest) | For `azd up` path |
| `azd` CLI installed | For `azd up` path |
| Power BI Premium F-SKU (GCC-H / IL5) or P-SKU (GCC) | For semantic model + Direct Lake parity |
| Quota for Databricks Premium workspace in target region | Check via `az vm list-usage` |
| Quota for ADX cluster (D14_v2 minimum recommended) | |
| Quota for Azure OpenAI capacity (TPM allocation) | gpt-4o or gpt-4.1; usgovvirginia for Gov |
| Internet egress for ACR image pulls (or pre-loaded ACR) | Container images come from a Microsoft public ACR; pre-mirror to your ACR if egress restricted |

Detailed per-boundary prerequisite checklists in the per-boundary
guides above.

## What gets deployed

A v1 multi-sub deploy creates roughly:

| Component | Quantity per Admin Plane | Quantity per DLZ |
|---|---|---|
| Resource groups | ~5 | ~6 |
| VNets | 1 hub | 1 spoke (peered to hub) |
| Private DNS zones | ~12 (centralized in hub) | 0 (linked to hub zones) |
| Storage accounts | 2 (KV + logging) | 3-5 (per workspace) |
| Container App Env or AKS cluster | 1 | 1 |
| Container Apps / AKS workloads | ~5 (Console, MCP, Copilot, etc.) | ~4 (parity services) |
| Databricks workspaces | 0 | 1 |
| Synapse workspaces | 0 | 1 |
| ADX clusters | 1 (shared) | 0 (database on shared) |
| Power BI Premium workspaces | 0 | 1+ per workspace |
| AI Foundry / Azure ML Hub | 1 | 0 |
| AI Search | 1 (S1+) | 0 |
| Purview accounts | 1 (Commercial/GCC/GCC-H) | 0 |
| Key Vault Premium HSM | 1 | 1 |

Cost estimate (Commercial F8-sizing): ~$3-5K/month underlying Azure
consumption + zero Loom IP cost in v1.

## Validation gates per deploy

After deploy completes, the Loom Console performs a built-in
health check:

- All Container Apps / AKS workloads passing `/health`
- All Private Endpoints resolving correctly
- Workspace Identity round-trip OK (Console can author a workspace
  via MCP)
- Catalog round-trip OK (read schema from UC / Purview)
- Power BI workspace creation via REST OK
- Sample data ingest + query OK (canary workspace)

Failures surface in Console "Monitoring" pane with remediation
suggestions.

## Where to next

After your first deploy:

1. **Create your first workspace** — [Tutorial 01 — First workspace](../tutorials/01-first-workspace.md)
2. **Ingest your first dataset** — [Tutorial 02 — First lakehouse](../tutorials/02-first-lakehouse.md)
3. **Set up your first Direct Lake-parity semantic model** —
   [Tutorial 03 — Direct Lake parity](../tutorials/03-direct-lake-parity.md)
4. **Plan your forward migration** to Fabric —
   [Forward to Fabric runbook](../operations/forward-to-fabric.md)

## Help

- **Runbooks** for deploy failures: [Deploy failure runbook](../runbooks/deploy-failure.md)
- **Internal channel:** Microsoft `#csa-loom-build` Teams channel
- **External issues:** [GitHub Issues](https://github.com/fgarofalo56/csa-inabox/issues)
  labeled `csa-loom`
