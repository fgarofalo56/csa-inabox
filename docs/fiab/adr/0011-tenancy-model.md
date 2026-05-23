# fiab-0011: Tenancy model — DMZ + DLZ + workspace-as-data-product

**Status:** Accepted
**Date:** 2026-05-22
**Locked decision ref:** LD-6

## Context

CSA Loom needs to map its conceptual surface (admin plane,
workspaces, domains) to Azure entities (subscriptions, resource
groups). The mapping matters because:

1. Federal customers usually want **subscription-level cost separation
   per domain / agency / mission area** — workspace-per-subscription
   would explode the subscription count
2. Microsoft CAF / ESLZ has established the **Data Landing Zone**
   pattern (subscription = DLZ; data products = RGs inside)
3. Microsoft Fabric uses workspace as the unit of self-service inside
   a tenant (workspaces bind to capacities; capacities are tenant-
   scoped)

The user's original description was "workspace = subscription" but the
more correct alignment is:

| ESLZ concept | Loom concept |
|---|---|
| Data Management Zone (sub) | Loom Admin Plane |
| Data Landing Zone (sub) | Loom Data Landing Zone (DLZ) |
| Data Product (RG inside DLZ) | Loom Workspace |

This is the "logical scope-of-self-service" level — both DLZs and
Fabric workspaces are the unit where a domain team operates.

## Decision

**Three-tier tenancy:**

1. **Admin Plane** — one subscription per organization. Hosts the
   Loom Console, Setup Wizard, MCP server, Copilot runtime, catalog
   overlay, AI Foundry / Azure ML Hub, AI Search, monitoring, Key
   Vault, shared services
2. **Data Landing Zone (DLZ)** — one subscription per domain / agency
   / mission. Hosts Databricks workspace + Synapse Serverless +
   ADX database + ADLS Gen2 + Power BI Premium + per-DLZ parity
   services (Activator, Mirroring, Direct-Lake-Shim)
3. **Loom Workspace** — one resource group per workspace, inside the
   DLZ. Hosts the per-team / per-project items (lakehouses,
   warehouses, semantic models, notebooks, KQL DBs, activator rules,
   data agents)

A single DLZ hosts multiple workspaces. A workspace is bound to one
DLZ at creation time.

**Two deployment modes** (Marketplace createUiDefinition equivalent
in azd CLI prompts):
- **Single-sub mode**: Admin Plane + 1 DLZ in same subscription
  (trial / small agency / POC). Maximum 1 DLZ; converting to
  multi-sub via Console "Convert to multi-sub" flow
- **Multi-sub mode**: Admin Plane in sub-A; each DLZ in its own
  subscription (sub-B, sub-C, ..., sub-N). Spoke VNets in each DLZ
  peer to Admin Plane hub VNet. Single Entra tenant; identical Entra
  groups across subs

## Consequences

### Positive

- Federal customers get subscription-level cost separation per
  domain (single most-requested federal pattern)
- Aligns with Microsoft CAF / ESLZ Data Landing Zone pattern —
  customers' Azure governance + policy teams already understand it
- Workspace-per-RG inside DLZ is fine-grained enough for team-level
  isolation without exploding subscription count
- Single Admin Plane simplifies cross-domain governance (catalog,
  catalog scans, Copilot agent registration)
- Multi-sub mode supports the "agency adds new domain via Console"
  pattern — new sub → DLZ Bicep deploys into it

### Negative

- Multi-sub mode requires customer to manage multiple subscriptions
  in Entra + Azure RBAC + cost reporting
- Cross-sub VNet peering adds networking complexity (managed by
  Bicep; transparent to user)
- Workspace creation goes through MCP-driven Bicep deploy inside the
  DLZ subscription — adds ~30-60 seconds latency vs portal-direct
- Single-sub-to-multi-sub conversion is a documented runbook (PRP-17)
  but is a one-time disruption for customers who outgrow single-sub

### Neutral

- Workspace = RG = lifecycle unit — delete workspace = delete RG
- DLZ subscription identity remains the customer's; Loom MCP MI has
  JIT Contributor when deploying into it; no persistent publisher
  access

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Workspace = subscription | Explodes subscription count; federal customers can't manage 50+ subs |
| All-in-one subscription | Loses domain-level cost separation; loses blast-radius isolation |
| Workspace = management group | Management groups aren't billing units; doesn't solve cost separation |
| Single DLZ pattern (no workspaces) | Loses team-level isolation inside a domain; would force one domain = one team |

## References

- PRD: [`temp/fiab-prd/04-reference-architecture.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/04-reference-architecture.md) §4.2
- Amendments: [`temp/fiab-prd/AMENDMENTS.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md) §A5
- External: [Microsoft CAF Data Landing Zones](https://learn.microsoft.com/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/architectures/data-landing-zone), [Azure/data-management-zone](https://github.com/Azure/data-management-zone), [Azure/data-landing-zone](https://github.com/Azure/data-landing-zone)
- Build: PRP-02 — `platform/fiab/bicep/modules/admin-plane/` + `landing-zone/`
