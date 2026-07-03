# Eventhouse — Parity gap (validator verdict 2026-05-26)

**Grade: C (one BLOCKER + multiple MAJORs)**

Validator: v2 4-phase live-browser + source-code review.

Loom URL:
`https://<your-console-hostname>/items/eventhouse/79e38fe3-7cd2-47ee-b0ea-7a80bc999891`

Loom screenshot: `temp/parity/eventhouse-loom.png` (full-page; captured during a
brief render window — note the Loom tab-strip carousel rapidly cycles back to
other tabs, but the editor body itself was probed via direct DOM evaluation +
source-code review). Reference UX from `docs/fiab/eventhouse-parity-spec.md`.

## Phase 1 — Fabric reference (from spec)

System overview pane (storage metrics, system resources, top users, ingestion
rate, top queried + ingested DBs, "What's new"). Per-database management:
**Tables view** as Cards or List with per-table metadata (compressed size, last
ingestion, OneLake availability toggle, row count, original size, retention,
caching policy, creation date, creator). Data preview (top records). Query
insights pane (duration percentiles, cache hit, top queries by metric).
OneLake integration (availability sync seconds, mirrored schema, query
acceleration policies, OneLake cache vs standard, sync status). NL2KQL Copilot.

## Phase 2 — Loom under test (live)

Card grid showing KQL databases under the cluster. Each card shows database
**name only** (plus optional prettyName, plus a `default` badge when matching
defaultDatabase). One toolbar: Refresh + "New KQL database" button (opens a
Dialog with a name field). That's the entire editor.

Source confirmation: `apps/fiab-console/lib/editors/phase3-editors.tsx` lines
161-270. State shape: `{ ok, cluster, defaultDatabase, databases:[{name, prettyName, persistentStorage}], error }`.

Backend probe (live):
- `GET /api/items/eventhouse/79e38fe3-…` → 200 with real cluster URI
  `https://adx-csa-loom-shared.eastus2.kusto.windows.net` and one DB
  `loomdb-default`.
- `POST /api/items/eventhouse/79e38fe3-…/database {name:"parity_test_db"}` →
  200 with real ARM resource ID
  `/subscriptions/363ef5d1-…/Microsoft.Kusto/Clusters/adx-csa-loom-shared/Databases/parity_test_db`
  and `provisioningState: Creating`. **Real ARM provisioning.**

## Phase 3 — Side-by-side gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| System overview pane (storage metrics, ingestion rate, top users) | **Missing** | **BLOCKER** for parity (this is the default Fabric landing pane for an Eventhouse) |
| List of child KQL databases | Present — card grid with name + default badge | (positive) |
| Create new KQL database dialog | **Present** — name input → real ARM POST | (positive, A-grade plumbing) |
| Per-database rich metadata (compressed size, retention, caching, OneLake availability, row count, original size, creation date, creator) | Missing — only name shown on card | MAJOR |
| Per-table data preview (top records inline) | Missing | MAJOR |
| OneLake availability toggle per table (ADX `.alter table ... policy onelake_availability`) | Missing — ribbon label only, no action | MAJOR |
| Query insights pane (duration percentiles, cache hit, top queries) | Missing | MAJOR |
| NL2KQL Copilot inline | Missing | MAJOR |
| Capacity metrics integration (CU usage, billing) | Missing | MINOR (admin Azure resources page covers some) |
| Materialized views / Functions / Data streams / Shortcuts sub-trees | Missing | MAJOR |
| Cards or List layout toggle | Missing | MINOR |
| Ribbon tabs (Home with New / Query / Manage groups) | Present | (positive) |
| Honest MessageBar for missing OneLake / capacity infra | Missing — buttons appear functional but do nothing | MAJOR (per `no-vaporware.md`) |

## Phase 4 — Functional click-every-button verification

| Loom control | Result |
|---|---|
| `GET /api/items/eventhouse/{id}` | 200, real cluster + DB list |
| **New KQL database** dialog → Create | `POST /api/items/eventhouse/{id}/database` → 200, real ARM provisioning. **PRIMARY ACTION WORKS** |
| Refresh button | Re-fetches the cluster state |
| Ribbon: New KQL database / New dashboard / Query with code / Get data / Data policies / OneLake availability | **No-op** — labels render but no click handlers bound (ribbon definitions are static labels). **BROKEN** (silently dead) |
| Database card click | No detail pane opens; just visual hover effect. **BROKEN-ish** (Fabric clicks open the per-DB view) |

## Verdict

**C-grade**. Real backend, real ARM provisioning works (good plumbing on the
narrow primary path). But:
- No system overview pane → **BLOCKER** for full parity
- Per-table management (metadata, OneLake toggle, query insights) entirely missing
- Ribbon buttons silently dead → BROKEN per `no-vaporware.md`
- No drill-down from DB card to its tables/views/functions

Catalog spec correctly identified gaps 1-6. Backend exists; UI work to
surface metrics + policy controls remains.

## Required for ≥ B grade

1. System Overview pane on the editor body when no DB is selected, with ADX
   `.show cluster details` + diagnostic-metric reads for ingestion rate / top
   queries. Cite the bicep that deploys diagnostic settings.
2. Clicking a DB card drills into a per-DB view showing tables (with each
   table's metadata: compressed size, retention, OneLake toggle, row count).
3. Wire the ribbon buttons:
   - `New KQL database` → already-working dialog
   - `New dashboard` → spawns a kql-dashboard item in the same workspace
   - `Query with code` → opens a kql-queryset
   - `Get data` → opens the GetData workflow (ADX `.ingest` + sample data)
   - `Data policies` → opens an ADX policy editor (retention/caching/update)
   - `OneLake availability` → toggle that issues `.alter table T policy onelake_availability`
4. For any of the above that aren't yet deployed in the Loom instance, surface
   the honest MessageBar gate per `no-vaporware.md`.

Estimated effort: 2-3 sessions for the UI work (backend already exists per
catalog).

## Evidence

- Live API calls (validator run):
  - `GET /api/items/eventhouse/79e38fe3-…` → 200 (real cluster URI, real DB list)
  - `POST .../database` → 200 (real ARM provisioning, resource ID returned)
- Source code: `apps/fiab-console/lib/editors/phase3-editors.tsx` lines 144-270.
- Screenshot: `temp/parity/eventhouse-loom.png`.
