# CSA Loom — End-to-End Test Script (2026-05-27)

This is the complete manual test script for the work landed today on `loom-console-fvbbctd4eehqbkcs.b02.azurefd.net` (Front Door fronting the Container App). Walk through each section in order — every check has a clear pass/fail with what to do on failure.

**Live URL:** https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net
**Sign in:** your Entra ID account in the FedCiv DLZ tenant (`d1fc0498-f208-4b49-8376-beb9293acdf6`)

**Expected revision after final deploy:** `loom-console--0000082` (or later) — the deploy chain is described in §10 below. **Current live SHA: `146d2158`** (confirmed via `/build-marker.txt`).

**Automated smoke status (last run after PR #345 merge):**
- ✅ `apps-install-e2e.mjs` — 10/10 apps install + idempotent
- ✅ `editors-render-smoke.mjs` — 85/85 editors render
- ⚠️ `walkthrough.mjs` — **46/48 pages pass**. 2 remaining known issues:
  - `/onelake` — Front Door WAF Bot Manager still 403'ing on initial page-load request burst (partial fix in this PR — see §11 for status)
  - `/items/eventstream/new` — Monaco JSON worker URL `/monaco/vs/language/json/jsonWorker.js` not served (copy-monaco-assets.mjs needs to include language subdir — see §11)

---

## 0. Pre-flight

- [ ] Open the live URL. Confirm sign-in completes and Home renders without errors.
- [ ] Open the browser DevTools console. **There should be NO red errors on load.**
- [ ] In DevTools → Network, sign out + sign back in; confirm `/api/me` returns 200 with your `oid` + `name`.
- [ ] Click the build marker URL: https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/build-marker.txt — should return a single line `loom-build-marker sha=… stamp=… token=LOOM_LIVE_BUILD`.

**If pre-flight fails:** stop here, capture the network error, and report back.

---

## 1. Apps install — full code+data bundles (PR #341)

### 1.1 Bootstrap catalogs (first-run only)

If this tenant has never seen Loom before, you'll see an empty Apps page.

- [ ] Visit https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/apps
- [ ] If the page says "No apps in this tenant yet", open DevTools console and run:
  ```js
  fetch('/api/admin/bootstrap-catalogs', { method: 'POST' }).then(r => r.json()).then(console.log)
  ```
- [ ] Reload `/apps`. You should see **10 app cards**: Casino Analytics, Data Steward Console, Fabric Mirror Onboarding, FedRAMP Compliance Tracker, FinOps Cost Optimizer, Healthcare Population Health, IoT Real-Time Insights, Lakehouse Inspector, Pipeline Designer, RAG Builder.

### 1.2 Install one app end-to-end

- [ ] Click **Casino Analytics** card.
- [ ] On the app detail page, confirm "Bundled items" shows **4 items**: warehouse, activator, 2 notebooks (not 0 — that was the v3.27 bug).
- [ ] Click **Install** (or **Install into workspace**). Pick or create a workspace.
- [ ] Within 5s the page should show "Installed 4 items" with no errors.
- [ ] Click **Open in workspace**. You should see all 4 items in the workspace's item list.

### 1.3 Verify rich content in each installed item

Open each of the 4 items and verify:

- [ ] **Casino Data Warehouse** opens to the warehouse editor. An **info MessageBar at the top** says "App-installed starter content — From `app-casino-analytics` — 5 dbt models · 5 starter queries". Click "View bundle" → a dialog opens with tabs **DDL / dbt models (5) / Starter queries (5)**. Each tab should show real SQL (CREATE TABLE for dim_player, fact_session, etc.; dbt models for bronze/silver/gold; analyst queries).
- [ ] **High-Roller Alert** opens to the Activator editor. Same MessageBar should say "activator rule: High-Roller Net-Win Alert ($50K / 1h)". View bundle → see the rule JSON with condition + Teams action.
- [ ] **Player Value Analysis** (notebook) → MessageBar shows "11 cells (default lang: pyspark)". View bundle → tabs of cells, each with real PySpark code (RFM scoring, MLflow churn ensemble).
- [ ] **Floor Optimization** (second notebook) → similar with K-means clustering code.

### 1.4 Install the remaining 9 apps

Repeat 1.2 for each of: Data Steward Console, Fabric Mirror Onboarding, FedRAMP Compliance Tracker, FinOps Cost Optimizer, Healthcare Population Health, IoT Real-Time Insights, Lakehouse Inspector, Pipeline Designer, RAG Builder.

For each, confirm:
- [ ] Bundled items count matches the app card (FedRAMP 2, IoT 3, RAG 4, Pipeline 4, etc.)
- [ ] Open at least one item per app and confirm BundleContentBar shows real content (KQL functions, dbt models, schema fields, OKR definitions, etc.)

### 1.5 Idempotency

- [ ] Install the same app twice. Second install should report all items as `existed` (not duplicated).

---

## 2. Editor ribbon buttons all wired (PR #344)

The header bar right under the **Home** tab now has functional buttons. Sample these 10 editors:

### 2.1 Notebook (reference — always worked)

- [ ] Open any installed notebook. The ribbon shows tabs: Home, Insert, View, Run, Help.
- [ ] **Home → Save** button is enabled and saves when clicked.
- [ ] **Run → Run all** triggers a Spark/Databricks job.

### 2.2 Activator

- [ ] Open the High-Roller Alert item.
- [ ] **Workspace dropdown** at the top should list **Loom workspaces by name** (e.g. "My workspace"), NOT capacity SKU values like "F64". ← This was the explicit user-reported bug.
- [ ] Ribbon **Home → New rule** opens the rule creation dialog.
- [ ] Disabled actions (Start, Stop, Email, Teams, Run pipeline) show a tooltip on hover explaining they're not yet wired.

### 2.3 KQL Database

- [ ] Open `/items/kql-database/new`.
- [ ] Monaco editor loads (NOT a textarea). Type `print "hello"` and see KQL syntax coloring.
- [ ] Ribbon buttons all have either an action OR a hover tooltip.

### 2.4 Warehouse

- [ ] Open `/items/warehouse/new`.
- [ ] Monaco T-SQL editor loads.
- [ ] Ribbon **Home → Run** is wired.

### 2.5 Eventstream

- [ ] Open `/items/eventstream/new`.
- [ ] Workspace picker shows Loom workspaces.
- [ ] Ribbon **Home → Save** is wired.

### 2.6 Synapse Dedicated SQL Pool

- [ ] Open `/items/synapse-dedicated-sql-pool/new`.
- [ ] Ribbon **Home → Run**, **Resume**, **Pause**, **Refresh** all wired (look for hover state change on click).

### 2.7 Foundry Hub + sub-editors

- [ ] Open `/items/ai-foundry-hub/new`.
- [ ] Ribbon **Reload** refreshes panels.
- [ ] Ribbon **Open in Azure portal** opens a new tab to `https://ai.azure.com/...`.

### 2.8 Power BI Report

- [ ] Open `/items/report/new`. Pick a workspace.
- [ ] Ribbon **Refresh** triggers a reload of the report list + detail.

### 2.9 ADF Trigger

- [ ] Open `/items/adf-trigger/new`.
- [ ] Ribbon **Start** / **Stop** are wired (POST to `/api/items/adf-trigger/[id]/state`).

### 2.10 Spot-check 5 more random editors

Pick any 5 from: Stream Analytics Job, APIM Api, Copilot Studio Agent, ML Model, Lakehouse, ADF Pipeline, Databricks Cluster, Cosmos Gremlin Graph, Geo Query, Variable Library.

For each:
- [ ] Open `/items/<type>/new`. Ribbon renders.
- [ ] **At least one ribbon button** has an `onClick` (test by clicking — see network call or dialog).
- [ ] Disabled buttons show explanatory tooltip on hover.

---

## 3. Monaco editor (PR #341 + #342)

7 editors used to break on load because Monaco's loader was blocked by CSP. Now all should work.

For each: Warehouse, Synapse Serverless SQL Pool, Synapse Dedicated SQL Pool, KQL Database, Eventstream, Azure SQL Database, Databricks SQL Warehouse:

- [ ] Open `/items/<type>/new`.
- [ ] DevTools console: NO "Loading the script 'https://cdn.jsdelivr.net/…' violates Content Security Policy" error.
- [ ] DevTools console: NO "Creating a worker from 'blob:…' violates Content Security Policy" error.
- [ ] Monaco editor visible (`.monaco-editor` element in DOM, with line numbers + syntax coloring).
- [ ] Type a query, see syntax coloring + IntelliSense (Ctrl+Space).

---

## 4. Compute lifecycle UI — NEW (this PR, §10 below)

Verify the new shared `<ComputePicker>` component with state badges + Resume/Pause/Restart actions.

### 4.1 dbt-job editor

- [ ] Open `/items/dbt-job/new`.
- [ ] **Compute target** dropdown lists Databricks clusters (NOT a free-text cluster_id Input).
- [ ] Selected cluster shows a state badge (Running / Stopped / etc.).
- [ ] If cluster is Stopped, a **Resume** button appears next to the badge. Click it → state should transition.

### 4.2 Warehouse + Synapse Dedicated SQL Pool

- [ ] Open `/items/warehouse/new` and `/items/synapse-dedicated-sql-pool/new`.
- [ ] **Compute target** picker shows the Synapse Dedicated SQL pool with state.
- [ ] If paused, **Resume** button appears.
- [ ] Clicking Resume fires `POST /api/loom/compute-targets/dedicated-sql:<name>/start` (verify in Network tab).

### 4.3 ML Model + ML Experiment

- [ ] Open `/items/ml-model/new` and `/items/ml-experiment/new`.
- [ ] **Predict compute** picker now exists (was previously a free-text Input or missing entirely).

---

## 5. Backing-service pickers — NEW (this PR, §10 below)

Verify free-text Inputs for Azure resources have been replaced with Select dropdowns.

### 5.1 Copy Job editor

- [ ] Open `/items/copy-job/new`.
- [ ] **Source linked service** and **Sink linked service** are dropdowns (NOT free-text Inputs), populated from `/api/adf/linked-services`.

### 5.2 Azure SQL Database

- [ ] Open `/items/azure-sql-database/new`.
- [ ] **Server** is a dropdown of Azure SQL servers (NOT free-text), driven by `/api/items/azure-sql-server`.
- [ ] After selecting a server, **Database** dropdown populates with databases on that server.

### 5.3 SQL Server 2025 Vector Index

- [ ] Open `/items/sql-server-2025-vector-index/new`.
- [ ] Same Server + Database dropdowns as above.

### 5.4 Geo Pipeline

- [ ] Open `/items/geo-pipeline/new`.
- [ ] **ADF pipeline name** is a dropdown driven by `/api/items/adf-pipeline` (NOT free-text).

### 5.5 Geo Dataset

- [ ] Open `/items/geo-dataset/new`.
- [ ] **ADLS container** is a dropdown driven by `/api/lakehouse/containers`.

### 5.6 Data Product Template

- [ ] Open `/items/data-product-template/new`.
- [ ] **Target workspace** is a dropdown (uses `useWorkspaces()`), not free-text.

### 5.7 User Data Function

- [ ] Open `/items/user-data-function/new`.
- [ ] **Function App** is a dropdown driven by `/api/azure/function-apps` (NEW BFF route).
- [ ] If the ARM call returns 0 results, a MessageBar should explain (e.g. "SP needs Reader role on subscription").

---

## 6. Page-level fixes

### 6.1 /workloads (was crashing with React error #130)

- [ ] Visit `/workloads`. Page renders without crash.
- [ ] DevTools console: NO React error #130 ("Element type is invalid").
- [ ] Cards render with proper icons (no broken `<undefined />`).

### 6.2 /workload-hub

- [ ] Visit `/workload-hub`. Same as above — renders cleanly with icons.

### 6.3 /onelake (still under investigation)

- [ ] Visit `/onelake`. **Known issue:** may show some 403s on side-rail requests (brand logo, tenant theme, notifications) — investigation report at `temp/onelake-403-investigation.md`. The core item list should still render.

### 6.4 Pre-save fetch noise silenced (this PR, §10 below)

For `/items/warehouse/new` and `/items/eventstream/new`:

- [ ] Open DevTools → Network.
- [ ] Visit each URL.
- [ ] No 404s on `/api/items/<type>/new` and no 409s on `/api/items/<type>/new/schema` (these fetches now correctly skip when `id === 'new'`).

---

## 7. Service-by-service health (live Azure connectivity)

The service-health probe at `apps/fiab-console/tests/service-health.mjs` exercises 23 endpoints across 12 service families. To run it locally:

```powershell
# From a workstation with az login + KV access to kv-loom-m56yejezt7bjo
$env:SESSION_SECRET = (az keyvault secret show --vault-name kv-loom-m56yejezt7bjo --name loom-session-secret --query value -o tsv)
node apps/fiab-console/tests/service-health.mjs
```

- [ ] Expected output: `23 pass · 0 not-configured · 0 fail (of 23)`.
- [ ] Per-family roll-up should show GREEN for: Cosmos, Synapse, Databricks, ADF, APIM, Foundry, AI Search, Fabric, Power Platform, Copilot Studio, Loom Search Index, ARM.

---

## 8. Apps install E2E (automated)

The full apps-install E2E exercises all 10 apps idempotently:

```powershell
node apps/fiab-console/tests/apps-install-e2e.mjs
```

- [ ] Expected output: `10/10 apps install cleanly + idempotently`.

---

## 9. Per-editor render smoke (automated)

The per-editor render smoke creates one item per registered editor type (85 types) and verifies the page renders + hydrates:

```powershell
node apps/fiab-console/tests/editors-render-smoke.mjs
```

- [ ] Expected output: `85/85 editors render cleanly`.

---

## 10. Deployment chain (operator section — already done before you test)

This is what the maintainer did to land all the work — for reference only.

The full chain for any PR merged today:

```bash
# 1. PR merged via gh api -X PUT pulls/<n>/merge -f merge_method=squash
# 2. ACR public network opened (publicNetworkAccess=Enabled, defaultAction=Allow) — needed for SP build worker
az acr update --name acrloomm56yejezt7bjo --public-network-enabled true --default-action Allow

# 3. Dispatch build
gh workflow run build-fiab-images.yml --ref main

# 4. ACR re-locked after build success
az acr update --name acrloomm56yejezt7bjo --public-network-enabled false

# 5. Container App updated to new SHA
NEW_SHA=$(git rev-parse origin/main)
az containerapp update -n loom-console -g rg-csa-loom-admin-eastus2 --image acrloomm56yejezt7bjo.azurecr.io/loom-console:$NEW_SHA

# 6. Revision health check
az containerapp revision show -n loom-console -g rg-csa-loom-admin-eastus2 --revision <latest> --query "{health:properties.healthState,running:properties.runningState}"
```

Confirm the live image SHA matches the latest main:
```bash
az containerapp show -n loom-console -g rg-csa-loom-admin-eastus2 --query "properties.template.containers[0].image" -o tsv
```

---

## 11. What's still queued for future sessions

These are explicitly NOT in scope for today's testing — they're tracked as separate work items:

- **Phase 2 — real Fabric/ADX/Synapse provisioning on install** (task #134). Today's apps install populates rich content in Cosmos (Phase 1). Phase 2 will also create the real Fabric notebooks, ADX KQL DBs with ingested rows, AI Search indexes with sample docs, dbt projects deployed to warehouses, etc. This is a multi-PR initiative.
- **/onelake 403 cascade partial fix only**. The HTTP Parameter Pollution diagnosis in `temp/onelake-403-investigation.md` was correct but incomplete — switching the multi-value `?type=A&type=B...` to comma-separated `?types=A,B,...` reduced WAF rule 921180's trigger but Bot Manager is still flagging the initial burst of requests from the page. Next steps: pull Front Door diagnostic logs from FedCiv DLZ Log Analytics, identify which rule is firing, request a WAF exclusion or rate-limit adjustment. Until fixed, `/onelake` shows mostly-empty page with 7 console 403s.
- **Monaco JSON worker URL** for `/items/eventstream/new`. The eventstream editor uses Monaco's JSON language worker, which expects `/monaco/vs/language/json/jsonWorker.js`. The `scripts/copy-monaco-assets.mjs` only copies `min/vs/` from `monaco-editor` package — language workers may live in `esm/vs/language/` or need to be sourced from `monaco-editor/min-maps/`. Next step: update the copy script to include the JSON language worker bundles, OR move eventstream off JSON Monaco language onto plaintext.

---

## How to report results

For each section, mark all checks ✅ or ❌. For any ❌, include:
- The route / editor where it failed
- DevTools console output (last 5 lines)
- Network panel screenshot of the failed request
- Expected vs actual behavior

Save the report as `temp/test-results-2026-05-27-<your-initials>.md` and ping the maintainer.

---

🤖 Generated alongside the work landed today by Claude (Opus 4.7).
