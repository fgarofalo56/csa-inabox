# rayfin-app — parity with Microsoft Fabric Apps (Rayfin) + model-bound apps

Source UI: https://learn.microsoft.com/fabric/apps/overview · https://github.com/microsoft/rayfin
Build 2026 references: Rayfin code-first BaaS (general case) + #28 "build web apps backed by semantic models".

> **Decision (audit-T145): Rayfin is code-first; Atelier is the visual builder.**
> The real Fabric Apps / Rayfin product has **no visual page/component
> designer** — it is `npm create @microsoft/rayfin` + a coding agent. Forcing a
> drag-drop canvas onto Rayfin would be vaporware that contradicts the product,
> so Loom keeps Rayfin **artifact-emitting** (model.ts / connector / CLI). The
> visual, multi-page low-code **builder** lives in **Atelier** (`workshop-app`,
> see `docs/fiab/parity/atelier-app.md`). The two are aligned by one shared
> app-definition schema (`lib/apps/app-definition.ts`): the Rayfin **Model
> binding → "Create Atelier app"** button lifts a binding into a visual Atelier
> page over the **same** Azure Analysis Services model.

The Rayfin CLI runs on the developer's machine, so Loom follows the honest
generate-artifact pattern (like the deploy planner emitting bicep): it authors
the spec, runs the **real** model binding against Azure backends, and emits the
SDK model + connector + exact CLI commands. The model-binding surface calls real
Azure REST/data-plane — no mock data.

## Fabric feature inventory

| Capability (Fabric Apps / Rayfin)                                    | Notes |
|----------------------------------------------------------------------|-------|
| Define entities / data model (decorators)                            | @entity/@text/@boolean/@date/@number |
| Choose services (database, storage)                                  | `rayfin init --services db,storage` |
| Auth (Entra SSO) + static hosting                                    | `--auth-methods fabric --static-hosting` |
| Scaffold + deploy to a workspace                                     | `npm create @microsoft/rayfin`, `npx rayfin up` |
| **Bind a web app to a semantic model** (#28)                         | App reads measures/fields from a model |
| Pick a bindable semantic model                                       | Model list |
| Introspect the model (tables, columns, measures)                     | Model metadata |
| Compose a read view (measures + group-by)                            | The data the app renders |
| Preview the bound data                                               | Live query against the model |
| Generate app data-access code for the binding                        | Typed connector |

## Loom coverage

| Capability                                  | Status | Backend per control |
|---------------------------------------------|--------|---------------------|
| Entities + fields                           | ✅ built | client-side spec → `model.ts` codegen; persisted to Cosmos via PUT `/api/items/rayfin-app/[id]` |
| Services / auth / static hosting            | ✅ built | spec → `rayfin init` command codegen |
| Scaffold + deploy commands                  | ✅ built | spec → CLI command codegen |
| `model.ts` generation                       | ✅ built | `generateModel()` |
| **Bind a semantic model** (#28)             | ✅ built | GET `/api/items/rayfin-app/models` → `listBindableModels()` → AAS ARM database list |
| Introspect tables/columns/measures          | ✅ built | GET `/api/items/rayfin-app/model-objects` → `introspectModel()` → real DAX `INFO.TABLES/COLUMNS/MEASURES()` over XMLA |
| Compose read view (measures + group-by)     | ✅ built | client multi-select → `buildReadViewDax()` (SUMMARIZECOLUMNS / ROW) |
| Preview bound data                          | ✅ built | POST `/api/items/rayfin-app/preview` → `executeDax()` real XMLA round-trip |
| Read-view connector codegen                 | ✅ built | `generateConnector()` emits `rayfin/data/model-view.ts` with the exact validated DAX |
| **Use in Atelier** (audit-T145 alignment)   | ✅ built | "Create Atelier app" → `appDefFromRayfinBinding()` → POST `/api/cosmos-items/workshop-app` (a visual app over the same AAS model) |
| AAS not configured                          | ⚠️ honest gate | all model-binding routes return `{ ok:false, gate }` 503; editor renders a Fluent MessageBar naming `LOOM_AAS_SERVER_NAME` + the AAS bicep module |

Zero ❌, zero stub banners.

## No-Fabric-dependency

The model-binding DEFAULT backend is **Azure Analysis Services** (a standalone
Azure resource). The full surface works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
UNSET — no Fabric/Power BI workspace is reached on the default path (only
`*.asazure.*` hosts via `executeDax`). AAS is the same backend the
semantic-model editor already uses, so the existing `aas-server.bicep` module
and `LOOM_AAS_SERVER_NAME/REGION/...` env wiring cover it — no new resource or
env var is introduced.
