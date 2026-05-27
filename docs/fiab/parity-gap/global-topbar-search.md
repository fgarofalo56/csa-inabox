# Global parity gap: Topbar search + Ctrl+K command palette

**Validated**: 2026-05-26  
**Surface**: Search input in top bar + Ctrl+K palette  
**Components**:  
  - `apps/fiab-console/lib/components/topbar-search.tsx`  
  - `apps/fiab-console/lib/components/command-palette.tsx`  
**Fabric reference**: Fabric search returns real items (workspaces, lakehouses, notebooks, reports) from tenant index. Ctrl+K opens command palette over items.  
**Backend probed**: `GET /api/search/items` exists (per app spec) but **is never called by either component**

## What renders

- Top-bar input: pill-shaped, dark-purple bg, placeholder "Search items, settings, item types…   (press / )", `Ctrl K` shortcut badge on right
- Click input → opens CommandPalette dialog prefilled with whatever was typed
- Press `/` while not focused on input → focuses topbar input
- Press `Ctrl+K` → opens CommandPalette
- CommandPalette is a `Dialog` with `[role="listbox"]` and grouped sections (Navigation / Admin / Create)

## Functional probes (auth'd)

- Typed "uat-sqldb" into palette (the user's REAL item visible in Home → Recent) — palette returned "No matches"
- Typed "notebook" → 1 match: "New notebook" → routes to `/items/notebook/new` (a static catalog entry, NOT real notebooks)
- **ZERO calls to /api/search/items** captured during typing (verified via browser_network_requests filter)
- Palette items come from `PAGES` static array + `FABRIC_ITEM_TYPES` catalog (in-memory filter only)

## What's broken

The palette is a **glorified launcher** — it filters in-memory lists of static "navigation entries" and "create X" actions. It does NOT search Cosmos `items` container, does NOT call AI Search, does NOT call `/api/search/items`.

This is a **vaporware violation per `.claude/rules/no-vaporware.md`** for a search surface — the input claims "Search items, settings, item types" but it only searches the catalog of item TYPES, not actual items in the tenant.

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| Top-bar search input | YES | — | Visible, styled, contrast OK |
| Ctrl+K opens palette | YES | — | Works |
| `/` focuses search | YES | — | Works |
| Search **real items by name** | **NO** | **BLOCKER** | "uat-sqldb" returns "No matches" despite being a real item |
| Search settings | PARTIAL | MAJOR | Admin subpages (Tenant settings, Capacity, etc.) match by label |
| Search item TYPES | YES | — | Creates "New lakehouse" etc. entries |
| Group headers | YES | — | Navigation / Admin / Create |
| Arrow keys nav | YES | — | Up/down/Enter |
| Recent searches | NO | MINOR | Fabric has this |

## Grade: **D**

Visual is parity. Functional is vaporware — the search doesn't search real items. Per `no-vaporware.md`, a fix requires either (a) wire the palette to `/api/search/items` (Cosmos query + optional AI Search fallback) and return real lakehouses/notebooks/reports/etc., or (b) honest MessageBar in palette saying "Item search not wired — use OneLake catalog for item discovery."
