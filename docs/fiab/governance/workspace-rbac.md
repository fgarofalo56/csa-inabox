# Workspace RBAC

## Role hierarchy

| Role | Scope | Permissions |
|---|---|---|
| FiaB Admins | Org-level Entra group | Full access; manage Admin Plane + all DLZs |
| FiaB Domain Stewards | Per-domain Entra group | Govern a domain's workspaces |
| FiaB Workspace Admins | Per-workspace Entra group | Manage a workspace (members, settings) |
| FiaB Workspace Members | Per-workspace Entra group | Read + write within a workspace |
| FiaB Workspace Viewers | Per-workspace Entra group | Read-only within a workspace |
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
