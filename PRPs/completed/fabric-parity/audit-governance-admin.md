# Functional Audit — Governance & Admin (governance-admin)

**Auditor pass:** 2026-06-26 · **Scope:** the ~23 `/admin/*` surfaces + the
governance / Purview / catalog / classifications / sensitivity / access-policy /
self-audit stack. **Method:** traced each user-facing surface UI control → BFF
route (`app/api/**`) → backend client (`lib/azure/**`, `lib/admin/**`,
`lib/coe-library/**`). Ran the no-vaporware greps (`return []` / `return {}` /
`MOCK_` / `SAMPLE_` / `TODO` / disabled buttons / handler-less `onClick`).

## Headline

**This area is in strong shape. No vaporware (F) and no dead stubs (D) found.**
Every surface traced reaches a real Azure/Cosmos/Graph/Purview backend, or an
**honest Fluent MessageBar / 503 gate** naming the exact env var or role to
provision (compliant with `no-vaporware.md`). The few B-grades below are honest
infra-gates or by-design Cosmos persistence — not defects. They are recorded as
P2 watch-items, not bugs.

The no-vaporware greps returned only **honest 404→empty fallbacks** (e.g.
`batch-labeling/route.ts:62,81`, `purview/dataquality/route.ts:37,40`,
`domains/route.ts:87` — all `catch(404) → []/{}` so the surface still renders)
and **comments documenting the removal of prior hardcoded tables**
(`azure-resources/route.ts:5`, `bootstrap-catalogs/route.ts:32`,
`capacity/page.tsx:38`). Zero `MOCK_`/`SAMPLE_` data arrays in any route or page.

## Findings table

