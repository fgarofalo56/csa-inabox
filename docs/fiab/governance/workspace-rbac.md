# Workspace RBAC

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


## Role hierarchy

| Role | Scope | Permissions |
|---|---|---|
| Loom Admins | Org-level Entra group | Full access; manage Admin Plane + all DLZs |
| Loom Domain Stewards | Per-domain Entra group | Govern a domain's workspaces |
| Loom Workspace Admins | Per-workspace Entra group | Manage a workspace (members, settings) |
| Loom Workspace Members | Per-workspace Entra group | Read + write within a workspace |
| Loom Workspace Viewers | Per-workspace Entra group | Read-only within a workspace |
| Custom roles | Composed | Grants on specific items + RLS / CLS predicates |

All roles are **Entra groups** managed by the customer's Entra
admin. Loom Console maps groups to internal permissions but doesn't
own the membership.

## Enforcement layers

| Layer | Mechanism |
|---|---|
| Storage | ADLS Gen2 POSIX ACLs + Storage RBAC (service-account separation between DLZs) |
| Engine | UC row filters + column masks (Commercial); Synapse RLS / column masks via views (Gov); Databricks SQL ABAC; Power BI semantic-model RLS; ADX row-level security |
| Loom Console | UI-level resource visibility — a Workspace Viewer can't see other workspaces in the same domain unless explicitly granted |

## Workspace identity

Each workspace gets a **system-assigned UAMI** for outbound
connections. The UAMI is:
- Storage Blob Data Contributor on the workspace's ADLS path
- UC role assignments or Hive grants
- KV Secrets User on workspace-scoped Key Vault references

Workspace identities are independent of human identity — they can
read/write workspace data without a user in the loop (notebook
scheduled refresh, Activator engine action dispatch, etc.).

## OAP (Outbound Access Protection)

Per-workspace egress rules — restrict outbound to allowed data
sources (anti-exfiltration). Enforced via NSG egress rules + Azure
Firewall app rules. Editable from Console "Admin" pane (gated by the
Setup Wizard approval flow).

## Cross-DLZ data sharing

When a workspace in one DLZ needs to read from another DLZ:
1. Source workspace publishes data product to org Marketplace
   (v1.1 Console pane; CLI in v1)
2. Target workspace requests access via Console "Catalog" workflow
3. Source admin approves
4. Delta Sharing protocol or direct UC grant (Commercial) /
   Storage-level grant (Gov)

## Audit

Every RBAC change → Activity Log + Sentinel (Gov). Console "Admin →
Audit" pane surfaces the most common queries.

## Related

- ADR: [fiab-0011 Tenancy model](../adr/0011-tenancy-model.md)
- Lineage: [Lineage](lineage.md)
- Console: [Admin pane](../console/index.md)
- Compliance: [Compliance index](../compliance/index.md)
