# label-inheritance — sensitivity-label inheritance & propagation (F15, F16, F17)

Source UI: Microsoft Purview Information Protection — label inheritance across
data assets / lineage, and Fabric/Power BI item sensitivity-label inheritance.
Grounded in Microsoft Learn:
- https://learn.microsoft.com/purview/how-to-automatically-label-your-content
- https://learn.microsoft.com/fabric/governance/information-protection
- https://learn.microsoft.com/power-bi/enterprise/service-security-sensitivity-label-inheritance-from-data-sources

CSA Loom implements label inheritance + downstream propagation **Azure-native**,
with **no Microsoft Fabric / Power BI dependency** (see
`.claude/rules/no-fabric-dependency.md`). The lineage graph lives in the Loom
Cosmos store; propagation runs as an Azure Functions timer.

## The three behaviors

| Ref | Behavior | Where |
|-----|----------|-------|
| **F16** | On create, a child item **pre-populates** its sensitivity label from the most-restrictive upstream source it is built from. The caller may **override** with an explicit label. | `app/api/items/_lib/item-crud.ts` → `applyLabelInheritance` (runs inside `createOwnedItem`) |
| **F17** | The semantic-model editor shows the inherited label as a **read-only** "Sensitivity (inherited from upstream)" field, with the upstream source named. | `lib/components/governance/upstream-sensitivity-field.tsx`, wired into the semantic-model editor's governance tab |
| **F15** | A timer **Azure Function** polls the lineage graph every N minutes and writes **downstream propagation state** to Cosmos. The lineage view shows a per-node **propagation-status indicator** from that state. | `apps/fiab-label-propagation` (timer Function) + `app/api/governance/lineage/route.ts` (read) + `app/governance/lineage/page.tsx` (indicator) |

## Propagation rules (canonical)

Labels are ordered **least → most restrictive**:

```
General < Internal < Confidential < Highly Confidential < Restricted
```

Custom (non-standard) labels rank at the bottom (`0`); a missing label is `-1`.

1. An item's **expected** label is the **most restrictive** label among its
   upstream (parent) items' *effective* labels. Propagation is **transitive**
   (grandparent → parent → child).
2. An item's **effective** label = `most-restrictive(its own current label, its
   expected-from-upstream label)`. This is what flows further downstream.
3. **Status** compares the item's CURRENT (stored) label to its EXPECTED label:

   | Status | Meaning |
   |--------|---------|
   | `in-sync` | current == expected (both may be empty) |
   | `pending` | expected is more restrictive than current → propagation needed |
   | `overridden` | current is more restrictive than expected → deliberate manual raise (**allowed**) |
   | `unlabeled` | has upstream, but neither it nor its upstream carries a label |
   | `no-upstream` | root item — nothing to inherit |

4. **Override is always allowed.** An item may be raised ABOVE its upstream
   (`overridden`); propagation never lowers a manually-raised label.
5. The algorithm is pure + deterministic + cycle-safe (Kahn topological order
   with a cycle guard). Canonical implementation +
   tests: `lib/governance/label-propagation.ts` (+ `__tests__`). The standalone
   Function mirrors it in `apps/fiab-label-propagation/src/propagation-core.ts`.

## Lineage edge sources

Inheritance and propagation follow the same typed `state` references the
lineage view uses: `lakehouseId`, `warehouseId`, `datasetId`, `datasourceId`,
`sourceItemId`, `targetItemId`, `sourceLakehouseId`, `sourceWarehouseId`,
`reportId`, `modelId`, `kqlDatabaseId`, `pipelineId`, plus notebook
`attachedSources[].id`.

## Data model

- **Item label**: `item.state.sensitivityLabel` (string). Inheritance also
  records `state.sensitivityLabelInherited` (bool) and
  `state.sensitivityLabelSource = { itemId, displayName, label }`.
- **Propagation state** (Cosmos container `label-propagation`, PK `/tenantId`):
  one row `id = prop:<itemId>` per item — `{ tenantId, itemId, itemType,
  displayName, currentLabel, expectedLabel, status, upstream[], runAt }`.

## Loom coverage

| Capability | State | Backend |
|------------|-------|---------|
| Child inherits parent label on create | ✅ built | `createOwnedItem` → Cosmos read of upstream item |
| Explicit override honored, marked non-inherited | ✅ built | `applyLabelInheritance` |
| Most-restrictive across multiple parents | ✅ built | `computePropagation` |
| Read-only inherited-label field on semantic model | ✅ built | `GET /api/governance/label-propagation/<itemId>` |
| Downstream propagation engine (timer) | ✅ built | `apps/fiab-label-propagation` (Functions timer) → Cosmos upsert |
| Lineage propagation-status indicator | ✅ built | lineage route reads `label-propagation` + live overlay |
| Per-node status + last-run provenance in lineage detail | ✅ built | `app/governance/lineage/page.tsx` |

Zero ❌. The lineage indicator computes **live** so it is never empty before the
first timer run, and **merges** the persisted state's `runAt` for real
last-propagated provenance once the Function has run.

## Backend per control

- F16 inheritance — Cosmos `items`/`workspaces` read (tenant-scoped) inside
  `createOwnedItem`. No external service.
- F17 read-only field — `GET /api/governance/label-propagation/<itemId>` →
  live `computePropagation` over the tenant graph + Cosmos `label-propagation`
  `runAt`.
- F15 engine — `apps/fiab-label-propagation` reads Cosmos `workspaces`+`items`,
  upserts `label-propagation`. Identity: Function system identity holding Cosmos
  DB Built-in Data Contributor (granted by `grant-navigator-rbac.sh`).

## Infra (bicep-synced)

- Cosmos container `label-propagation` — created lazily by
  `lib/azure/cosmos-client.ts` (`labelPropagationContainer`) and listed in
  `KNOWN_CONTAINER_IDS`.
- Function App — `platform/fiab/bicep/modules/admin-plane/label-propagation-function.bicep`,
  wired into `modules/admin-plane/main.bicep` behind `labelPropagationEnabled`
  (default on; no-op without a Cosmos account). App settings
  `LOOM_COSMOS_ENDPOINT`, `LOOM_COSMOS_DATABASE`, `LABEL_PROPAGATION_CRON`.
- Post-deploy RBAC — `scripts/csa-loom/grant-navigator-rbac.sh` grants the
  Function identity Cosmos DB Built-in Data Contributor.

## Verification

- Unit: `lib/governance/__tests__/label-propagation.test.ts` (8),
  `app/api/items/_lib/__tests__/label-inheritance.test.ts` (5),
  `apps/fiab-label-propagation/src/propagation-core.test.ts` (parity mirror).
- Live: create a report on a `Confidential` semantic model → the report inherits
  `Confidential` (read-only + override option); raise the model to `Restricted`
  → lineage shows the report `pending` until the next timer cycle, then `in-sync`
  with a real `runAt`. With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET (Azure-native
  default), all three behaviors function against Cosmos only.
