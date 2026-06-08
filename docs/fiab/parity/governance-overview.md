# governance-overview — parity with Microsoft Purview governance landing / OneLake Catalog Govern (posture)

**Source UI:** Microsoft Purview portal landing + Unified Catalog **health /
posture** view, and the Fabric **OneLake Catalog → Govern** tab. Grounded in
Microsoft Learn:
- https://learn.microsoft.com/purview/unified-catalog
- https://learn.microsoft.com/purview/unified-catalog-data-health-management
- https://learn.microsoft.com/purview/unified-catalog-reports
- https://learn.microsoft.com/fabric/governance/onelake-catalog-govern

**Loom surface:** `app/governance/page.tsx` (the `/governance` landing), built on
`PageShell`, `Section`/`Toolbar`, `LoomDataTable`, `ItemTile`/`TileGrid`,
`PurviewGate`, `ActivityFeedPane`.

## No-Fabric / no-Purview reality

The landing page is **100% functional with `LOOM_DEFAULT_FABRIC_WORKSPACE`
UNSET and no Purview account**. Every posture number is derived live from the
Cosmos catalog + audit log via `/api/governance/insights`. The only
Purview-touching control is the **connection chip** (`PurviewGate`), which
renders the honest infra-gate (env var + bicep module + roles) when Purview is
absent or cross-cloud — the rest of the page still renders fully.

## Inventory → Loom coverage → backend per control

| Purview / OneLake-Govern capability | Loom control | Backend per control | Status |
|---|---|---|---|
| Governance posture KPIs (estate size, sensitivity & classification coverage, active policies, audit volume) | Posture stat cards: Governed items, Sensitivity coverage %, Classification coverage %, Active policies, Audit events (30d) | `GET /api/governance/insights` → Cosmos `workspace-items` + `audit-log` aggregates | ✅ BUILT |
| Microsoft Purview connection / health status | `PurviewGate` chip (live / not-configured / cross-cloud) | `GET /api/governance/purview/status` → `probePurview()` | ✅ BUILT (honest gate ⚠️ when unbound — full page still renders) |
| Coverage-by-asset-type report (per-type labeled / classified) | "Coverage by item type" — sortable / resizable / filterable `LoomDataTable` + list/tile `ViewToggle` | `GET /api/governance/insights` (`coverage[]`) → Cosmos | ✅ BUILT |
| Most-governed / curated assets highlight | "Most-classified items" recognition tiles (per-type icon, classification badges, count) | `GET /api/governance/insights` (`topClassified[]`) → Cosmos | ✅ BUILT |
| Left-nav into every governance surface (Catalog mgmt / Discovery / Data Map / Health) | "Governance framework" section grid mirroring the Purview left nav, capped `Toolbar` search filter, keyboard-navigable cards | client-side router to `/governance/*`, `/catalog/*`, `/admin/*` surfaces | ✅ BUILT |
| Tenant activity / recent governance events | "Recent activity" feed (audits, comments, shares) | `ActivityFeedPane` → `GET /api/activity` → Cosmos `audit-log` | ✅ BUILT |
| Learn / docs entry point | "What is the Unified Catalog?" Learn deep-link | static link to learn.microsoft.com | ✅ BUILT |

**Legend:** ✅ BUILT = real control + real backend today. ⚠️ honest-gate = the
full UI renders; the one Purview-dependent control names the exact one-time fix.
No MISSING rows, no stub banners, no dead controls.

## Grade

**A** — every control on the landing page calls a real Cosmos-backed route; the
single Purview leg degrades to an honest, named gate without breaking the page.
Web-3.0 spaced cards + sortable/filterable table per `ui-web3-guide.md`.
