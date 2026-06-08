# governance-classifications — parity with Microsoft Purview classifications & label taxonomy

**Source UI:** Microsoft Purview portal → **Data Map → Classifications** (system
+ custom classification rules) and the **classification / sensitivity taxonomy**
admin. Grounded in Microsoft Learn:
- https://learn.microsoft.com/purview/concept-classification
- https://learn.microsoft.com/purview/create-a-custom-classification-and-classification-rule
- https://learn.microsoft.com/purview/microsoft-purview-connector-overview

**Loom surface:** `app/governance/classifications/page.tsx` (+ `GovernanceShell`,
`LoomDataTable`).

## No-Fabric / no-Purview reality

Loom-native classification taxonomy + rollup — **no Purview required**. The
taxonomy is a tenant-settings doc seeded with a sensible default set (Public /
Internal / Confidential / PII / Restricted); item editors apply these and the
rollup reports usage. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

## Inventory → Loom coverage → backend per control

| Purview capability | Loom control | Backend per control | Status |
|---|---|---|---|
| Classification / label taxonomy list (the tenant's standard labels) | "Label taxonomy" card — swatch + name + sensitivity tier + description rows | `GET /api/governance/classification-types` → Cosmos `tenant-settings` (`classification-types:<tenantId>`, seeded defaults) | ✅ BUILT |
| Create a classification / label (name + sensitivity + colour + description) | "Add label" row — name `Input`, sensitivity `Dropdown` (Public→Restricted), colour picker, description `Input` | `POST /api/governance/classification-types` → Cosmos upsert (idempotent by name) | ✅ BUILT |
| Delete a classification / label | per-row delete `Button` | `DELETE /api/governance/classification-types?id=` → Cosmos | ✅ BUILT |
| Applied-classification rollup (distinct classifications + hit counts) | "Applied classifications" `LoomDataTable` — Classification chip, Hits count, Sample items | `GET /api/governance/classifications` → Cosmos `workspace-items` (`state.classifications`) aggregation | ✅ BUILT |
| Drill into classified assets | sample-item links → `/items/{type}/{id}` (first 3 + "+N more") | client route into item editors | ✅ BUILT |
| Refresh / re-aggregate | "Refresh" reloads both taxonomy + rollup | re-invokes both GET routes | ✅ BUILT |
| Where classifications are applied | (cross-surface) item editors (Lakehouse / Data Product / Semantic Model) write `state.classifications` | item-editor PATCH → Cosmos | ✅ BUILT (applied in item editors; reported here) |

**Legend:** ✅ BUILT = real control + real backend today. No honest-gate-only and no MISSING rows; zero
stub banners — the entire surface is Azure-native Cosmos with no Purview leg.

## Grade

**A** — full taxonomy CRUD + live applied-classification rollup, all on real
Cosmos routes; sortable/filterable `LoomDataTable`; no mocks, no Fabric/Purview
dependency.
