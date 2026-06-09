# ops-copilot — parity with the Azure portal operational actions (capacity scale, network access toggle, workspace create)

Source UI:
- Synapse dedicated SQL pool scale — Azure portal → Synapse workspace → SQL pools → Scale (Learn: `azure/synapse-analytics/sql-data-warehouse/quickstart-scale-compute-portal`)
- Synapse workspace networking / "Allow Azure services" — Azure portal → Synapse workspace → Networking (`properties.trustedServiceBypassEnabled`)
- Azure Data Explorer cluster scale-up (SKU) — Azure portal → ADX cluster → Scale up (Learn: `azure/data-explorer/manage-cluster-vertical-scaling`)
- Workspace create — Loom-native workspace (Cosmos), the Azure-native default per `no-fabric-dependency.md`

The Ops Admin Copilot is the natural-language front door to these same operations. It does not replace the explicit cards in **Scale & manage** — it sits beside them and produces the *same* real ARM/Cosmos writes, gated by an approval diff and an RBAC check.

## Azure feature inventory → Loom coverage

| Capability (Azure portal) | Loom coverage | Backend per control |
|---|---|---|
| Scale dedicated SQL pool to a new DWU SKU (DW100c…DW30000c) | ✅ NL → diff → execute | `synapse-dev-client.updateDedicatedPoolSku` → ARM `PATCH .../sqlPools/{pool}` `{sku:{name}}` |
| Read current pool SKU/state for the diff | ✅ | `synapse-dev-client.getDedicatedPool` |
| Scale ADX cluster to a new VM SKU (+ instance count) | ✅ NL → diff → execute | `kusto-arm-client.updateKustoClusterSku` → ARM `PATCH .../clusters/{c}` |
| Read current ADX SKU/capacity for the diff | ✅ | `kusto-arm-client.getKustoClusterArm` |
| Toggle workspace "allow trusted Azure services" (OAP) | ✅ NL → diff → execute | `arm-client.setSynapseWorkspaceOap` → ARM `PATCH .../workspaces/{ws}` `{properties:{trustedServiceBypassEnabled}}` |
| Read current OAP value for the diff | ✅ | `arm-client.getSynapseWorkspaceOap` |
| Create a workspace | ✅ NL → diff → execute | Cosmos `workspacesContainer.items.create` (PK `/tenantId`) |
| Confirm-before-apply (no accidental mutation) | ✅ approval-diff card; nothing runs until Confirm | classify endpoint reads only; execute endpoint writes |
| Restrict who can run ops actions | ✅ honest RBAC gate | Graph `transitiveMembers` / `checkMemberGroups` vs `LOOM_OPS_ADMIN_ENTRA_GROUP` (Console UAMI `Group.Read.All`) |
| Surface "you lack the role" honestly | ✅ MessageBar names the group + Azure RBAC actions; ARM 403 surfaced verbatim as `roleGate` | route returns `rbacGate` / `roleGate` |
| Resource not provisioned in this deployment | ✅ honest config gate naming the env var | `OpsUnconfiguredError` → `configGate` MessageBar |

Zero ❌, zero stub banners.

## Two-phase flow (why there's no fake success)

1. **Classify** — `POST /api/admin/ops-copilot` calls AOAI with the `ops_*` tool schemas (`tool_choice: required`), reads the current Azure state, and returns an `OpsIntention` + before/after diff. **No mutation.** The pending intention is staged in Cosmos bound to the caller's OID.
2. **Execute** — `POST /api/admin/ops-copilot/execute` re-reads the staged intention (must match caller + still pending), then performs the real ARM/Cosmos write. An ARM 403 (UAMI missing the role) is surfaced verbatim — never a fake "Done".

## RBAC model

- **Caller gate:** when `LOOM_OPS_ADMIN_ENTRA_GROUP` is set, the signed-in admin must be a transitive member of that Entra group. Unset → any signed-in admin (matches the rest of the admin pane). Graph outage is fail-closed for a configured group.
- **Executor gate:** the Console UAMI needs Azure RBAC `Microsoft.Synapse/workspaces/write`, `Microsoft.Synapse/workspaces/sqlPools/write`, `Microsoft.Kusto/clusters/write` on the target — already provided by the Contributor-at-RG grant in `scaling-rbac.bicep`. If missing, ARM 403 → honest `roleGate` MessageBar.

## Per-cloud matrix

| Cloud | ARM base | Graph base | Synapse pool/OAP write | ADX write | Cosmos | Notes |
|---|---|---|---|---|---|---|
| Commercial | management.azure.com | graph.microsoft.com | ✅ | ✅ | documents.azure.com | Full |
| GCC | management.azure.com | graph.microsoft.com | ✅ | ✅ | documents.azure.com | Commercial endpoints |
| GCC-High | management.usgovcloudapi.net | graph.microsoft.us | ✅ | ✅ | documents.azure.us | All resolved by `cloud-endpoints.ts` |
| DoD/IL5 | management.azure.microsoft.scloud | dod-graph.microsoft.us | ✅ | ✅ | documents.azure.us | `armBase()`/`graphBase()` return DoD endpoints |

100% Azure-native — no `api.fabric.microsoft.com` / `api.powerbi.com` is ever called. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Files

- `apps/fiab-console/lib/azure/arm-client.ts` — shared ARM fetch + Synapse OAP read/write
- `apps/fiab-console/lib/azure/copilot-personas.ts` — persona registry (ops-admin)
- `apps/fiab-console/lib/copilot/ops-tools.ts` — tool schemas, classify, intention builders, executor
- `apps/fiab-console/app/api/admin/ops-copilot/route.ts` — classify + RBAC gate
- `apps/fiab-console/app/api/admin/ops-copilot/execute/route.ts` — execute approved intention
- `apps/fiab-console/lib/components/admin/ops-copilot-pane.tsx` — Fluent v9 pane
- `apps/fiab-console/app/admin/capacity/page.tsx` — mounts the pane
- `platform/fiab/bicep/modules/admin-plane/main.bicep` — `loomOpsAdminEntraGroup` param + `LOOM_OPS_ADMIN_ENTRA_GROUP` env var
