# App-bundle dataset audit — real, repo-hosted, loaded

**Scope:** all 29 CSA Loom app bundles in `apps/fiab-console/lib/apps/content-bundles/app-*.ts`.
**Rule:** [.claude/rules/no-vaporware.md](../../../.claude/rules/no-vaporware.md) — every dataset / shortcut a bundle references must ship REAL (hosted in the repo) and the install must actually load it so it is present + queryable, OR honest-gate with the exact reason. No external URL that 404s, no workspace that doesn't exist.

## How datasets land now

There are three ways a bundle's data becomes real at install time (when "Deploy artifacts to live Azure services" is ON):

1. **Inline `deltaTables[].sampleRows`** (warehouse `sampleRows`, KQL table `sample[]`): already uploaded by the lakehouse / warehouse / KQL provisioners as real CSV into the tenant's ADLS + loaded to a table / registered as a Synapse OPENROWSET view. These ship in-repo as part of the bundle source and were already real — kept as-is.
2. **`shortcuts[].repoDataset`** (NEW, preferred — self-contained): a repo-relative path under `samples/app-data/<app>/<file>`. The lakehouse provisioner (`lib/install/provisioners/lakehouse.ts` → `provisionShortcuts`) reads the real file via `lib/apps/repo-datasets.ts`, uploads it into the tenant's OWN ADLS under `<lakehouse-root>/Files/_shortcuts/<name>/`, registers a real `active` shortcut row, and (when Synapse serverless is configured) an OPENROWSET view so it is queryable. Nothing external.
3. **`shortcuts[].publicAnonymous: true`** with an `https://`/`abfss://` target: a genuinely public, anonymous-read dataset. The provisioner runs a REAL unauthenticated HEAD/GET probe (no UAMI RBAC); 2xx ⇒ `active`, otherwise `pending` with the HTTP status (honest gate).
4. **`shortcuts[].target = internal://<container>/<path>`**: a pointer to the tenant's primary ADLS account (UAMI already reads it). Registered `active`.

Any bare external `target` with none of these flags is registered **`pending`** with an explicit gate — never a silent `active` over an unreachable URL.

## Audit table (only bundles with a dataset/shortcut/external-data reference)

