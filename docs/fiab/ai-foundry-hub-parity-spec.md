# Loom AI Foundry Hub Editor — Foundry-parity spec

> Captured 2026-05-26 by catalog agent `foundry-parity-2026-05-26`. Sources: Microsoft Learn — [Hub resources overview](https://learn.microsoft.com/azure/foundry-classic/concepts/ai-resources), [How to create and manage a Foundry hub](https://learn.microsoft.com/azure/foundry-classic/how-to/create-azure-ai-resource), [Create a secure hub with managed virtual network](https://learn.microsoft.com/azure/foundry-classic/how-to/create-secure-ai-hub), [Managed virtual network for Foundry projects](https://learn.microsoft.com/azure/foundry/how-to/managed-virtual-network). Cross-checked against existing Loom editor at `apps/fiab-console/lib/editors/foundry-hub-editor.tsx::FoundryHubEditor` and the foundry client at `apps/fiab-console/lib/azure/foundry-client.ts::getWorkspaceInfo`.

## What it is

An **Azure AI Foundry hub** (`Microsoft.MachineLearningServices/workspaces` of `kind=Hub`) is the top-level shared container that groups multiple AI projects under common security, networking, identity, and connectivity settings. It is the resource that IT admins create once; developers then carve their work into child **projects** that inherit the hub's connections, compute pools, and policies.

A hub owns these shared dependencies: **Storage account** (artifacts, datastores), **Key Vault** (credential store), **Application Insights** (telemetry), **Container Registry** (custom envs), and an attached **Foundry / AI Services** account that surfaces Azure OpenAI, Speech, Content Safety, Language, Vision. It also holds **connections** to external resources (AI Search, AOAI in other subscriptions, Cosmos, custom REST endpoints), a **managed virtual network** if isolation is required, **shared compute** (instances + clusters), and the **identity** (system- or user-assigned) used to broker access to all of the above.

## UI components

### Page chrome
- Title bar: hub `friendlyName` (editable) + provisioning state badge + region pill
- Right-side actions: **Refresh**, **Open in Azure portal**, **Manage**, **Delete** (with confirmation)
- Top tab strip: **Overview**, **Connected resources**, **Connections**, **Computes**, **Models**, **Deployments**, **Datastores**, **Networking**, **Identity**, **RBAC**, **Diagnostics**, **Tags**

### Overview tab
- Hero card: friendly name, description (inline editable), kind=Hub badge, region, resource group, subscription
- Linked-resources grid (6 tiles): **Storage**, **Key Vault**, **Container Registry**, **Application Insights**, **Foundry / AI Services**, **AI Search** (if connected). Each tile shows the resource short name, status dot, deep-link to that resource in the portal
- Quick stats row: projects, connections, computes (running/stopped), deployments, recent jobs

### Connected resources tab
- One row per dependent resource (Storage, KV, ACR, App Insights, Foundry account). Columns: **Resource**, **Type**, **Connection identity** (credential vs identity-based), **Status**, **Role assignments**, **Open**
- Per-row drawer: principal ID, role assignment list, last-checked timestamp, repair button if a role is missing

### Connections tab
- Full grid of **hub-scoped connections** — AOAI, AI Search, custom keys, OneLake, blob, Foundry AI Services. Columns: **Name**, **Category**, **Target endpoint**, **Auth type** (api_key / aad / managed_identity / sas), **Shared to all projects**, **Created**
- Toolbar: **+ New connection** (wizard with category dropdown: AzureOpenAI, AzureAISearch, CognitiveSearch, AzureBlob, CustomKeys, ApiKey), **Edit**, **Test**, **Delete**
- Connection editor pane: name, category, endpoint, auth method, key/secret (write-only field), metadata key-values, sharing toggle (Shared to all / project-scoped)

### Computes tab
- Two sub-tabs: **Instances**, **Clusters**
- Columns: **Name**, **Type** (ComputeInstance / AmlCompute), **VM size**, **State** (Running, Stopped, Resizing, Failed), **Min/Max nodes** (clusters), **Created**, **Created by**, **Idle shutdown**
- Per-row actions: **Start**, **Stop**, **Restart**, **Delete**, **Open Jupyter/VS Code** (instances only)

### Models / Deployments tab
- Read-through to hub-scoped registered models and online endpoints (rendered in detail in their own editors)
- Tile counts + last-deployed-model badge

### Datastores tab
- Columns: **Name**, **Type** (AzureBlob, AzureFile, AzureDataLakeGen2), **Account**, **Container**, **Default** (badge), **Auth**
- Actions: **+ Register**, **Set as default**, **Browse contents**, **Delete**

### Networking tab
- **Public network access** toggle (Enabled / Disabled)
- **Managed virtual network** section: isolation mode (Allow Internet Outbound / Allow Only Approved Outbound / Disabled), provisioning state, **Outbound rules** grid (FQDN / private endpoint / service tag — one row per rule), **Inbound private endpoints** grid (name, subnet, FQDN)
- **+ Add outbound rule** wizard: rule type, destination (resource picker for PE, FQDN textbox for FQDN, service-tag dropdown for ST)

### Identity tab
- **System-assigned identity**: enabled toggle, principal ID, tenant ID
- **User-assigned identity** list: name, client ID, principal ID, scope, **Add**, **Remove**
- **Storage access mode**: Credential-based / Identity-based (radio)

### RBAC tab
- Standard Azure RBAC blade: principal, role (Foundry built-ins: Foundry User, Foundry Developer, Foundry Manager, Foundry Contributor, plus AML Data Scientist, AzureML Compute Operator), scope (hub or descendant), condition
- **+ Add role assignment** wizard

### Diagnostics tab
- App Insights pinned charts: recent error rate, query rate, latency p95
- Activity log (last 50): create/update/delete on hub and child workspaces

## What Loom has

The current Loom `FoundryHubEditor` (`apps/fiab-console/lib/editors/foundry-hub-editor.tsx`) is wired live to `Microsoft.MachineLearningServices/workspaces` (kind=Hub) via the BFF route `GET /api/foundry/workspace`, plus sibling routes for `/connections`, `/computes`, `/datastores`, `/api/items/ml-model`, `/api/foundry/deployments`, and `/api/items/ml-experiment`. The hub client is `foundry-client.ts::getWorkspaceInfo`.

- Overview panel renders real workspace info (name, friendlyName, RG, location, kind, provisioningState, publicNetworkAccess, discoveryUrl, plus short names for storageAccount, keyVault, containerRegistry, applicationInsights). No mock data
- Tabs implemented: Overview, Connections, Computes, Datastores, plus tile counts for Models/Deployments/Experiments. Each tab lazy-loads, surfaces a `Spinner`, then either a table or a Fluent `MessageBar intent="error"`
- Ribbon stubs: **Reload**, **Open in Azure portal**, **New connection**, **New deployment** — only Reload is wired
- Connections table shows category, target, authType, isSharedToAll — no edit/test/delete actions
- Computes table shows name/type/vmSize/state — start/stop wired in the ComputeEditor (separate editor), not from this hub view
- No Networking tab (no managed-vnet inspection), no Identity tab, no RBAC tab, no Diagnostics tab, no outbound-rule grid

## Gaps for parity

1. **Connection lifecycle** — current grid is read-only. Need **+ New connection** wizard (category picker, endpoint, auth-type, key/secret handling via Key Vault reference), **Test connection** action, **Edit / Delete** rows
2. **Managed VNet / Networking tab** — no inspection of `properties.managedNetwork` (isolationMode, outboundRules, status). Foundry portal shows full inbound PE list + outbound FQDN/PE/ST rules. Loom shows nothing here today
3. **Identity tab** — `identity.type` and `userAssignedIdentities` are read off the workspace JSON but only the principalId is implicit; need full system+UAMI display with role-assignment summary
4. **RBAC tab** — no role-assignments grid. Needs `Microsoft.Authorization/roleAssignments` query scoped to the hub plus an "Add role" pane
5. **Datastores actions** — list is read-only. Need **+ Register datastore**, **Set default**, **Delete**, **Browse contents** (browse hits Storage SDK with hub identity)
6. **Linked-resources health** — Overview shows resource names but not their reachability or whether the hub identity has the right role (Storage Blob Data Contributor, KV Secrets User, ACR Pull, AppInsights Reader, AI Services Contributor). A small health-dot per linked resource catches drift early
7. **Compute creation from hub** — today compute create-form lives in the `ComputeEditor`. Foundry surfaces a **+ New compute** flyout directly from the hub Computes tab
8. **Diagnostics / activity log** — no recent-activity panel or AppInsights chart embed
9. **Outbound rule editor** — when managed VNet is set to `AllowOnlyApprovedOutbound`, admins must add FQDN / PE / service-tag rules. Loom has no UI for this
10. **Tag editor** — hub-level ARM tags are not exposed; project bookkeeping conventions (cost-center, env=prod) live there
11. **Delete hub / cascade preview** — destructive action with preview of child projects + dependent resources is missing
12. **Hub-create wizard** — Loom does not let you create a hub from the catalog. The current path requires the Bicep deploy. A guided **+ New hub** wizard (basics → storage → networking → encryption → identity → review) would match Foundry portal parity

## Backend mapping

All hub-scoped reads/writes target ARM under `/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.MachineLearningServices/workspaces/{hub}`.

| Loom surface | Backend call |
|---|---|
| Overview / linked resources | `GET {hub}?api-version=2024-10-01` → `properties.{storageAccount,keyVault,containerRegistry,applicationInsights,hubResourceId,discoveryUrl,publicNetworkAccess,managedNetwork}` |
| Connections list / get / create / delete | `GET/PUT/DELETE {hub}/connections/{name}?api-version=2024-10-01-preview` |
| Test connection | `POST {hub}/connections/{name}/listSecrets` (validate) + a category-specific probe |
| Computes list / get / create / start / stop / delete | `GET/PUT/DELETE {hub}/computes/{name}` and `POST {hub}/computes/{name}/{start,stop,restart}` |
| Datastores list / get / register / delete | `GET/PUT/DELETE {hub}/datastores/{name}` |
| Managed network status + rules | `GET {hub}/outboundRules?api-version=2024-10-01-preview`; `PUT {hub}/outboundRules/{name}` to add; `GET {hub}/managedNetworkProvisions` for provisioning state |
| RBAC | `GET /subscriptions/{sub}/providers/Microsoft.Authorization/roleAssignments?$filter=atScope() and assignedTo({objectId})&api-version=2022-04-01` scoped to hub resourceId |
| Identity | already on `GET {hub}` → `identity.{type,principalId,tenantId,userAssignedIdentities}` |
| Diagnostics | `GET {appInsights}/api/query` (KQL, already wired in `queryTraces`) |
| Activity log | `GET /subscriptions/{sub}/providers/Microsoft.Insights/eventtypes/management/values?$filter=resourceUri eq '{hubId}'` |
| Tags | `PATCH {hub}` with merged `tags` |

The existing client (`foundry-client.ts`) already implements `getWorkspaceInfo`, `listConnections`, `listComputes`, `listDatastores`, `createCompute`, `startCompute`, `stopCompute`, `deleteCompute`. New helpers required: `createConnection`, `deleteConnection`, `testConnection`, `listOutboundRules`, `createOutboundRule`, `listRoleAssignments`, `addRoleAssignment`, `getActivityLog`, `setHubTags`.

## Required Azure resources

- **Hub workspace** (`Microsoft.MachineLearningServices/workspaces` kind=Hub) — already provisioned as `aifoundry-csa-loom-eastus2` (env `LOOM_FOUNDRY_NAME`)
- **Dependent resources** all already provisioned and bound to the hub: `Microsoft.Storage/storageAccounts`, `Microsoft.KeyVault/vaults`, `Microsoft.Insights/components`, `Microsoft.ContainerRegistry/registries`, `Microsoft.CognitiveServices/accounts` (AI Services / Foundry account, kind=AIServices)
- **Optional managed VNet** — provisioned only if isolation is required; surfaced honestly with a `MessageBar intent="warning"` when `properties.managedNetwork` is absent
- **UAMI** `LOOM_UAMI_CLIENT_ID` — needs **Contributor** at hub scope (already in place) plus **Azure AI Enterprise Network Connection Approver** if managed-VNet PE creation is exposed in the UI
- **Bicep** — extend `platform/fiab/bicep/modules/foundry/` with optional `managedNetwork` parameter and outbound-rule child resources so push-button deploy matches what the editor can manage

## Estimated effort

**3 focused sessions** to reach grade B (production-grade — works, looks good, real data, real backend):

- **Session N+1 (~2 hrs):** Networking tab (managed-VNet status + outbound rules table), Identity tab, RBAC tab (read-only). Linked-resource health dots on Overview
- **Session N+2 (~2 hrs):** Connection lifecycle (create / test / delete) with category-aware form, Datastores actions (register / set-default / delete), hub-level tag editor
- **Session N+3 (~3 hrs):** Outbound-rule create wizard (FQDN + PE + ST), Add-role-assignment wizard, Diagnostics tab with embedded App Insights query + activity-log panel, **+ New hub** wizard (calls a new Bicep-backed BFF route)

A fourth session lands grade A+ (tests + bicep): Vitest unit tests on the connection-form validation and outbound-rule shape, a Playwright walk against the seeded hub, and bicep module extensions covering `managedNetwork.outboundRules[]` and the AI Enterprise Network Connection Approver role assignment.
