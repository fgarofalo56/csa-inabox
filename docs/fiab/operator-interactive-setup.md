# CSA Loom — Operator: Interactive Setup Steps

After `gh workflow run csa-loom-post-deploy-bootstrap.yml --ref main` finishes
green, three more grants need to happen via portal UIs that don't accept SP
auth. **Total time: ~5 minutes.** Each grant unlocks a family of editors.

**Target principal for every grant below:**

- **UAMI display name:** `uami-loom-console-eastus2`
- **UAMI client (application) id:** `c6272de5-3c4e-4b72-8b57-71b2e950209b`
- **UAMI object (principal) id:** `e61f3eb3-c646-4183-8198-4c4a34cd9a01`

When a UI asks "user / group / service principal", you want **Service principal**
and search either by the display name or the client id.

---

## 1. Power Platform Administrator role  *(unblocks 15 editors)*

Unlocks: Power Apps, Power Automate flow, Dataverse table, AI Builder model,
Power Page, Power Platform environment, **Copilot Studio agent + knowledge +
topic + action + channel + analytics + template library** (the whole
Copilot Studio family piggybacks on this single grant).

### Click path

1. Go to **https://admin.powerplatform.microsoft.com**
2. Sign in with a tenant Global Admin (or anyone already in Power Platform
   Administrators).
3. Left nav → **Settings** → **Roles and administrators** (sometimes
   labeled "Microsoft Entra roles" in newer UI).
4. Find the **Power Platform Administrator** role row → click **Assign**.
5. Search for `uami-loom-console-eastus2` (or paste the client id
   `c6272de5-3c4e-4b72-8b57-71b2e950209b`).
6. Select the result → **Add** → confirm.

> Some tenants surface this under **Microsoft Entra admin center → Roles &
> admins → Power Platform Administrator → Add assignments**. Either path
> lands at the same grant.

### Verify

Re-run service-health:

```bash
SECRET=$(az keyvault secret show --vault-name kv-loom-m56yejezt7bjo --name loom-session-secret --query value -o tsv)
SESSION_SECRET="$SECRET" node apps/fiab-console/tests/service-health.mjs
```

Expect:

```
Power Platform    | /api/powerplatform/environments               | 200    | PASS
Copilot Studio    | /api/items/copilot-studio-agent?envs=1        | 200    | PASS
```

In the UI, `/items/power-app/new` and `/items/copilot-studio-agent/new` should
load the environments dropdown with at least your default Dataverse env.

---

## 2. Fabric tenant — "Service principals can use Fabric APIs"  *(unblocks 5 editors)*

Unlocks: Semantic model, Report, Dashboard, Paginated report, Scorecard
(everything that goes through Fabric REST). Also makes the Notebook editor
fully green for Fabric-hosted notebooks.

### Click path

1. Go to **https://app.fabric.microsoft.com**
2. Top-right gear icon → **Admin portal**.
3. Left nav → **Tenant settings**.
4. Search the page for **"Service principals can use Fabric APIs"**
   (under the **Developer settings** section).
5. Toggle to **Enabled**.
6. **Apply to → Specific security groups** → pick or create a group named
   `loom-fabric-sp` (recommended) — keeps the grant tight.
7. Open Entra ID → **Groups** → **All groups** → **+ New group**:
   - Group type: **Security**
   - Name: `loom-fabric-sp`
   - Members → **Add members** → search for the UAMI client id
     `c6272de5-3c4e-4b72-8b57-71b2e950209b` → Add → Create.
8. Back in Fabric admin portal → Apply.

> Two related toggles in the same area are worth flipping while you're there:
> - **"Service principals can call Fabric public APIs"** → Enabled, same group
> - **"Allow service principals to use read-only admin APIs"** → Enabled, same group

### Then — add the UAMI to each target Fabric workspace

Fabric items live inside workspaces; even with the tenant toggle on, the UAMI
needs explicit access to each workspace it should read/write.

For each workspace Loom should operate in:

1. Fabric → open the workspace → **Manage access** (top-right).
2. **+ Add people or groups**.
3. Search for the UAMI client id → assign role **Member** (or Admin if you
   want write).

### Verify

```bash
SESSION_SECRET="$SECRET" node apps/fiab-console/tests/service-health.mjs
```

Expect `/api/fabric/workspaces` to return >0 workspaces and the count to
match what you granted access to. In the UI, `/items/notebook/new` should
populate a workspace dropdown and let you create + run a notebook.

---

## 3. Power BI tenant settings — workspace SP enablement  *(supplemental)*

Already mostly handled by step 2 (they share the same Fabric admin portal),
but two specific Power BI toggles deserve a check:

1. Same admin portal → **Tenant settings**.
2. **"Allow service principals to use Power BI APIs"** → Enabled → `loom-fabric-sp` group.
3. **"Service principals can access read-only admin APIs"** → Enabled.

