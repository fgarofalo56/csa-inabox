# CSA Loom v3 — Tenant bootstrap (post-deploy one-time config)

This doc captures the **one-time, per-tenant admin actions** that a Loom
deployment needs but that bicep can't fully automate (cross-cloud resources,
data-plane RBAC granted in a portal, tenant-level service enablement). Each
section is referenced from the in-app honest gate (the Fluent `MessageBar`
that names the exact step), per `.claude/rules/no-vaporware.md`.

---

## Day-one operator prerequisites {#day-one-prereqs}

The post-deploy bootstrap workflow (`csa-loom-post-deploy-bootstrap`) automates
every grant that an Azure service principal can perform unattended. The checklist
below covers the **residual one-time tenant actions** that require a human
(Global Administrator, Privileged Role Administrator, or tenant owner) because
they touch directory-level consent, sovereign enrollment, or management-group
hierarchy that a deploy SP normally cannot reach. Run these once after the first
deploy; they are idempotent and do not need to be repeated for re-deploys.

### Prerequisite A — Deploy SP: `AppRoleAssignment.ReadWrite.All` on Microsoft Graph {#prereq-graph-approle-write}

**Why:** The bootstrap workflow grants Microsoft Graph application roles (`InformationProtectionPolicy.Read.All`,
`Policy.Read.All`, `SensitivityLabel.Evaluate`, `SecurityAlert.Read.All`, and the Identity Picker roles)
to the Console managed identity. Assigning app-roles to a managed identity IS the grant — there is
no separate "Grant admin consent" click. However, the assignment itself requires the deploy SP to hold
`AppRoleAssignment.ReadWrite.All` on Microsoft Graph.

**Action:** A Global Administrator or Privileged Role Administrator runs **once**:

```bash
# Step 1 — find the deploy SP's service-principal object id
DEPLOY_SP_OBJID=$(az ad sp show --id <deploy-SP-appId> --query id -o tsv)

# Step 2 — find Microsoft Graph SP id
GRAPH_SP_ID=$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" -o tsv)

# Step 3 — find the AppRoleAssignment.ReadWrite.All app-role id on Graph
APPROLE_RW=$(az ad sp show --id $GRAPH_SP_ID \
  --query "appRoles[?value=='AppRoleAssignment.ReadWrite.All'].id | [0]" -o tsv)

# Step 4 — grant the deploy SP AppRoleAssignment.ReadWrite.All
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$DEPLOY_SP_OBJID/appRoleAssignments" \
  --headers "Content-Type=application/json" \
  --body "{\"principalId\":\"$DEPLOY_SP_OBJID\",\"resourceId\":\"$GRAPH_SP_ID\",\"appRoleId\":\"$APPROLE_RW\"}"
```

After this, re-run the bootstrap workflow. All Graph AppRole grants will succeed
unattended from that point forward. Until this is done, the
`/admin/security` MIP + DLP tabs and the Identity Picker render honest
`MessageBar` gates (not blank/broken screens).

### Prerequisite B — MSAL app-reg: admin-consent `Azure Service Management user_impersonation` {#prereq-azure-svc-mgmt-consent}

**Why:** The Connections "Add existing" wizard uses the signed-in user's
delegated identity (the MSAL token) to enumerate subscriptions and
resources across the tenant via `https://management.azure.com/subscriptions`.
This requires the `Azure Service Management / user_impersonation` delegated
permission to be admin-consented on the Loom MSAL app registration.

**Action:** A Global Administrator or Application Administrator runs **once**:

```bash
# Via the Azure portal:
# Entra ID → App registrations → <loom-msal-app> → API permissions
# → Add a permission → Azure Service Management → Delegated
# → user_impersonation → Add
# → Grant admin consent for <tenant>

# Or via CLI (replace APP_OID with the app registration's OBJECT id):
APP_OID=$(az ad app show --id $LOOM_MSAL_CLIENT_ID --query id -o tsv)
AZURE_SVC_MGMT_SP=$(az ad sp list --filter "appId eq '797f4846-ba00-4fd7-ba43-dac1f8f63013'" --query "[0].id" -o tsv)
USER_IMP_SCOPE_ID=$(az ad sp show --id $AZURE_SVC_MGMT_SP \
  --query "oauth2PermissionScopes[?value=='user_impersonation'].id | [0]" -o tsv)

# Add the required resource access to the app registration
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/applications/$APP_OID" \
  --headers "Content-Type=application/json" \
  --body "{\"requiredResourceAccess\":[{\"resourceAppId\":\"797f4846-ba00-4fd7-ba43-dac1f8f63013\",\"resourceAccess\":[{\"id\":\"$USER_IMP_SCOPE_ID\",\"type\":\"Scope\"}]}]}"

# Grant admin consent for the delegated permission
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants" \
  --headers "Content-Type=application/json" \
  --body "{\"clientId\":\"$AZURE_SVC_MGMT_SP\",\"consentType\":\"AllPrincipals\",\"resourceId\":\"$AZURE_SVC_MGMT_SP\",\"scope\":\"user_impersonation\"}"
```

Without this, the Connections "Add existing" user-delegated cross-sub
auth returns a 403 (`insufficient_claims`) and the Connections pane
renders an honest MessageBar with this exact remediation.

### Prerequisite C — Tenant-root management group: Console UAMI `Reader` {#prereq-tenant-root-mg-reader}

**Why:** Azure Resource Graph returns rows only for scopes where the
caller has at least Reader. The bootstrap workflow attempts to grant
Reader at the tenant-root management group (which propagates to every
subscription in the tenant), but this requires the deploy SP to hold
Owner or User Access Administrator on the root management group —
a privilege most deploy SPs don't have by default.

**Action:** A tenant Owner or an identity with the `ManagementGroupAccess`
Entra built-in role runs **once**:

```bash
# Find the tenant root management group id (equals the AAD tenant id)
TENANT_ID=$(az account show --query tenantId -o tsv)
MG_SCOPE="/providers/Microsoft.Management/managementGroups/$TENANT_ID"

# Optional: override with LOOM_TENANT_ROOT_MG_ID repo var for non-default root MG name
# MG_SCOPE="/providers/Microsoft.Management/managementGroups/<custom-root-mg-name>"

# Grant Console UAMI Reader at the tenant root (inherits to all subs)
az role assignment create \
  --assignee-object-id <CONSOLE_UAMI_PRINCIPAL_ID> \
  --assignee-principal-type ServicePrincipal \
  --role "Reader" \
  --scope "$MG_SCOPE"
```

Without this grant, Connections cross-sub discovery only sees resources in
the admin subscription. The Connections "Add existing" pane still works but
shows resources from the admin sub only.

### Prerequisite D — DLP policy LIST: Microsoft preview enrollment {#prereq-dlp-preview-enrollment}

**Why:** The `informationProtection/dataLossPreventionPolicies` endpoint
(`/beta`) that backs the DLP Policies list in `/admin/security` is
in public preview and requires the tenant to be enrolled. DLP
**alerts**, **violations**, and the Azure-native **Restrict-access**
enforcement tab use GA Graph endpoints and work without enrollment.

**Action:** File a **Microsoft support ticket** to enroll your tenant in
the `informationProtection.dataLossPreventionPolicies` beta feature:

```
Product: Microsoft Graph
Feature: Information Protection / Data Loss Prevention
Request: Enroll tenant <tenantId> in the informationProtection/dataLossPreventionPolicies /beta preview
```

Until enrolled, the Policy list segment shows an honest `MessageBar`
explaining the enrollment requirement. Alerts, violations, and
Restrict-access are unaffected.

---

## Deployment topology — `deploymentMode` & DLZ-attach {#deployment-topology}

`platform/fiab/bicep/main.bicep` requires a **`deploymentMode`** parameter
(`@allowed(['single-sub','multi-sub'])`, **no default** — it is a hard input):

- **`single-sub`** — Admin Plane + exactly one DLZ in the deployment
  subscription (`rg-csa-loom-dlz-single-<location>`). For trials / POCs.
  Several Console env vars (`LOOM_ADLS_ACCOUNT`, the Cosmos/Weave/Synapse
  endpoints) are **derived** in single-sub because the one DLZ's resource names
  are deterministic over `singleDlzRg.id`.
- **`multi-sub`** — Admin Plane in the deployment sub; one DLZ per domain across
  separate subscriptions. The operator must supply **`dlzSubscriptionIds`**
  (parallel to `dlzDomainNames`) and pre-create the per-DLZ resource groups
  (`scripts/csa-loom/bootstrap-dlz-rgs.sh`). In multi-sub the per-DLZ navigator
  env (storage / Cosmos / Synapse) can't be wired from the single Admin Plane —
  patch it post-deploy with `scripts/csa-loom/patch-navigator-env.sh`.

The in-app [Deployment planner](parity/deploy-planner.md) emits `deploymentMode`
into the exported `.bicepparam` (derived from the domain count when unset), so a
planner export is deployable as-is. The committed param files set it explicitly.

