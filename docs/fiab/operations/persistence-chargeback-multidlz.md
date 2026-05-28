# CSA Loom — Persistence, chargeback, and multi-DLZ deployment

The three operational questions every Loom customer asks once they
get past the first deploy. Honest answers with file-evidence pointers
so platform engineers can verify each claim themselves.

---

## 1. Where does CSA Loom data live? Is it persistent?

**Short answer: yes, persistent. Container restarts lose nothing.**

Every piece of Loom state — workspaces, items, folders, tabs, audit
events, share grants, permissions, user preferences, comments,
notifications — lives in **Cosmos DB**, not in the Container App's
memory. The Container App is stateless; killing it and rolling a new
revision loses zero data.

### Cosmos containers (17, all provisioned by the bicep `cosmos.bicep` module)

| Container | Partition key | What lives there |
|---|---|---|
| `workspaces` | `/tenantId` | Workspace documents (name, description, capacity, domain, owner, timestamps) |
| `items` | `/workspaceId` | Item documents per workspace (every "+ New item" creates one) |
| `folders` | `/workspaceId` | Workspace tree folder structure |
| `workspace-permissions` | `/workspaceId` | Workspace RBAC role bindings |
| `workspace-git` | `/workspaceId` | Per-workspace Git connection config |
| `apps-catalog` | `/tenantId` | Per-tenant installable apps catalog |
| `workloads-catalog` | `/tenantId` | Per-tenant enabled workloads |
| `tenant-themes` | `/tenantId` | Per-tenant branding |
| `tenant-settings` | `/tenantId` | Per-tenant toggles (e.g. `LOOM_GRAPH_USERS_ENABLED` opt-in) |
| `marketplace-listings` | `/tenantId` | Published data products (auto-populated when workspace gets a domain) |
| `audit-log` | `/itemId` | Per-item audit events (created/edited/shared/etc.) |
| `comments` | `/itemId` | Per-item comments |
| `shares` | `/itemId` | Per-item share-link tokens |
| `notifications` | `/userId` | Per-user notifications |
| `user-prefs` | `/userId` | Per-user UI preferences (theme, dismissed Learn drawers, etc.) |
| `tabs-state` | `/userId` | Per-user open-tabs state (the Fabric-parity tab strip) |
| `search-history` | `/userId` | Per-user search history |
| `downloads` | `/userId` | Per-user download history |
| `copilot-sessions` | `/sessionId` | Cross-item Copilot orchestrator conversation history |
| `copilot-help-sessions` | `/userId` | Help Copilot widget conversation history |

**Where the containers are defined:** `apps/fiab-console/lib/azure/cosmos-client.ts:55-103` — every container is created idempotently on first BFF call (`createIfNotExists`). The bicep at `platform/fiab/bicep/modules/landing-zone/cosmos.bicep` provisions the Cosmos account + DB.

### What about file content (notebooks, KQL, code)?

- **Notebook cells, KQL queries, T-SQL** — persisted on the underlying engine (Synapse, Databricks, ADX), not in Loom's Cosmos. Loom only tracks the *pointer* (workspace + item id + engine artifact id) in its `items` container.
- **Lakehouse files** — live in **ADLS Gen2** containers (bronze / silver / gold / landing). Container Apps never touch the data plane; the Console BFF only does ADLS REST through the Console UAMI.

### Per-tenant isolation

Every Cosmos query in the BFF is parameterized with `tenantId` (or `userId` for user-scoped containers) extracted from the encrypted MSAL session. There's no cross-tenant read possible — the partition key enforcement is at the query layer (`cosmos-client.ts:70` and every route under `app/api/`).

### Disaster-recovery posture

- Cosmos DB ships with `continuous` backup mode (per the bicep). Point-in-time restore up to 30 days back.
- ADLS Gen2 has soft-delete on the storage account (per bicep `storage.bicep`).
- Key Vault Premium has soft-delete + purge protection.
- See [Disaster-recovery runbook](disaster-recovery.md) for full restore drill.

---

## 2. Chargeback / billing / costing reports — what exists today and what doesn't

**Short answer: documented + UI-gated, not yet wired end-to-end.**

This is one of the active build areas. Here's exactly where each piece stands.

### What's wired

| Surface | State | Source of truth |
|---|---|---|
| `/admin/capacity` page | Renders per-service current SKU + state from ARM | `app/admin/capacity/page.tsx`, real ARM REST |
| `/admin/usage` page | Item counts, audit-log activity, top-active items | `app/admin/usage/page.tsx`, real Cosmos queries |
| Marketplace usage telemetry | App Insights metrics on every APIM call (per-product per-consumer) | wired via the data-marketplace tutorial pattern |
| Per-workspace last-accessed | `lastAccessedAt` on every Workspace doc | `cosmos-client.ts` workspace POST |

### What's NOT yet wired

