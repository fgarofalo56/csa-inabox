# Loom Variable Library Editor — Fabric-parity build spec

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


> Reference: Microsoft Learn — *What is a variable library?* (`/fabric/cicd/variable-library/variable-library-overview`), *Variable types in variable libraries* (`/fabric/cicd/variable-library/variable-types`), *Value-sets in variable libraries* (`/fabric/cicd/variable-library/value-sets`), *Item reference variable type (preview)* (`/fabric/cicd/variable-library/item-reference-variable-type`), *Variable library permissions* (`/fabric/cicd/variable-library/variable-library-permissions`), *Variable library CI/CD* (`/fabric/cicd/variable-library/variable-library-cicd`), *Variable library definition* (`/rest/api/fabric/articles/item-management/definitions/variable-library-definition`), *Automate variable libraries by using APIs* (`/fabric/cicd/variable-library/automate-variable-library`). Documented 2026-05-26 by catalog agent.

## Overview

A Fabric **Variable Library** is a workspace-scoped item that holds named configuration parameters consumed by other items in the same workspace — pipelines, notebooks, dataflows Gen2, shortcuts, and Spark Job Definitions. The library solves two problems: (1) **share** a single configuration value across many items in a workspace (one shortcut data-source URL, many lakehouses point at it), and (2) **vary** that value by deployment stage (dev/test/prod) without editing the consuming items. Exactly one **value set** is "active" per workspace at runtime; deployment pipelines flip the active set as part of promoting to the next stage.

The library is created from **New item → Develop data → Variable library**. It opens with a left-rail of value sets (`Default`, plus any alternative sets) and a central variables grid. A user can switch the displayed value set, edit per-variable values for that set, and mark one as the workspace's active set.

## Fabric Variable Library UX inventory

### Page chrome
- Page title shows the library name (editable inline)
- Capacity badge, workspace breadcrumb, global action bar
- Top-right: **Save**, **Share**, **Comments**, **Settings** (controls active value set and item-level options)

