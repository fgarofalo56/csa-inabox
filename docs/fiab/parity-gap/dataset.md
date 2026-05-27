# dataset — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/dataset/new`
**Fabric reference**: ai.azure.com — Data assets (uri_file / uri_folder / mltable)
**Loom screenshot**: `temp/parity/dataset-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/dataset` | 200 | 0 assets in hub scope |
| `POST /api/items/dataset` | wired | — |

Form shows: Scope dropdown (hub) · Project picker · Type filter (all/uri_file/uri_folder/mltable) · New asset form (Name / Type / URI / Version / Description) · Empty list table.

## Phase 3 — Fabric vs Loom

| Fabric element | Loom present? | Severity |
|---|---|---|
| Type filter (uri_file / uri_folder / mltable) | YES | — |
| Project scope picker | YES | — |
| **Browse storage / lake to pick URI** (file browser dialog) | NO — URI is free-text input only | MAJOR |
| **Schema profiler** (column types, sample, sensitivity) | NO | MAJOR |
| **Versions history with diff** | NO — Loom shows table but only when an existing asset is opened | MAJOR |
| **Lineage view** (consumers + producers) | NO | MAJOR |
| **Quality stats / drift / freshness** | NO | MAJOR |
| Tags + properties editor | NO | MINOR |
| Preview button (first 50 rows) | NO | MAJOR — critical for any data-engineering parity claim |

## Functional

- Create asset POSTs to BFF (not executed against real Foundry to avoid creating noise data assets)
- Filter dropdowns are present but only have hardcoded options (no schema-aware filtering)

## Grade — **D**

Backend list + create work. Real Foundry asset surface is rich (browse, schema, versions, lineage, preview); Loom's is basically a URI/metadata form. Multiple BLOCKERs → **D**.
