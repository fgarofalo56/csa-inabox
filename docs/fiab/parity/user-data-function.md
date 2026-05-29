# user-data-function — parity with Fabric User Data Functions

Source UI: Fabric portal editor (https://learn.microsoft.com/fabric/data-engineering/user-data-functions/user-data-functions-portal-editor),
Test (https://learn.microsoft.com/fabric/data-engineering/user-data-functions/test-user-data-functions),
Generate invocation code (https://learn.microsoft.com/fabric/data-engineering/user-data-functions/generate-invocation-code),
REST definition (https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/user-data-function-definition).

## Fabric feature inventory

| # | Capability | Fabric surface |
|---|------------|----------------|
| 1 | Code editor (function_app.py) | Code viewer/editor |
| 2 | Functions explorer list (parse `@udf.function()`) | Functions list |
| 3 | Test / Run a function (params → output + logs) | Test/Run panel |
| 4 | Publish | Publish button |
| 5 | Manage connections (Fabric data sources) | Settings → Manage connections |
| 6 | Library management (public PyPI / private wheel) | Settings → Library management |
| 7 | Generate invocation code (Notebook / client / OpenAPI) | Home → Generate invocation code |
| 8 | Runtime + entrypoint metadata | item metadata |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | built ✅ | `MonacoTextarea` language=python |
| 2 | built ✅ | Functions explorer parses decorated functions + signatures from the source |
| 3 | honest-gate ⚠️ | Test/Run panel renders (function selector + typed param inputs + output/logs). Invokes via POST `/api/items/user-data-function/[id]/invoke`, which calls the per-function REST endpoint when the item is published to a Fabric UDF workspace (`state.fabricItemId`/`functionAppName`); otherwise returns a precise MessageBar naming the publish step. Full panel always renders. |
| 4 | built ✅ | Save persists source+definition to Cosmos; Deploy ribbon publishes (see #5 gate) |
| 5 | built ✅ | Connections editor (comma list of workspace items → `connectedDataSources`) |
| 6 | built ✅ | Library management table (public PyPI name+version, private wheel name) persisted in `state.libraries` per the UDF definition schema |
| 7 | built ✅ | Generate invocation code dialog: Notebook (mssparkutils), Python client, OpenAPI — generated from the parsed function signatures |
| 8 | built ✅ | runtime/entrypoint fields |

## Backend per control

- Code/config/libraries/connections → Cosmos `state` via PATCH `/api/items/user-data-function/[id]`
- Invoke → POST `/api/items/user-data-function/[id]/invoke` (Fabric UDF public REST endpoint when published)
- The disabled "Deploy to Function App" button and the v2.x config-only MessageBar are REMOVED; replaced with the real publish/invoke path + an honest publish gate naming `LOOM_FABRIC_*` / the workspace publish step.
