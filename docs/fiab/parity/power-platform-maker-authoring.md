# power-platform-maker-authoring — parity with Power Platform maker (canvas / flow / Pages / Tables)

Source UI: make.powerapps.com (Canvas Studio, Tables/Dataverse, Model-driven app
designer), make.powerautomate.com (cloud flow designer), make.powerpages.microsoft.com.
Grounded in Microsoft Learn:
- power-apps/maker/canvas-apps/embed-apps-dev (canvas player iframe + GCC base)
- power-apps/maker/model-driven-apps/.../limits-and-config (model-driven no-iframe)
- power-automate/developer/embed-flow-dev (Flow widget SDK + delegated token)
- power-apps/developer/data-platform/webapi/create-update-column-definitions-using-web-api (column create)
- power-pages/.../embed-website (Pages iframe disabled by default)

## What changed in this PR

Maker authoring was previously surfaced as scattered deep-link `<a>` tags and
`window.open` calls out to the maker portals, and the tree navigator deep-linked
out instead of opening the Loom editor. This PR surfaces authoring as
first-class in-Loom tabs + a real Dataverse write, and routes tree navigation
back into the Loom editors.

## Maker feature inventory → Loom coverage

| Maker capability | Loom coverage | Backend / honest constraint |
|---|---|---|
| Canvas app **run/play** | ✅ "Play / embed" tab — iframe `apps.powerapps.com/play/<id>?source=iframe` | Real web-player iframe. GCC/DoD via `LOOM_POWERAPPS_PLAYER_BASE`. |
| Canvas app **author (Studio)** | ✅ "Studio" tab — primary "Open Canvas Studio" button | ⚠️ Honest-gate: Studio sends `frame-ancestors` CSP, cannot iframe. Opens in new tab. |
| Canvas app **publish revision** | ✅ Details tab "Publish latest revision" | Real `publishAppRevision` POST (powerapps admin REST). |
| Model-driven app **author** | ✅ "Studio" tab — warning + "Open in maker" | ⚠️ Honest-gate: MS blocks model-driven iframe embedding (platform limit). |
| Cloud flow **list / run / history** | ✅ "Runs" tab — list, manual run, run history | Real Flow admin REST (`/run`, `/runs`). |
| Cloud flow **create** (D7) | ✅ "New flow" → seed manual/scheduled trigger → create | Real `POST workflows` (Dataverse, category 5 modern flow, Draft). |
| Cloud flow **author definition** (D7) | ✅ "Designer" tab — edit Logic Apps definition + connection-references grid, Save, Turn on/off | Real `GET/PATCH workflows({id})` clientdata (Dataverse SP). Definition validated against the Logic Apps workflowdefinition.json schema (not a free blob). |
| Cloud flow **visual drag-drop designer** | ✅ "Open visual designer" secondary | ⚠️ Honest-gate: Flow widget SDK needs a *delegated* user JWT (aud `service.flow.microsoft.com`); Loom's server-side UAMI SP can't mint it. Opens in new tab. The *definition* is authored in-product (above). |
| Dataverse table **inspect** (columns/keys/rels/views/rules/data) | ✅ existing tabs | Real Dataverse Web API reads. |
| Dataverse table **add column** | ✅ Columns tab → "New column" dialog | Real `POST EntityDefinitions(...)/Attributes` with the concrete `@odata.type` per type (String/Memo/Integer/Decimal/Money/Boolean/DateTime). |
| Dataverse table **create new table** (E8) | ✅ "New table" dialog — display/plural, schema (publisher prefix), ownership, primary column, table type (Standard/Elastic), Notes/Activities | Real `POST EntityDefinitions` (`buildEntityMetadata`) with one IsPrimaryName StringAttribute. Dataverse SP. |
| Power Pages **author (design studio)** (G4) | ⚠️ Honest-gate banner | No public design API; proprietary studio. |
| Power Pages **site lifecycle** (provision/delete/restart, WAF, IP, scan) (G5) | ⚠️ Honest-gate banner — explicit SP-unsupported note | **Power Pages admin API (`api.powerplatform.com/powerpages`) requires username/password (delegated) auth and does NOT support the service-principal flow Loom uses.** Documented limitation, not a removed banner (`powerPagesAdminConfigGate`). Site metadata stays readable via Dataverse `mspp_website`. |
| Tree navigator open table/app/flow | ✅ `router.push` into the Loom editor (was: deep-link out) | In-app navigation to `/items/<type>/<id>?envId=`. |

