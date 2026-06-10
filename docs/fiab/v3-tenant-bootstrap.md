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


