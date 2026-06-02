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
