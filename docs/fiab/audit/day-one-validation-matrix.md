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
| **App install — Lakehouse Inspector** | **FAIL** | Lakehouse + notebook create ✅, but **`synapse-serverless-sql-pool` step = remediation** (scoped-credential/external-data-source on loom_lakehouse). MSI grant applied; not cleared. FIXING. |
| **Shortcuts — register from bundle** | **FAIL→FIXING** | Parser rejected `blob.core.windows.net` + `onelake://` (fixed in code, pending v0.11 roll). Bundle also ships an unreachable example dataset + non-existent workspace — DATASET workstream. |
| Right-click context menu (lakehouse) | NOT-TESTED | Operator reports broken; not yet reproduced in UI. |

---

## B. NOT-TESTED — the full surface still owed a real frontend validation

Assume nothing here works until driven in the UI.

- **Item types (~104):** every New→item create flow + its primary action (run/query/render/deploy), in the UI. Only AutoML + Notebook + Lakehouse (partial) + Map (shell) driven so far.
- **Apps (29):** install → provision → **load real data** → use it, per bundle. Only FinOps (PASS) + Lakehouse Inspector (FAIL) driven.
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
