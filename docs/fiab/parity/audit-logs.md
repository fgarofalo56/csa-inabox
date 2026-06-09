# audit-logs — parity with Azure Monitor + Microsoft Purview Audit

Source UI:
- Azure Monitor → Logs (Log Analytics) — https://learn.microsoft.com/azure/azure-monitor/logs/log-analytics-overview
- Microsoft Purview Data Map → Audit / "Data Map history" — https://learn.microsoft.com/purview/data-map-history
- Microsoft Fabric / OneLake audit events surface in the Microsoft 365 / Purview audit log

CSA Loom's "Audit logs" page (F19) is the unified audit viewer. It does NOT
require a real Microsoft Fabric or Power BI tenant: the Azure-native default is
the Cosmos `audit-log` container plus Azure Monitor (Log Analytics) and Purview
Data Map audit. Fabric/Power BI events, if a tenant opts in, would arrive via
the same Purview/M365 audit plane — never on the default code path.

## Azure / Purview feature inventory (grounded in Learn)

| # | Capability (real UI)                                            | Source surface                          |
|---|-----------------------------------------------------------------|-----------------------------------------|
| 1 | Time-range scoped query (last hour / 24h / 7d / 30d / custom)   | Azure Monitor Logs time picker          |
| 2 | Filter by user / actor (UPN)                                    | Purview audit `userId`; LA `where`      |
| 3 | Filter by activity / operation type                            | Purview `operationType`; Cosmos `kind`  |
| 4 | Filter by target item / asset (GUID / resource id)             | Purview `guid`; Cosmos `itemId`         |
| 5 | Free-text keyword search                                       | Purview `keywords`; LA contains         |
| 6 | Tabular result grid (time, actor, activity, target, change)    | Azure Monitor Logs results grid         |
| 7 | Sort / resize / per-column filter                              | Azure Monitor Logs grid                 |
| 8 | Source / provider column                                       | M365/Purview unified audit "Workload"   |
| 9 | Export results to CSV                                          | Azure Monitor "Export → CSV"            |
| 10| Honest gate when the audit plane is not provisioned            | n/a (Loom infra-gate requirement)       |
| 11| Governance event categories (Asset / Glossary / Classification)| Purview Data Map audit categories       |

## Loom coverage

| # | Capability                          | Status | Notes |
|---|-------------------------------------|--------|-------|
| 1 | Time-range picker                   | built ✅ | `since` dropdown → `startTime`/`timespan` on all 3 sources; `until` upper-bound supported by the route. |
| 2 | User (UPN) filter                   | built ✅ | `User (UPN)` Input → `user=` → `queryAuditLog({userId})` + `queryLoomAppEvents({user})` + Cosmos `who` filter. |
| 3 | Activity / kind filter              | built ✅ | `Event type` Dropdown → `type=` → Purview `operationType`, LA `eventType`, Cosmos `kind`. |
| 4 | Item / asset filter                 | built ✅ | `Item / Asset ID` Input → `itemId=` → Purview `guid`, LA `itemId`, Cosmos `itemId`. |
| 5 | Free-text search                    | built ✅ | Toolbar search → `q=` → Purview `keywords`, Cosmos multi-field filter. |
| 6 | Result grid                         | built ✅ | `LoomDataTable` over merged rows (When / Who / Kind / Source / Target / Change). |
| 7 | Sort / resize / per-column filter   | built ✅ | Provided by `LoomDataTable`. |
| 8 | Source column                       | built ✅ | Fluent `Badge` per row: Cosmos / Purview / Log Analytics. |
| 9 | Export CSV                          | built ✅ | `Export CSV` button → `toCsv` (at, who, kind, source, itemId, key, from, to, category). |
| 10| Honest gate                         | built ✅ | Per-source `gates.purview` / `gates.la` MessageBars (`intent="warning"`) naming the env var / role; Cosmos rows still render. |
| 11| Governance categories               | built ✅ | Purview `category` carried through to CSV + row detail. |

Zero ❌, zero stub banners.

## Backend per control

| Control                  | Backend call                                                                 |
|--------------------------|------------------------------------------------------------------------------|
| Page load / Refresh      | `GET /api/admin/audit-logs` → `Promise.allSettled` over 3 sources            |
| Cosmos rows (primary)    | `auditLogContainer()` cross-partition SQL `SELECT TOP @top … ORDER BY c.at`  |
| Purview rows             | `queryAuditLog()` → `POST {base}/datamap/api/audit/query?api-version=2023-10-01-preview` |
| Log Analytics rows       | `queryLoomAppEvents()` → `queryLogs()` → `POST {LA}/v1/workspaces/{id}/query` (KQL `AppTraces | where customDimensions.source == "loom-audit"`) |
| Time / user / kind / item filters | forwarded as query params to all three source functions             |
| Export CSV               | client-side `Blob` from already-fetched rows                                 |

## Per-cloud behavior

| Cloud      | Purview audit host                         | LA query host                  | Effective behavior |
|------------|--------------------------------------------|--------------------------------|--------------------|
| Commercial | `{account}.purview.azure.com`              | `api.loganalytics.azure.com`   | All three sources live. |
| GCC        | Commercial endpoints (`isGovCloud()=false`)| `api.loganalytics.azure.com`   | Full parity. |
| GCC-High   | `{account}.purview.azure.us`               | `api.loganalytics.us`          | Full parity (TLD swap, already bicep-wired). |
| IL5 / DoD  | Purview not deployed → `gates.purview`     | `api.loganalytics.us`          | Cosmos + LA rows; honest Purview gate, no fabricated data. |

## Honest-gate wiring

- `LOOM_PURVIEW_ACCOUNT` unset → `PurviewNotConfiguredError` → yellow MessageBar.
- UAMI lacks a Data Map role (401/403) → `PurviewError` → MessageBar pointing at
  `scripts/csa-loom/grant-purview-datamap-role.sh` (ROLE=data-reader). The
  `consolePurviewAuditNote` output in `catalog.bicep` documents this grant.
- `LOOM_LOG_ANALYTICS_WORKSPACE_ID` unset → `MonitorNotConfiguredError` → yellow
  MessageBar. Env var is already wired in `admin-plane/main.bicep`.

## Verification

- `npx tsc --noEmit` clean on `route.ts`, `page.tsx`, `purview-client.ts`,
  `monitor-client.ts`, and `admin-routes.test.ts`.
- Vitest contract tests in
  `app/api/admin/__tests__/admin-routes.test.ts` cover: Cosmos-only rows with a
  `source` badge, dual honest gates when Purview + LA are unconfigured,
  three-source merge + DESC sort, user/itemId filter forwarding, and the
  primary-Cosmos-failure 500 path. (Vitest is not installed in the shared
  worktree store; tests are type-checked via tsc per the repo's known harness
  gap — run `pnpm --filter fiab-console test` in a full install to execute.)