### Left-rail — value sets
| Element | Purpose |
|---|---|
| `Default` value set (always present, can't be renamed/deleted) | Holds the canonical value for each variable |
| `+ New value set` button | Creates an alternative set (e.g. `dev`, `test`, `prod`) |
| Per-set context menu | Rename · Delete · Set as active for this workspace |
| Active-set chip | Marks which value set the workspace currently resolves at runtime |

Naming rules: not empty, no leading/trailing spaces, starts with letter or underscore, only letters/digits/underscores/hyphens, ≤256 chars, unique within library.

### Main grid — variables
| Column | Behavior |
|---|---|
| **Name** | Variable name, unique within library, case-sensitive |
| **Type** | Dropdown: `String` · `Integer` · `Number` · `Boolean` · `DateTime` (ISO 8601) · `Guid` · `Item reference` (preview, advanced) · `Connection reference` (preview, advanced) |
| **Value (`{activeSetName}`)** | Editor varies by type — text input, number spinner, toggle, ISO datetime picker, GUID input, or "..." picker for item/connection reference |
| **Note** | Free-form description, ≤2,048 chars |
| **Row actions** | Delete · Duplicate |

A consent dialog appears when changing the type of a variable that already has values — the change resets all values across all sets and is flagged as a potential breaking change for consumers.

### Item-reference picker (advanced type, preview)
Opens a dialog listing every Fabric item the caller has read on, scoped by left-side workspace tree + top-right item-type filter. Selecting an item stores `{ workspaceId, itemId }`. Different value sets may point to different items of the same type (e.g. `Lakehouse_Dev` vs `Lakehouse_Prod`).

### Connection-reference picker (advanced type, preview)
Same pattern but stores a connection ID for an external data connection (Snowflake, Azure SQL, etc.) so consumers can resolve credentials without embedding strings.

### Value set tabs (top of grid)
- One tab per value set
- Active-set tab is highlighted with an "Active" badge
- Empty cells in an alternative set inherit from `Default`; only diverging values are persisted in that set's JSON file

### Settings flyout
- **Active value set** (per workspace) — radio list of all sets
- **Read-only from notebooks** banner (informational — notebooks consume but can't mutate)
- **Size limits** indicator — up to 1,000 variables and 1,000 value sets per library; max 10,000 cells; 1 MB total payload

### Downstream consumption surfaces
| Consumer | How it references a variable |
|---|---|
| Data Pipelines | `Library variables` tab → `+ New` → pick `{library, variable, type}`; reference as `@pipeline().libraryVariables.NAME` |
| Notebooks | `notebookutils.variableLibrary.getLibrary("name").variableName` (Python/Scala/R) or `notebookutils.variableLibrary.get("$(/**/lib/var)")` |
| Dataflow Gen2 (CI/CD) | Reference inside `mashup.pq` only; basic types only; no connection mutation; no schema-mapping mutation |
| Shortcuts | `Manage shortcut` → Edit target → Assign variable to a property (connection ID, target location) |

### Permissions
Aligned with workspace roles — Viewer reads, Contributor edits, Member/Admin edit + reshare. Item-reference variables additionally require read permission on the referenced item; missing perms don't fail consumers but suppress extended metadata. There's no per-variable permission — the library is the unit.

### Git integration
On commit, the library serializes as a folder containing:
- `variables.json` — variable definitions + default values
- `settings.json` — library-level settings (active value set name, etc.)
- `valueSets/{name}.json` — one file per alternative set, containing only diverging values
- `.platform` — auto-generated item-platform metadata

## What Loom has today

Loom's `VariableLibraryEditor` (`apps/fiab-console/lib/editors/phase4-editors.tsx` line 552) is **C-grade** — renders, saves to Cosmos, but doesn't match Fabric semantics:

- Variable types limited to `string | number | bool | secret-ref` — missing `Integer`, `DateTime`, `Guid`, `ItemReference`, `ConnectionReference`
- Value sets hard-coded to four tabs: `default | dev | test | prod` — no rename, no add, no delete, no per-workspace "active" toggle
- No `note` column on variables
- No per-variable type-change consent dialog
- No item-reference picker; no connection-reference picker
- No size-limit enforcement, no settings flyout
- No git-shape serialization (Loom persists a single Cosmos doc — not the `variables.json` / `valueSets/{name}.json` shape)
- No downstream consumption wiring — Loom's notebook, data-pipeline, and dataflow editors don't have a `Library variables` tab to bind a variable to an activity input
- Single `default` field on each variable plus optional `dev/test/prod` strings — values are always strings even for `bool` and `number`

## Gaps for parity

1. **Expand the type system** to the seven Fabric types: `String`, `Integer`, `Number`, `Boolean`, `DateTime`, `Guid`, `ItemReference`, `ConnectionReference`. Render type-specific editors (number spinner, toggle, ISO datetime, GUID input).
2. **Dynamic value sets** — remove the hard-coded `dev/test/prod` tabs. Add **`+ New value set`** button. Per-tab context menu: Rename, Delete (blocked if active), Set as active. Persist the workspace's active set on the workspace document (`workspace.state.activeValueSetByLibraryId[libraryId] = setName`).
3. **Active-set indicator** — chip on the active value-set tab + Settings flyout radio list to switch.
4. **`Note` column** — 2,048-char description per variable.
5. **Type-change consent dialog** — when a user changes a variable's type and values exist, prompt + reset all sets' values for that variable.
6. **Item-reference picker** — dialog listing Loom catalog items, workspace tree on left, item-type filter on right. Persist `{ workspaceId, itemId }`. Validate read-perm on save.
7. **Connection-reference picker** — list APIM/data-product connections + external connections registered in Loom. Persist connection ID.
8. **Size limits** — enforce ≤1,000 variables, ≤1,000 value sets, ≤10,000 cells, ≤1 MB payload; surface a MessageBar at 80% capacity.
9. **Git-shape serialization** — on save, project Cosmos doc into the four-file structure (`variables.json`, `settings.json`, `valueSets/{name}.json`, `.platform`) so a future Fabric-Git mirror can round-trip.
10. **Downstream `Library variables` panel** in consuming editors (pipeline, notebook, dataflow, SJD) — picker that binds a consumer parameter to `{library, variable}`. At run time, the executor resolves through the workspace's active value set.
11. **Notebook NotebookUtils stub** — emit a `notebookutils.variableLibrary.getLibrary(name)` shim in the Loom-managed Spark session that hits a Loom resolve endpoint instead of Fabric.
12. **Permission enforcement** — restrict edit operations to Contributor+, surface missing item-reference reads on the row.
13. **Naming validation** — enforce the value-set naming rules and uniqueness checks client-side and server-side.

## Backend mapping

| Fabric concept | Loom backend |
|---|---|
| Create variable library | ✅ `/api/items/variable-library` (Cosmos CRUD via item-crud lib) |
| Get / Update library | ✅ `/api/items/variable-library/[id]` GET / PUT |
| Variables collection | **EXTEND** `state.variables[] = { name, type, note, defaultValue }` — type widened to the seven Fabric types |
| Value sets | **NEW** `state.valueSets = { Default: {...overrides}, dev: {...overrides}, ... }` — `Default` always present; only diverging values stored in alternative sets |
| Active value set (per workspace) | **NEW** persist `workspace.state.activeValueSet[libraryId] = setName` on the workspace document |
| Item reference value | **NEW** stored as `{ workspaceId, itemId }`; picker reads from Loom catalog `/api/items/list` |
| Connection reference value | **NEW** stored as connection ID; picker reads from APIM connections + external-connection registry |
| Resolve variable at runtime | **NEW** `GET /api/items/variable-library/[id]/resolve?valueSet={name}` returns `{ name: resolvedValue }` map for a given set (defaults to active set) |
| Bind consumer to variable | **NEW** consumers persist `{ libraryId, variableName }` references; resolve at submit/run time |
| Git serialization | **NEW** `GET .../[id]/git-shape` projects Cosmos doc to the four-file structure (read-only export for now); roundtrip deferred |
| Permissions | **EXTEND** Loom RBAC — viewer/contributor/member/admin map to existing workspace-role gate |
| Size limits | **NEW** server-side validation in PUT handler |

## Required Azure resources

- ✅ Loom Cosmos `items` container (already)
- ✅ Loom workspace document (already) — needs `state.activeValueSet` sub-doc
- **NEW** No new Azure resource needed for v1 — variable resolution is in-process on the BFF. v2 (when notebook/Spark session integration lands) needs the same Spark/Synapse infra Loom already provisions.
- **Optional** Azure Key Vault — if `ConnectionReference` resolves to a secret-bearing connection, the BFF can mint a KV-backed reference instead of returning a raw string. KV is already in the Loom bicep.

## Estimated effort

**2 focused sessions.**

- **Session 1 (~2.5h):** Backend — widen type system, dynamic value sets, active-set persistence on workspace, item-reference + connection-reference resolvers, size-limit validation, resolve endpoint, git-shape export. Cosmos schema migration to `valueSets` map.
- **Session 2 (~2.5h):** Frontend rebuild — dynamic value-set tabs (add/rename/delete/active toggle), type-specific value editors, item-reference picker dialog, connection-reference picker dialog, consent dialog on type change, settings flyout, downstream `Library variables` tab stub in pipeline/notebook editors. UAT harness coverage + A11y audit.

Drops Loom Variable Library from **C** (saves, but partial type system + hard-coded sets) to **A** (full Fabric type fidelity, dynamic sets, active-set switching, downstream binding).