**DLZ-attach** (adding a domain after first-run) does not redeploy the Admin
Plane: the Console **"Add Data Landing Zone"** action registers the new domain
in the `DlzOnboardingRegistry`, then re-runs `main.bicep` with an expanded
`dlzSubscriptionIds` / `dlzDomainNames`. The new spoke peers to the existing
`adminPlaneHubVnetId`, attaches its ADX database to the shared cluster, and the
`setupOrchestratorSpokeRbac` grant (gated on `setupOrchestratorEnabled`) gives
the Console UAMI Contributor on the new spoke subscription. Diagrams +
walkthrough: [`docs/fiab/diagrams/`](diagrams/README.md) ·
[Tutorial 09](tutorials/09-tenant-topology.md) ·
[Reference architecture](architecture.md#deployment-flows).

---

## Runtime env-var reference (`/admin/env-config`) {#env-var-reference}

Every `LOOM_*` / `SESSION_SECRET` runtime var the Console reads is registered in
`apps/fiab-console/lib/admin/self-audit.ts` (`ENV_CHECKS`) and surfaced, grouped
and searchable, on **`/admin/env-config`** — the in-app, no-Azure-portal way to
view and set them (each Save rolls a real ACA revision). The page shows a 3-way
**status** per var: **set** (present in the running revision), **derived**
(bicep auto-fills it from another resource on a push-button deploy — the
operator normally never sets it by hand), or **not set**. For every unset/derived
var the page names the exact **bicep module + RBAC role** that provisions it.

| Subsystem | Vars | Bicep that wires it | Role / tenant action | Default status (commercial-full) |
|---|---|---|---|---|
| Identity & session | `SESSION_SECRET`, `LOOM_ENTRA_CLIENT_ID`, `LOOM_ENTRA_TENANT_ID`, `LOOM_UAMI_CLIENT_ID` | `modules/admin-plane/main.bicep` (params loomSessionSecret / loomMsalClientId; uami-console) | Entra app reg + redirect URI (one-time) | set |
| Data plane (Loom store) | `LOOM_COSMOS_ENDPOINT`, `LOOM_SUBSCRIPTION_ID`, `LOOM_DLZ_RG` / `LOOM_ADMIN_RG` | `modules/landing-zone/main.bicep` (cosmos) → admin-plane apps[] env | Cosmos DB Built-in Data Contributor (UAMI) | set |
| Permissions | `LOOM_TENANT_ADMIN_OID` / `LOOM_TENANT_ADMIN_GROUP_ID` | `main.bicep` params loomTenantAdminOid / loomTenantAdminGroupId | — (your Entra OID/group) | set |
| Azure services | `LOOM_SYNAPSE_WORKSPACE`, `LOOM_KUSTO_CLUSTER_URI`, `LOOM_EVENTHUB_NAMESPACE`, `LOOM_ADLS_ACCOUNT`, `LOOM_AI_SEARCH_SERVICE`, `LOOM_AOAI_ENDPOINT`, `LOOM_LOG_ANALYTICS_RESOURCE_ID`, `LOOM_ADF_FACTORY`, `LOOM_PURVIEW_ACCOUNT` | `modules/landing-zone/*` + `modules/admin-plane/*` per service flag | per-service data-plane role on the UAMI (see each section) | set when its `*Enabled` flag is on |
| Usage analytics embed (F21) | `LOOM_USAGE_REPORT_KIND`, `LOOM_USAGE_PBI_WORKSPACE_ID`, `LOOM_USAGE_PBI_REPORT_ID`, `LOOM_GRAFANA_USAGE_DASHBOARD_UID`, `LOOM_GRAFANA_ENDPOINT` | `main.bicep` params loomUsageReportKind / loomUsagePbi* / loomGrafanaUsageDashboardUid → `modules/admin-plane/main.bicep` apps[] env | **powerbi:** UAMI = Power BI workspace Member + "SP can use Power BI APIs" tenant setting. **grafana:** Grafana Viewer (UAMI). | KIND = `powerbi` (ids unset → honest gate) — see [§ below](#usage-analytics-embed) |
| Govern analytics embed (F2) | `LOOM_REPORT_KIND`, `LOOM_GOVERN_PBI_WORKSPACE_ID`, `LOOM_GOVERN_PBI_REPORT_ID`, `LOOM_GRAFANA_DASHBOARD_UID` | `main.bicep` params loomReportKind / loomGovernPbi* / loomGrafanaDashboardUid → admin-plane apps[] env | same as F21 | KIND = `powerbi` (ids unset → honest gate) |
| Embed codes / Org visuals (F22/F23) | `LOOM_ORG_VISUALS_URL` | **derived** by `modules/admin-plane/main.bicep` from `loomStorageAccount` + `modules/landing-zone/org-visuals-rbac.bicep` | Storage Blob Data Contributor (container) + Storage Blob Delegator (account) | derived (single-sub) |
| Audit logs (Log Analytics) | `LOOM_LOG_ANALYTICS_WORKSPACE_ID` | **derived** by `modules/admin-plane/main.bicep` from `monitoring.outputs.lawCustomerId` | Log Analytics Reader (UAMI) | derived |
| Enrichment | `LOOM_GRAPH_USERS_ENABLED` | admin-plane apps[] env + post-deploy Graph grant | Microsoft Graph `Directory.Read.All` (application) | set when graph enrichment opted in |

> **Per cloud:** the embed `*_REPORT_KIND` defaults to `powerbi` for
> **Commercial / GCC** and **`grafana`** for **GCC-High / IL5** (Power BI is
> Fabric-family and strictly opt-in per `.claude/rules/no-fabric-dependency.md`;
> the native Fluent charts always work without any embed backend).

---

## Usage analytics embed (F21) {#usage-analytics-embed}

The **`/admin/usage`** page always renders native Fluent usage charts from Log
Analytics telemetry. The **"Open analytics"** button additionally embeds a rich
report — Power BI (Commercial / GCC) or Azure Managed Grafana (GCC-High / IL5).
The same pattern backs the Governance **"View more"** (F2) embed.
`commercial-full.bicepparam` defaults `loomUsageReportKind = 'powerbi'` (and
`loomReportKind = 'powerbi'`) so the embed path is wired by default; the BFF
(`/api/admin/usage/embed`) honestly returns **503** with the exact follow-up
until the report id + workspace membership are supplied.

### Commercial / GCC — Power BI Embedded

1. **Publish a usage report** to a Power BI workspace (or reuse the F64 capacity
   workspace this deploy already has).
2. **Add the Console UAMI** (`LOOM_UAMI_CLIENT_ID`) as a **Member** of that
   workspace (App owns data / service-principal embed).
3. **Enable the tenant setting** "Service principals can use Power BI APIs"
   (Power BI Admin portal → Tenant settings → Developer settings).
4. **Set the ids** on the Console app:

```bash
az containerapp update \
  --name <loom-console-app> --resource-group <loom-admin-rg> \
  --set-env-vars \
    LOOM_USAGE_REPORT_KIND=powerbi \
    LOOM_USAGE_PBI_WORKSPACE_ID="<workspace-guid>" \
    LOOM_USAGE_PBI_REPORT_ID="<report-guid>" \
    LOOM_REPORT_KIND=powerbi \
    LOOM_GOVERN_PBI_WORKSPACE_ID="<workspace-guid>" \
    LOOM_GOVERN_PBI_REPORT_ID="<report-guid>"
```

### GCC-High / IL5 — Azure Managed Grafana

Power BI Embedded is not available; use Azure Managed Grafana (supported in
Azure Government). In the Gov param file set `managedGrafanaEnabled = true` and
`loomUsageReportKind = 'grafana'` (+ `loomReportKind = 'grafana'`), then:

1. Create a usage dashboard in the deployed Managed Grafana.
2. Grant the Console UAMI **Grafana Viewer** on the instance.
3. Set `LOOM_GRAFANA_USAGE_DASHBOARD_UID` (and `LOOM_GRAFANA_DASHBOARD_UID` for
   Govern). `LOOM_GRAFANA_ENDPOINT` is auto-wired from the deployed Grafana.

### Bicep sync

- Params + env wiring: `platform/fiab/bicep/main.bicep` (params
  `loomUsageReportKind` / `loomUsagePbiWorkspaceId` / `loomUsagePbiReportId` /
  `loomGrafanaUsageDashboardUid` + the Govern equivalents, forwarded to the
  admin-plane module) → `platform/fiab/bicep/modules/admin-plane/main.bicep`
  apps[] env (the `loomUsageReportKind == 'powerbi' && !empty(...)` guards keep
  the env honest until the ids are set).
- Capacity: `pbiEmbeddedEnabled` (A1) or `managedGrafanaEnabled` in the
  admin-plane module; `commercial-full.bicepparam` reuses the F64 capacity by
  default (`pbiEmbeddedEnabled = false`).
- Workspace membership + the "Service principals can use Power BI APIs" tenant
  setting are **post-deploy admin actions** (Power BI is Fabric-family) and
  cannot be expressed in ARM/bicep — hence this runbook.

---

## Microsoft Purview (Unified Catalog) {#microsoft-purview-unified-catalog}

Loom's **Governance** and **Unified Catalog** surfaces run natively against a
Microsoft Purview account's data plane (`<account>-api.purview.azure.com`):
governance domains, data products, glossary, Data Map sources/scans, lineage,
classifications, and access policies.

The Console resolves its Purview account from the `LOOM_PURVIEW_ACCOUNT`
environment variable. When that is set and reachable, every governance control
goes live; otherwise the in-app gate shows exactly what's below.

### Why a one-time step is sometimes required

- **Greenfield tenant (no Purview yet):** set `purviewEnabled = true` and bicep
  creates `purview-csa-loom-<region>` and wires `LOOM_PURVIEW_ACCOUNT` for you.
  See `platform/fiab/bicep/modules/admin-plane/catalog.bicep`.
- **Existing Purview, same cloud:** keep `purviewEnabled = false`, set
  `LOOM_PURVIEW_ACCOUNT` to the existing account's short name, and grant the
  Console UAMI the data-plane roles (below). See
  `docs/fiab/runbooks/purview-tenant-reuse.md`.
- **Cross-cloud (the common blocker):** if the only Purview in the tenant lives
  in **US Gov** but the Loom Console runs in **Commercial** (or vice-versa),
  the data plane **cannot** be reached across sovereign clouds with one account
  name. The Console's `probePurview()` reports `cross_cloud`. Provision a
  Purview account in the **Console's** cloud and point `LOOM_PURVIEW_ACCOUNT`
  at it. There is no env-var-only fix for cross-cloud.

### Step 1 — Provision / choose a Purview account in the Console's cloud

```bash
# Greenfield: let bicep do it
#   platform/fiab/bicep/params/<cloud>.bicepparam
#   param purviewEnabled = true
# then re-dispatch the admin-plane deploy.

# Or reuse an existing account in the SAME cloud as the Console:
EXISTING_PURVIEW="purview-corp-prod"   # short name, NOT the full URL
```

### Step 2 — Set `LOOM_PURVIEW_ACCOUNT` on the Console app

```bash
az containerapp update \
  --name <loom-console-app> \
  --resource-group <loom-admin-rg> \
  --set-env-vars LOOM_PURVIEW_ACCOUNT="$EXISTING_PURVIEW"
```

The Console accepts either the short account name or a full
`https://<account>-api.purview.azure.com` URL (it normalizes to the short name).

### Step 3 — Grant the Console UAMI the Unified Catalog data-plane roles

These are **Purview governance-domain roles granted in the Purview portal**,
not ARM RBAC. Grant all three to the Loom Console UAMI
(`LOOM_UAMI_CLIENT_ID` / its object id):

| Role | Scope | Why |
|---|---|---|
| **Data Curator** | Governance domain | Read business domains, glossary terms, governed assets. |
| **Data Product Owner** | Governance domain | Create / publish / update data products via the Unified Catalog plane. |
| **Data Reader** | Data Map collection | Browse assets, lineage, scans, classifications. |

In the Purview portal: **Settings → Roles and scopes → Governance domain →
Add** the UAMI to each role. (Data Map collection roles are under
**Data Map → Collections → Role assignments**.)

### Step 4 — (Optional) Register Loom data sources + scans

To populate the Data Map, register the Loom lakehouse/Synapse/Databricks
storage as Purview sources and schedule scans. This can be done from the Loom
**Governance → Scans & sources** surface (Register source + Run now) once the
account is wired, or via `az purview source/scan` — see
`docs/fiab/runbooks/purview-tenant-reuse.md` for the CLI recipe.

### Step 5 — Verify

Open **Governance** in the Console. The Purview status banner should flip to a
green **"Connected — `<account>` · live"** chip. **Governance → Scans &
sources** lists registered sources; **Unified catalog → Governance domains**
lists/creates domains. If you still see the warning gate, click **Recheck** and
read the reported reason (`not_configured` → env var unset on the app;
`cross_cloud` → wrong cloud; `upstream_error` → role grant / firewall).

### Bicep sync

- Resource + env var + admin role: `platform/fiab/bicep/modules/admin-plane/catalog.bicep`
  (`Microsoft.Purview/accounts`, the `LOOM_PURVIEW_ACCOUNT` env wiring in
  `admin-plane/main.bicep`, and the Data Curator role assignment).
- The three governance-domain roles in Step 3 are **portal-only** data-plane
  RBAC and intentionally cannot be expressed in ARM/bicep — hence this runbook.

---

## AI Foundry Agent Service project {#ai-foundry-agent-service}

Loom's **Agent Service** surfaces (Foundry agent editor, Data Agent publish,
the test-chat / embeddings paths) run against a dedicated **AI Foundry
(AIServices) account + project** with two model deployments. Unlike the shared
AzureML Foundry Hub (`aifoundry-csa-loom-<region>`), this is a
`Microsoft.CognitiveServices/accounts` (kind `AIServices`) with project
management enabled, so it exposes a real Agent Service project endpoint.

The Console resolves it from these env vars (all set by bicep — see Bicep sync):

| Env var | Live value (Commercial) | Backs |
|---|---|---|
| `LOOM_FOUNDRY_PROJECT_ENDPOINT` | `https://aifndry-loom-eastus2.services.ai.azure.com/api/projects/loom-agents` | Agent Service project plane |
| `LOOM_FOUNDRY_PROJECT_ID` | ARM id of the project | Connection wiring |
| `LOOM_FOUNDRY_PROJECT_NAME` | `loom-agents` | Project display / resolve |
| `LOOM_AOAI_ENDPOINT` | `https://aifndry-loom-eastus2.openai.azure.com/` | AOAI chat + embeddings clients |
| `LOOM_AOAI_CHAT_DEPLOYMENT` | `chat` (gpt-4.1-mini, 2025-04-14, GlobalStandard) | Chat completions |
| `LOOM_AOAI_DEPLOYMENT` | `chat` (mirror of `_CHAT_DEPLOYMENT`) | Copilot / data-agent orchestrators |
| `LOOM_AOAI_EMBED_DEPLOYMENT` | `text-embedding-ada-002` (v2, Standard) | Embeddings |
| `LOOM_AOAI_COMPLETION_DEPLOYMENT` | _(empty)_ — optional, e.g. `gpt-4o-mini` (2024-07-18, GlobalStandard) | Notebook/SQL inline code completion (ghost text). Empty ⇒ ghost text reuses `LOOM_AOAI_DEPLOYMENT`. Set `loomAoaiCompletionDeployment` to deploy a dedicated low-latency slot; leave empty in GCC-High / IL5 regions where the model is unavailable. |
| `LOOM_AOAI_API_VERSION` | `2024-10-21` (bicep param `loomAoaiApiVersion`) | Chat Completions REST version; advance for o-series reasoning models |
| `LOOM_AOAI_AUDIENCE` | `https://cognitiveservices.azure.com` (Gov: `…azure.us`) | AOAI bearer token scope, derived per boundary |

#### Per-cloud AOAI endpoint patterns {#aoai-per-cloud}

`resolveAoaiTarget()` (`apps/fiab-console/lib/azure/copilot-orchestrator.ts`)
picks the host suffix from `getOpenAiSuffix()` and the token audience from
`cogScope()`, both keyed off the active sovereign boundary (`LOOM_CLOUD`, falling
back to `AZURE_CLOUD`). When the resolved `LOOM_AOAI_ENDPOINT` host contradicts
the active cloud, the resolver throws an honest `NoAoaiDeploymentError` (rather
than letting the data-plane 401) and the Copilot pane renders a MessageBar with a
cloud-correct **Configure in AI Studio** deep-link.

| LoomCloud | `LOOM_CLOUD` | `LOOM_AOAI_ENDPOINT` pattern | Token audience (`LOOM_AOAI_AUDIENCE`) | AI Studio portal | Regions |
|---|---|---|---|---|---|
| Commercial | `Commercial` (or unset) | `https://<acct>.openai.azure.com/` | `https://cognitiveservices.azure.com` | `ai.azure.com` | all commercial regions |
| GCC | `GCC` | `https://<acct>.openai.azure.com/` | `https://cognitiveservices.azure.com` | `ai.azure.com` | GCC tenant on Commercial Azure AOAI |
| GCC-High | `GCC-High` | `https://<acct>.openai.azure.us/` | `https://cognitiveservices.azure.us` | `ai.azure.us` | `usgovarizona`, `usgovvirginia` |
| IL5 | `IL5` (→ `GCC-High`) | `https://<acct>.openai.azure.us/` | `https://cognitiveservices.azure.us` | `ai.azure.us` | `usgovarizona`, `usgovvirginia` |

When `agentFoundryEnabled = true`, bicep derives the correct suffix automatically
via `environment().suffixes.storage` — the patterns above only matter when reusing
an existing account through the `az containerapp update --set-env-vars` path. The
4-cloud host resolution is locked by the unit test
`apps/fiab-console/lib/azure/__tests__/cloud-matrix.test.ts` (AOAI describe block).

### Greenfield (let bicep do it)

Set `param agentFoundryEnabled = true` in
`platform/fiab/bicep/params/<cloud>.bicepparam` and re-dispatch the admin-plane
deploy. Bicep provisions:

- The AIServices account `aifndry-loom-<region>` (S0, custom subdomain, project
  management on).
- The `loom-agents` project (SystemAssigned identity).
- The `chat` and `text-embedding-ada-002` model deployments.
- Three account-scope RBAC grants to the Console UAMI: **Azure AI Developer**,
  **Cognitive Services User**, **Cognitive Services OpenAI User**.

Module: `platform/fiab/bicep/modules/ai/foundry-project.bicep`.

### Reuse an existing account

Point the six env vars above at your existing AIServices account / project /
deployment names via `az containerapp update --set-env-vars`, and grant the
Console UAMI the same three roles on that account
(`az role assignment create --assignee <uami-object-id> --role "Azure AI Developer" --scope <account-id>`,
repeat for *Cognitive Services User* and *Cognitive Services OpenAI User*).

### Verify

Open an Agent editor / Data Agent in the Console. The Foundry status chip
should report the resolved project; the test-chat path returns a model
completion. If gated, the MessageBar names the unset env var.

### Bicep sync

- Account + project + model deployments + 3 UAMI roles:
  `platform/fiab/bicep/modules/ai/foundry-project.bicep`.
- Module wiring + the six `LOOM_FOUNDRY_*` / `LOOM_AOAI_*` env vars:
  `platform/fiab/bicep/modules/admin-plane/main.bicep` (`agentFoundryEnabled`).

---

## Microsoft Graph app-roles — MIP + DLP (day-one) {#graph-admin-consent-mip-dlp}

Loom's **/admin/security** MIP (sensitivity labels) and DLP tabs call Microsoft
Graph **app-only** with the Console UAMI. That requires the five **application**
app-roles below on Microsoft Graph, assigned to the Console UAMI's service
principal.

| App-role (application permission) | App-role id | Backs |
|---|---|---|
| `InformationProtectionPolicy.Read.All` | `19da66cb-0fb0-4390-b071-ebc76a349482` | MIP sensitivity-label policy reads |
| `SensitivityLabel.Evaluate` | `57f0b71b-a759-45a0-9a0f-cc099fbd9a44` | apply-label evaluation |
| `Policy.Read.All` | `246dd0d5-5bd0-4def-940b-0421030a5b68` | DLP / tenant policy reads |
| `SecurityAlert.Read.All` | `bf394140-e372-4bf9-a898-299cfc7564e5` | DLP alerts/violations (alerts_v2) |
| `SecurityIncident.Read.All` | `45cc0394-e837-488b-a098-1918f48d186c` | Graph Security incidents (alerts_v2) |

> These are the **Application** app-role ids (type `Role`), not the delegated
> `oauth2PermissionScopes` ids. Using the delegated id silently fails app-only.

**This is automated day-one.** The flags `loomMipEnabled` / `loomDlpEnabled`
default `true` (so the Console gets `LOOM_MIP_ENABLED=true` + `LOOM_DLP_ENABLED=true`
out of the box), and the post-deploy bootstrap job **Grant MIP+DLP Graph
AppRoles** assigns the five app-roles automatically. There is **no separate
"Grant admin consent" click** for a managed identity — assigning the app-role to
the UAMI's service principal *is* the grant, and it takes effect immediately.
(The interactive "Grant admin consent" prompt is the *app-registration* pattern,
where a Global/Application Administrator approves a *requested* permission. A
managed identity has no app registration and no consent prompt.) Until the
app-roles land, the tabs render the honest `503 NotConfigured` MessageBar — never
an empty stub.

### The one-time tenant prerequisite (only if the grants 403)

Assigning Graph app-roles to the UAMI requires the **bootstrap/deploy principal**
to hold **`AppRoleAssignment.ReadWrite.All` on Microsoft Graph** (or the
*Privileged Role Administrator* directory role). The deploy SP is created with
Azure RBAC (Owner/Contributor) but **not** with this Graph directory privilege,
so on the very first deploy the **Grant MIP+DLP Graph AppRoles** step may `403`.
When it does, the step prints a `::warning::` with the exact remediation below
and continues (non-fatal — the tabs stay on the honest gate). A
**Global Administrator** runs this **once**, then re-runs the bootstrap job:

```bash
# As a Global Administrator / Privileged Role Administrator:
DEPLOY_SP_OBJID=<the deploy SP service-principal OBJECT id>   # az ad sp show --id <deploy appId> --query id -o tsv
GRAPH_SP_ID=$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" -o tsv)
APPROLE_RW=$(az ad sp show --id "$GRAPH_SP_ID" \
  --query "appRoles[?value=='AppRoleAssignment.ReadWrite.All'].id | [0]" -o tsv)
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$DEPLOY_SP_OBJID/appRoleAssignments" \
  --headers "Content-Type=application/json" \
  --body "{\"principalId\":\"$DEPLOY_SP_OBJID\",\"resourceId\":\"$GRAPH_SP_ID\",\"appRoleId\":\"$APPROLE_RW\"}"
```

This is the **only** thing that lets the bootstrap assign the MIP/DLP app-roles
unattended. It can't be self-served from the deploy because granting a Graph
directory privilege to *itself* would be a privilege-escalation an Azure RBAC
role can't perform — it requires a directory-role holder.

### Manual fallback (no bootstrap)

```bash
az login    # as a user/SP with AppRoleAssignment.ReadWrite.All on Graph
CONSOLE_UAMI_PRINCIPAL=<console UAMI object id> \
  ./scripts/csa-loom/grant-graph-approles.sh
```

Idempotent (re-running is a no-op). It POSTs `appRoleAssignments` on the UAMI's
service principal against the Microsoft Graph SP
(`appId 00000003-0000-0000-c000-000000000000`).

### Bicep sync

- Env flags `LOOM_MIP_ENABLED` / `LOOM_DLP_ENABLED` default ON:
  `platform/fiab/bicep/modules/admin-plane/main.bicep` (`loomMipEnabled` /
  `loomDlpEnabled` params) + `params/commercial-full.bicepparam`.
- The five Graph app-roles are **Graph-plane** grants and intentionally cannot be
  expressed in ARM/bicep — hence the bootstrap step +
  `scripts/csa-loom/grant-graph-approles.sh`.

## DLP policy CRUD — SCC PowerShell sidecar {#dlp-scc-sidecar}

The DLP **reads** (policies/rules/alerts/violations/simulate) and the
Azure-native **Restrict-access** revokes work day-one via Graph + ADLS/Synapse/ADX
(above). DLP policy **authoring** (create/edit/delete DLP compliance policies +
rules) has **no Microsoft Graph write surface** — it runs through Security &
Compliance PowerShell (`Get/New/Set/Remove-DlpCompliancePolicy` +
`*-DlpComplianceRule`). The same applies to sensitivity-label + label-policy CRUD
(`New-/Set-/Remove-Label`, `*-LabelPolicy`). Loom proxies all of this to a
PowerShell Azure Function — `azure-functions/scc-labels` — deployed by
`platform/fiab/bicep/modules/admin-plane/scc-labels-function.bicep` and wired into
the Console as `LOOM_DLP_ADMIN_ENABLED` / `LOOM_MIP_ADMIN_ENABLED` +
`LOOM_SCC_LABELS_ENDPOINT` / `LOOM_SCC_LABELS_KEY`.

The sidecar authenticates to SCC with **certificate-based app-only auth**
(`Connect-IPPSSession -AppId … -Certificate … -Organization …`). That app needs
the Graph app-role **`Exchange.ManageAsApp`** + the Entra directory role
**Compliance Administrator**. Creating an app registration, assigning a directory
role, and uploading an auth certificate are **interactive Entra-admin actions** —
they can't be self-served by an Azure deploy SP — so DLP/label **CRUD** is
**opt-in** (`loomDlpAdminEnabled` / `loomMipAdminEnabled`, default `false`). Until
it's wired, the DLP-management tab renders the honest `dlp_admin_not_configured`
gate; everything else on the page works.

### One-time setup

The post-deploy bootstrap step **Provision SCC labels + DLP sidecar** runs
`scripts/csa-loom/provision-scc-labels-sidecar.sh` every deploy and performs the
automatable parts: it creates/reuses the SCC app registration, grants
`Exchange.ManageAsApp`, assigns Compliance Administrator (when the bootstrap
principal is a Privileged Role Administrator), and — once the Function app exists
— publishes the `labels/` + `dlp/` code. The remaining one-time human actions:

1. **Create an auth certificate** and upload its public key (`.cer`) to the SCC
   app registration; install the PFX into the Function app and set
   `WEBSITE_LOAD_CERTIFICATES` to the thumbprint (the `sccCertThumbprint` param
   wires this app setting).
2. **Re-deploy admin-plane** with `loomDlpAdminEnabled = true` (and/or
   `loomMipAdminEnabled = true`), `sccAppId = <app id>`,
   `sccCertThumbprint = <thumbprint>`,
   `sccOrganization = <tenant>.onmicrosoft.com` (sovereign clouds also set
   `sccConnectionUri`, e.g. `https://ps.compliance.protection.office365.us`).
3. **Consent `Exchange.ManageAsApp`** for the SCC app (Entra → App registrations →
   *CSA Loom SCC Labels Sidecar* → API permissions → Grant admin consent). This
   IS the app-registration pattern, so the interactive consent click *is*
   required here (unlike the Console UAMI app-roles above).

### Bicep sync

- Module: `platform/fiab/bicep/modules/admin-plane/scc-labels-function.bicep`
  (deploys when `loomMipAdminEnabled || loomDlpAdminEnabled`).
- Env: `LOOM_DLP_ADMIN_ENABLED` / `LOOM_MIP_ADMIN_ENABLED` +
  `LOOM_SCC_LABELS_ENDPOINT` / `LOOM_SCC_LABELS_KEY` in
  `admin-plane/main.bicep`.

## Databricks reachability — private endpoint (day-one) {#databricks-private-endpoint}

The DLZ Databricks workspace (`databricks.bicep`) is VNet-injected with
`publicNetworkAccess: 'Disabled'`. Without a private path the Console
(`/api/.../databricks/*`) gets **`403 Unauthorized network access to workspace`**
(#1466). The day-one fix is **private-by-default**: a **`databricks_ui_api`
private endpoint** on the DLZ spoke `snet-private-endpoints` subnet, plus the
**`privatelink.azuredatabricks.net`** private DNS zone (Gov:
`privatelink.databricks.azure.us`) linked to the hub VNet. The PE registers the
per-workspace host (`adb-<id>.NN.azuredatabricks.net`) on the zone, so the Console
resolves the workspace to its private IP and reaches it over hub→spoke peering.
No tenant action and **no IP-allowlist drift**.

| Piece | Where |
|---|---|
| Private DNS zone (`privatelink.azuredatabricks.net` / `…databricks.azure.us`) | `admin-plane/network.bicep` (`dnsZones[23]`, output key `databricks`) |
| `databricks_ui_api` PE + DNS group | `landing-zone/databricks.bicep` (`peUiApi`, `peUiApiDnsGroup`) |
| Threading | `main.bicep` → `landing-zone/main.bicep` (`databricks` module gets `privateEndpointSubnetId` + `databricksPrivateDnsZoneId`) |

> The Console's calls are REST/UI-API, so `databricks_ui_api` is sufficient. A
> `browser_authentication` PE is only needed for browser **SSO** over a private
> path (not used by Loom's server-side calls).

### IP-allowlist fallback (opt-in)

If an operator runs the workspace with `publicNetworkAccess=Enabled` instead of
the PE, the workspace IP access list (when enabled) can still block the Console's
NAT egress IP. Set repo vars `LOOM_DBX_IP_ALLOWLIST_FALLBACK=true` +
`LOOM_CONSOLE_EGRESS_IP=<egress IP/CIDR>` and the bootstrap step **Databricks
reachability fallback** adds that IP to an `ALLOW` list via
`POST /api/2.0/ip-access-lists`. The PE is preferred (no IP drift, matches the
Network page "private by default" posture).

## Databricks Unity Catalog — account id + account-admin (day-one) {#databricks-uc-account}

The **Catalog → Metastores** Unified-Catalog page (`/catalog/metastores`, the
one-click metastore **attach**) and the **`/catalog/domains`** UC-mirror surface
talk to the Databricks **account** plane
(`accounts.azuredatabricks.net/api/2.0/accounts/{account_id}/...`) — a different
plane than the workspace SCIM the bootstrap already configures. Enumerating and
attaching metastores is an **account-level** operation, so it needs two things
that workspace-level SCIM can't provide:

1. **`LOOM_DATABRICKS_ACCOUNT_ID`** on the Console — the Databricks account GUID.
   This is **not discoverable from ARM** (the workspace resource doesn't expose
   it), so it's supplied as config:
   - **Greenfield / single-sub:** set the env var `LOOM_DATABRICKS_ACCOUNT_ID`
     before the deploy. `params/*.bicepparam` reads it
     (`readEnvironmentVariable('LOOM_DATABRICKS_ACCOUNT_ID','')`) → `main.bicep`
     `databricksAccountId` → `admin-plane/main.bicep` wires it onto the console
     as `LOOM_DATABRICKS_ACCOUNT_ID` (+ `LOOM_DATABRICKS_ACCOUNT_HOST` for
     sovereign clouds).
   - **dlz-attach / tenant (admin plane not redeployed):** set the repo var
     **`DATABRICKS_ACCOUNT_ID`** (and optionally `DATABRICKS_ACCOUNT_HOST` =
     `accounts.azuredatabricks.us` for Gov). The **Enable Unity Catalog** bootstrap
     step then patches `LOOM_DATABRICKS_ACCOUNT_ID` onto the live console Container
     App. `scripts/csa-loom/patch-navigator-env.sh` also wires it (reads
     `DATABRICKS_ACCOUNT_ID` / `LOOM_DATABRICKS_ACCOUNT_ID` from the env).

   Find the account id at **accounts.azuredatabricks.net → top-right user menu →
   Account ID** (or the `?account_id=` URL).

2. **Console UAMI is a Databricks _account admin_.** The bootstrap's **Enable
   Unity Catalog** step runs `scripts/csa-loom/enable-unity-catalog.sh`, which
   adds the Console UAMI as an account service principal and PATCHes it the
   `account_admin` role (account-level SCIM
   `/accounts/{id}/scim/v2/ServicePrincipals`). **One-time prereq:** the deploy
   SP (`limitlessdata_deploy`) must itself be a **Databricks account admin** for
   that PATCH to succeed — an existing account admin (the AAD identity that
   created the account / first workspace, typically a Global Admin or platform
   owner) promotes the deploy SP once via the account console
   (accounts.azuredatabricks.net → User management → Service principals → mark as
   account admin). If the deploy SP isn't an account admin, the step emits a
   `::warning::` and the UC surfaces honest-gate (workspace registration +
   catalog listing still work) — it is **never** a hard deploy blocker.

Without `LOOM_DATABRICKS_ACCOUNT_ID`, the console UC client
(`lib/azure/unity-catalog-account-client.ts`) throws
`UnityCatalogAccountNotConfiguredError`, which the BFF renders as an honest
MessageBar naming the env var — registration and catalog listing remain
functional; only the one-click metastore **attach** is unavailable.

| Piece | Where |
|---|---|
| Console env `LOOM_DATABRICKS_ACCOUNT_ID` / `…_HOST` | `admin-plane/main.bicep` (apps[].env), param `databricksAccountId` |
| Param source | `params/*.bicepparam` (`readEnvironmentVariable('LOOM_DATABRICKS_ACCOUNT_ID')`) |
| Account-admin + metastore + default catalog | `scripts/csa-loom/enable-unity-catalog.sh` (bootstrap **Enable Unity Catalog** step) |
| dlz-attach live env bridge | bootstrap **Enable Unity Catalog** step + `scripts/csa-loom/patch-navigator-env.sh` |

## Batch labeling — Power BI Admin setLabels {#batch-labeling-powerbi-setlabels}

The **Admin → Batch labeling** page (`/admin/batch-labeling`) bulk-applies a
sensitivity label to many catalog items at once. It always writes the label
assignment to Cosmos (the item's `state.sensitivityLabel`), and — when Microsoft
Purview is configured — stamps the label as an Atlas asset classification on the
matching catalog asset. Neither of those needs anything beyond the Purview
bootstrap above.

The **optional** third sink is the Power BI Admin
`InformationProtection.setLabels` REST API, which writes the label onto the
underlying Power BI artifact (semantic model / report / dashboard / dataflow)
linked to a Loom item. It requires two things that the page surfaces honestly
(the checkbox only appears when both are satisfied):

1. **A real MIP label GUID.** The Power BI API only accepts Microsoft
   Information Protection label GUIDs, not Loom-native label ids. So
   `LOOM_MIP_ENABLED=true` (see the MIP section above) must already be on, and
   the operator must pick a label sourced from MIP in the dropdown.

2. **The Console UAMI must be a Fabric Administrator.** This is a one-time
   M365 / Entra admin action and is **NOT an Azure ARM role** — it cannot be
   granted from bicep. A tenant admin adds the Console UAMI's service principal
   to the *Fabric administrator* role in the Microsoft 365 admin center
   (Roles → Role assignments → Fabric administrator), or via the Power BI
   tenant settings "Service principals can use Fabric APIs" group plus the admin
   role. Until this is done, `setLabels` returns 401/403, which the results grid
   shows verbatim in red per row (no fake success).

### Step — Flip the feature flag

```bash
az containerapp update --name <loom-console-app> --resource-group <loom-admin-rg> \
  --set-env-vars LOOM_POWERBI_ADMIN_LABELS=true
```

Or set `loomPowerBiAdminLabels = true` in the `.bicepparam` and re-deploy
admin-plane (the env wiring is already in `admin-plane/main.bicep`).

### Bicep sync

- Env flag `LOOM_POWERBI_ADMIN_LABELS`:
  `platform/fiab/bicep/main.bicep` (`loomPowerBiAdminLabels` param) →
  `platform/fiab/bicep/modules/admin-plane/main.bicep`.
- The Fabric Administrator role assignment is a **Power BI / M365 tenant** grant
  and intentionally cannot be expressed in ARM/bicep — hence the one-time admin
  action above. The page hides the Power BI checkbox until `LOOM_POWERBI_ADMIN_LABELS`
  is set, and any per-artifact 403 is shown verbatim.

## PostgreSQL in-database query (Entra auth)

The unified SQL editor's **Query** tab and schema browser run real SQL against a
PostgreSQL flexible server over the `pg` wire protocol, authenticating with a
Microsoft Entra access token (no stored password). One-time setup:

1. Connect to the server as its PostgreSQL **Entra admin** and register the
   console identity as a PG principal:

   ```sql
   SELECT * FROM pgaadauth_create_principal('<console-uami-name>', false, false);
   -- then grant it the privileges it needs, e.g.:
   GRANT CONNECT ON DATABASE <db> TO "<console-uami-name>";
   GRANT USAGE ON SCHEMA public TO "<console-uami-name>";
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO "<console-uami-name>";
   ```

2. Set `LOOM_POSTGRES_AAD_USER` to that principal name (`loomPostgresAadUser`
   param in `admin-plane/main.bicep`, already wired to the console app env), e.g.:

   ```bash
   az containerapp update --name <loom-console-app> --resource-group <loom-admin-rg> \
     --set-env-vars LOOM_POSTGRES_AAD_USER='<console-uami-name>'
   ```

Until it's set, the PG Query tab shows an honest setup gate (ARM inventory,
provisioning, databases, and firewall are already live without it). Gov clouds:
override the token audience with `LOOM_POSTGRES_AAD_SCOPE` if needed.

### Bicep sync

- `LOOM_POSTGRES_AAD_USER`: `platform/fiab/bicep/modules/admin-plane/main.bicep`
  (`loomPostgresAadUser` param). The in-engine `pgaadauth_create_principal` call
  is a data-plane grant and intentionally cannot be expressed in ARM/bicep.

## Azure SQL server — schema/table browser (Entra-admin data-plane) {#azure-sql-server-schema-browser}

The **Azure SQL server** editor lets you drill from a logical server into any of
its databases and browse that database's **schemas, tables, columns, indexes,
constraints, views, stored procedures, functions, and table types** in a live
object navigator. Each database is read on a **dedicated TDS connection** to
`<server>.<sql-suffix>` (Azure SQL Database has no cross-database query, so the
server cannot enumerate every database's objects on one connection — the
navigator opens a fresh connection per selected database). All reads are real
`sys.*` catalog queries over the existing Azure SQL TDS path — **no new Azure
resource, route, or env var**.

For the navigator to return rows (rather than the honest TDS auth error it shows
otherwise) the **console UAMI must be able to read the target database's
metadata**. One-time, per logical server:

1. Make the console UAMI the server's **Microsoft Entra admin** — settable
   inline from the editor's **AAD admin** ribbon button
   (`Microsoft.Sql/servers/administrators`), via the portal, or:

   ```bash
   az sql server ad-admin create --resource-group <rg> --server <server> \
     --display-name '<console-uami-name>' --object-id <console-uami-objectId>
   ```

   **or**, for least privilege, provision the UAMI as a contained user with
   read + metadata rights in each database you want to browse (run as the
   server's Entra admin):

   ```sql
   CREATE USER [<console-uami-name>] FROM EXTERNAL PROVIDER;
   ALTER ROLE db_datareader ADD MEMBER [<console-uami-name>];
   GRANT VIEW DEFINITION TO [<console-uami-name>];
   ```

Until one of these is in place the navigator renders the real connection/auth
error verbatim (per `no-vaporware.md`) — ARM inventory (servers, databases,
firewall, AAD admin) is already live without it.

### Bicep sync

- No new Azure resource or env var. The `Microsoft.Sql/servers/administrators`
  (Entra admin) assignment and the in-database `db_datareader` + `VIEW
  DEFINITION` grant are **data-plane** acts that intentionally cannot be
  expressed in ARM/bicep — `platform/fiab/bicep/modules/admin-plane/sql-rbac.bicep`
  deliberately grants the UAMI only the control-plane **SQL DB Contributor**
  role and explicitly NOT data-plane access (see its header comment). The editor
  exposes the AAD-admin setter so the operator can perform the one-time grant
  from the UI.

## Azure SQL — full-text search + SQL 2025 vector indexes {#azure-sql-search-management}

The standalone **Azure SQL database** editor's **Full-text search** and **Vector
indexes** tabs create/populate/drop full-text catalogs + indexes and SQL Server
2025 vector indexes via real T-SQL DDL over TDS (`search-management` BFF). They
ride the existing Azure SQL Query path, so they need **no new Azure resource,
env var, role assignment, or Cosmos container** — only data-plane prerequisites:

1. The console UAMI must be `db_owner` or `db_ddladmin` on the target database
   (the same identity the Query tab already uses as the server's Microsoft Entra
   admin). A permission error surfaces verbatim in the action MessageBar.

2. **Vector indexes on SQL Server 2025 (NOT Azure SQL Database)** require
   enabling the preview-features database-scoped configuration once per database:

   ```sql
   ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON;
   ```

   On **Azure SQL Database** this step is not needed — `CREATE VECTOR INDEX`
   works without it. The editor's Vector tab surfaces an honest gate naming the
   missing prerequisite when the engine lacks `sys.vector_indexes`, and a guided
   "add a `VECTOR(N)` column first" hint (`ALTER TABLE ... ADD col VECTOR(1536)`)
   when no vector column exists yet.

### Bicep sync

- None. The feature uses the existing Azure SQL TDS connection (no new resource,
  env var, role, or container). The `PREVIEW_FEATURES` toggle and `db_owner`
  grant are data-plane actions that intentionally cannot be expressed in ARM/bicep.

## ADX Event Hub data connections — cluster MI grant {#adx-eventhub-data-connection}

The KQL-database **Event Hub data connection** wizard (KqlDatabaseEditor →
**Data → Data connections**) creates a streaming `Microsoft.Kusto/.../dataConnections`
(kind `EventHub`). ADX authenticates to Event Hubs using the **cluster's
system-assigned managed identity**, which must hold **Azure Event Hubs Data
Receiver** on the namespace. The Azure portal auto-grants this when you create a
connection in the portal; the ARM REST API (what the Loom wizard calls) does
**not**, so the grant must exist first or the `PUT .../dataConnections` returns
`Forbidden`.

**Default deploy (greenfield ADX):** fully automated. `admin-plane/main.bicep`
outputs `adxClusterPrincipalId`; the top-level `main.bicep` threads it into the
DLZ `landing-zone/main.bicep`, which passes it to `eventhubs.bicep`. There the
`adxEhDataReceiverRole` role assignment grants the cluster MI Azure Event Hubs
Data Receiver (role `a638d3c7-ab3a-418d-83e6-5f17a39d4fde`) on the namespace.
**No manual step.**

**BYO / existing ADX cluster (`existingAdxClusterName` set):** the admin-plane
output is empty (it can't read a pre-existing cluster's MI principal id at
deploy time), so the grant is skipped. Grant it once manually:

```bash
ADX_MI=$(az kusto cluster show \
  -g <adx-cluster-rg> -n <adx-cluster-name> \
  --query identity.principalId -o tsv)
EHNS=$(az eventhubs namespace show \
  -g <dlz-rg> -n evhns-loom-<domain>-<location> --query id -o tsv)
az role assignment create \
  --assignee-object-id "$ADX_MI" --assignee-principal-type ServicePrincipal \
  --role "Azure Event Hubs Data Receiver" --scope "$EHNS"
```

**Verify:** create a connection in the wizard, send events to the hub, and run
`.show data connections` in the KQL editor — the connection lists with
`State = Running` and rows appear in the target table within seconds.

## ADX cluster lifecycle + database/table RBAC + RLS {#adx-lifecycle-rbac-rls}

The KQL-database editor's **Manage** ribbon exposes three admin surfaces, all
Azure-native (no Fabric tenant required, works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset):

- **Cluster lifecycle & scale** — stop / start / delete the cluster, change the
  SKU + instance count, toggle optimized autoscale and streaming ingestion.
  Backed by ARM (`/api/admin/scaling/adx` GET/POST/PUT →
  `kusto-arm-client.ts`). **Prereq:** the Console UAMI's **Azure Kusto
  Contributor** grant at the cluster scope (role
  `833127c3-3d62-4978-9c27-c0a5e418f64f`, granted by
  `admin-plane/adx-cluster.bicep` `consoleKustoContributor`). That role already
  includes `Microsoft.Kusto/clusters/{stop,start}/action`, write, and delete —
  **no extra role assignment is needed.**
- **Manage principals (RBAC)** — add/remove database- and table-scoped
  principals (`/api/adx/principals` → `.add/.drop database|table <role>`).
- **Row-level security** — author the per-table RLS predicate
  (`/api/adx/rls` → `.alter table <T> policy row_level_security`).

Both data-plane surfaces (RBAC + RLS) ride the Console UAMI's
**AllDatabasesAdmin** grant on the cluster — an ADX `principalAssignments` child
resource (`adxConsoleAdmin` in `admin-plane/adx-cluster.bicep`), **not** an
Azure RBAC roleAssignment. On a **greenfield** deploy this is automatic. For a
**BYO / existing** cluster, grant it once:

```bash
UAMI_OID=$(az identity show -g <admin-rg> -n <console-uami> --query principalId -o tsv)
az kusto cluster-principal-assignment create \
  -g <adx-cluster-rg> --cluster-name <adx-cluster-name> \
  --principal-assignment-name console-uami-alldatabasesadmin \
  --principal-id "$UAMI_OID" --principal-type App --role AllDatabasesAdmin
```

**Verify:** in the KQL editor, open **Manage › Manage principals**, add a viewer,
and confirm it lists; open a table's RLS shield, enable a predicate, and run
`.show table <T> policy row_level_security` — the policy returns
`IsEnabled = true` with your query.

## Tapestry — investigative graph (link / geo / timeline) {#tapestry-investigative-graph}

**Tapestry** is the Azure-native, Gotham-class investigation surface (item type
`tapestry`). It composes three coordinated analysis panes over the **same
materialized `Node_*` / `Edge_*` ADX tables** the graph editors already query —
**no second engine and no Microsoft Fabric dependency** (works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset):

- **Link** — `POST /api/items/tapestry/[id]/link` runs KQL `make-graph` +
  `graph-match` / `graph-shortest-paths` / `graph-mark-components`; results render
  in the force-directed canvas.
- **Geo** — `POST /api/items/tapestry/[id]/geo` projects node `lat`/`lon`
  properties into a GeoJSON FeatureCollection rendered by the keyless
  `GeoJsonMap`. A **live Azure Maps raster basemap** layers behind it when
  `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` is set (Commercial / GCC only — the geo panel
  still renders vector-only in GCC-High / IL5).
- **Timeline** — `POST /api/items/tapestry/[id]/timeline` runs
  `summarize count() by bin(<ts>, <window>), edgeLabel` over `Edge_*`.

**Env (no new variables — all already wired in `admin-plane/main.bicep`):**
`LOOM_KUSTO_CLUSTER_URI` + `LOOM_KUSTO_DEFAULT_DB` (the ADX cluster from
`admin-plane/adx-cluster.bicep`) drive link + geo + timeline;
`NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` (secret `loom-azure-maps-key` from
`admin-plane/azure-maps.bicep`) is the optional live-basemap upgrade. The Console
UAMI's **AllDatabasesAdmin** grant on the cluster (see
[ADX lifecycle](#adx-lifecycle-rbac-rls)) covers the data-plane reads.

**Seed real data (one-time, makes the acceptance pass):**

```bash
# Mint a session cookie, then:
curl -X POST "$BASE/api/admin/load-sample-data?kind=investigation" -b "$COOKIE"
# → materializes Node_Person/Node_Org/Node_Location/Node_Event +
#   Edge_Knows/Edge_MemberOf/Edge_LocatedAt/Edge_Attended in loomdb-default.
```

**Verify:** open a `tapestry` item → **Link** tab → Run link (Pattern match) and
confirm the graph renders; **Geo** tab → Plot located entities (6+ points);
**Timeline** tab → Run timeline (Daily) and confirm per-bucket counts by
relationship. With ADX unset, every pane returns an honest **503** MessageBar
naming `LOOM_KUSTO_CLUSTER_URI` — never a Fabric gate.

### Bicep sync

No new Azure resources or env vars — Tapestry reuses the shared ADX cluster
(`admin-plane/adx-cluster.bicep`) and the existing Azure Maps account
(`admin-plane/azure-maps.bicep`). The three BFF routes consume
`LOOM_KUSTO_CLUSTER_URI` / `LOOM_KUSTO_DEFAULT_DB` /
`NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY`, all already present in the loom-console
container env in `admin-plane/main.bicep`.

## Cost Management + Diagnostics (Console UAMI subscription grants)
Two subscription-scoped grants the admin console needs (the RG-scoped admin-plane
bicep can't express them):

- **Cost Management Reader** — the `/monitor` Cost surface queries
  `Microsoft.CostManagement` across every CSA Loom subscription. Without it a sub
  returns 403 and the Cost UI honest-gates it.
- **Monitoring Contributor** — the "diagnostics on by default" sweep writes
  `microsoft.insights/diagnosticSettings` on resources across the estate. Without
  it the sweep 403s per resource.

Run once per subscription the console should see:

```bash
scripts/csa-loom/grant-cost-monitoring-rbac.sh [subscriptionId ...]   # default: current az sub
```

Idempotent; requires az logged in as Owner / User Access Administrator on the sub.
(Granted live on 363ef5d1-…-bf8c 2026-06-06.)

## Stream Analytics Query Builder — Query Tester grant {#asa-query-tester}

The Eventstream **transform-node builder** (`stream-analytics-job` editor →
**Query Builder** / **Test** tabs) compiles guided filter/aggregate/window/join
operations to SAQL and validates / runs them through the ASA control plane. The
Compile and Test Query operations are **subscription/location-scoped** RP actions
(`Microsoft.StreamAnalytics/locations/{CompileQuery,TestQuery,SampleInput}/action`),
which sit ABOVE the DLZ resource group — so the RG-scoped *Stream Analytics
Contributor* grant from `landing-zone/stream-analytics.bicep` does **not**
authorize them. Grant the Console UAMI the built-in **Stream Analytics Query
Tester** role at subscription scope (one-time):

```bash
az role assignment create --assignee-object-id <console-uami-oid> \
  --assignee-principal-type ServicePrincipal \
  --role "Stream Analytics Query Tester" \
  --scope /subscriptions/<sub>
# role id: 1ec5b3c1-b17e-4e25-8312-2acb3c3c5abf
```

Until granted, the editor's **Compile**/**Run** actions surface an honest error
naming this role — the rest of the builder (guided config + live SAQL preview)
stays fully functional.

**Run test (sample output rows)** additionally needs a place for ASA to write
the test output: set `loomAsaTestWriteUri` (admin-plane param →
`LOOM_ASA_TEST_WRITE_URI`) to a blob **container SAS URL** with write+read.
Without it, **Run test** honest-gates while **Compile** (validation) still works.

## Loom Connections (Key Vault-backed source credentials)

Loom **Connections** (`/connections`) let users register a data-source connection
once; any secret (password / connection string / account key / SPN secret) is
written to **Key Vault** and only a reference is stored. Reused by mirroring,
ADF / Synapse linked services, and datasets.

Wiring (auto on deploy):
- `LOOM_KEY_VAULT_URI` → console env (`admin-plane/main.bicep`, from the keyvault
  module output).
- The Console UAMI is granted **Key Vault Secrets Officer** on the vault
  (`keyvault.bicep`, `consolePrincipalId` param).

For an existing deployment, set the env + grant once:
```bash
az containerapp update --name <loom-console> -g <loom-admin-rg> \
  --set-env-vars "LOOM_KEY_VAULT_URI=https://<vault>.vault.azure.net/"
az role assignment create --assignee-object-id <console-uami-oid> \
  --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets Officer" \
  --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault>
```
(Granted live on kv-loom-… 2026-06-06.)

## External MCP Tools — browse-catalog + deploy wizard {#mcp-catalog-deploy}

Admin → Tenant settings → **External MCP Tools** has a **Browse library** of MCP
servers (`lib/mcp/catalog.ts`). "Deploy" provisions the chosen server as an
**internal Azure Container App** in the Loom managed environment, writes each
`secret:true` config field to **Key Vault** (per-field, value never stored in
Cosmos — only the secret name), wires non-secret fields as env vars, and
auto-registers the endpoint so the Copilot orchestrator discovers its tools. No
Microsoft Fabric dependency (Container Apps + Key Vault + Cosmos only).

Wiring (auto on deploy):
- Console env (`admin-plane/main.bicep`): `LOOM_ACA_ENV_ID` (= CAE resource id),
  `LOOM_ACA_ENV_DOMAIN` (= CAE default domain), `LOOM_MCP_CATALOG_UAMI_ID`
  (= `uami-loom-mcp` resource id).
- RBAC: the **MCP UAMI** is granted **Key Vault Secrets User** (`keyvault.bicep`,
  `mcpPrincipalId`) so the deployed container resolves its secrets at runtime;
  the **Console UAMI** is granted **Managed Identity Operator**
  (`mcp-catalog-rbac.bicep`) so it can assign that identity to the new app. The
  Console UAMI already holds **Contributor** (`scaling-rbac.bicep`) and **Key
  Vault Secrets Officer** (`keyvault.bicep`).
- Permission: `admin.deploy-mcp` (Admin; delegable at `/admin/permissions`).
- Deploy-from-scratch IaC mirror: `mcp-catalog-app.bicep`.

Per-cloud: Commercial / GCC run on Container Apps (full path). GCC-High / IL5 run
the plane on **AKS** (no CAE) — `LOOM_ACA_ENV_ID` is empty and the wizard shows an
honest gate (deploy via the AKS/Helm path instead). For an existing Container
Apps deployment, the three env vars are set automatically by a redeploy; no extra
manual grant is needed beyond the bicep-wired roles above.

## Eventstream MQTT/Kafka mTLS certificates (Key Vault) {#eventstream-mtls-certs}

The Real-Time Hub **Connect source → MQTT** dialog (and the Kafka secure-
connection panels) can authenticate to a broker with mutual TLS using
certificates stored as **Key Vault certificate objects** (PEM, content type
`application/x-pem-file`). The dialog's **TLS/mTLS settings** section offers a
**Trust CA certificate** picker and a **Client certificate and key** picker;
both list real certificates from the eventstream cert vault and the connector
persists only a `{certVaultUri, certName}` reference — never the key material.

Wiring (auto on deploy):
- `LOOM_EVENTSTREAM_CERT_VAULT` → console env (`admin-plane/main.bicep`,
  defaults to the admin-plane vault output; set
  `loomEventstreamCertKeyVaultUri` to isolate streaming certs in a separate
  vault).
- The Console UAMI is granted **Key Vault Certificate User** on the vault
  (`keyvault.bicep`, role `db79e9a7-68ee-4b58-9aeb-b90e7c24fcba`).

Import the CA + client certs as PEM bundles (cert + private key concatenated,
LF line endings, `issuerParameters.name: "Unknown"` for externally signed):
```bash
az keyvault certificate import \
  --vault-name <vault> --name mqtt-ca     --file ca.pem     --policy @pem-policy.json
az keyvault certificate import \
  --vault-name <vault> --name mqtt-client --file client.pem --policy @pem-policy.json
```

For an existing deployment, set the env + grant once:
```bash
az containerapp update --name <loom-console> -g <loom-admin-rg> \
  --set-env-vars "LOOM_EVENTSTREAM_CERT_VAULT=https://<vault>.vault.azure.net/"
az role assignment create --assignee-object-id <console-uami-oid> \
  --assignee-principal-type ServicePrincipal \
  --role "Key Vault Certificate User" \
  --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault>
```

Until configured, the mTLS cert pickers honest-gate with a Fluent MessageBar
naming `LOOM_EVENTSTREAM_CERT_VAULT` + the role to grant — the rest of the MQTT
dialog (broker URL, topic, version, username/password) stays fully functional.
Broker passwords entered in the dialog are written to `LOOM_KEY_VAULT_URI`
(Secrets Officer, above) as a `*SecretRef`, never stored in the item state.

## Delta Sharing shortcuts (cross-tenant) {#delta-sharing-shortcuts}

A **Delta Sharing** lakehouse shortcut (Lakehouse editor → Shortcuts → New
shortcut → *Delta Sharing (cross-tenant)*) virtualizes a table a partner shares
with you over the open Delta Sharing protocol — no Fabric / Power BI dependency.
The share owner gives you a **credential file** (open-sharing profile JSON:
`shareCredentialsVersion`, `endpoint`, `bearerToken`, `expirationTime`) via an
activation link. Store the raw JSON as a **Key Vault secret** and name it in the
wizard; Loom validates the bearer token against the share server on create
(`GET <endpoint>/shares`) and again on **Test/Retry**. A `401`/`403` ⇒ the token
is expired/invalid — the shortcut shows the **Broken** badge; update the KV
secret with a fresh credential file and click **Retry** (or press **F11** on the
selected row) to restore it.

No new Azure resources or env vars are required — the Console UAMI already holds
**Key Vault Secrets Officer** on the admin-plane vault (see above), which is all
a **Files** Delta Sharing shortcut needs (the credential is validated and the
profile is stored in the registry for notebook reads via
`delta_sharing.SharingClient`).

A **Tables** Delta Sharing shortcut additionally registers a Databricks Unity
Catalog table over the `deltaSharing` Spark provider, which requires the
Databricks engine (`LOOM_DATABRICKS_HOSTNAME`) plus a **UC Volume** to hold the
credential file. Create the volume once as a metastore admin in the Databricks
workspace:

```sql
CREATE CATALOG IF NOT EXISTS loom;
CREATE SCHEMA  IF NOT EXISTS loom.loom_shortcuts;
CREATE VOLUME  IF NOT EXISTS loom.loom_shortcuts.loom_shortcut_files;
-- Grant the Console UAMI (workspace service principal) write to the volume:
GRANT WRITE VOLUME, READ VOLUME ON VOLUME loom.loom_shortcuts.loom_shortcut_files TO `<console-uami-app-id>`;
```

Override the volume path with `LOOM_DELTA_SHARING_VOLUME=<catalog>.<schema>.<volume>`
on the Console if you keep shortcut credentials in a different governed volume.
If the volume is absent, a Tables Delta Sharing shortcut honest-gates
(`delta_sharing_needs_uc_volume`) with the exact `CREATE VOLUME` remediation; a
Files Delta Sharing shortcut works without Databricks entirely.

## SharePoint / OneDrive shortcuts (Microsoft Graph) {#sharepoint-shortcuts}

A **SharePoint / OneDrive** lakehouse shortcut (Lakehouse editor → Shortcuts →
New shortcut → *SharePoint / OneDrive*) virtualizes a SharePoint document-library
folder/file or a OneDrive item zero-copy under **Files** — Azure-native parity
with Fabric OneLake's OneDrive/SharePoint shortcut, with **NO Fabric / Power BI
dependency**. The data plane is **Microsoft Graph**, called app-only on the
Console UAMI; it works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

One-time tenant bootstrap:

1. **Grant the Console UAMI two Graph application AppRoles** (out-of-band — ARM
   can't grant Graph AppRoles):

   ```bash
   CONSOLE_UAMI_PRINCIPAL=<console-uami-object-id> \
     scripts/csa-loom/grant-shortcut-graph-approles.sh
   # Sovereign clouds: GRAPH_HOST=https://graph.microsoft.us (GCC-High) /
   #                   https://dod-graph.microsoft.us (IL5)
   ```

   - `Sites.Read.All` (`332a536c-c7ef-4017-ab91-336970924f0d`) — enumerate
     SharePoint sites + their document libraries (drives).
   - `Files.Read.All` (`01d4889c-1287-42c6-ac1f-5d1e02578ef6`) — list + read
     OneDrive / SharePoint drive items the shortcut points at.

2. **A Tenant Administrator grants admin consent** at *Entra ID → Enterprise
   applications → Console UAMI → Permissions → Grant admin consent*. Until
   consented every Graph call returns `403` and the SharePoint source renders its
   honest-gate MessageBar (no mock data).

3. **Enable the feature**: set `loomSharepointShortcutsEnabled=true` in the
   admin-plane bicepparam (wires `LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true` into the
   Console Container App) and redeploy, or set the env var directly. The Graph
   AppRole grant is also performed automatically by the post-deploy bootstrap
   workflow (`csa-loom-post-deploy-bootstrap.yml`).

The `LOOM_GRAPH_BASE` env var (already injected by the admin-plane bicep for the
identity picker) determines the sovereign Graph host + token scope, so GCC-High /
IL5 mint a sovereign-scoped token. **SharePoint/OneDrive shortcuts are Files-only**
(Graph is a file API — a *Tables* shortcut honest-gates `sharepoint_files_only`).
Browse supports a SharePoint site search, your OneDrive, or pasting a sharing
link. The **Test** action re-reads the targeted drive item via Graph (a `404` ⇒
the document moved/was deleted; a `403` ⇒ consent/AppRole revoked).

## Approval Logic App — Office 365 connection consent {#approval-logic-app-o365}

The pipeline editor's **Approval (Logic App)** activity (F25) is backed by a
Consumption Logic App + Office 365 Outlook connection deployed by
`platform/fiab/bicep/modules/integration/approval-logicapp.bicep` (wired into the
DLZ landing-zone as module `approvalLogicApp`). Bicep creates the
`office365-loom-approval` connection but **cannot** perform the interactive OAuth
consent — that is a one-time admin action.

### Why a one-time step is required

The Office 365 Outlook managed connector authenticates as a **licensed mailbox**
via delegated OAuth. There is no service-principal / managed-identity path for
`/approvalmail/$subscriptions`, so a human with a licensed mailbox must authorize
the connection once. Until then the `Send_approval_email` action returns `401`
and the Approval activity surfaces a clear error.

### Step 1 — Authorize the connection

1. Portal → the DLZ resource group → open Logic App `logic-loom-approval-<region>`.
2. **Logic app designer** → select the **Send_approval_email** action →
   **Change connection** → **Add new** → sign in with a licensed Office 365
   mailbox (the "from" sender for approval emails).
3. **GCC-High / IL5:** choose the **AzureUSGovernment** authentication endpoint
   (`login.microsoftonline.us`) and confirm `AZURE_CLOUD=AzureUSGovernment` is set
   on the Console (admin-plane sets this automatically for GCC-High / IL5).

### Step 2 — Confirm Console wiring

The Console reads the Logic App via `LOOM_APPROVAL_LOGIC_APP_NAME`
(default `logic-loom-approval-<region>`) and `LOOM_APPROVAL_LOGIC_APP_RG`
(defaults to `LOOM_DLZ_RG`). For an existing deployment:
```bash
az containerapp update --name <loom-console> -g <loom-admin-rg> \
  --set-env-vars "LOOM_APPROVAL_LOGIC_APP_NAME=logic-loom-approval-<region>" \
                 "LOOM_APPROVAL_LOGIC_APP_RG=<dlz-rg>"
```

### Step 3 — Verify

In a pipeline, add an **Approval (Logic App)** activity, declare a `string`
parameter `approverEmail`, click **Fetch trigger URL** (populates the activity
`url`), Save + Publish, then Run. An approval email arrives; **Approve**
continues the pipeline, **Reject** fails the branch.

### Bicep sync

`approval-logicapp.bicep` deploys the workflow + O365 connection + Logic App
Contributor grant for the Console UAMI (so the BFF can call `listCallbackUrl`).
`admin-plane/main.bicep` exposes `loomApprovalLogicAppName` /
`loomApprovalLogicAppRg` as env vars. Only the OAuth consent above is manual.

## Reference Lakehouse — cross-account RBAC {#reference-lakehouse-cross-account-rbac}

Loom's **Reference Lakehouses** federation (lakehouse explorer → **References →
+**) lets a primary lakehouse browse other in-workspace lakehouses side-by-side,
**read-only**. Reads use **pass-through RBAC**: the Console UAMI reads the
referenced lakehouse's ADLS Gen2 containers with its own managed identity.

- **Same-account references (default):** no action needed. In-workspace
  lakehouses share the primary LOOM ADLS Gen2 account, on which the Console UAMI
  already holds **Storage Blob Data Contributor** (a superset of Reader). Add a
  reference, expand it, and browse/preview immediately.
- **Cross-account references:** when a referenced lakehouse declares its own
  storage account (`state.storageAccount`), grant the Console UAMI **Storage
  Blob Data Reader** (`2a2b9908-6ea1-4ae2-8e65-a410df84e7d1`) on that account
  (or a single container). Until granted, the reference shows an error icon +
  the exact remediation tooltip in the explorer (honest gate, per
  `.claude/rules/no-vaporware.md`):

```bash
# Grant the Console UAMI read on a referenced (cross-account) storage account:
az role assignment create --assignee-object-id <console-uami-oid> \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Reader" \
  --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>

# (Optional) scope to a single container instead of the whole account:
#   .../storageAccounts/<account>/blobServices/default/containers/<container>
```

No new bicep resource ships for this — the referenced account is a **runtime**
choice (which lakehouse the user adds), not a deploy-time input, so the grant is
an operator action exactly like cross-account Lakehouse **shortcuts**. The
reference set itself is stored on the primary lakehouse's Cosmos `items` doc
(`state.referencedLakehouseIds`) — no new Cosmos container, no new env var.

For **previews** of a cross-account reference, the **Synapse Serverless** MI
(used by OPENROWSET) must also hold Storage Blob Data Reader on the referenced
account — same `az role assignment create` with the Synapse workspace MI's
object id.

**Sovereign clouds (GCC / GCC-High / IL5):** the ADLS DFS host is hard-coded to
`*.dfs.core.windows.net` in `adls-client.ts` (a pre-existing, separately-tracked
limitation). Until a `LOOM_STORAGE_ENDPOINT_SUFFIX` is introduced, only
**same-account** references are supported in sovereign clouds; cross-account
references there are blocked until the DFS host is parameterized.

---

## AI Foundry (AIServices) — Console UAMI Cognitive Services roles {#foundry-aiservices-roles}

> **#1468.** CSA Loom's default "Foundry" is an **AIServices Cognitive Services
> account** (`aifndry-loom-<region>`, `kind=AIServices`) — *not* a classic
> `Microsoft.MachineLearningServices/workspaces`. The AzureML "Data Scientist"
> role/scope does not apply to it, so the old bootstrap grant 404'd and (because
> the steps weren't decoupled) cascade-skipped the grants after it.

For the AIServices Foundry account the Console UAMI needs **Cognitive Services
roles** on the account scope, granted by the bootstrap **Grant Console UAMI
Foundry roles** step (type-aware; decoupled `continue-on-error`):

| Role | GUID | Why |
|---|---|---|
| Cognitive Services User | `a97b65f3-24c7-4388-baec-2e87135dc908` | read/list the account, deployments, models |
| Cognitive Services OpenAI User | `5e0bd9bd-7b93-4f28-af87-19fc36ad61bd` | chat/completions/embeddings data-plane calls (Entra auth) |

The step detects the account type and only takes the AzureML path
(`AzureML Data Scientist` + `AzureML Compute Operator`, below) when a real
`Microsoft.MachineLearningServices/workspaces` exists. To grant manually on an
AIServices estate:

```bash
AISVC=$(az cognitiveservices account list -g <admin-rg> \
  --query "[?contains(name,'aifndry') || kind=='AIServices'].id | [0]" -o tsv)
for ROLE in a97b65f3-24c7-4388-baec-2e87135dc908 5e0bd9bd-7b93-4f28-af87-19fc36ad61bd; do
  az role assignment create --assignee-object-id <console-uami-oid> \
    --assignee-principal-type ServicePrincipal --role "$ROLE" --scope "$AISVC"
done
```

The single-sub greenfield path also grants these from bicep (`ai-foundry.bicep`
Cognitive Services role assignments). The AzureML section below applies **only**
to a BYO classic MLServices hub.

---

## Azure ML / AI Foundry Hub — Console UAMI AzureML Data Scientist {#aml-data-scientist}

The Data Science editors — **`ml-model`** (model registry + online endpoints)
and **`ml-experiment`** (jobs + MLflow runs/metrics) — call the Azure ML data
plane (`Microsoft.MachineLearningServices/workspaces/.../{models,jobs}` ARM REST
and the `*.api.azureml.ms` MLflow tracking server) **with the Console UAMI's
managed identity**. Both require the UAMI to hold **AzureML Data Scientist**
(`f6c7c914-8db3-469d-8ca1-694a8f32e121`) on the target workspace. Without it,
`GET /api/items/ml-model` and `GET /api/items/ml-experiment` return **403** and
the editors render their honest MessageBars naming this role.

### Greenfield (let bicep do it)

No action needed. When `aiFoundryEnabled = true`, `ai-foundry.bicep` grants the
Console UAMI AzureML Data Scientist on the Foundry hub workspace
(`hubConsoleDataScientist`) at deploy time — the editors work on a clean deploy.

### Bring-your-own Foundry hub

When you point Loom at an existing hub (`EXISTING_AOAI` / `existingFoundryAccountName`),
bicep does **not** touch that workspace's RBAC. Grant the UAMI manually:

```bash
az role assignment create \
  --assignee-object-id <console-uami-oid> \
  --assignee-principal-type ServicePrincipal \
  --role "AzureML Data Scientist" \
  --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.MachineLearningServices/workspaces/<hub-name>
# role id: f6c7c914-8db3-469d-8ca1-694a8f32e121
```

### Verify

Open an `ml-model` item → the bind picker lists real AML workspaces + models.
Open an `ml-experiment` item → the jobs list loads (no 403); the "Runs &
metrics" tab returns MLflow runs. If gated, the MessageBar names the unset env
var / this role.

### Bicep sync

- Greenfield grant: `platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep`
  (`hubConsoleDataScientist`).

---

## Deploy-planner ML workspace — LOOM_AML_WORKSPACE env patch {#aml-workspace-env-patch}

By default the `ml-experiment` "Runs & metrics" tab tracks against the AI Foundry
hub workspace (via the `LOOM_FOUNDRY_NAME` / `LOOM_FOUNDRY_REGION` fallback in
`mlflow-client.ts`) — so it works out of the box. When you deploy a **dedicated**
Azure ML workspace alongside the console (deploy-planner `mlWorkspaceEnabled = true`,
or a BYO AML workspace) and want experiment tracking to target **that** workspace,
the console's `LOOM_AML_WORKSPACE` env var must be set.

The admin-plane Container App env is rendered **before** the deploy-planner
workspace exists (same ordering constraint as the Databricks hostname), so this
is a one-time post-deploy patch:

```bash
AML_WS=$(az ml workspace show -g <dlz-rg> -n <aml-workspace-name> --query name -o tsv)
az containerapp update --name loom-console -g rg-csa-loom-admin-<region> \
  --set-env-vars LOOM_AML_WORKSPACE="$AML_WS" LOOM_AML_RG=<dlz-rg>
```

Without the patch, the tab falls back to the Foundry hub as the MLflow target —
still functional, but runs logged against the dedicated workspace won't appear.
Also grant the Console UAMI AzureML Data Scientist on that workspace
([§AzureML Data Scientist](#aml-data-scientist)).

| Env var | Backs | Fallback when empty |
|---|---|---|
| `LOOM_AML_WORKSPACE` | MLflow tracking workspace name (`mlflow-client.ts`) | `LOOM_FOUNDRY_NAME` |
| `LOOM_AML_RG` | RG of that workspace | `LOOM_FOUNDRY_RG` |

### Bicep sync

- `LOOM_AML_WORKSPACE` / `LOOM_AML_RG` params + env wiring:
  `platform/fiab/bicep/modules/admin-plane/main.bicep` (`loomAmlWorkspace` /
  `loomAmlRg`), threaded from `platform/fiab/bicep/main.bicep`.

---

## Notebook Pylance / pylsp IntelliSense bridge

The notebook cell editor (Monaco) gets Pylance-grade Python IntelliSense
(completions, hover docstrings, signature help, diagnostics) from
**python-lsp-server + pyright** running **in the Console container** — no
Fabric, no external call, all clouds. It is **opt-in** so the default image is
untouched.

To enable it:

1. **Build the Console image with the pylsp layer.** CI passes the build-arg for
   the Data Science notebook variant:

   ```bash
   docker build apps/fiab-console --build-arg LOOM_INCLUDE_PYLSP=true -t <acr>/loom-console:<tag>
   ```

   Without this layer the bridge simply stays off (probe reports
   `lspAvailable:false`) and cells keep Monaco's built-in completions.

2. **Turn the bridge on** by setting the Console app env var (Bicep param
   `pylspEnabled` on `admin-plane/app-deployments.bicep`, surfaced as
   `LOOM_PYLSP_ENABLED`):

   ```bicep
   // params/<cloud>-full.bicepparam
   param pylspEnabled = true
   ```

   `instrumentation.ts` then attaches the WebSocket bridge to the Next HTTP
   server on `/api/notebook/*/lsp` (same port, same Container Apps ingress;
   WebSockets work on the default `http` transport). The upgrade is authenticated
   with the encrypted `loom_session` cookie.

3. **(Optional) Curated AML Environment.** `deploy-planner/ml-workspace.bicep`
   ships `loom-pylsp-env` (jupyter-lsp + python-lsp-server + pyright over
   pandas/numpy/scikit-learn) so AML compute instances + JupyterLab get the same
   IntelliSense and the VS Code for the Web path uses a known-good kernel.

### "Open in VS Code for the Web" deep-link (Commercial only)

The notebook header shows an **Open in VS Code for the Web** button that
deep-links to the AML compute-instance VS Code surface. Microsoft does not offer
VS Code for the Web in GCC / GCC-High / DoD, so the button is gated on
`CSA_LOOM_BOUNDARY === 'Commercial'` **and** only renders when both AML values
are configured (no dead button):

```bicep
param amlInstance     = '<aml-compute-instance-name>'   // LOOM_AML_INSTANCE
param amlWorkspaceId  = '<aml-workspace-arm-id-or-wsId>' // LOOM_AML_WORKSPACE_ID
// param amlPortalBase = 'https://ml.azure.com'          // default
```

These flow through `app-deployments.bicep` to the Console as `LOOM_AML_INSTANCE`,
`LOOM_AML_WORKSPACE_ID`, `LOOM_AML_PORTAL_BASE`. The gate is evaluated
server-side in `/api/notebook/[id]/lsp`; the client never reads boundary env
directly.

## Govern tab — data-owner posture refresh (F3) {#posture-refresh}

The **Govern tab → data-owner ("My items") view** (`/governance/govern?view=owner`)
shows the signed-in user's governance posture — inventory, sensitivity-label
coverage, and curation state — plus owner-scoped recommended-action cards. On
tab-open the Console BFF dispatches an owner-scoped recompute to the
**`posture-refresh`** Azure Function (fire-and-forget), which writes fresh
aggregates to Cosmos; the Console then re-reads them. The surface is **fully
functional without the Function** — when it is not wired, the BFF computes the
same posture live from Cosmos and the UI shows an honest MessageBar. No Fabric /
Power BI dependency on any path (all four clouds behave identically).

### Cosmos containers (auto-created, no ARM step)

Created lazily by the Console's `cosmos-client.ts` (`createIfNotExists`) on first
access — no Bicep container resource needed beyond the account + database:

| Container | Partition key | Doc |
|-----------|---------------|-----|
| `posture-aggregates` | `/ownerId` | `{ id: ownerId, ownerId, totalItems, labelCoveragePct, descriptionCoveragePct, endorsementCoveragePct, computedAt }` |
| `recommended-actions` | `/ownerId` | `{ id: ownerId, ownerId, unlabeled[], undescribed[], unendorsed[], computedAt }` |

`id == partitionKey == ownerId` (the owner OID), so every owner read/write is a
single-partition point-operation — cross-owner leakage is structurally impossible.

### Wire the Function (optional — UI works without it)

1. Deploy `azure-functions/posture-refresh/deploy/main.bicep` (storage + Y1 plan +
   Python Function App with system-assigned MI + cross-RG Cosmos data-plane grant).
   See `azure-functions/posture-refresh/DEPLOYMENT.md`.
2. Publish code, capture the host key, store it in the Loom Key Vault as
   `loom-posture-function-key`.
3. Set the admin-plane params so the Console picks it up:

   ```bicep
   // params/<cloud>-full.bicepparam
   param loomPostureFunctionUrl = '<functionUrl output>'
   // param loomPostureFunctionKeySecretName = 'loom-posture-function-key'  // default
   ```

   These surface as `LOOM_POSTURE_FUNCTION_URL` (plain) and
   `LOOM_POSTURE_FUNCTION_KEY` (secretRef → Key Vault) on the Console. Empty URL →
   honest gate + live compute fallback.

Per-cloud: `LOOM_COSMOS_ENDPOINT` is already boundary-resolved by
`admin-plane/main.bicep` (`documents.azure.com` Commercial/GCC,
`documents.azure.us` GCC-High/IL5); the Function needs no cloud-specific code.

---

## OneLake Security (F7) — Console UAMI Storage Blob Data Owner {#onelake-security-acl}

The **Security** tab in the Lakehouse / Mirrored-Database / Mirrored-Databricks
editors creates **data-access roles** that grant Read / ReadWrite on chosen
folders + tables to chosen members. The Azure-native backend enforces each role
as **ADLS Gen2 POSIX ACLs** on the Delta folders (no Fabric workspace required).

Setting ACLs **on behalf of other principals** requires the Console UAMI to hold
**Storage Blob Data Owner** (`b7e6dc6d-f1e8-4753-8033-0f276bb0955b`) on the DLZ
storage account — the only built-in role with the ACL-modify "superuser" bit
(Reader / Contributor cannot set ACLs for others). This is off by default
(least-privilege); enable it when you want the Security tab.

### Step 1 — Deploy with the feature enabled

```bicep
// params/<cloud>-full.bicepparam
param loomOnelakeSecurityEnabled = true   // → Storage Blob Data Owner grant + LOOM_ONELAKE_SECURITY_ACL=true
// param loomFabricSecurityEnabled = true  // OPTIONAL opt-in Fabric dataAccessRoles mirror (non-Gov only)
```

`synapse.bicep` / `synapse-storage-rbac.bicep` then grant the Owner role
(`consoleOwnerGrant`), and `admin-plane/main.bicep` sets
`LOOM_ONELAKE_SECURITY_ACL=true` on loom-console.

### Step 1b — Existing deployment (manual grant + env)

```bash
az role assignment create --assignee-object-id <console-uami-oid> \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Owner" \
  --scope /subscriptions/<sub>/resourceGroups/<dlz-rg>/providers/Microsoft.Storage/storageAccounts/<dlz-account>
az containerapp update --name loom-console -g rg-csa-loom-admin-<region> \
  --set-env-vars LOOM_ONELAKE_SECURITY_ACL=true
```

Until both are in place, the Security tab renders but **honest-gates** role
creation with a MessageBar naming `LOOM_ONELAKE_SECURITY_ACL` + the Owner role.

### Step 2 — Verify

Open a lakehouse → **Security** → **New role**, pick `/Tables/<t>` + a member,
**Create role**. Then the **Verification** view reads the live ACL back
(`getAccessControl`) and confirms the member's object id is present — the
read-back proves the grant is real.

### Opt-in Fabric mirror (non-Gov only)

With `LOOM_FABRIC_SECURITY_ENABLED=true` and a bound Fabric workspace + item id,
the **Fabric sync** sub-tab pushes the Loom roles to Fabric's
`PUT /workspaces/{ws}/items/{id}/dataAccessRoles` (replace-all). Honest-gated off
in GCC-High / IL5 (Fabric is not authorized at that boundary) — the ADLS ACL path
is the only one there and remains fully functional.

### Bicep sync

- Owner grant: `landing-zone/synapse.bicep` (`loomOnelakeSecurityEnabled`) →
  `synapse-storage-rbac.bicep` (`consolePrincipalNeedsOwner`, `consoleOwnerGrant`).
- Env vars: `admin-plane/main.bicep` (`loomOnelakeSecurityEnabled` →
  `LOOM_ONELAKE_SECURITY_ACL`; `loomFabricSecurityEnabled` →
  `LOOM_FABRIC_SECURITY_ENABLED`).
- Cosmos container `onelake-security-roles` (PK `/itemId`) — created lazily by
  `cosmos-client.ts`, no ARM step.

## Workspace Manage Access — RBAC-Admin grant + Graph + Fabric opt-in (F5) {#workspace-manage-access}

The workspace **Manage access** pane (Settings → Permissions, and the standalone
button on the workspace page) is Azure-native: each membership row is stored in
Cosmos `workspace-roles` AND mirrored to a real Azure RBAC role assignment on
the DLZ resource group (Admin/Member → Contributor; Contributor/Viewer →
Reader). No Fabric capacity is required.

### Step 1 — RBAC-Admin grant (bicep, automatic)

`platform/fiab/bicep/modules/admin-plane/workspace-rbac.bicep` grants the
Console UAMI the **Role Based Access Control Administrator** role
(`f58310d9-a9f6-439a-9e8d-f62e7b41a168`) on the DLZ RG, CONSTRAINED via an ABAC
condition (v2.0) so it may only write/delete Contributor + Reader assignments.
It is wired in `main.bicep` (`module workspaceRbac`, scoped to `loomDlzRg`) and
runs unless `skipRoleGrants=true`. When skipped (deployer lacks User Access
Administrator), grant it manually:

```bash
az role assignment create \
  --role "Role Based Access Control Administrator" \
  --assignee <console-uami-principal-id> \
  --scope /subscriptions/<sub>/resourceGroups/<dlz-rg>
```

Until the grant exists the pane still works — membership is recorded in Cosmos
and the **Azure RBAC** column shows `Pending` with the exact remediation in an
honest-gate MessageBar (per `no-vaporware.md`).

### Step 2 — Graph read permissions (shared with the grant dialog)

Member search + nested-group resolution reuse the Console UAMI's Graph app
permissions **User.Read.All + Group.Read.All** (granted in the
[MIP + DLP Graph consent](#graph-admin-consent-mip-dlp) step). `GroupMember.Read.All`
is sufficient for `transitiveMembers` if you prefer least-privilege. The Graph
host is cloud-aware (`graphBase()` → `graph.microsoft.us` in Gov).

### Step 3 — (Opt-in) Fabric role mirroring

Strictly optional. To ALSO mirror roles to a Microsoft Fabric workspace, set
`param loomWorkspaceRolesFabricEnabled = true` (Console env
`LOOM_WORKSPACE_ROLES_FABRIC=1`) and add the Console UAMI to the target Fabric
workspace as **Admin**. The flag is forced OFF at IL5 (Fabric is not
IL5-authorized). With the flag unset, nothing calls `api.fabric.microsoft.com`.

### Verify

Add a real Entra group with **Member** role → the row appears, the **Azure RBAC**
column reads `Active`, and `az role assignment list --scope /subscriptions/<sub>/resourceGroups/<dlz-rg>`
shows a Contributor assignment for that group's object id. Remove → both the
Cosmos row and the ARM assignment are gone.

### Bicep sync

- Module: `platform/fiab/bicep/modules/admin-plane/workspace-rbac.bicep`
- Wired in `admin-plane/main.bicep` (`module workspaceRbac` + param
  `loomWorkspaceRolesFabricEnabled` + env `LOOM_WORKSPACE_ROLES_FABRIC`)
- Cosmos container `workspace-roles` is created lazily by `cosmos-client.ts`.

## SQL endpoint "user's identity" data-access mode {#sql-user-identity-access-mode}

A SQL analytics endpoint (Synapse Dedicated / Serverless SQL pool) has a
**Data access mode** control in its editor (F10):

- **Delegated (service identity)** — the DEFAULT. Queries run as the Loom
  console managed identity. Always works; no per-user setup. Nothing below is
  required for this mode.
- **User's identity** — queries run under the signed-in user's own Azure
  identity (so row-level security, `SUSER_NAME()`, and the SQL audit log reflect
  the real user). This is **opt-in** and needs the one-time tenant config below.
  Until it's done, the mode is honest-gated: the query route returns
  `NO_USER_SQL_TOKEN` and the editor shows what to do.

**Step 1 — Delegated SQL permission + admin consent (one-time, per tenant).**
The Loom console app registration must hold the Azure SQL Database
`user_impersonation` delegated permission so a SQL-audience token is issued for
the user at sign-in. The audience host is cloud-portable via
`LOOM_SYNAPSE_SQL_TOKEN_SCOPE` (`database.windows.net` for Commercial/GCC,
`database.usgovcloudapi.net` for GCC-High/IL5) — already set per-boundary in
`admin-plane/main.bicep`, so no new env var.

```bash
az login   # user/SP with Application.ReadWrite.All on the app
MSAL_APP_ID=<loom console app registration appId> \
  scripts/csa-loom/grant-sql-delegated-permission.sh
# then a Tenant Admin grants consent:
az ad app permission admin-consent --id <loom console app registration appId>
```

**Step 2 — Provision the user in the SQL endpoint** (so their token authorizes):

- *Dedicated pool* (run as the Synapse AAD admin / console UAMI):
  ```sql
  CREATE USER [user@tenant.onmicrosoft.com] FROM EXTERNAL PROVIDER;
  ALTER ROLE db_datareader ADD MEMBER [user@tenant.onmicrosoft.com];
  ALTER ROLE db_datawriter ADD MEMBER [user@tenant.onmicrosoft.com];
  ```
- *Serverless (OPENROWSET over ADLS)*: grant the user **Storage Blob Data
  Reader** on the lake storage account (Azure RBAC). Workspace members often
  already have it — then no extra step.

**Verify.** With the mode set to *User's identity*, run
`SELECT SUSER_NAME() AS me;` (Dedicated) — it returns the signed-in user's UPN,
not the console identity. The chosen mode persists in Cosmos
(`item.state.accessMode`) and survives reload.


## Open mirroring (push Parquet → managed Delta) — producer onboarding

The "Open mirroring" source on a Mirrored Database is a **push** model: an
external producer writes Parquet into the DLZ **`landing`** ADLS Gen2 container
at `<mirrorId>/<table>/*.parquet`, and Loom merges it into a managed Delta table
under `bronze/mirrors/<workspaceId>/<mirrorId>/Tables/<table>` via a **Synapse
Spark Livy batch** (`runOpenMirrorMerge`). No Microsoft Fabric.

**Already provisioned by bicep — no extra admin step for Loom itself:**

- The `landing` container is created in `landing-zone/storage.bicep` and surfaced
  to the console as `LOOM_LANDING_URL` (admin-plane `apps[].env`).
- The Console UAMI already holds **Storage Blob Data Contributor** on the DLZ
  storage account (it lists the landing zone, uploads the merge script to
  `bronze/scripts/open-mirror-merge.py`, and the Spark job writes Delta).
- The merge job runs on the Spark pool named by `LOOM_OPEN_MIRROR_POOL`
  (optional override) → falls back to `LOOM_SYNAPSE_SPARK_POOL` → `LOOM_SPARK_POOL`
  → `loompool`. `LOOM_SYNAPSE_WORKSPACE` must be set (it already is for the
  notebook / Spark editors).

**One grant for the EXTERNAL producer** (its own SP / UAMI object id — not known
to bicep at deploy time). Use the **RBAC** path shown in the editor's "Producer
credentials → RBAC" tab:

```bash
az role assignment create \
  --role "Storage Blob Data Contributor" \
  --assignee "<producer-principal-object-id>" \
  --scope "/subscriptions/<sub>/resourceGroups/<dlz-rg>/providers/Microsoft.Storage/storageAccounts/<account>/blobServices/default/containers/landing"
```

**SAS alternative (optional).** To hand the producer a user-delegation SAS instead
of RBAC, grant the **Console UAMI** the `Storage Blob Delegator` role on the DLZ
storage account (it is not part of the default grant set). The editor's "Producer
credentials → SAS" tab surfaces this as an honest gate with the exact command.

## BigQuery + Oracle mirror sources (Fabric Build 2026 #19) {#mirror-bigquery-oracle}

The mirror wizard's **Google BigQuery** and **Oracle** source cards capture the
source-specific connection coordinates the Azure-native default backend (ADF copy
→ ADLS Bronze Delta) needs. **No Microsoft Fabric** is involved on the default
path; Fabric open-mirroring (Google BigQuery preview / Oracle GoldenGate) is the
opt-in alternative only.

**No NEW env var is introduced** — both reuse the existing ADF CDC plumbing
(`LOOM_ADF_NAME`, `LOOM_MIRROR_SOURCE_LINKED_SERVICE`,
`LOOM_MIRROR_ADLS_LINKED_SERVICE`). The one-time tenant setup is the *source-side*
prerequisite the wizard surfaces as an honest gate:

| Source | Wizard fields | One-time tenant prerequisite |
|---|---|---|
| **Google BigQuery** | GCP project id, dataset, Key Vault connection holding the service-account JSON | An ADF **GoogleBigQueryV2** linked service bound to the service-account key; the SA needs **BigQuery Data Viewer** + **BigQuery Job User** on the project. Point `LOOM_MIRROR_SOURCE_LINKED_SERVICE` at it. |
| **Oracle** | host, service name/SID, on-prem data gateway (SHIR), sync user, Key Vault connection holding the sync-user secret | An **on-prem data gateway / self-hosted integration runtime** that can reach the Oracle listener, plus an ADF **Oracle** linked service bound to it. The sync user needs `CREATE SESSION`, `SELECT_CATALOG_ROLE`, `EXECUTE_CATALOG_ROLE`, `SELECT ANY TABLE`, `LOGMINING` (see Learn). Point `LOOM_MIRROR_SOURCE_LINKED_SERVICE` at it. |
| **Snowflake** | account/host, database, Key Vault connection holding the Snowflake credential, sync mode | An ADF **Snowflake** linked service (credential in Key Vault). Set `LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE` to it (falls back to `LOOM_MIRROR_SOURCE_LINKED_SERVICE`) + `LOOM_MIRROR_ADLS_LINKED_SERVICE` for the Bronze sink. Snowflake mirrors via an ADF **Copy** pipeline (delete-then-copy full refresh → Bronze Parquet) + a schedule trigger on `LOOM_MIRROR_COPY_CADENCE` (default `1h`). |

### Ongoing CDC per source — what each `syncMode` actually does {#mirror-ongoing-cdc}

The wizard's **Sync mode** control (snapshot · incremental · continuous) is carried
into `mirroring.json` `source.typeProperties.syncMode` and persisted to item state;
**Start** reads it and picks the real Azure-native engine — no Fabric:

| Source | Incremental engine | Notes |
|---|---|---|
| **Azure SQL DB / MI / SQL Server** | SQL **Change Tracking** delta (CHANGETABLE), or ADF **CDC** resource → Bronze Delta when `LOOM_ADF_NAME` + the two linked-service vars are set (`continuous`). | Watermark = `CHANGE_TRACKING_CURRENT_VERSION`. |
| **PostgreSQL** | **Watermark-incremental** on an auto-detected monotonic column (updated-at timestamp / serial id) — the PG analog of Change Tracking. | PG is **not** a valid ADF `adfcdcs` source, so it never uses the CDC resource. Insert/update fidelity; physical deletes are a disclosed follow-up. |
| **Cosmos DB** | **`_ts`-watermark incremental** — each Start reads only documents whose server-stamped `_ts` advanced. | No analytical-store / Synapse Link required (that is Fabric-adjacent and deprecated for new projects); the transactional `_ts` watermark is the no-Fabric path. |
| **Snowflake** | ADF **Copy** runtime — delete-then-copy full refresh → Bronze Parquet, re-run on the `LOOM_MIRROR_COPY_CADENCE` schedule trigger (`incremental`/`continuous`). `snapshot` = one-time load, no trigger. | Needs the Snowflake + ADLS linked services above. |

New env vars (all default-empty / `1h`, threaded root `main.bicep` → `admin-plane`):
`LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE`, `LOOM_MIRROR_COPY_CADENCE`. The pre-existing
`LOOM_MIRROR_SOURCE_LINKED_SERVICE` / `LOOM_MIRROR_ADLS_LINKED_SERVICE` are now also
threaded from the root template (previously admin-plane-only).

Until the linked services are configured, **Start** returns a precise gate naming
the exact env var + grants (no fake "Running"), and **Verify** returns a
source-specific reachability note (the service-account / gateway is validated when
the copy first runs). All wizard fields render + persist regardless, so the
surface is never empty.

Learn references: [BigQuery mirroring](https://learn.microsoft.com/fabric/mirroring/google-bigquery) ·
[Oracle mirroring](https://learn.microsoft.com/fabric/mirroring/oracle) ·
[Oracle required permissions](https://learn.microsoft.com/fabric/mirroring/oracle-limitations#required-permissions) ·
[ADF BigQuery V2 connector](https://learn.microsoft.com/azure/data-factory/connector-google-bigquery) ·
[ADF Oracle connector](https://learn.microsoft.com/azure/data-factory/connector-oracle).

## Item-level Share — per-database Azure RBAC (Access control / IAM) {#sql-database-share-rbac}

The **Share** tab in the SQL database editor mirrors the Azure portal *Access
control (IAM) → Add role assignment* blade scoped to a single Azure SQL database
(`Microsoft.Sql/servers/{server}/databases/{db}`). It assigns **Reader**,
**Contributor**, or **SQL DB Contributor** to an Entra user/group, lists the
assignments declared at that scope, and revokes them — all real ARM REST.

Assigning roles requires the Console UAMI to hold **Role Based Access Control
Administrator** (`f58310d9-a9f6-439a-9e8d-f62e7b41a168`) on the SQL server's
resource group. To stay least-privilege the grant is **ABAC-constrained** to
exactly those three role GUIDs — the UAMI cannot grant Owner / User Access
Administrator even though it holds RBAC-Admin. The principal picker also needs
the UAMI's Graph `User.Read.All` + `Group.Read.All` app-roles (already granted
by the Identity Picker bootstrap; see `identity-graph-rbac.bicep`).

### Bicep sync (default — no manual step)

`admin-plane/sql-database-share-rbac.bicep` runs automatically (unless
`skipRoleGrants=true`), scoped to `LOOM_SQL_RG` (defaults to `LOOM_DLZ_RG`):

```bicep
// params/<cloud>-full.bicepparam — only if your SQL servers live outside the DLZ RG
param loomSqlServerRg = 'rg-my-sql-servers'   // → constrained RBAC-Admin grant here + LOOM_SQL_RG
```

### Existing deployment (manual grant)

```bash
RG=<sql-server-rg>
az role assignment create \
  --assignee-object-id <console-uami-oid> --assignee-principal-type ServicePrincipal \
  --role "Role Based Access Control Administrator" \
  --scope "/subscriptions/<sub>/resourceGroups/$RG" \
  --condition-version 2.0 \
  --condition "((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {acdd72a7-3385-48ef-bd42-f606fba81ae7, b24988ac-6180-42a0-ab88-20f7382dd24c, 9b7fa17d-e63e-47b0-bb0a-15c516ac86ec})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {acdd72a7-3385-48ef-bd42-f606fba81ae7, b24988ac-6180-42a0-ab88-20f7382dd24c, 9b7fa17d-e63e-47b0-bb0a-15c516ac86ec}))"
```

**Verify.** On the Share tab, search a user, pick **Reader**, click **Assign** —
the success MessageBar prints the live ARM **assignment id**
(`…/providers/Microsoft.Authorization/roleAssignments/<guid>`). The *Current
access* sub-tab lists it; **Revoke** removes it. If the UAMI lacks the grant the
ARM call returns **403** and the verbatim message surfaces in the dialog (no
fake success).

## Source control for SQL schema — ADO / GitHub connection {#sql-database-git}

The **Source control** tab on the SQL database editor is an **honest gate** until
a Git provider is connected. Schema version control (DACPAC diff, migration
history) runs through an Azure DevOps service connection or a GitHub Actions
workflow — not a live ARM data-plane API — so it is configured via environment
variables + a pipeline, not an in-app commit form.

Set on the Console container app (then redeploy) — wire in
`admin-plane/main.bicep` (these map 1:1 to the params there):

| Setting | When | Meaning |
|---|---|---|
| `LOOM_SQL_GIT_PROVIDER` | always | `azdo` or `github` (empty = honest gate) |
| `LOOM_SQL_GIT_ADO_ORG` | azdo | Azure DevOps organization name |
| `LOOM_SQL_GIT_ADO_PROJECT` | azdo | Azure DevOps project holding the repo |
| `LOOM_SQL_GIT_ADO_REPO` | azdo | Git repository name for the DACPAC project |
| `LOOM_SQL_GIT_ADO_PAT_SECRET` | azdo | Key Vault secret name holding the ADO PAT |
| `LOOM_SQL_GIT_GITHUB_REPO` | github | `org/repo` for the schema project |
| `LOOM_SQL_GIT_GITHUB_BRANCH` | github | default branch (e.g. `main`) |
| `LOOM_SQL_GIT_GITHUB_PAT_SECRET` | github | Key Vault secret name holding the GitHub PAT |

```bicep
// params/<cloud>-full.bicepparam
param loomSqlGitProvider = 'azdo'
param loomSqlGitAdoOrg = 'contoso'
param loomSqlGitAdoProject = 'DataPlatform'
param loomSqlGitAdoRepo = 'sql-schema'
param loomSqlGitAdoPatSecretName = 'sql-git-ado-pat'   // a Key Vault secret name
```

Then add a pipeline step that runs `SqlPackage /Action:Extract` (produce a
DACPAC) + `SqlPackage /Action:Script` (diff against the checked-in schema). On
GCC-High / DoD use the Azure DevOps Government endpoints, not the commercial
`dev.azure.com`.


## DirectQuery semantic-model source binder (Azure Analysis Services)

The semantic-model editor's **DirectQuery source** tab binds a model to a live
Azure source (Synapse Serverless / Dedicated, Azure SQL, or Azure Data
Explorer) via Azure Analysis Services — no Microsoft Fabric or Power BI
capacity is required. The tab honest-gates (Fluent MessageBar) until these are
set; the rest of the editor works regardless.

| Setting | When | Meaning |
|---|---|---|
| `LOOM_AAS_SERVER` | to enable DQ binding | bare AAS server name (no region/suffix), e.g. `loom-aas` |
| `LOOM_AAS_REGION` | with server | Azure region of the server, e.g. `eastus2` |
| `LOOM_AAS_MODEL`  | with server | tabular model (database) name on the server |

```bicep
// params/<cloud>-full.bicepparam
param loomAasServer = 'loom-aas'
param loomAasRegion = 'eastus2'
param loomAasModel  = 'LoomModel'
```

One-time tenant grant (RBAC cannot express this — it is an Analysis Services
*server administrator* assignment, surfaced honestly in the editor MessageBar):

```bash
# Add the Console UAMI as an AAS server administrator.
az resource update \
  --ids "$(az resource show -g <rg> -n <loomAasServer> \
            --resource-type Microsoft.AnalysisServices/servers --query id -o tsv)" \
  --set properties.asAdministrators.members='["app:<uami-app-id>@<tenant-id>"]'
```

On GCC-High / DoD the AAS data-plane host is `*.asazure.usgovcloudapi.net`
(resolved automatically by `cloud-endpoints.aasSuffix()`); the bound source
must also grant the UAMI the appropriate data-plane role (a SQL login for the
Synapse / Azure SQL TDS sources, or a database viewer on the ADX cluster).

## Semantic-model column metadata — Azure Analysis Services XMLA {#semantic-model-aas-xmla}

The Semantic model editor's **Tables** tab edits column metadata (data
category, format string, summarize-by, display folder, sort-by, hidden, and
calculated columns / tables) over the **XMLA** endpoint of a Tabular model. The
Azure-native backend is **Azure Analysis Services** — a standalone Azure
resource, so this requires **no Microsoft Fabric / Power BI workspace** (per
`.claude/rules/no-fabric-dependency.md`).

### Step 1 — Deploy AAS (bicep, automatic)

Set `loomSemanticBackend=analysis-services`. `admin-plane/main.bicep` then
deploys `analysis-services.bicep`, adds the Console UAMI as a server
administrator (`app:<clientId>@<tenantId>`), and wires
`LOOM_AAS_SERVER_URL=asazure://<region>.asazure.windows.net/<name>` +
`LOOM_AAS_DATABASE=loomdb` to the Console app. AAS is **Commercial / GCC only**
— the module is guarded off at `GCC-High` / `IL5`.

### Step 1b — Existing deployment / pre-existing server

Set `loomAasServerUrl` to an existing `asazure://…` URL (and add the Console
UAMI as a server administrator on that server). The module is skipped and the
URL is wired through verbatim.

### GCC-High / IL5 / DoD

AAS is not offered in Azure Government. If a tenant licenses **Power BI
Premium**, set `LOOM_POWERBI_XMLA_ENDPOINT` to the Premium XMLA endpoint and the
editor uses it instead (token scope `https://high.analysis.usgovcloudapi.net/powerbi/api/.default`).
Otherwise the Tables tab renders read-only structure with an honest gate
MessageBar — no fabricated data.

### Verify

`GET /api/items/semantic-model/<id>/model` returns `{ ok: true, backend, tables }`
with real columns; a column `Apply` (`PATCH … op=alter-column`) returns
`{ ok: true, tmsl }` echoing the exact TMSL Alter sent.
## Analysis Services — RLS/OLS Security tab {#analysis-services-rls-ols}

The semantic-model **Security (RLS/OLS)** tab authors model roles (row-level DAX
filters + object-level table/column permissions) and runs **test-as-role**
probes through an Analysis-Services XMLA endpoint. This is **Azure-native and
needs no Fabric/Power BI workspace** — when nothing is configured the tab shows
an honest MessageBar naming the env var to set; the full editor surface still
renders.

Two interchangeable backends:

### Option A — Azure Analysis Services (default; no Fabric/Power BI tenant)

AAS **cannot** use a managed identity as a server admin, so a dedicated service
principal is the admin and the XMLA data-plane auth uses that SPN.

1. Deploy the server (wired in `admin-plane/main.bicep`):
   ```bicep
   // params/<cloud>-full.bicepparam
   param aasEnabled = true
   param aasSpnClientId = '<appId of the AAS-admin SPN>'   // NOT the Console UAMI
   param aasSku = 'D1'                                     // Developer; $0 idle
   ```
   The module sets `asAdministrators` to `app:<clientId>@<tenantId>` and grants
   the Console UAMI ARM Reader on the server. It emits `LOOM_AAS_SERVER`
   (`asazure://…`), `LOOM_AAS_TENANT_ID`, and `LOOM_AAS_CLIENT_ID` to the app.
2. Store the SPN secret in Key Vault and wire it as the env var
   `LOOM_AAS_CLIENT_SECRET` (Container App secretRef → KV secret
   `loom-aas-client-secret`). This is the one out-of-band step (the SPN secret
   is not created by bicep).
3. Deploy your semantic-model database(s) into the AAS server (Visual Studio /
   Tabular Editor / a TMSL `createOrReplace`).

### Option B — Power BI Premium / Fabric capacity XMLA (opt-in)

1. Capacity admin: enable **XMLA endpoint = Read Write** on the Premium/Fabric
   capacity.
2. Tenant admin: enable **"Allow XMLA endpoints and Analyze in Excel"**.
3. Add the Console UAMI as a **Member** on the Power BI workspace.
4. Set the endpoint:
   ```bicep
   param loomPowerbiXmlaEndpoint = 'powerbi://api.powerbi.com/v1.0/myorg/<Workspace>'
   ```
   (GCC-High / IL5 use the `analysis.usgovcloudapi.net` token scope automatically.)

> Service principals can execute the role TMSL but **cannot** be added as role
> *members* (Power BI/AAS restriction) — use real Entra users or security groups.

### Verify

Open a semantic model → **Security (RLS/OLS)** tab → Add a role with a row
filter (e.g. `[Region] = "East"`) and a hidden column → Save → **Test as role**
with a tenant UPN. The result grid returns only the filtered rows and omits the
OLS-hidden column — that JSON is the receipt. Not available in the DoD (IL6)
boundary (AAS is not offered there; the tab shows a DoD gate).
## Lakehouse "Expose as Iceberg" — Delta UniForm (OneLake Iceberg V2 endpoint parity) {#lakehouse-iceberg-uniform}

The Lakehouse **Settings → Expose as Iceberg** control gives Fabric OneLake's
"Iceberg V2 endpoint" parity on the Azure-native path: a Delta table is made
readable by Apache Iceberg V2 readers (Snowflake, Trino, Spark, Athena) with no
data copy. There is **no Microsoft Fabric / OneLake / Power BI dependency** —
it works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

On save (toggle Enabled), Loom runs a real Delta Lake **UniForm** statement via
a Databricks SQL Warehouse:

```sql
ALTER TABLE delta.`abfss://<container>@<account>.dfs.core.windows.net/Tables/<table>`
  SET TBLPROPERTIES (
    'delta.enableIcebergCompatV2' = 'true',
    'delta.universalFormat.enabledFormats' = 'iceberg'
  );
```

Delta then asynchronously generates Iceberg V2 metadata (`metadata/*.metadata.json`)
alongside the Delta log. The Settings panel surfaces the `abfss://` table path,
the HTTPS metadata-folder URL, and the `azure://` form for a Snowflake
`EXTERNAL VOLUME`. Tables with deletion vectors should be upgraded once in a
notebook with `REORG TABLE … APPLY (UPGRADE UNIFORM(ICEBERG_COMPAT_VERSION=2))`.

This **reuses the existing `LOOM_DATABRICKS_HOSTNAME`** env var (already injected
into the Console Container App by `platform/fiab/bicep/modules/admin-plane/main.bicep`),
the same wiring as Lakehouse liquid clustering — **no new env var, bicep
resource, or role grant is needed.** When `LOOM_DATABRICKS_HOSTNAME` is unset or
no SQL Warehouse exists, the panel renders an honest warning MessageBar, persists
the selection, and still shows the Iceberg metadata path.

## Spark / compute configuration — Databricks "Allow pool creation" entitlement {#spark-compute-pool-entitlement}

The workspace **Spark compute** surface (Settings → Spark compute; F13) configures
Databricks instance pools, runtime, environment libraries, and job defaults. It is
Azure-native by default — **no Microsoft Fabric capacity or workspace is required** —
and reuses the existing `LOOM_DATABRICKS_HOSTNAME` env var (already injected into the
Console Container App by `platform/fiab/bicep/modules/admin-plane/main.bicep`). **No new
env var or bicep resource is needed.**

One workspace-admin action gates pool creation. The Console UAMI (which authenticates to
Databricks as an AAD principal via the SCIM-provisioned workspace identity) must hold the
**Allow pool creation** entitlement. By default only Databricks workspace admins have it.
Grant it once:

- In the Databricks workspace **Admin Settings → Identity and access → Service principals**,
  select the Console UAMI service principal and enable **Allow instance pool creation**, OR
- via the SCIM Entitlements API:
  ```
  PATCH https://<workspace-host>/api/2.0/preview/scim/v2/ServicePrincipals/<id>
  { "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations": [{ "op": "add", "path": "entitlements",
                     "value": [{ "value": "allow-instance-pool-create" }] }] }
  ```

Without the entitlement, `POST /api/2.0/instance-pools/create` returns **403
PERMISSION_DENIED** and the create-pool dialog surfaces that verbatim (no fake success).
Reading pools / runtime / node-types and saving runtime/jobs defaults to Cosmos all work
without it. The Cosmos `workspace-spark-config` container is created lazily by
`cosmos-client.ts` — no ARM pre-step.

In **GCC-High / DoD** Azure Databricks is not offered; the surface renders an honest
MessageBar (`not_available_in_cloud`) directing operators to the Synapse Spark pool path.

## Materialized lake views — ADF-scheduled refresh callback {#materialized-lake-view-refresh}

Materialized lake views (`materialized-lake-view` item type) need **no new tenant
configuration**. They reuse the existing landing-zone backends:

- **Refresh compute** — Synapse Spark batch via `LOOM_SYNAPSE_WORKSPACE` +
  `LOOM_SYNAPSE_SPARK_POOL` (the Console UAMI must hold **Synapse Compute
  Operator** on the Spark pool to submit Livy batches — already granted for
  notebooks / Spark job definitions; see [Synapse workspace tree](#synapse-kql-sjd)).
- **Delta storage** — the DLZ ADLS Gen2 medallion containers
  (`LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL`), Storage Blob Data Contributor.
- **Serverless preview** — the `LOOM_SYNAPSE_WORKSPACE` `-ondemand` endpoint.
- **Lineage** — Loom's own Cosmos `thread-edges` container (created lazily by
  `cosmos-client.ts`; no ARM pre-step).

The only **optional** new setting is `LOOM_CONSOLE_BASE_URL` (bicep param
`loomConsoleBaseUrl`). It is baked into the "Refresh materialized lake view" ADF
pipeline's Web-activity callback so a *scheduled* ADF run can reach the MLV
refresh endpoint behind Front Door. Leave it empty and editor-driven refreshes
still work (the refresh route derives the origin from the request); set it to
the vanity / Front Door console URL to enable ADF-scheduled refreshes. The ADF
factory itself is gated by the existing `LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` /
`LOOM_ADF_NAME` vars + the Data Factory Contributor role.

No Microsoft Fabric / OneLake tenant is required for any part of this.

---

## Synapse workspace tree — KQL scripts + Spark job definitions {#synapse-kql-sjd}

The Synapse workspace tree's **KQL scripts** and **Spark job definitions (SJD)**
groups create / edit / run real Synapse workspace artifacts via the data-plane
(`<workspace>.dev.azuresynapse.*`, artifacts api-version `2020-12-01`). No
Microsoft Fabric workspace is involved — these are Azure-native Synapse artifacts.

**Env** — `LOOM_SYNAPSE_WORKSPACE` (the Synapse workspace name) gates the whole
surface; when unset the BFF routes 503 with an honest MessageBar. `LOOM_SYNAPSE_SUB`
overrides the subscription for a reused/BYO workspace. The data-plane host is
**sovereign-cloud aware and auto-derived** from `LOOM_CLOUD` / `AZURE_CLOUD`
(`dev.azuresynapse.net` in Commercial/GCC; `dev.azuresynapse.usgovcloudapi.net`
in GCC-High/IL5/DoD) by both `synapse-artifacts-client.ts` (artifact CRUD) and
`synapse-dev-client.ts` (Livy Spark-batch submit), so the KQL CRUD path and the
SJD Run path resolve to the **same** host in every boundary. Override the host
explicitly for clouds we don't enumerate (e.g. China) via
`AZURE_SYNAPSE_DEV_HOST_SUFFIX=dev.azuresynapse.azure.cn` (artifacts client uses
`LOOM_SYNAPSE_DEV_SUFFIX`). KQL-script **Run** targets a workspace **Kusto pool**
(`<pool>.<ws>.kusto.azuresynapse.{net|us}`) listed from ARM — no standalone ADX,
no Fabric Eventhouse.

**Synapse RBAC (data plane)** — granted post-deploy by `landing-zone/synapse.bicep`
deployment scripts on the **Console UAMI** (`consolePrincipalId`), all via
`az synapse role assignment create`:

- **Synapse Artifact Publisher** (workspace scope) — `kqlScripts/write,delete`
  and `sparkJobDefinitions/write,delete`. Backs create / edit / delete in the
  tree. Resource: `consoleArtifactPublisherRoleScript` (output
  `consoleArtifactPublisherRoleAssigned`). Least-privilege; Synapse Administrator
  is a superset that also works.
- **Synapse Compute Operator** (Spark pool scope) — submit / cancel Spark jobs.
  Backs the **SJD Run** (Livy batch) path. Resource: `consoleSparkSubmitRoleScript`.

Both scripts require `synapseRoleAssignmentUamiId` (a UAMI pre-holding Synapse
Administrator) and are skipped when `skipRoleGrants=true`. The SQL-AAD-admin
assignment (`workspaces/administrators`) and ARM Contributor do **not** confer
Synapse-RBAC artifact rights — without Artifact Publisher the UI renders but
create/edit/delete 403s.

---

## Fabric IQ — unified MCP tool surface for external agents {#fabric-iq-mcp}

CSA Loom exposes a single **Model Context Protocol (MCP)** endpoint —
`POST /api/iq/mcp` — that packages the organization's **ontology** (conceptual
entity model), **semantic** layer (curated tables + measures), and **live
signals** (Azure Data Explorer telemetry) into one tool surface. External
agents — **Microsoft Agent 365**, **Azure AI Foundry agents**, **Copilot
Studio** — register this endpoint as an MCP server and ground their answers on
the org's governed knowledge. This is the *server* side of MCP (the inverse of
the "External MCP Tools" admin panel, which lets Loom *call* external servers).

All three layers are **Azure-native** — no Microsoft Fabric / Power BI workspace
is required (per `no-fabric-dependency.md`). Ontology + semantic data come from
the Loom `ontology` / `semantic-model` Cosmos items; live signals come from the
ADX cluster (`LOOM_ADX_CLUSTER_URI`).

### Tools exposed (`tools/list`)

| Tool | What it returns |
| --- | --- |
| `iq_overview` | One-call discovery of every ontology, semantic model, and whether signals are available. |
| `iq_search` | Cross-layer search of entity / table / measure names. |
| `iq_list_ontologies` / `iq_get_ontology` | Ontology summaries; full entity hierarchy + IS_A relationships + data bindings. |
| `iq_list_semantic_models` / `iq_get_semantic_model` | Semantic-model summaries; full tables + measures (DAX) + relationships. |
| `iq_list_signal_tables` | ADX tables available for real-time querying. |
| `iq_query_signals` | Run a **read-only** KQL query against ADX (control/management commands are rejected). |

### Auth

Two credentials are accepted:

1. **MSAL cookie session** — Console users (and the in-app self-test) always
   reach the endpoint with their session; the acting tenant is the session
   `oid`. This path needs **no** env var.
2. **Bearer token** — external agents present
   `Authorization: Bearer <token>` plus an `x-user-oid` header naming the
   tenant to act on behalf of. The token is `LOOM_IQ_MCP_TOKEN` if set,
   otherwise the shared `LOOM_INTERNAL_TOKEN`. **The token path only works when
   `LOOM_IQ_MCP_ENABLED=true`.**

`GET /api/iq/mcp` returns an unauthenticated discovery document (server name,
protocol version, tool list, whether external access is enabled) so registration
UIs can verify the URL — it never exposes tenant data.

### Enable the external-agent path

Set the bicep param `loomIqMcpEnabled=true` (default `false`). This injects
`LOOM_IQ_MCP_ENABLED=true` and wires `LOOM_INTERNAL_TOKEN` (the deterministic
`guid(resourceGroup().id, 'loom-maf-internal-token-v1')`) as the default Bearer
secret on the Console app. To use a dedicated rotating secret instead, set
`LOOM_IQ_MCP_TOKEN` on the Console app and hand the same value to the agent.

### Register with an external agent

Point the agent's MCP-server configuration at
`https://<console-host>/api/iq/mcp` with:

```
Authorization: Bearer <LOOM_IQ_MCP_TOKEN or LOOM_INTERNAL_TOKEN>
x-user-oid: <the tenant oid the agent acts for>
```

### Verify

```
# Discovery (no auth):
curl -s https://<console-host>/api/iq/mcp | jq '{server, externalAccessEnabled, tools: [.tools[].name]}'

# tools/list (Bearer):
curl -s -X POST https://<console-host>/api/iq/mcp \
  -H 'authorization: Bearer <token>' -H 'x-user-oid: <oid>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'

# tools/call → unified overview:
curl -s -X POST https://<console-host>/api/iq/mcp \
  -H 'authorization: Bearer <token>' -H 'x-user-oid: <oid>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"iq_overview","arguments":{}}}'
```

### Bicep sync

- Param + env var + secret wiring: `platform/fiab/bicep/modules/admin-plane/main.bicep`
  (`loomIqMcpEnabled`, `LOOM_IQ_MCP_ENABLED`, `LOOM_INTERNAL_TOKEN` /
  `loom-internal-token`).
- Server route: `apps/fiab-console/app/api/iq/mcp/route.ts`; tool catalog +
  dispatcher: `apps/fiab-console/lib/azure/iq-mcp-tools.ts`; data layer:
  `apps/fiab-console/lib/azure/iq-mcp.ts`.

In **GCC-High / DoD** the IQ surface works the same; the live-signals layer
requires an ADX cluster in the Gov cloud (`iq_list_signal_tables` /
`iq_query_signals` return an honest gate naming `LOOM_ADX_CLUSTER_URI` when one
isn't provisioned). Ontology + semantic layers work with no extra infra.

## Insider Risk Management for Lakehouse — indicator thresholds {#irm-lakehouse}

Governance → **Insider risk** computes insider-risk indicators (unusual data
volume, off-hours / weekend access, privileged access) live over the Loom
audit log + Azure Monitor. There is **no Microsoft Fabric / Purview-IRM
dependency** and **no new env var or Azure resource** to provision:

- The primary signal is the Cosmos `audit-log` container — always available,
  needs no extra grant (it is the same container the Audit logs surface reads).
- The optional Monitor signals (app-access events, lakehouse-load volume,
  privileged control-plane ops) reuse the shared Log Analytics workspace
  (`LOOM_LOG_ANALYTICS_WORKSPACE_ID`) and the UAMI's existing **Monitoring
  Reader** + **Log Analytics Reader** grants used by `monitor-client`. When the
  workspace id is unset the dashboard still renders and computes the
  Cosmos-backed indicators; the Monitor signals degrade to an honest warning
  MessageBar.

### One-time config (optional)

Indicator selection and thresholds are stored as a **structured** tenant
settings document `irm:<tenantId>` in the existing `tenant-settings` Cosmos
container. It is created on first save from the in-app **Indicators &
thresholds** panel (Switch toggles + SpinButtons + a timezone Dropdown — no
freeform JSON) via `POST /api/governance/irm`; no migration or deployment step
is required. Defaults: 30-day window, `volumeZ=2`, business hours 07:00–19:00
UTC, weekends flagged, with `unusual-volume` + `off-hours-access` enabled and
`high-pipeline-volume` + `privileged-access` opt-in (mirroring Purview IRM's
"indicators off by default" stance).

### Bicep sync

No new module. Reuses `platform/fiab/bicep/modules/shared/diagnostic-settings.bicep`
(Log Analytics workspace) and the existing Cosmos `audit-log` / `tenant-settings`
containers. Server: `apps/fiab-console/app/api/governance/irm/route.ts`; engine:
`apps/fiab-console/lib/azure/irm-client.ts`; UI: `apps/fiab-console/app/governance/irm/page.tsx`.

In **GCC-High / DoD** the dashboard works the same — the Cosmos path is
cloud-agnostic; the Monitor signals use the sovereign LA endpoint
(`LOOM_LOG_ANALYTICS_ENDPOINT`) already resolved by `monitor-client`.





## Governance → Data quality + Master data (Unity Catalog grant)

Governance → **Data quality** (Delta constraints + Databricks Lakehouse
Monitoring) and Governance → **Master data** (golden-record match/merge) run on
the workspace Databricks SQL Warehouse. The on-demand rule **run** and the
Kusto/Synapse paths need no extra grant. Two actions write to Unity Catalog and
require a one-time grant to the Console UAMI on the target schema:

- MDM golden-record table creation (`CREATE OR REPLACE TABLE <golden>`).
- Lakehouse Monitoring metric tables + dashboard.

Grant (run once as a UC metastore admin, replacing the principal + schema):

```sql
GRANT USE CATALOG ON CATALOG main TO `<console-uami-app-id>`;
GRANT USE SCHEMA, CREATE TABLE, MODIFY, SELECT ON SCHEMA main.mdm TO `<console-uami-app-id>`;
```

Until this grant is in place, the Data quality Monitors tab and MDM merge show an
honest MessageBar (the constraint/merge call returns the precise UC permission
error) — no fake success. No Microsoft Fabric or Power BI workspace is involved.

---

## Domain registry ↔ DLZ binding (tenant topology) {#domain-registry-dlz-binding}

The catalog domains registry (`tenant-settings` Cosmos doc `domains:<tenant>`) is
the **authoritative tenant topology**: each domain may be bound to its Data
Landing Zone — `subscriptionIds[]`, `dlzRg`, `location`, `capacitySku`,
`adminGroupId` / `memberGroupId` (Entra groups backing the domain-admin tier),
`costCenter`, `chargebackTag`, and a `status`
(`registered` → `attaching` → `active` → `detached` / `error`) (audit-t158).
NO Microsoft Fabric dependency — the registry is 100% Cosmos + Azure-native; the
Fabric Admin domain adapter stays hard-gated off on IL5.

### How a domain gets bound

- **Automatic (dlz-attach):** after the Setup Orchestrator's `dlz-attach`
  deployment succeeds it POSTs the binding to the Console's token-gated internal
  API `POST /api/internal/topology/register-domain`
  (`Authorization: Bearer ${LOOM_INTERNAL_TOKEN}` + `x-loom-caller-oid`), which
  upserts the domain and flips `status` to `active`.
- **Manual:** a tenant admin uses **/admin/domains → Actions → Attach existing
  subscription** (binds an already-attached sub) and the domain **Settings →
  Landing zone** tab (region, capacity, admin/member groups, cost center).

### The `loom-domain` chargeback tag {#loom-domain-tag}

Every DLZ resource is stamped with the tag **`loom-domain` = `loom-domain:<id>`**
(`DOMAIN_TAG_KEY` in `lib/azure/domain-registry.ts`). This single key is the
contract three subsystems share:

- **Resource inventory** — `/admin/domains` → Landing zone → Resource inventory
  runs an Azure Resource Graph query
  `Resources | where tags['loom-domain'] =~ 'loom-domain:<id>'` to list a
  domain's resources (`lib/azure/topology-inventory.ts`).
- **Cost Management** — `cost-client.ts` groups chargeback by the same tag.
- **dlz-attach bicep** — stamps the tag via `complianceTags` on the DLZ module.

The Console UAMI needs **Reader** on each bound subscription for the ARG
inventory to return rows; otherwise the surface shows an honest gate naming the
exact `az role assignment create ... --role Reader --scope /subscriptions/<id>`.

### Connections "Add existing" / `/api/azure/connectables` (Resource Graph) {#connectables-reader}

The **Connections → Add existing** picker and `GET /api/azure/connectables`
enumerate connectable Azure resources with an Azure Resource Graph query.
Resource Graph honors RBAC, so the querying principal needs at least **Reader**
at the subscription scope for resources to appear.

- **Covered by bicep (day-one):** `modules/admin-plane/rti-hub-rbac.bicep`
  (invoked unconditionally from `main.bicep`, `scope: subscription()`) grants the
  **Console UAMI Reader at the deployment subscription scope**. The connectables
  route's **UAMI fallback path** uses this grant, so "Add existing" works on a
  clean deploy with no manual action. For additional subscriptions, set
  `LOOM_EXTRA_SUBSCRIPTIONS` and grant the Console UAMI Reader there too.
- **Optional per-user enhancement (tenant-admin step, NOT bicep-expressible):**
  to let connectables enumerate with the **signed-in user's** identity instead of
  the UAMI, the Loom console **app registration** needs the **Azure Service
  Management** `user_impersonation` delegated permission with **admin consent**.
  This is a one-time Entra tenant-admin action (Entra → App registrations →
  Loom console → API permissions → Add **Azure Service Management** →
  `user_impersonation` → **Grant admin consent**). Until then the UAMI path above
  is used (and is sufficient). This cannot be granted from bicep because delegated
  admin-consent is a Microsoft Graph / directory operation, not an ARM resource.

### Workspace → domain binding (required)

Creating a workspace now **requires** a governance domain. Both
`POST /api/admin/workspaces` and `POST /api/workspaces` reject a missing/unknown
domain (HTTP 400). The seeded **`default`** domain is the guaranteed fallback for
legacy / single-domain tenants — the create wizard preselects it. Existing
domain-less workspaces remain valid (the rule is enforced on create only).

### Bicep sync

- **New env var** `LOOM_CONSOLE_INTERNAL_URL` on the Setup Orchestrator container
  app (`modules/admin-plane/setup-orchestrator.bicep`, default `http://loom-console`,
  the CAE-internal console name) — the base URL the `dlz-attach` callback POSTs to.
- `LOOM_INTERNAL_TOKEN` (already Bicep-wired to both apps) gates the internal
  register-domain route; the route **fails closed** when it is unset.

---

## Tenant topology + "Add landing zone" (dlz-attach) — audit-t157

CSA Loom installs in one of two **topologies**:

- **`tenant`** — the first-run install. `main.bicep` deploys the Admin Plane
  (Console/hub) **plus** the single-sub or multi-sub DLZ(s). This is the ONLY
  topology that deploys a Console. It is reachable only from the first-run
  Setup Wizard (`/setup`); once a hub exists `/setup` redirects to
  `/admin/add-landing-zone` and the server-side deploy route rejects
  `topology=tenant`, so a **second Console can never be stamped from the UI**.
  The bicep enforces the same — the `adminPlane` module is gated on
  `topology == 'tenant'`.
- **`dlz-attach`** — add ONE Data Landing Zone in a **new subscription** to the
  already-deployed hub. No Console is deployed. The DLZ reads the hub's
  coordinates from the Cosmos `tenant-topology` doc (below). Driven by the
  `/admin → Add landing zone` wizard, the Setup Orchestrator, or the
  `deploy-fiab-*.yml` workflows (`topology=dlz-attach` + `target_subscription`).

### Post-deploy step: write the tenant-topology doc

After a `topology=tenant` deploy, run **`scripts/csa-loom/write-tenant-topology.sh`**
to persist the hub coordinates so later attaches never free-type Azure ids:

```bash
scripts/csa-loom/write-tenant-topology.sh \
  --deployment-name "$DEPLOY_NAME" \
  --subscription "<hub-sub-id>" \
  --cosmos-endpoint "https://<cosmos-acct>.documents.azure.com:443/" \
  --tenant-id "$AZURE_TENANT_ID"
```

It reads the `main.bicep` outputs (`hubVnetId`, `hubLawId`, `hubPrivateDnsZoneIds`,
`hubAdxClusterRgName`, `hubConsolePrincipalId`, …) and upserts them into the
`loom` DB **`tenant-topology`** container (`id='tenant-topology'`, PK `/tenantId`,
partitioned by the Entra tenant id). The container is declared in
`platform/fiab/bicep/modules/landing-zone/cosmos.bicep` **and** created lazily by
`apps/fiab-console/lib/azure/cosmos-client.ts` `ensure()` (the createIfNotExists
hotfix fallback). The deploy identity needs **Cosmos DB Built-in Data Contributor**
on the account; the script fails honestly if a value or a Python dependency
(`azure-cosmos`, `azure-identity`) is missing — it never writes a partial doc.

### dlz-attach RBAC gate (honest)

The Setup Orchestrator identity must hold **Contributor on the NEW subscription**
to attach a DLZ there. The orchestrator checks this for real
(`AuthorizationManagementClient.role_assignments.list_for_scope`) before
submitting and, when missing, fails with the exact, gov-aware remediation
(`LOOM_ORCHESTRATOR_PRINCIPAL_ID` is its UAMI object id):

```bash
# Gov boundaries only:
az cloud set --name AzureUSGovernment
az role assignment create \
  --assignee-object-id <orchestrator-principal-object-id> \
  --assignee-principal-type ServicePrincipal \
  --role Contributor \
  --scope /subscriptions/<targetSubscriptionId>
```

All coordinates are Azure-native resource ids — attach works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset (no Fabric dependency).