For Power BI workspace ops (publishing reports, refreshing datasets):

4. Open any Power BI workspace → Settings → **Workspace settings** →
   **Access** → add the UAMI as **Member** or **Admin**.

### Verify

In the UI, open any `/items/report/new` or `/items/semantic-model/new` →
workspace picker should populate.

---

## 4. Optional cleanup — let bicep deploy missing endpoints

Two editors are gated on Azure resources that aren't deployed in the
default Loom stack yet. Both are tracked in the bicep tree but not in
the default `commercial-full.bicepparam`:

### Content Safety endpoint

Editor: `/items/content-safety/new`. Needs an `Microsoft.CognitiveServices/accounts`
with kind `ContentSafety`. To deploy:

```bash
az cognitiveservices account create \
  --name csloomcontentsafety-eastus2 \
  --resource-group rg-csa-loom-admin-eastus2 \
  --kind ContentSafety --sku S0 --location eastus2 \
  --custom-domain csloomcontentsafety-eastus2
```

Then set the env var on the container app:

```bash
az containerapp update -g rg-csa-loom-admin-eastus2 -n loom-console \
  --set-env-vars LOOM_CONTENT_SAFETY_ENDPOINT=https://csloomcontentsafety-eastus2.cognitiveservices.azure.com/
```

Grant UAMI the role:

```bash
ACC=$(az cognitiveservices account show -n csloomcontentsafety-eastus2 -g rg-csa-loom-admin-eastus2 --query id -o tsv)
az role assignment create --assignee-object-id e61f3eb3-c646-4183-8198-4c4a34cd9a01 \
  --assignee-principal-type ServicePrincipal \
  --role "Cognitive Services User" --scope "$ACC"
```

### Purview account (for sensitivity labels in workspace settings)

Editor: workspace Settings drawer → **Sensitivity** tab. Today renders an
honest "needs Purview Information Protection" MessageBar.

To enable: provision a `Microsoft.Purview/accounts`, grant UAMI
**Purview Data Reader**, set `LOOM_PURVIEW_ACCOUNT=<name>` env var on
loom-console. The Sensitivity tab will then list labels from the live
Purview tenant.

---

## 5. APIM — verify the route gap, not a real gap

Service-health reports `APIM | NOT CONFIGURED` because the inventory
listing endpoint `/api/apim/instances` doesn't exist. The actual APIM
editors (`/items/apim-api/new` etc.) **work** — they use the per-item
routes which were granted "API Management Service Contributor" by the
bootstrap workflow.

No action needed; this is a test-script gap, not a product gap. Will be
fixed in the next service-health pass.

---

## How to verify everything end-to-end after the grants

After steps 1 + 2 (the two clicks that matter), re-run the audits:

```bash
# Open KV for cookie minting
MY_IP=$(curl -s https://api.ipify.org)
az keyvault update -n kv-loom-m56yejezt7bjo --public-network-access Enabled --default-action Deny -o none
az keyvault network-rule add -n kv-loom-m56yejezt7bjo --ip-address "$MY_IP/32" -o none
sleep 15
SECRET=$(az keyvault secret show --vault-name kv-loom-m56yejezt7bjo --name loom-session-secret --query value -o tsv)

# v3 Cosmos round-trip — should be 26/26
SESSION_SECRET="$SECRET" node apps/fiab-console/tests/uat-v3.mjs

# Service health — should jump from 18/22 → ~21/22 (PP + CS green)
SESSION_SECRET="$SECRET" node apps/fiab-console/tests/service-health.mjs

# Browser walkthrough — should keep 42/48
SESSION_SECRET="$SECRET" node apps/fiab-console/tests/walkthrough.mjs

# RE-LOCK IMMEDIATELY
az keyvault network-rule remove -n kv-loom-m56yejezt7bjo --ip-address "$MY_IP/32" -o none
az keyvault update -n kv-loom-m56yejezt7bjo --public-network-access Disabled -o none
```

---

## After-checklist — what should be 100% live

