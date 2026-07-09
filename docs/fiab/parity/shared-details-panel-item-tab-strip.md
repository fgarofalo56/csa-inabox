# SC-2 DetailsPanel + SC-8 ItemTabStrip / ToolbarCrossLinks — parity

Source UI: Microsoft Fabric Real-Time Intelligence — Eventhouse / KQL Database
item chrome (right "Database details" panel + item-level tab strip + RTI
toolbar cross-links), captured live in
`PRPs/active/next-waves/fabric-ux-observations.md` §"Eventhouse / KQL Database".

These are UX-Wave 0 shared components (PRP-ux-baseline-program §3, SC-2 + SC-8).
Built once, adopted everywhere. Reference adopters: **eventhouse** editor
(`lib/editors/phase3/eventhouse-editor.tsx`) and **kql-database** editor
(`lib/editors/phase3/kql-database-editor.tsx`).

## Fabric feature inventory (from the live capture)

Right details panel ("Database details"):
- Compressed / original size stats.
- OneLake availability toggle.
- Overview facts: created by/on, region, **Query URI** + **MCP Server URI** with
  Copy buttons, last ingestion, **caching policy + retention policy with inline
  edit pencils**.
- **Related elements** list with **find-by-name**.

Item chrome:
- Item-level **tab strip: Eventhouse | Database** (two related editors in one
  item chrome).
- Toolbar **cross-links to every RTI surface**: Live view, New, Get data, Query
  with code, KQL Queryset, Notebook, Real-Time Dashboard, Data Agent, Operations
  Agent, Data policies, OneLake; "Analyze data with ▾" primary CTA.

## Loom coverage

| Bar row | Coverage | Where |
|---------|----------|-------|
| Right details panel, stat rows (compressed/original size) | ✅ | `DetailsPanel` `StatRow[]` — eventhouse feeds total (compressed) size + table count |
| Copyable **Query URI** with Copy button + Tooltip "Copied" feedback | ✅ | `DetailsPanel` `UriRow` — eventhouse + kql feed the real cluster URI (`clusterUri()`); Copy writes the exact string via `navigator.clipboard` |
| Copyable **connection string** | ✅ | `UriRow` — real ADX `Data Source=<cluster>;Initial Catalog=<db>` |
| Copyable **MCP Server URI** | ✅ component / ⚠️ adopters | `UriRow` supports it generically; the ADX adopters omit it because the shared Loom ADX cluster does not expose a per-database MCP endpoint (no-vaporware: not fabricated). Wired the moment a real MCP URI exists. |
| Copyable **OneLake / ADLS path** | ✅ component | `UriRow` supports it; consumed by lakehouse/OneLake adopters in later waves |
| **Inline-editable caching policy** (pencil → field → PATCH real route) | ✅ | `PolicyRow` `type:'number'` — eventhouse PATCHes `POST /api/items/eventhouse/[id]/policies` (`.alter database policy caching`); kql PATCHes `POST /api/adx/policy-authoring` (`.alter database policy caching`) |
| **Inline-editable retention policy** | ✅ | `PolicyRow` — eventhouse `softDeleteDays`; kql `retention` scope=database |
| Inline-editable **boolean** policy (e.g. OneLake availability) | ✅ component | `PolicyRow` `type:'boolean'` (Switch) + `type:'select'` supported |
| Honest error surfaced inline on PATCH failure, editor stays open | ✅ | `PolicyRowView` renders the caller's `{ ok:false, error }` in a MessageBar |
| **Related elements** with **find-by-name** | ✅ | `DetailsPanel.related` — eventhouse lists sibling databases; kql lists tables / materialized views / functions; `SearchBox` filters by name/kind |
| **Item-level tab strip** (Eventhouse \| Database) | ✅ | `ItemTabStrip` — eventhouse shows Eventhouse\|Database (Database routes to the selected KQL DB); kql shows Eventhouse\|Database |
| **Toolbar cross-links** to sibling RTI surfaces | ✅ | `ToolbarCrossLinks` — Query with code / KQL Queryset / Notebook / Real-Time Dashboard / Data Agent / Operations Agent / OneLake, overflow past `maxInline` collapses into a "More" menu |
| "Analyze data with" primary CTA | ✅ | `CrossLink.primary` (eventhouse "Query with code" primary) |
| OneLake availability **toggle** in the panel | ⚠️ | Available in eventhouse via the existing Policies dialog (`oneLakeAvailability` POST); the panel exposes caching/retention inline, OneLake availability stays in the dialog for this wave |

Zero ❌. Every row is built ✅ or an honest, documented ⚠️.

## Backend per control (real, Azure-native — no Fabric dependency)

- **Query URI / connection string** — read from the live shared ADX cluster
  (`clusterUri()` / `info.cluster`). No `api.fabric.microsoft.com`.
- **Caching / retention inline-edit (eventhouse)** — `POST
  /api/items/eventhouse/[id]/policies` → `.alter database policy caching` /
  `.alter database policy retention` (KQL mgmt commands).
- **Caching / retention inline-edit (kql-database)** — `POST
  /api/adx/policy-authoring?id=<item>` → `setDatabaseCachingPolicy` /
  `setDatabaseRetentionPolicy`; current values read via `GET /api/adx/policies`.
- **Cross-links** — routing-only to existing Loom routes
  (`/items/kql-queryset/new`, `/items/notebook/new`, `/items/kql-dashboard/new`,
  `/items/data-agent/new`, `/items/operations-agent/new`, `/onelake`, and the
  eventhouse `createDashboard` handler). No backend call.

## Contract (die-hard)

`DetailsPanel` is **purely presentational** — it never fetches. Callers pass
typed `sections` (stat / URI / policy rows) and per-policy `onSave` handlers that
PATCH the item's REAL policy route. `ItemTabStrip` / `ToolbarCrossLinks` are
**routing-only**. This keeps every surface Azure-native by construction and
introduces no Fabric dependency (`.claude/rules/no-fabric-dependency.md`), no
raw-JSON config (`loom_no_freeform_config`), and Fluent v9 + Loom tokens only
(`web3-ui.md`, `ux-baseline.md`).

## Files

- `apps/fiab-console/lib/components/shared/details-panel.tsx` (SC-2)
- `apps/fiab-console/lib/components/shared/item-tab-strip.tsx` (SC-8)
- `apps/fiab-console/lib/components/shared/__tests__/details-panel.test.tsx`
- `apps/fiab-console/lib/components/shared/__tests__/item-tab-strip.test.tsx`
- Adopters: `lib/editors/phase3/eventhouse-editor.tsx`,
  `lib/editors/phase3/kql-database-editor.tsx`
