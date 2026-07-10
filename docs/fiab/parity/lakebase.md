# lakebase — parity with Azure Database for PostgreSQL Flexible Server (Databricks-Lakebase-style OLTP)

Source UI: Azure portal PostgreSQL Flexible Server blade + Databricks Lakebase.
Surface file: `apps/fiab-console/lib/editors/lakebase-editor.tsx`
Wave: UX-Wave 3 (UX-301), UX-baseline program. Grade target: C → B/A.

## Baseline bar coverage (docs/fiab/ux-standards.md §2, §7.2 editor checklist)

| # | Bar item | Status | Notes |
|---|----------|--------|-------|
| Ribbon + contextual groups + Copilot | ✅ | `ItemEditorChrome` ribbon (Data / Lifecycle groups); header Copilot button. |
| SC-9 Command search (Ctrl+Q / Alt+Q) | ✅ | `useRegisterRibbonCommands(ribbon, 'lakebase-postgres')` + `commandSearch` on the chrome. |
| SC-6 Teaching banner | ✅ | `TeachingBanner surfaceKey="lakebase-analyze"` (dismiss-persisted) with Learn-more. |
| SC-4 Guided empty state | ✅ | No-server Overview now renders `GuidedEmptyState` (Provision / Bind existing / Ask Copilot / Learn more) — replaces the plain MessageBar. Each path runs a real action. |
| SC-2 Right details panel | ✅ | `DetailsPanel` (Server details): stats (state/version/compute/storage/HA/region/pgvector), copyable **Endpoints** URIs (FQDN, PG connection string, psql command), inline-editable **Configuration** policies (working database, backend) that PATCH the real item route, and Related **Databases** with find-by-name → switch working DB. |
| SC-5 Preview table (type badges + timing bar) | ✅ | Query tab and pgvector kNN search results now render through `PreviewTable` (type-badged columns + "Succeeded (Xs) · Columns N · Rows N" status bar) instead of the ad-hoc `ResultGrid`. |
| Real backend on every control | ✅ | Provision (ARM PUT), query (pg wire protocol), branches (PITR), replicas, pgvector enable/search — all unchanged real BFF calls. |
| Honest gates | ✅ | Databricks-backend gate + query gate preserved as Fluent MessageBars. |
| SC-10 Entity/relationship diagram | ⚠️ | Not built this wave — the editor does not currently fetch table/relationship schema; adding an ER diagram requires a new schema-introspection backend call (out of scope for a UX-lift). Tracked for the SC-10 B-sweep. |
| SC-8 Item-tab strip / cross-links | n/a | Lakebase is a single-editor item with no sibling RTI/ADF surface to cross-link. |

## Backend per control (unchanged — UX lift only)

- Overview / details: `GET /api/items/lakebase-postgres/:id`; policy pencils → `PATCH` (`setDatabase`, `setBackend`).
- Provision: `GET|POST /api/items/lakebase-postgres/:id/provision` (ARM Flexible Server).
- Query / vector: `POST …/query`, `POST …/pgvector` (pg wire protocol).
- Branches / replicas: `POST …/branches`, `POST …/replicas`, `POST …/snapshot`.

## Verification

- `tsc --noEmit` clean; `no-raw-px`, `no-bare-server-fetch`, `check-circular-deps` green.
- Render test `lib/editors/__tests__/lakebase.test.tsx` (chrome + ribbon mount against a bound-server fetch mock).
- Fluent v9 + Loom tokens only; DetailsPanel wraps below the server card on narrow widths (no horizontal overflow); dark + light via shared components.
- Live click-walk (deployed console, `LOOM_DEFAULT_FABRIC_WORKSPACE` unset) pending operator UAT.