| # | Surface | Grade | Backend traced | Root cause / note (file:line) | Fix / action |
|---|---------|-------|----------------|-------------------------------|--------------|
| 1 | Self-audit (`/admin` healer) | **A** | `lib/admin/self-audit.ts` — live probes hit Cosmos/AOAI, detect 401/403; dry-run preview + admin-gated healer | `app/api/admin/self-audit/route.ts:26,49` real engine, no mocks | none |
| 2 | Classifications (`/admin/classifications`) | **A** | Cosmos `tenant-settings` + **best-effort real Purview** custom-classification rules + CUSTOM scan rule sets | `classifications/route.ts:97,191` `syncClassificationTaxonomyToPurview`; honest `purview` field when `LOOM_PURVIEW_ACCOUNT` unset | none |
| 3 | Permissions / feature-RBAC (`/admin/permissions`) | **A** | Cosmos `featurePermissionsContainer`, capability-gated upsert/delete | `permissions/grants/route.ts:40,77,90` | none |
| 4 | Domains (`/admin/domains`) | **A** | Cosmos domains + workspace GROUP-BY counts + Unity-Catalog link + Purview status | `domains/route.ts:79` real GROUP BY; `:87` honest `catch→{}` | none |
| 5 | Security · MIP labels/policies/evaluate (`/admin/security`) | **A** | Real MS Graph `/beta/security/informationProtection/sensitivityLabels` | `lib/azure/mip-graph-client.ts:152,230,303` real `graphFetch`; honest 403 gate w/ grant-script hint :138 | none |
| 6 | Security · Purview scans/sources/glossary/DQ | **A** | Real classic Purview Data Map data plane (`purview.azure.net/.default`) | `lib/azure/purview-client.ts:217,320`; `govern/trigger-scan/route.ts:17,60` real `triggerScanRun` | none |
| 7 | Catalog browse/search/lineage/glossary (`/catalog`) | **A** | AI Search + Purview + Unity-Catalog + OneLake, per-source | `catalog/browse/route.ts:53,167`; honest 400/empty per source | none |
| 8 | Governance-catalog reindex | **A** | Ensures `loom-governance-items` AI Search index, full Cosmos backfill | `governance-catalog/reindex/route.ts:38` honest **503** when `LOOM_AI_SEARCH_SERVICE` unset (names bicep module) | none |
| 9 | Access-requests workflow (`/api/access-requests`) | **A** | Cosmos `accessRequestWorkflowContainer` + `[id]/decision` route | `access-requests/route.ts:36,50` | none |
| 10 | Data-quality rules + monitors/run (`/admin` DQ, `/dq/*`) | **A** | Cosmos rule store + **real execution** via `data-quality-client` / Databricks UC monitors | `data-quality-rules/route.ts:94`; `dq/monitors/route.ts:69,95` apply constraint | none |
| 11 | Batch labeling (`/admin/batch-labeling`) | **A** | Real Purview `addAssetClassification` + Power BI artifact labeling | `batch-labeling/route.ts:42-46`; `:62,81` honest 404→[]/{} | none |
| 12 | Copilot-usage (`/admin/copilot-usage`) | **A** | Real KQL over Loom Log Analytics (`queryLogs`) | `copilot-usage/route.ts:75-77`; honest gate `:128-135` when LA/App-Insights unconfigured | none |
| 13 | Usage analytics (`/admin/usage`) | **A** | Cosmos audit-log + workspaces + items aggregation | `usage/route.ts:26,174` | none |
| 14 | Embed-codes (`/admin/embed-codes`) | **A** | Cosmos `auditLogContainer`-backed CRUD | `embed-codes/route.ts:67,86,104` | none |
| 15 | Org-visuals dashboards (`/admin/org-visuals`) | **B+** | Loom-native render over the deployment's OWN Azure estate (Cost Mgmt / Resource Graph / Defender / Log Analytics); **no Fabric/Power BI** | `dashboards/render/route.ts:86-96` live resolve; `report-view.tsx:143,170,176` labels live/sample + fallback MessageBar; saved-dash Open passes `defaultLive` (`dashboards-pane.tsx:201`) | Watch-item only: `placeholderTable` (render:103) draws illustrative "Sample N" rows — already gated behind the **Sample** toggle and provenance badges, so honest. No change required. |
| 16 | Tenant-settings (`/admin/tenant-settings`) | **B** | Cosmos-persisted settings + audit log; persist→reload verified by design | `tenant-settings/route.ts:13,81,175` | By design (config store, not an Azure push). No action. |
| 17 | DSPM-AI posture (`/admin/security`) | **B** | Real engine; honest **503** `dspm_ai_not_configured` when `LOOM_COSMOS_ENDPOINT` unset | `dspm-ai/route.ts:32,52` | Honest gate. No action. |
| 18 | Security · DLP policies/rules/simulate | **B** | Real Graph `/beta` DLP for **Commercial**; honest gate elsewhere | `dlp-graph-client.ts:373-381` `/beta` policy segment 404→`DlpNotConfiguredError`; **Gov/DoD roots** have no DLP segment (`:173-188`); **no public simulate API** → honest MessageBar (`dlp/simulate/route.ts:8-12,43`) | Not a Loom defect — upstream MS Graph limitation, surfaced honestly. Repoint `evaluatePolicy` + drop gate if/when MS ships GA simulate. |
| 19 | Deploy-plan cost-estimate (`/admin/deploy-planner`) | **B** | Real **Azure Retail Prices API** (`prices.azure.com/api/retail/prices`) | `deploy-plan/cost-estimate/route.ts:46,73,78` real fetch | Honest disclosure: Retail API is Commercial-only; Gov estimate is "directional" w/ Commercial reference (route header :17-23). No action. |
| 20 | Updates / apply (`/admin/updates`) | **B** | Real ARM preflight (image existence + ARM perms) | `updates/apply/route.ts:51,79,146` honest **503** `arm-not-configured` | Honest gate. No action. |

## Verdict

- **F (vaporware):** 0
- **D (dead stub):** 0
- **C (functional but rough):** 0
- **B (production-grade, honest-gate / by-design):** 6 (#15–20)
- **A (production-grade + real backend):** 14

The governance-admin surface meets `no-vaporware.md` and `no-fabric-dependency.md`:
every governance item works Azure-native by default (Cosmos + Purview classic
Data Map + MS Graph MIP/DLP + AI Search + Log Analytics + Azure Retail Prices),
Fabric/Power BI is never on a default path, and every unprovisioned dependency
surfaces an honest named gate rather than faked data.

**Recommended follow-ups (all P2, none blocking):**
1. When MS Graph ships a GA DLP **simulate** API, repoint `evaluatePolicy()` and
   remove the honest gate in `dlp/simulate/route.ts`.
2. Track Gov-cloud DLP **policy** read once `graph.microsoft.us` exposes the
   `/beta/informationProtection/dataLossPreventionPolicies` segment.
3. (Cosmetic) Consider a one-line "illustrative sample" caption on org-visuals
   tiles while in Sample mode, even though the toggle already discloses it.