| Bundle | Reference (before) | Class (before) | Disposition (now) | Loaded? |
|---|---|---|---|---|
| **app-lakehouse-inspector** | `https://datasetsforfabric.blob.core.windows.net/retail-public/orders.csv` (shortcut) | external 404 | → repo-hosted `samples/app-data/lakehouse-inspector/retail-orders-public.csv` (267 rows), uploaded to tenant ADLS + Synapse view | **YES** (repoDataset) |
| **app-lakehouse-inspector** | `onelake://fraud-analytics-prod/lakehouse-fraud/gold/fraud_scores` (shortcut) | non-existent workspace | **removed** (fake cross-workspace ref); notebook cell 5 retargeted to read the real `retail-orders-public` shortcut | n/a (removed) |
| app-lakehouse-inspector | `deltaTables[].sampleRows` (bronze/silver/gold ×10 tables) | inline-sample | unchanged — already uploaded + loaded by the lakehouse provisioner | YES (already) |
| **app-ml-pipeline** | `abfss://unity-catalog@onelake/ml/features` (shortcut) | malformed/unreachable | **removed** — the churn feature tables are already real Delta tables in this lakehouse (inline sampleRows) | n/a (removed) |
| **app-direct-lake-replacement** | `abfss://legacy-exports@{{ADLS_ACCOUNT}}.dfs.core.windows.net/pbirs-archive` (shortcut) | external (non-existent container) | → repo-hosted `samples/app-data/direct-lake-replacement/legacy-bi-export-manifest.csv` (10 rows) | **YES** (repoDataset) |
| **app-multi-agency-onboarding** | `abfss://catalog@{{ADLS_ACCOUNT}}.dfs.core.windows.net/overlay` (shortcut) | external (non-existent container) | → repo-hosted `samples/app-data/multi-agency-onboarding/admin-plane-catalog-overlay.csv` (8 rows) | **YES** (repoDataset) |
| **app-hybrid-topology** | `abfss://bronze@govdlzlake.dfs.core.usgovcloudapi.net/reference/` (shortcut) | external (tenant-specific account) | → repo-hosted `samples/app-data/hybrid-topology/acs5yr-tract-aggregates.csv` (120 rows, non-classified Census ACS) | **YES** (repoDataset) |
| **app-hybrid-topology** | `https://commrefdata.blob.core.windows.net/public/acs5yr/` (notebook NB_MOVE `SRC`) | external 404 hard-coded | notebook `SRC`/`DST` softened to in-tenant illustrative paths (`Files/_shortcuts/commercial_aggregate/…`); azcopy stays customer-initiated (commented), no live external fetch | n/a (illustrative) |
| **app-azure-realtime-analytics** | `abfss://landing@{{ADLS_ACCOUNT}}.dfs.core.windows.net/eventhub-capture` (shortcut) | external (templated) | → `internal://landing/eventhub-capture` (tenant's own landing container) | YES (internal) |
| **app-azure-realtime-analytics** | `abfss://data@analyticsstorage.dfs.core.windows.net/` (notebook mount) | external placeholder | parameterised to a customer-supplied `adls_account` widget/conf (no hard-coded fake account) | n/a (illustrative setup) |
| **app-healthcare-popmgt** | `https://data.cms.gov/...`, `https://npiregistry.cms.hhs.gov/api/`, `https://hcup-us.ahrq.gov/...` (3 shortcuts) | external (genuinely public) | marked `publicAnonymous: true` — install runs a REAL anonymous probe; 2xx ⇒ active, else pending+HTTP status | probed (honest) |
| **app-federal-data-mesh** | `deltasharing://marketplace/{consuming-domain}` (shortcut) | placeholder pseudo-target | **removed** — the Delta Sharing automation notebook creates the real grant + shortcut once approved | n/a (removed) |
| app-fabric-mirror-onboard | `Files/MirroredRetailOLTP` (shortcut) | internal relative | unchanged — internal path; data seeded inline | YES (already) |
| app-casino-analytics, app-data-steward, app-finops-cost, app-iot-realtime, app-pipeline-designer, app-real-time-dashboards | inline `sampleRows` only | inline-sample | clean — unchanged | YES (already) |
| app-data-governance, app-workspace-monitoring, app-sovereign-ai-agents, app-supercharge-* | `learn.microsoft.com` / GitHub repo links in sourceDocs / markdown | doc-ref | clean — documentation links, not data loads | n/a |
| app-rag-builder | `https://sample.docs.csa-loom.invalid/...` (sampleDocs source_url metadata) | doc-ref (`.invalid` by design) | clean — index metadata, not a data fetch | n/a |
| app-change-feed-processor | `target: 'redis'` (eventstream destination) | service ref | clean — destination type + connectionSecretRef, not a lakehouse shortcut | n/a |
| app-logic-apps-integration | `*.contoso.example` API URLs (workflow params) | placeholder | out of scope (Logic App workflow params, not a dataset/shortcut); the logic-app provisioner already gates on real connectors | n/a |
| app-fedramp-tracker, app-supercharge-utils, app-supercharge-guide | — | clean | clean | n/a |

## Repo-hosted sample datasets added

| File | Rows | Bundle |
|---|---|---|
| `samples/app-data/lakehouse-inspector/retail-orders-public.csv` | 267 | app-lakehouse-inspector (reference impl) |
| `samples/app-data/direct-lake-replacement/legacy-bi-export-manifest.csv` | 10 | app-direct-lake-replacement |
| `samples/app-data/multi-agency-onboarding/admin-plane-catalog-overlay.csv` | 8 | app-multi-agency-onboarding |
| `samples/app-data/hybrid-topology/acs5yr-tract-aggregates.csv` | 120 | app-hybrid-topology |

All are realistic columns, a few hundred rows max, git-sized (<40KB each). Shipped into the Next.js standalone bundle via `outputFileTracingIncludes` in `apps/fiab-console/next.config.mjs`.

## Remaining honest limitations

- **app-healthcare-popmgt** CMS/NPI/AHRQ shortcuts are genuinely-public external endpoints. They are probed at install; if the public endpoint changes/rejects the probe they register `pending` with the HTTP status (by design — Loom does not copy third-party federal datasets into the tenant). This is honest, not vaporware.
- **Repo-dataset upload requires the DLZ ADLS** (`LOOM_LANDING_URL` / `LOOM_BRONZE_URL` …) to be configured. With no DLZ container the lakehouse provisioner already honest-gates (`status:'remediation'`) naming the exact env var — unchanged behaviour, applies to the repoDataset uploads too.
- **Synapse OPENROWSET views** over uploaded shortcuts are an optional queryability convenience; when `LOOM_SYNAPSE_WORKSPACE` is unset the file is still uploaded + browsable, the view step is skipped (logged).

## Tests

- `apps/fiab-console/lib/install/__tests__/lakehouse-shortcut-datasets.test.ts` — 6 tests: repoDataset upload+view+active row; missing repoDataset → pending; internal:// → active; publicAnonymous 2xx → active / non-2xx → pending; bare external → pending.
- `apps/fiab-console/lib/apps/__tests__/repo-datasets.test.ts` — 10 tests: path normalisation, traversal/absolute rejection, real read of the shipped retail CSV.
