# agent-loom — what the built-in Loom agent knows + can do

`agent-loom` is the built-in CSA Loom Copilot/orchestrator. It understands how a
Loom deployment is *supposed* to be wired, and it can review the running console
and apply runtime-safe fixes (admin-approved). This doc is its ground truth.

## How agent-loom checks + heals

Two tools are registered in the cross-item Copilot tool registry
(`apps/fiab-console/lib/azure/copilot-orchestrator.ts`):

- **`loom_self_audit`** — runs the real audit engine
  (`apps/fiab-console/lib/admin/self-audit.ts`) and returns a scored report:
  identity, data plane, Azure services, permissions, security posture, with the
  exact remediation per warning/failure. Same engine as **Admin → Health & self-audit**.
- **`loom_heal`** — applies a runtime-safe fix by `fixId` (e.g. `ensure-cosmos`).
  Only fixes the Console managed identity can safely apply at runtime run;
  deploy-time issues return guidance instead of a fake "fixed". Admin-approved at the UI.

Ask the Copilot: *"Audit this Loom deployment and fix what you can."*

## What a healthy Loom needs (the audit's ground truth)

### Identity & session (critical)
- `SESSION_SECRET` — session signing key (resolved from Key Vault in CI; never on disk).
- `LOOM_ENTRA_CLIENT_ID` + `LOOM_ENTRA_TENANT_ID` — the AAD app users sign in with.
- `LOOM_UAMI_CLIENT_ID` — the user-assigned managed identity every Azure data-plane call uses.

### Data plane (critical)
- `LOOM_COSMOS_ENDPOINT` (+ `LOOM_COSMOS_DATABASE`) — Cosmos holds every workspace,
  item, permission grant, config. Containers are `createIfNotExists` on first touch
  (the `ensure-cosmos` healer fix). UAMI needs **Cosmos DB Built-in Data Contributor**.
- `LOOM_SUBSCRIPTION_ID` + (`LOOM_DLZ_RG` or `LOOM_ADMIN_RG`) — ARM discovery + scaling.

### Permissions (critical)
- `LOOM_TENANT_ADMIN_OID` (your Entra user OID) **or** `LOOM_TENANT_ADMIN_GROUP_ID`
  (a group you're in) — deploy params `loomTenantAdminOid` / `loomTenantAdminGroupId`.
  Members bypass the feature-permission gate with full Admin. **This is the fix for
  the "Access denied (403)" on /admin/permissions** — there is no other first-admin path.

### Azure services (recommended/optional — each enables a workload, Azure-native by default)
Per `.claude/rules/no-fabric-dependency.md`, every workload runs on Azure-native
backends; none requires real Microsoft Fabric.
- **Synapse** (`LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_DEDICATED_POOL`) — warehouse, notebooks, pipelines.
- **ADX** (`LOOM_KUSTO_CLUSTER_URI`, `LOOM_KUSTO_DEFAULT_DB`) — KQL DBs, eventhouses, Real-Time dashboards.
- **Event Hubs** (`LOOM_EVENTHUB_NAMESPACE`, `LOOM_EVENTHUB_RG/SUB`) — eventstreams.
- **ADLS Gen2** (`LOOM_ADLS_ACCOUNT` or `LOOM_{LANDING,BRONZE,SILVER,GOLD}_URL`) — lakehouse + mirror Bronze.
- **AI Search** (`LOOM_AI_SEARCH_SERVICE`) — RAG indexes.
- **AOAI / Foundry** (`LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT`, or a Foundry project endpoint) —
  Copilot, help agent, data agents. UAMI needs **Cognitive Services OpenAI User**.
- **Azure Monitor** (`LOOM_LOG_ANALYTICS_RESOURCE_ID`, `LOOM_ALERT_RG`) — Activator alert rules. UAMI needs **Monitoring Contributor**.
- **ADF** (`LOOM_ADF_FACTORY`, `LOOM_ADF_RG`) — mirrored-database CDC → Bronze. Factory MI needs db_datareader on source + Storage Blob Data Contributor on ADLS.
- **Purview** (`LOOM_PURVIEW_ACCOUNT`) — optional governance mirror; domains + data quality work Loom-native (Cosmos) without it.

### Enrichment (optional)
- `LOOM_GRAPH_USERS_ENABLED=true` + UAMI **Directory.Read.All** — display name + department on the Users page.

### Security posture
- `SESSION_SECRET` ≥ 32 chars; `NODE_ENV=production` behind HTTPS (Secure cookies);
  a bootstrap admin principal set (don't leave admin open).

## What's runtime-fixable vs deploy-time

- **Runtime-safe (agent-loom applies with approval):** `ensure-cosmos` (createIfNotExists DB + containers).
- **Deploy-time (agent-loom shows the exact remediation, you apply + redeploy):**
  env vars (set in `admin-plane/main.bicep` `apps[]` env / the `*.bicepparam`),
  and RBAC grants (the post-deploy bootstrap workflow grants most UAMI roles;
  elevated grants need an Owner/User Access Administrator).

Bicep sync: env vars live in `platform/fiab/bicep/modules/admin-plane/main.bicep`
and the params in `platform/fiab/bicep/params/*.bicepparam`. RBAC grants are in the
resource bicep modules + `csa-loom-post-deploy-bootstrap.yml`.
