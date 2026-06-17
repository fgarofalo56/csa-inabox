# CSA Loom — Day-One 100% Validation Matrix (HONEST)

**Ship gate:** every item, function, capability, app, and control-plane surface must be validated **end-to-end** (backend + **frontend** + Azure services + APIs) and proven to work — or have an honest, documented limitation — before day-one release.

**Rules (non-negotiable, set by the operator):**
1. **No PASS without a FRONTEND observation.** A passing API/route check is NOT a PASS. A row is PASS only when the actual UI action was driven and the real result was observed in the browser.
2. **No fake/missing datasets.** If an app bundle references a dataset, that dataset must be **hosted in the repo** and **actually loaded/installed** by the flow. External/example URLs that 404 or reference non-existent workspaces are FAILs.
3. **No vaporware.** A UI that renders but doesn't perform its claimed function is a FAIL.
4. **Honest status only.** Untested = `NOT-TESTED`. Do not infer PASS.

**Status legend:** `PASS` (frontend-verified) · `FAIL` (frontend-verified broken) · `FIXING` (fix in progress) · `NOT-TESTED` (not yet driven in the UI — assume nothing).

---

## A. Verified in the FRONTEND so far (this is the ONLY trustworthy section)

| Surface | Status | Frontend evidence |
|---|---|---|
| AutoML (create→wizard→submit) | PASS* | Drove wizard in browser; real AML job submitted, visible in Runs w/ Studio link. *Required a fix: AmlCompute cluster provisioned + concurrency≤nodes. |
| Notebook (cell run) | PASS | Run cell → real Synapse Spark Livy session 29 on loompool (observed). |
| App install — FinOps Cost Optimizer | PASS | Installed in CSA Loom Demo; 3 items provisioned w/ real Azure ids (observed). |
| CoE report viewer render | PASS | Report tab rendered 7 visuals (observed earlier); live-data path = separate PR. |
| **App-bundle dataset load (repoDataset → tenant ADLS)** | **PASS** | **v0.11, 2026-06-16:** fresh install of Lakehouse Inspector into a clean workspace. Report: *"Shortcut retail-orders-public: uploaded repo dataset `samples/app-data/lakehouse-inspector/retail-orders-public.csv` → `…/Files/_shortcuts/retail-orders-public/retail-orders-public.csv` (38751 bytes)"*, *"registered 'active' (self-contained, in-tenant)"*, *"Shortcuts: 1 active, 0 pending, 0 failed (of 1 declared)"*. Proves #1434 — the CSV ships in the image (`/app/samples`) and is uploaded to tenant ADLS. 38751 B = the repo file size. |
| **Shortcuts — register from bundle** | **PASS** | **v0.11:** bundle declares 1 repoDataset shortcut; report = *"1 active, 0 pending, 0 failed (of 1 declared)"*. (An earlier "2 external pending shortcuts" report in the CSA Loom Demo workspace was a STALE prior-session install — items "existed", not re-provisioned with v0.11 code.) Parser #1429 + datasets #1433/#1434 landed. Right-click context menu still NOT-TESTED. |
| **App install — Lakehouse Inspector (lakehouse+notebook+medallion seed)** | **PASS** | **v0.11:** both items `created`; Azure-native ADLS Gen2 lakehouse materialised — 10 table folders (10 seeded), 10 Synapse serverless views, shortcut active. Real `abfss://landing@srloomdlk6mvh5sm6z7do…`. |
| **Lakehouse Inspector — serverless SQL endpoint (T-SQL query)** | **PASS** | **2026-06-17, fresh centralus estate:** after granting the Console UAMI the **Synapse SQL Administrator** Synapse-RBAC role on the DLZ workspace, Retry → `synapse-serverless-sql-pool` step goes green `created` (`syn-loom-default-centralus-ondemand.sql.azuresynapse.net`); install toast *"All items installed and provisioned."* **Root cause:** "Login failed for token-identified principal" on CREATE DATABASE = UAMI lacked CONTROL SERVER. The ARM `administrators/activeDirectory` AAD-admin route does NOT create a working serverless login for an MI (documented Graph-fetch limitation); Artifact Publisher + Compute Operator don't confer SQL admin. Fix = Synapse SQL Administrator RBAC (roleId `7af0c69a-…`). **Durable bicep fix still owed** — synapse.bicep must grant SQL Administrator at deploy (must pass appId since the deploy identity is an SPI; PR #1440's ARM-admin sid=appId is insufficient). |
| Right-click context menu (lakehouse) | NOT-TESTED | Operator reports broken; not yet reproduced in UI. |

---

## B. NOT-TESTED — the full surface still owed a real frontend validation

Assume nothing here works until driven in the UI.

- **Item types (~104):** every New→item create flow + its primary action (run/query/render/deploy), in the UI. Only AutoML + Notebook + Lakehouse (partial) + Map (shell) driven so far.
- **Apps (29):** install → provision → **load real data** → use it, per bundle. Only FinOps (PASS) + Lakehouse Inspector (PASS, incl. serverless T-SQL after the SQL-Admin RBAC fix) driven.
- **Feature surfaces (243 leaves from the Wave-2 code audit):** Real-Time Hub, RTI catalog, Activators, Mirroring (all source types), APIs (APIM/GraphQL/DAB/UDF), Warp/Weave, Workload Hub, Connections, Business Events, Event Hubs — drive each in the UI.
- **Control planes:** every Admin Portal page + action (Tenant settings, Capacity/Scale, Runtime config, API Mgmt, Domains, Deployment planner, Add landing zone, Security & governance, Feature permissions, Batch labeling, Embed codes, Org visuals, Audit logs, Usage, Copilot usage, DSPM, Users, Network & DNS, Updates) + the Setup Wizard + DLZ attach/visualize.
- **Datasets:** audit ALL 29 bundles → every referenced dataset hosted in-repo + load verified.

---

## C. Execution method (so it's trustworthy, not "claimed")
1. Drive each surface in the authenticated browser; record PASS/FAIL + the observed evidence here.
2. For each FAIL: fix (live + bicep), re-drive in the UI, flip to PASS only on observation.
3. Datasets: host real sample data in the repo (`samples/` or `docs/fiab/sample-data/`), wire installers to upload/load it, verify the data is queryable in the UI.
4. Report progress as honest counts (N driven / M PASS / K FAIL / rest NOT-TESTED). Never "100%" until the matrix is actually all-PASS.

_This is a large, attended, multi-session program. Progress is tracked here, honestly, with frontend evidence per row._