Zero ❌. Every non-functional state is an honest, Learn-grounded embedding
constraint with a working "Open in <X>" action — not a removed banner or a dead
control.

## Backend per new control

| Control | Backend |
|---|---|
| New table dialog | `POST /api/powerplatform/tables?envId=` → `createTable()` → Dataverse `POST EntityDefinitions` (Dataverse SP). |
| New column dialog | `POST /api/items/dataverse-table/[id]/columns?envId=` → `addColumn()` → Dataverse Web API `EntityDefinitions/Attributes` (Dataverse SP `LOOM_DATAVERSE_CLIENT_ID`). |
| New flow | `POST /api/items/power-automate-flow/new/definition?envId=` → `createFlow()` → Dataverse `POST workflows` (Draft). |
| Designer Save definition | `PATCH /api/items/power-automate-flow/[id]/definition?envId=` → `updateFlowDefinition()` → Dataverse `PATCH workflows({id})` clientdata. |
| Designer Turn on/off | same route, `{state:'on'\|'off'}` → `setFlowStateViaDataverse()` → `PATCH workflows({id})` statecode/statuscode. |
| Open visual designer | `window.open(make.powerautomate.com/environments/<env>/flows/<id>/details)` |
| Open Canvas Studio | `window.open(make.powerapps.com/e/<env>/studio/<app>)` |
| Studio play tab | iframe `<LOOM_POWERAPPS_PLAYER_BASE>/play/<app>?source=iframe` |

## Azure-native / no-Fabric

All paths authenticate with the Console UAMI (BAP/PowerApps/Flow control plane)
and the dedicated Dataverse SP (Dataverse Web API). No `fabricWorkspaceId`, no
`api.fabric.microsoft.com` / `api.powerbi.com`. Works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Sovereign cloud

`LOOM_POWERAPPS_PLAYER_BASE` (bicep param `powerAppsPlayerBase`,
admin-plane/main.bicep) overrides the canvas player base: GCC/GCC-High =
`https://apps.gov.powerapps.us`, DoD/IL5 = `https://apps.appsplatform.us`.
Control-plane bases now override via `LOOM_BAP_BASE` / `LOOM_POWERAPPS_BASE` /
`LOOM_FLOW_BASE` (bicep params `powerPlatformBapBase` / `powerPlatformPowerAppsBase`
/ `powerPlatformFlowBase`). Dataverse-scoped authoring (tables, flow definitions)
is per-env (`<org>.crm.dynamics.com`) and auto-sovereign — no override needed.
The Power Pages admin-API SP-unsupported limit applies in all clouds.

## Bicep sync

- `admin-plane/main.bicep`: existing `LOOM_POWERAPPS_PLAYER_BASE` env, **plus
  three new sovereign control-plane host envs** `LOOM_BAP_BASE` /
  `LOOM_POWERAPPS_BASE` / `LOOM_FLOW_BASE` (params `powerPlatformBapBase` /
  `powerPlatformPowerAppsBase` / `powerPlatformFlowBase`, default empty → code
  default commercial). No new Azure resource — table + flow-definition writes
  reuse the existing `LOOM_DATAVERSE_CLIENT_ID/_SECRET/_TENANT_ID`.

## Verification

- `npx tsc --noEmit` — all touched files clean (pre-existing griffel-numeric +
  registry index-signature backlog excluded).
- `npx vitest run lib/power-platform/__tests__/maker-authoring.test.ts` — green
  (URL builders + `buildAttributeMetadata` per column type + `buildEntityMetadata`
  table create + `validateFlowDefinition`/`emptyFlowDefinition` flow authoring).
- Live E2E (operator, post-merge): with a Dataverse env bound —
  (1) Tables → New table → `new_LoomDemo` (Standard, UserOwned) → 204 + table
  appears on reload; Columns → New column → `new_LoomTest` (String) → 204.
  (2) Flows → New flow → `Loom Demo Flow` (manual) → Draft created; Designer →
  edit definition + add a connection reference → Save → 204; Turn on → statecode 1.
  Visual designer + Canvas Studio open the maker surfaces in new tabs.