| Capability | Status | What's missing |
|---|---|---|
| **Cost Management API integration** | `/admin/capacity` shows an honest MessageBar saying *"Cost & utilization deferred — requires Azure Cost Management API"* | Need to wire the [`Microsoft.CostManagement/query`](https://learn.microsoft.com/azure/cost-management-billing/automate/usage-details-api-overview) REST endpoint. Specifically: `POST /providers/Microsoft.CostManagement/query?api-version=2024-08-01` with a scope of the Admin Plane RG + each DLZ RG, dataset `ActualCost`, granularity `Daily`, group by `ResourceType` |
| **Per-workspace chargeback** | Backlog | The bridge: every Loom workspace tags its underlying Azure resources with `{loomTenantId: ..., loomWorkspaceId: ...}` so the Cost Management query can `groupBy` those tags. Bicep tag injection exists; the cost-query path is the gap |
| **Per-domain chargeback** | Backlog | Same bridge — Loom workspaces carry `domain` metadata; aggregate the cost-query result by tag value |
| **FinOps app** | Graded F at `docs/fiab/parity-gap/app-finops-cost.md` | Whole app is scaffolded but unwired — auto-pause + idle-finder + budgets are vaporware today |
| **Budget alerts** | Not started | `Microsoft.Consumption/budgets` PUT per RG; wire alert webhooks back to the notifications container |

### What you can do today

1. **Manual chargeback** — Azure Cost Management portal at `portal.azure.com → Cost Management + Billing → Cost analysis`, scoped to your Admin Plane + DLZ resource groups. Group by `Tag` → `loomWorkspaceId` / `loomDomain`. Export to Power BI.
2. **Marketplace usage Power BI dashboard** — already ships in the *Data Marketplace* app bundle (`apps/csa-loom/data-marketplace/`). Joins APIM telemetry with Cost Management exports.
3. **Tag-driven roll-up via Azure Policy** — apply `loomTenantId` / `loomWorkspaceId` / `loomDomain` tags via Azure Policy at the management group, then any cost report inherits the grouping.

### Roadmap

The chargeback path is on the active build queue. Tracked under task #134 (Phase 2 real provisioning) and #151 (Phase 2 MEGA install wizard). When the install wizard wires resource provisioning end-to-end, the cost-management query layer ships as part of it — every provisioned resource gets the right tags day one.

---

## 3. Multi-DLZ deployment — deploy a new domain / DLZ to a different subscription

**Short answer: bicep + bootstrap scripts ship today; the in-Console "Deploy DLZ to new sub" wizard is partial.**

### What works today (CLI path)

```bash
# 1. Set the target subscription as active
az account set -s <target-sub-id>

# 2. Run the bicep with the DLZ-only parameter file pointing at the existing Admin Plane
cd platform/fiab
az deployment sub create \
  --name loom-dlz-$(date +%s) \
  --location <region> \
  --template-file bicep/main.bicep \
  --parameters bicep/params/dlz-only-commercial.bicepparam \
  --parameters adminPlaneSubscriptionId=<admin-plane-sub-id> \
  --parameters adminPlaneRg=rg-csa-loom-admin-<region> \
  --parameters loomAdminGroupObjectId=<entra-group-oid>

# 3. Peer the new DLZ VNet to the Admin Plane hub (idempotent helper script)
bash scripts/csa-loom/peer-dlz-to-hub.sh \
  --dlz-sub <target-sub-id> \
  --hub-sub <admin-plane-sub-id> \
  --dlz-vnet vnet-csa-loom-dlz-<region> \
  --hub-vnet vnet-csa-loom-hub-<region>

# 4. Run the post-deploy bootstrap (SCIM grants, AppRoles, etc.)
bash scripts/csa-loom/bootstrap-all.sh --dlz-sub <target-sub-id>
```

The bicep is **subscription-scoped** (`targetScope = 'subscription'`) and each DLZ module deploys to its own RG. The 5 boundary `.bicepparam` files all support multi-sub mode. Full sequence documented in [`docs/fiab/deployment/multi-sub-multi-tenant.md`](../deployment/multi-sub-multi-tenant.md).

### What's partial (in-Console wizard)

The `/setup` page exposes a Setup Wizard with a step machine
(`intro → boundary → mode → domain → capacity → review → deploying → done`).
The current state at `apps/fiab-console/app/api/setup/deploy/route.ts:13-50`:

- The wizard collects all inputs correctly
- The validation step compiles real Bicep + runs `az deployment sub validate`
- The deploy step returns **503 with the exact `az deployment sub create` command** for the operator to run

This is intentional today (the original PRP-04 status is 🟡 — operator validation pending). The MCP-driven submit-to-deploy flow that closes this gap is in flight under PRP-04 / PRP-05 (Self-hosted Azure MCP Server). When MCP lands, the wizard's `deploy` button runs `az deployment sub create` itself via the MCP tool — no operator hand-off.

### Permission model

Per the user-feedback rule in `.claude/rules/no-vaporware.md`: deploying a DLZ to a new sub requires the deploy SP to have **Contributor + User Access Administrator** on that sub. Per task #151's design, the in-Console wizard will:

- Show the customer what permissions the deploy SP needs
- Let the customer paste the new sub id + grant the role assignment via a guided link (Azure portal deep-link with the right scope + role pre-selected)
- Then proceed to deploy

That guided flow is the gap that closes the partial state. Until it ships, the CLI path above is the production-ready answer.

### Cross-DLZ network model

- One hub VNet in the Admin Plane (typically `10.0.0.0/16`)
- One spoke VNet per DLZ (`10.N.0.0/16`)
- Hub ↔ spoke bidirectional peering, configured by `peer-dlz-to-hub.sh`
- 17 private DNS zones link from the hub to every spoke (`scripts/csa-loom/link-private-dns.sh`)
- No spoke-to-spoke traffic by default — Azure Firewall in the hub routes if explicitly enabled per [`docs/fiab/deployment/multi-sub-multi-tenant.md`](../deployment/multi-sub-multi-tenant.md)

---

## Related

- [Cost analysis runbook](cost.md)
- [Capacity management runbook](capacity-management.md)
- [Disaster recovery](disaster-recovery.md)
- [Forward to Fabric migration](forward-to-fabric.md)
- [Multi-sub / multi-tenant deployment guide](../deployment/multi-sub-multi-tenant.md)
- [PRP-04 Setup Wizard](../../../PRPs/active/csa-loom/PRP-04-setup-wizard.md)
- [PRP-05 Self-hosted Azure MCP Server](../../../PRPs/active/csa-loom/PRP-05-mcp-server.md)
- Tasks #134 (Phase 2 real provisioning), #151 (PHASE 2 MEGA install wizard + RBAC)
