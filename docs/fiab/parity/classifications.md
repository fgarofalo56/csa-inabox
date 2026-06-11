# classifications — parity with Microsoft Purview Data Map (Classification rules + Scans)

Source UI:
- Purview portal → Data Map → **Classification rules** (Custom tab):
  https://learn.microsoft.com/purview/data-map-classification-custom
- Purview portal → Data Map → **Scan rule sets**:
  https://learn.microsoft.com/purview/data-map-scan-rule-set
- Purview portal → Data Map → **Sources → Scans → Run now**:
  https://learn.microsoft.com/purview/register-scan-synapse-workspace#scan
- Classification best-practice (custom rules + scan rule set):
  https://learn.microsoft.com/purview/data-gov-best-practices-classification

Loom surface: `/admin/classifications` (`app/admin/classifications/page.tsx`)
BFF: `/api/admin/classifications`, `/api/governance/scans`
Client: `lib/azure/purview-client.ts`, `lib/azure/purview-classification-sync.ts`

## Azure/Purview feature inventory

| # | Capability (Purview portal) | REST / data-plane |
|---|------------------------------|-------------------|
| 1 | Create a custom classification rule (name, classification, description) | `PUT /scan/classificationrules/{name}` kind=Custom |
| 2 | Column-name regex pattern | `properties.columnPatterns:[{kind:'Regex',pattern}]` |
| 3 | Data regex pattern | `properties.dataPatterns:[{kind:'Regex',pattern}]` |
| 4 | Dictionary (word list) | compiled to a `dataPatterns` `\b(w1\|w2)\b` regex |
| 5 | Minimum % match threshold | `properties.minimumPercentageMatch` (60 default) |
| 6 | Edit / re-save a rule | PUT is create-or-replace (idempotent) |
| 7 | Delete a rule | `DELETE /scan/classificationrules/{name}` |
| 8 | List rules | `GET /scan/classificationrules` |
| 9 | Custom scan rule set including the custom rules | `PUT /scan/scanrulesets/{name}` kind=<source kind> |
| 10 | Define a scan that uses the custom rule set | `PUT /scan/datasources/{ds}/scans/{scan}` (scanRulesetType:'Custom') |
| 11 | Run a scan now | `PUT /scan/datasources/{ds}/scans/{scan}/runs/{runId}` |
| 12 | List sources / scans / runs | `GET /scan/datasources`, `.../scans`, `.../runs` |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | Create rule (guided Fluent dialog: name, classification Dropdown, description) | built ✅ | page.tsx create dialog → POST classifications |
| 2 | Column-name regex | built ✅ | `rulePatterns()` column-name-regex → `upsertCustomClassificationRule` |
| 3 | Data regex | built ✅ | `rulePatterns()` data-regex |
| 4 | Dictionary | built ✅ | `rulePatterns()` dictionary → escaped `\b(...)\b` |
| 5 | Min % match | built ✅ | sync sets `minimumPercentageMatch:60` for data patterns |
| 6 | Edit / re-save | built ✅ | PUT idempotent; "Sync to Purview" re-pushes the taxonomy |
| 7 | Delete | built ✅ | DELETE classifications → `removeClassificationRuleFromPurview` |
| 8 | List rules | built ✅ | GET classifications (Cosmos taxonomy) + `listClassificationRules()` |
| 9 | Custom scan rule set | built ✅ | `upsertScanRuleset` per `DEFAULT_SCAN_RULESET_KINDS` (AdlsGen2, AzureSqlDatabase) |
| 10 | Define a scan | built ✅ | `/api/governance/scans` POST `{define:true,...}` → `upsertScan` |
| 11 | Run scan now | built ✅ | "Run scan now" dialog → POST `{run:true,source,scan}` → `triggerScanRun` |
| 12 | List sources / scans / runs | built ✅ | `/api/governance/scans` GET (existing) |
| — | Purview not provisioned | honest-gate ⚠️ | warning MessageBar names `LOOM_PURVIEW_ACCOUNT` + Data Source Administrator |
| — | UAMI lacks role | honest-gate ⚠️ | error MessageBar surfaces the verbatim 403, Cosmos write preserved |

Zero ❌ rows; zero stub banners. Every control calls a real Purview scan-plane REST endpoint.

## Backend per control

- Add rule → Cosmos `classifications:<tenantId>` write **then** `syncClassificationTaxonomyToPurview` (ensureClassificationDefs + upsertCustomClassificationRule per rule + upsertScanRuleset per kind).
- Sync to Purview → POST `{syncOnly:true}` → re-runs the same sync over all rules.
- Delete rule → Cosmos write + `deleteCustomClassificationRule` + re-sync remaining rules.
- Run scan now → `/api/governance/scans` GET sources → GET scans → POST `{run:true}` → `triggerScanRun` (202).

## Per-cloud

- **Commercial / GCC:** full path. Host `{account}.purview.azure.com`, scan api-version `2022-07-01-preview`.
- **GCC-High:** host `{account}.purview.azure.us` (handled by `purviewBase()` + `isGovCloud()`). Same REST shapes.
- **IL5:** Purview not in audit scope (`catalogPrimary='atlas-aks'`). `LOOM_PURVIEW_ACCOUNT` is unset there → the surface renders the honest gate (rules saved to Cosmos), no scan calls.
- **No Fabric dependency:** the classic Data Map scan plane is Azure-native; works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. Default scan-rule-set kinds (AdlsGen2 + AzureSqlDatabase) target the Azure-native lakehouse/warehouse backends — no OneLake/Fabric kinds.

## Notes / caveats

- Purview custom classification rules are **English-only**; non-Latin regex is passed through and Purview validates it (its error surfaces verbatim — never silently dropped).
- Custom classifications are **not** in any System scan rule set, so the sync builds a CUSTOM scan rule set per source kind and a scan must select `scanRulesetType:'Custom'` to auto-assign them (Purview best-practice).
- Classification names are namespaced `LOOM.<TENANT8>.<CLASSIFICATION>` per Purview's namespacing best-practice.

## Bicep / bootstrap sync

- No new ARM resource (the Purview account already exists in `catalog.bicep`).
- New role need: the Console UAMI must hold **Data Source Administrator** on the root collection. `catalog.bicep` now emits `consolePurviewScanAdminGrant`; the post-deploy bootstrap workflow already grants all four Data Map roles (including `data-source-administrator`) via `grant-purview-datamap-role.sh`.
- No new env var (`LOOM_PURVIEW_ACCOUNT` already wired).
