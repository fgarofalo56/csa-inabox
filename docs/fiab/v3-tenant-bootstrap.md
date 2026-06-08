# CSA Loom v3 — Tenant bootstrap (post-deploy one-time config)

This doc captures the **one-time, per-tenant admin actions** that a Loom
deployment needs but that bicep can't fully automate (cross-cloud resources,
data-plane RBAC granted in a portal, tenant-level service enablement). Each
section is referenced from the in-app honest gate (the Fluent `MessageBar`
that names the exact step), per `.claude/rules/no-vaporware.md`.

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
| `LOOM_AOAI_EMBED_DEPLOYMENT` | `text-embedding-ada-002` (v2, Standard) | Embeddings |

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

## Microsoft Graph admin consent — MIP + DLP {#graph-admin-consent-mip-dlp}

Loom's **/admin/security** MIP (sensitivity labels) and DLP tabs call Microsoft
Graph **app-only** with the Console UAMI. That requires two **application**
app-roles on Microsoft Graph, granted to the UAMI **and** admin-consented at the
tenant. ARM/bicep cannot grant Graph app-roles, so this is a one-time script +
a one-time admin click.

| App-role (application permission) | App-role id | Backs |
|---|---|---|
| `InformationProtectionPolicy.Read.All` | `19da66cb-0fb0-4390-b071-ebc76a349482` | MIP sensitivity-label policy reads |
| `Policy.Read.All` | `246dd0d5-5bd0-4def-940b-0421030a5b68` | DLP / tenant policy reads |

> These are the **Application** app-role ids (type `Role`), not the delegated
> `oauth2PermissionScopes` ids. Using the delegated id silently fails app-only.

### Step 1 — Grant the app-roles to the Console UAMI

```bash
az login    # as a user/SP with Application.ReadWrite.All on Graph
CONSOLE_UAMI_PRINCIPAL=<console UAMI object id> \
  ./scripts/csa-loom/grant-graph-approles.sh
```

The script is idempotent (re-running is a no-op). It POSTs
`appRoleAssignments` on the UAMI's service principal against the Microsoft Graph
SP (`appId 00000003-0000-0000-c000-000000000000`).

### Step 2 — Tenant admin consent

A **Privileged Role Administrator / Global Administrator** must consent:

> Entra ID → Enterprise applications → *Console UAMI* → Permissions →
> **Grant admin consent for `<tenant>`**

Until consent is issued, every Graph call returns 403 and the MIP/DLP tabs show
their honest `403 — AppRole not consented` MessageBars.

### Step 3 — Flip the feature flags

```bash
az containerapp update --name <loom-console-app> --resource-group <loom-admin-rg> \
  --set-env-vars LOOM_MIP_ENABLED=true LOOM_DLP_ENABLED=true
```

Or set `loomMipEnabled = true` / `loomDlpEnabled = true` in the `.bicepparam`
and re-deploy admin-plane (the env wiring is already in `admin-plane/main.bicep`).

### Bicep sync

- Env flags `LOOM_MIP_ENABLED` / `LOOM_DLP_ENABLED`:
  `platform/fiab/bicep/modules/admin-plane/main.bicep` (`loomMipEnabled` /
  `loomDlpEnabled` params).
- The two Graph app-roles are **Graph-plane** grants and intentionally cannot be
  expressed in ARM/bicep — hence `scripts/csa-loom/grant-graph-approles.sh` +
  the admin-consent click above.

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
