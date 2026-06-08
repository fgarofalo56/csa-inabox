# cosmos-container-settings — parity with Azure Cosmos DB Data Explorer (Scale & Settings + New Container)

Source UI:
- New Container dialog — https://learn.microsoft.com/azure/cosmos-db/nosql/quickstart-portal
- Scale & Settings (Data Explorer) — https://learn.microsoft.com/azure/cosmos-db/set-throughput
- Time to Live — https://learn.microsoft.com/azure/cosmos-db/nosql/time-to-live
- Indexing policy — https://learn.microsoft.com/azure/cosmos-db/index-policy
- Unique keys — https://learn.microsoft.com/azure/cosmos-db/unique-keys
- ARM resource — https://learn.microsoft.com/azure/templates/microsoft.documentdb/2024-11-15/databaseaccounts/sqldatabases/containers

Azure-native default: ARM control plane (`Microsoft.DocumentDB/databaseAccounts`, api 2024-11-15)
via the Console UAMI (DocumentDB Account Contributor, already granted in
`platform/fiab/bicep/modules/landing-zone/cosmos.bicep`). No Fabric dependency.

## Azure feature inventory → Loom coverage

| Capability (portal)                                   | Loom coverage | Backend (real ARM) |
|-------------------------------------------------------|---------------|--------------------|
| New Container — id                                    | ✅ wizard step 1 | container PUT `resource.id` |
| New Container — target database                       | ✅ wizard step 1 dropdown | container PUT path `/sqlDatabases/{db}` |
| New Container — partition key                          | ✅ wizard step 1 | container PUT `resource.partitionKey.paths` |
| New Container — throughput: shared / manual / autoscale | ✅ wizard step 2 | container PUT `options.throughput` / `options.autoscaleSettings.maxThroughput` |
| New Container — indexing mode (consistent / none)      | ✅ wizard step 3 | `resource.indexingPolicy.indexingMode` |
| New Container — included / excluded index paths        | ✅ wizard step 3 (form rows) | `resource.indexingPolicy.includedPaths/excludedPaths` |
| New Container — composite indexes (path + order)       | ✅ wizard step 3 (form groups) | `resource.indexingPolicy.compositeIndexes` |
| New Container — TTL (off / per-item / default seconds)  | ✅ wizard step 4 | `resource.defaultTtl` (omit / -1 / N) |
| New Container — unique keys (create-time only)          | ✅ wizard step 4 (form rows) | `resource.uniqueKeyPolicy.uniqueKeys` |
| Settings — current throughput display                   | ✅ panel Scale | GET `throughputSettings/default` |
| Settings — edit RU/s (manual) live                      | ✅ panel Scale | PUT `throughputSettings/default { throughput }` |
| Settings — edit max RU/s (autoscale) live               | ✅ panel Scale | PUT `throughputSettings/default { autoscaleSettings.maxThroughput }` |
| Settings — manual ↔ autoscale migration                 | ✅ panel Scale | POST `…/migrateToAutoscale` / `…/migrateToManualThroughput` |
| Settings — TTL edit                                     | ✅ panel TTL | PUT container `resource.defaultTtl` |
| Settings — indexing-policy edit (paths + composite)     | ✅ panel Indexing | PUT container `resource.indexingPolicy` |
| Settings — partition key (read-only, immutable)         | ✅ panel (display) | GET container |
| Settings — unique keys (read-only, immutable)           | ✅ panel (display + note) | GET container `resource.uniqueKeyPolicy` |
| Settings — conflict resolution policy                   | ⚠️ honest gate (multi-region write accounts only) | — |

Zero ❌. The only non-built row is the honest conflict-resolution gate, which
applies only to multi-region write accounts (a real Azure prerequisite, not a
Loom shortcut) per no-vaporware.md.

## No raw JSON (loom_no_freeform_config)

Indexing policy and unique keys are built entirely from labelled form rows +
ascending/descending dropdowns in `lib/components/cosmos/cosmos-policy-editors.tsx`.
The client (`indexingPolicyToArm` / `uniqueKeyPolicyToArm` in
`lib/azure/cosmos-account-client.ts`) serialises them to the ARM resource shape —
no JSON textarea anywhere.

## Files

- BFF: `app/api/cosmos/containers/route.ts` (POST extended), `app/api/cosmos/container-settings/route.ts` (GET + PATCH), `app/api/cosmos/container-throughput/route.ts` (GET + PATCH)
- Client: `lib/azure/cosmos-account-client.ts` (`createContainer` extended, `getContainer`, `updateContainerSettings`, `updateContainerThroughput`, `migrateContainerToAutoscale/ToManual`)
- UI: `lib/components/cosmos/cosmos-container-wizard.tsx`, `cosmos-settings-panel.tsx`, `cosmos-policy-editors.tsx`; wired in `lib/editors/cosmos-account-editor.tsx`

## Verification

- `creating a container with autoscale + a composite index + TTL` → POST `/api/cosmos/containers` body carries `maxThroughput`, `indexingPolicy.compositeIndexes`, `defaultTtl`; the wizard then opens the new container's Settings tab which GETs `/api/cosmos/container-settings` → the ARM control-plane shape reflects all three (the receipt).
- `editing throughput changes RU/s live` → panel Scale Save → PATCH `/api/cosmos/container-throughput` → ARM PUT `throughputSettings/default` → re-GET returns the new RU/s, shown in the panel.
