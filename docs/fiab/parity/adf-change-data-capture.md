# adf-change-data-capture — parity with Azure Data Factory "Change Data Capture (preview)"

Source UI: ADF Studio → Author hub → **Factory Resources → Change Data Capture (preview)** group,
and the CDC resource detail view. Learn: <https://learn.microsoft.com/en-us/azure/data-factory/concepts-change-data-capture-resource>
ARM: `Microsoft.DataFactory/factories/adfcdcs` (api-version `2018-06-01`).

This is a **pure Azure Data Factory** resource — no Microsoft Fabric / Power BI dependency.
The whole surface works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. (Fabric Data Factory uses
Copy Jobs, not the factory-level `adfcdcs` resource; we never touch Fabric here.)

## Azure feature inventory (grounded in Learn + ADF Studio)

| # | Capability (ADF Studio) | ARM operation |
|---|---|---|
| 1 | List all CDC resources in the factory (left-pane group with count) | `GET .../adfcdcs` |
| 2 | Open a CDC resource and inspect source → target mapping before running | `GET .../adfcdcs/{name}` |
| 3 | See the live status pill (Running / Stopped / Starting / Stopping), auto-refreshing | `GET .../adfcdcs/{name}/status` (bare string) |
| 4 | See the latency / policy mode (Continuous vs Microbatch + recurrence) | `properties.policy` |
| 5 | Start a CDC resource (initial load + continuous capture to Delta) | `POST .../adfcdcs/{name}/start` |
| 6 | Stop a running CDC resource (landed data + resource remain) | `POST .../adfcdcs/{name}/stop` |
| 7 | Delete a CDC resource | `DELETE .../adfcdcs/{name}` |
| 8 | Create / update a CDC resource (mapper source + Delta target) | `PUT .../adfcdcs/{name}` |

## Loom coverage

| # | Capability | Status | Where |
|---|---|---|---|
| 1 | List CDC resources with live count | built ✅ | `factory-resources-tree.tsx` `g-cdc` group → `GET /api/adf/cdc` |
| 2 | Open + inspect source→target mapping ("preview before execute") | built ✅ | `lib/adf/adf-cdc-editor.tsx` → `GET /api/adf/cdc?name=X` |
| 3 | Live status pill, auto-refreshing while Running/transitioning | built ✅ | `AdfCdcEditor` 5s poll → `GET /api/adf/cdc?name=X&status=1` |
| 4 | Latency / policy mode + recurrence | built ✅ | `AdfCdcEditor` meta row |
| 5 | Start | built ✅ | tree + editor → `POST /api/adf/cdc {action:'start'}` |
| 6 | Stop | built ✅ | tree + editor → `POST /api/adf/cdc {action:'stop'}` |
| 7 | Delete | built ✅ | tree + editor → `POST /api/adf/cdc {action:'delete'}` / `DELETE ?name=` |
| 8 | Create / update CDC resource | built ✅ | `POST /api/adf/cdc {spec}` (also driven by the mirror wizard / mirror-engine `runMirrorAdfCdc`) |

The CDC **mapper designer** (visually wiring source columns → target columns in a brand-new
resource from scratch) is created today through the **mirrored-database mirror wizard**
(`mirror-source-wizard.tsx` → `runMirrorAdfCdc`), which builds the full `AdfCdcSpec` (source
linked service + selected tables, AzureBlobFS Delta target) and PUTs it via this same route. The
Factory Resources surface is the **inspect + lifecycle** view; both paths hit real ARM REST.

## Backend per control

- Every read/write goes through `lib/azure/adf-client.ts` (`listAdfCdcs`, `getAdfCdc`,
  `statusAdfCdc`, `upsertAdfCdc`, `startAdfCdc`, `stopAdfCdc`, `deleteAdfCdc`) which call ARM via
  the Console UAMI token. `statusAdfCdc` normalizes the bare-JSON-string status response.
- The BFF route `app/api/adf/cdc/route.ts` validates the session, applies the honest factory
  config gate (503 `not_configured` naming `LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` / `LOOM_ADF_NAME`),
  and returns `{ ok, ... }` JSON.

## Per-cloud

| Cloud | Notes |
|---|---|
| Commercial | ARM `management.azure.com`; `adfcdcs` @ `2018-06-01`. Full support. |
| Government | ARM `management.usgovcloudapi.net` via `armBase()` / `LOOM_ARM_ENDPOINT`; same resource + api-version. No code change. |
| Fabric | No dependency — pure ADF ARM. Works with no Fabric workspace bound. |

## RBAC / bicep

No new bicep. The Console UAMI's existing **Data Factory Contributor** on the factory covers all
`Microsoft.DataFactory/factories/adfcdcs/*` operations (list/get/status/start/stop/delete/put).
The ADF system-assigned MI already holds **Storage Blob Data Contributor** on the DLZ ADLS account
(added for the mirror Delta sink).

## Verification

`npx tsc --noEmit` clean on touched files; vitest `app/api/adf/cdc/__tests__/cdc-route.test.ts`
covers 401 / 503-gate / list / detail / status-poll / start / stop / delete / upsert / 400. Live
E2E is the minted-session probe against `GET /api/adf/cdc` on a deployment with the factory env
vars set.
