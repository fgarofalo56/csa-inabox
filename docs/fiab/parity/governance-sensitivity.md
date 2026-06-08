# governance-sensitivity — parity with Microsoft Purview Information Protection (MIP) sensitivity labels (F12)

**Source UI:** Microsoft Purview portal → **Information Protection →
Sensitivity labels** (taxonomy + label distribution / coverage) and the Fabric
item **sensitivity label** experience. Grounded in Microsoft Learn:
- https://learn.microsoft.com/purview/sensitivity-labels
- https://learn.microsoft.com/purview/get-started-with-sensitivity-labels
- https://learn.microsoft.com/fabric/governance/information-protection

**Loom surface:** `app/governance/sensitivity/page.tsx` (+ `GovernanceShell`,
`LoomDataTable`).

## No-Fabric / no-Purview reality

The distribution + coverage view is **derived live from each item's Cosmos
`state.sensitivityLabel`** — no Fabric, no Power BI, no Purview required. Labels
are applied through item editors / the label flyout; this surface reports usage
and links out to the Purview label-management admin for taxonomy editing. Works
with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

## Inventory → Loom coverage → backend per control

| MIP / Information Protection capability | Loom control | Backend per control | Status |
|---|---|---|---|
| Label coverage summary (total / labeled / unlabeled + %) | three stat cards | `GET /api/governance/sensitivity` → Cosmos `workspace-items` (`state.sensitivityLabel`) | ✅ BUILT |
| Label distribution across the estate | clickable label distribution cards (per-label count + share bar, colour-coded by tier) | `/api/governance/sensitivity` (`distribution[]`; standard labels always shown incl. zero) | ✅ BUILT |
| Filter assets by label | click a distribution card → filters the labeled-items table; "Clear filter" | client filter over `items[]` | ✅ BUILT |
| Labeled-asset inventory (item / type / workspace / label) | `LoomDataTable` — Item, Type, Workspace, Label badge, Open | `/api/governance/sensitivity` (`items[]`) → Cosmos | ✅ BUILT |
| Open a labeled asset's editor | per-row "Open" → `/items/{type}/{id}` | client route | ✅ BUILT |
| Tier-coloured label badges (Public→Restricted, Highly Confidential→danger) | colour mapping in cards + table | client `labelColor`/`labelHex` over the MIP tier | ✅ BUILT |
| Manage the label taxonomy (create/edit labels) | "Manage labels in Microsoft Purview" deep-link | links to `purview.microsoft.com/informationprotection/labels` | ✅ BUILT (taxonomy admin is the Purview/M365 compliance plane; deep-linked, not re-implemented) |
| Refresh / re-aggregate | "Refresh" re-runs the aggregation | re-invokes `/api/governance/sensitivity` | ✅ BUILT |
| Apply a label to an asset | (cross-surface) label flyout / item editors write `state.sensitivityLabel`; opt-in Graph `setLabels` / Purview label-on-asset | item-editor PATCH → Cosmos (+ `mip-graph-client` when opt-in) | ✅ BUILT (apply in item editors; reported here) |

**Legend:** ✅ BUILT = real control + real backend today. No honest-gate-only and no MISSING rows — the
coverage/distribution surface is fully Azure-native Cosmos; taxonomy *editing*
is honestly deep-linked to the Purview/M365 compliance plane (the authoritative
owner of the MIP label store), which is parity, not a stub.

## Grade

**A** — live label coverage + distribution + filterable labeled-asset inventory
on real Cosmos, with an honest deep-link to the authoritative MIP taxonomy admin.
No mocks, no Fabric dependency.