| Editor family | Verdict after grants 1 + 2 |
|---|---|
| Cosmos-only (workspace, items, comments, share, audit, prefs, tabs, notifications) | ✅ A+ |
| Synapse Serverless / Dedicated SQL pool | ✅ A+ (Dedicated needs Resume first) |
| Databricks (cluster, job, notebook, SQL warehouse) | ✅ A |
| ADF (pipeline, dataset, trigger, mounted) | ✅ A |
| APIM (API, product, policy) | ✅ A |
| Lakehouse (ADLS Gen2 browser, OPENROWSET preview, Open in notebook, Load to Tables) | ✅ A+ |
| Warehouse (Fabric over Synapse Dedicated) | ✅ A |
| Azure SQL family (DB, Server, MI, SQL 2025 vector) | ✅ A |
| Mirrored database / mirrored Databricks | ✅ A |
| KQL database / Eventhouse / queryset / dashboard | ✅ A+ |
| Activator | ✅ A |
| Eventstream | ✅ A (env vars set 2026-05-26 — namespace was already deployed) |
| AI Search index | ✅ A+ |
| AI Foundry hub + project + prompt-flow + eval + ml-model + ml-experiment + compute + dataset | ✅ A *(unlocked by bootstrap)* |
| Content Safety | ⚠️ B until step 4 (~3 min deploy) |
| Power BI (semantic model, report, dashboard, paginated, scorecard) | ✅ A *(unlocked by step 2 + workspace grants)* |
| Power Platform (Power Apps, Power Automate, Dataverse, AI Builder, Power Page, environment) | ✅ A *(unlocked by step 1)* |
| Copilot Studio (agent, knowledge, topic, action, channel, analytics, templates) | ✅ A *(unlocked by step 1)* |
| Cross-item Copilot orchestrator | ✅ A |
| Data products (template, instance) | ✅ A |
| Graph (Cosmos Gremlin) | ✅ A |
| Graph (Cypher, GQL, graph-model, ontology) | ⚠️ B (parsing only) |
| Geo family (dataset, map, pipeline, query) | ⚠️ B (works when Lakehouse data present) |
| dbt job | ⚠️ B until `LOOM_DBT_ENDPOINT` set |
| Spark job definition | ✅ A |
| Environment | ✅ A |
| Copy job / Data pipeline / GraphQL API / User data function | ✅ A / B |
| Plan / Operations agent / Tracing | ✅ A |

**Net after the two interactive clicks: ~60 of ~70 editors land at A/A+.**
The remaining ~10 are B for honest reasons (need additional infra or are
specialized parsers without an Azure backing).

---

## Push-button reproducibility

Bicep at `platform/fiab/bicep/` deploys every Azure resource Loom uses.
The post-deploy bootstrap workflow grants every UAMI role that can be
granted via SP. **The only things `gh workflow run` can't do** are the
two interactive grants in sections 1 and 2 above. Document those for any
new tenant; everything else is replayable end-to-end.

For a fresh sub:

```bash
# 1. Provision
az deployment sub create \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial-full.bicepparam \
  -l eastus2

# 2. Bootstrap RBAC (Synapse + Databricks + APIM + Foundry + admin RG Reader)
gh workflow run csa-loom-post-deploy-bootstrap.yml --ref main

# 3. Apply interactive grants (sections 1 + 2 of this doc)

# 4. Bootstrap catalogs (curated apps + workloads)
# Sign in to the live URL once, then either:
#   - POST /api/admin/bootstrap-catalogs from the browser dev console, OR
#   - Click any /apps page — auto-copy from GLOBAL fires on first read

# 5. Optional: reindex AI Search
# POST /api/admin/reindex-items
```

---

## What I actually did in this session (2026-05-26)

**Power Platform Administrator grant — DONE via Microsoft Graph:**

1. Created role-assignable security group `loom-uami-admins` (Graph id: `5e2efb0a-8b25-4ddb-b545-a9b547127472`).
2. Added UAMI service principal (`e61f3eb3-c646-4183-8198-4c4a34cd9a01`) as member.
3. Assigned the **Power Platform Administrator** directory role (template id `11648597-926c-4cf3-9c36-bcebb0ba8dcc`) to the group at directory scope.

The Entra assignment is in place. Power Platform API still 403s the SP because:
- **Entra → PP propagation takes 5-15 min.** Retry `service-health.mjs` after the wait.
- **Dataverse-backed editors** (Power Apps, Dataverse table, AI Builder) additionally need the SP registered as an **Application User** inside each Dataverse environment. Path: PPAC → Environment → Settings → Users + permissions → Application users → + New app user → search `c6272de5-3c4e-4b72-8b57-71b2e950209b` → assign business unit + System Administrator security role.

**Fabric tenant SP grants — already in place:**
- "Service principals can call Fabric public APIs" → Enabled, applied to group `FabricDataGov` (id `43a6f18e-75c5-41e8-88c5-1532231baec6`).
- UAMI was already a member of `FabricDataGov` (Graph reports "already exist" on add).
- `/api/fabric/workspaces` returns 1 workspace today — Fabric editors green for that workspace.

**Foundry — DONE via post-deploy-bootstrap (PR #333 merged):**
- UAMI: Reader on `rg-csa-loom-admin-eastus2`
- UAMI: AzureML Data Scientist on `aifoundry-csa-loom-eastus2` workspace
- UAMI: Storage Blob Data Reader on Foundry storage
- `/api/foundry/{workspace,connections,computes,datastores,deployments}` all 200.

**Bootstrap workflow now contains the full RBAC recipe.** Re-running `gh workflow run csa-loom-post-deploy-bootstrap.yml --ref main` on any fresh sub re-applies the same grants idempotently.
