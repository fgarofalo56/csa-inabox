# rayfin-app — parity with Microsoft Fabric Apps (Rayfin) + model-bound apps

Source UI: https://learn.microsoft.com/fabric/apps/overview · https://github.com/microsoft/rayfin
Build 2026 references: Rayfin code-first BaaS (general case) + #28 "build web apps backed by semantic models".

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
| AAS not configured                          | ⚠️ honest gate | all model-binding routes return `{ ok:false, gate }` 503; editor renders a Fluent MessageBar naming `LOOM_AAS_SERVER_NAME` + the AAS bicep module |

Zero ❌, zero stub banners.

## Visual app builder (audit-T145)

**Decision — standalone, in the Rayfin/Fabric-Apps surface (not Weave/Atelier).**
The task asked whether the low-code visual builder should live under Weave/Atelier
(audit-T51) or standalone. On the Azure-native build there is **no separate
Atelier (`workshop-app`) item type**, and the real Fabric-Apps app-building flow
(`npm create @microsoft/rayfin --template dataapp`) is itself a **code-first +
GitHub Copilot codegen** flow — there is no WYSIWYG Fabric canvas to mirror. So a
Loom-hosted visual builder with a **real Azure runtime** is the honest home, and
it lives standalone inside this Rayfin editor's **App builder** tab. (If an
Atelier surface is later added, it should reuse `rayfin-app-model.ts` +
`rayfin-model-binding.ts` rather than fork them.)

The builder is a genuine low-code surface — pages → components → data bindings —
with a real backend: the **app definition** persists on the Cosmos item
(`state.spec.app`) and a **runtime** executes every data component's read view
live over XMLA. It does **not** pretend to run the Microsoft Rayfin CLI in the
browser (that runs on the dev machine); instead Loom emits a typed
`rayfin/app.config.ts` artifact (the same generate-artifact pattern), while the
live preview proves each binding against the real Azure Analysis Services model.

| Capability (low-code app builder)                          | Status | Backend per control |
|------------------------------------------------------------|--------|---------------------|
| Pages: add / rename / delete / select                      | ✅ built | client app definition → persisted on `state.spec.app` via PUT `/api/items/rayfin-app/[id]` |
| Component palette (Table / Metric / Chart / Form / Text)   | ✅ built | `emptyComponent()` typed model — no freeform JSON (loom-no-freeform-config) |
| Bind a data component to the model (measures + group-by)   | ✅ built | reuses the bound model's introspected objects (`/model-objects`) |
| Per-component live preview                                 | ✅ built | POST `/api/items/rayfin-app/preview` → `executeDax()` real XMLA |
| **Run app preview (runtime)** — render every component live | ✅ built | POST `/api/items/rayfin-app/[id]/render` → per-component `buildReadViewDax()` + `previewReadView()` real XMLA |
| Metric / chart / table render of live rows                 | ✅ built | runtime rows → Fluent metric card / CSS bar chart / data grid |
| Form component bound to a Rayfin entity                    | ✅ built | entity dropdown; write-back runs in the **deployed** app (honest — no fake POST in Loom) |
| Scaffold wizard (model → measure + category → starter app) | ✅ built | `scaffoldAppDefinition()` builds an Overview page (metric + table + chart) |
| `rayfin/app.config.ts` codegen                             | ✅ built | `generateAppConfig()` emits typed pages → components → DAX |
| App definition validation                                  | ✅ built | `validateAppDefinition()` (duplicate ids, unbound model, empty chart) |
| AAS not configured                                         | ⚠️ honest gate | render route returns `{ ok:false, gate }` 503; builder shows MessageBar naming `LOOM_AAS_SERVER_NAME` |

Tests: `lib/editors/__tests__/rayfin-app-model.test.ts` (21 cases — DAX, codegen,
scaffold, validation). Zero ❌, zero stub banners.

## No-Fabric-dependency

The model-binding DEFAULT backend is **Azure Analysis Services** (a standalone
Azure resource). The full surface works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
UNSET — no Fabric/Power BI workspace is reached on the default path (only
`*.asazure.*` hosts via `executeDax`). AAS is the same backend the
semantic-model editor already uses, so the existing `aas-server.bicep` module
and `LOOM_AAS_SERVER_NAME/REGION/...` env wiring cover it — no new resource or
env var is introduced.
