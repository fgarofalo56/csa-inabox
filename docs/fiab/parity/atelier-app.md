# atelier-app (workshop-app) — parity with the visual low-code app builder (Palantir Workshop)

Source UI: Palantir Workshop (operational low-code apps) · Microsoft Power Apps canvas builder
(https://learn.microsoft.com/power-apps/maker/canvas-apps/getting-started). audit-T51 / audit-T145.

Atelier is CSA Loom's **visual** low-code application builder. It is the home of
the pages / components / data-bindings / actions experience (the Rayfin app type
stays code-first — see the decision in `docs/fiab/parity/rayfin-app.md`). Both
builders share one app-definition schema + store (`lib/apps/app-definition.ts`,
persisted on the Cosmos item's `state.appDef`).

Per `.claude/rules/no-fabric-dependency.md` every binding is Azure-native by
default and the editor works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset:
- ontology-entity components/actions → **Azure Synapse dedicated SQL pool** (TDS).
- semantic-model components → **Azure Analysis Services** (DAX over XMLA), the
  same model a Rayfin app binds.

## Workshop / low-code-builder feature inventory

| Capability                                            | Notes |
|-------------------------------------------------------|-------|
| Multi-page app layout                                 | Pages = screens |
| Component palette (table / metric / text)             | Drop components onto a page |
| Per-component data binding                            | Bind a component to a data source |
| Field-level / measure selection                       | Choose columns / measures / group-by |
| Live data preview in the builder                      | See real rows before publishing |
| Write-back actions (create / update)                  | Operational actions over the data |
| App-creation wizard                                   | Scaffold pages from a data model |
| Bind to a semantic model                              | Model-backed pages |
| Real runtime over the bound data                      | Reads/writes the backing store |

## Loom coverage

| Capability                            | Status | Backend per control |
|---------------------------------------|--------|---------------------|
| Bind a Loom Ontology                  | ✅ built | `POST /api/items/workshop-app/[id]/bind-ontology` (Cosmos + Thread edge) |
| Multi-page layout (add/rename/remove) | ✅ built | `state.appDef.pages` (Cosmos via PATCH) |
| Component palette (table/metric/text) | ✅ built | `state.appDef.pages[].components` |
| Bind component → ontology entity      | ✅ built | dropdown over the bound ontology's object types |
| Bind component → semantic model       | ✅ built | `GET /api/items/rayfin-app/models` + `…/model-objects` (AAS via ARM/XMLA) |
| Field / measure / group-by selection  | ✅ built | dropdown + checkboxes (no JSON) |
| Live preview — ontology entity        | ✅ built | `POST /api/items/workshop-app/[id]/data` (Synapse: SELECT TOP / GROUP BY) |
| Live preview — semantic model         | ✅ built | `POST /api/items/rayfin-app/preview` (AAS DAX SUMMARIZECOLUMNS/ROW) |
| Aggregate (count by columns) view     | ✅ built | `/data` op `aggregate` (Synapse GROUP BY) |
| Write-back action: create             | ✅ built | `POST …/run-action` op `create` (parameterized INSERT, sp_executesql) |
| Write-back action: update             | ✅ built | `POST …/run-action` op `update` (parameterized UPDATE) |
| New-app wizard (page per object type) | ✅ built | client-side generator → `appDef` |
| Legacy v0 (`objectViews`) migration   | ✅ built | `migrateWorkshopState` (zero data loss on open) |
| Honest infra gate (Synapse/AAS unset) | ⚠️ gate | MessageBar names `LOOM_SYNAPSE_WORKSPACE`/`LOOM_SYNAPSE_DEDICATED_DB` / `LOOM_AAS_SERVER_NAME` |
| Deploy as a standalone hosted app     | ⚠️ gate | Runtime is the Loom BFF over Synapse/AAS today (fully functional in-product). A dedicated Container App host reuses `platform/fiab/bicep/modules/admin-plane/app-deployments.bicep` + `container-platform.bicep`; no new env var on the default path. |

Zero ❌. The only non-functional states are honest infra gates.

## Backend / env (Azure-native default, no Fabric)

| Source        | Env vars (already wired)                                  | Bicep module |
|---------------|-----------------------------------------------------------|--------------|
| Synapse SQL   | `LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_DEDICATED_DB`      | `modules/.../synapse*` |
| AAS model     | `LOOM_AAS_SERVER_NAME`, `LOOM_AAS_REGION`                 | `modules/admin-plane/aas-server.bicep` |

No new env var is introduced — the builder reuses the Synapse + AAS wiring that
already powers the warehouse editor and the Rayfin model binding. Gov uses the
sovereign AAS suffix resolved by `lib/azure/cloud-endpoints.ts` (`aasSuffix()`).

## Verification

- `lib/apps/__tests__/app-definition.test.ts` covers the schema, normalization,
  legacy migration, and the Rayfin→Atelier page generator.
- Live E2E (with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET): bind an ontology, add a
  table component bound to an entity, Preview → real Synapse rows (or honest 503
  gate naming the Synapse env var); add a metric bound to an AAS measure, Preview
  → real DAX result (or honest AAS gate); run a create action → real INSERT
  receipt (`recordsAffected`).
