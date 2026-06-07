# trigger-parameter-sources — parity with ADF trigger parameterization (F4)

Source UI: Azure Data Factory Studio → Pipeline → **Add trigger → New/Edit** →
(when the pipeline declares parameters) the per-parameter **value** column.
Learn: https://learn.microsoft.com/azure/data-factory/how-to-use-trigger-parameterization

## Feature: schedule-time parameter overrides from Key Vault / App Config

ADF Studio lets a trigger supply a value for each declared pipeline parameter
when the trigger fires. Those values accept a literal or an ADF expression
(e.g. `@trigger().scheduledTime`) and are stored in
`TriggerPipelineReference.parameters` (an `IDictionary<string,object>`). ADF
does **not** dereference an `AzureKeyVaultSecretReference` in that position
(that type is only valid inside linked-service `typeProperties`), and the
`@Microsoft.AppConfiguration(...)` syntax is an App Service feature, not an ADF
one. So a value sourced from Key Vault / App Config must be resolved before it
is written into `parameters`.

Loom builds the same per-parameter value column and extends it with a **source
picker**: Direct value, Key Vault secret, or App Config key. KV/App Config
values are resolved **server-side at trigger-creation time** (snapshot
semantics) and the resolved literal is written into the ADF trigger. The UI
discloses this ("Resolved at creation — recreate if the value changes").

## Azure/Fabric feature inventory

| Capability (ADF Studio) | Notes |
|---|---|
| Per-parameter value field when attaching a trigger | shown only when the pipeline declares parameters |
| Literal value | string/number/bool |
| ADF expression value (`@trigger().scheduledTime`, …) | system-variable parameterization |
| Secure (`secureString`) parameter masking | value stored in plain text in the trigger def |

## Loom coverage

| Inventory row | Status | Where |
|---|---|---|
| Per-parameter value control (only when params declared) | ✅ built | `param-source-picker.tsx` rendered per `pipelineParams[]` in `trigger-wizard.tsx` |
| Direct literal value | ✅ built | `ParamBinding.source='direct'` → written verbatim into `parameters` |
| ADF expression value | ✅ built | same Direct field accepts `@trigger().scheduledTime` etc. |
| `secureString` masking | ✅ built | Direct input switches to `type=password` + plain-text warning |
| **Key Vault secret source** (Loom extension) | ✅ built | resolved via KV REST `GET /secrets/{name}` from `LOOM_PARAM_KEYVAULT` |
| **App Config key source** (Loom extension) | ✅ built | resolved via App Config REST `GET /kv/{key}` from `LOOM_PARAM_APPCONFIG` |
| Honest gate when KV/App Config unconfigured | ⚠️ honest-gate | route returns 503 naming the exact env var + role; picker shows a "Not configured" badge |

Zero ❌. Zero stub banners.

## Backend per control

| Control | Backend call |
|---|---|
| Direct value | none (literal passed through `resolveParamBindings`) |
| Key Vault secret | `GET {LOOM_PARAM_KEYVAULT}/secrets/{name}?api-version=7.4` — AAD scope derived from vault URI (`vault.azure.net` / `vault.usgovcloudapi.net`) |
| App Config key | `GET {LOOM_PARAM_APPCONFIG}/kv/{key}?api-version=2023-11-01[&label=…]` — AAD scope derived from endpoint (`azconfig.io` / `azconfig.azure.us`) |
| Trigger create | `PUT factories/{f}/triggers/{name}?api-version=2018-06-01` with resolved literals in `pipelines[0].parameters` (or `pipeline.parameters` for tumbling window) |

Auth: the same UAMI→DefaultAzureCredential chain every Loom Azure client uses.
KV/App Config 403/404 surface verbatim with the upstream HTTP status.

## No-Fabric / no-vaporware

- Azure-native only (ADF + Key Vault + App Configuration). No Fabric/Power BI
  hosts on any code path. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Real REST at creation time; missing-config states are honest 503 gates that
  name the exact env var and RBAC role. No mock data.

## Bicep sync

- `platform/fiab/bicep/modules/admin-plane/main.bicep`:
  - new params `loomParamKeyVaultUri` (defaults to the admin-plane vault) and
    `loomParamAppConfigEndpoint` (empty = App Config source disabled).
  - new console env vars `LOOM_PARAM_KEYVAULT` and `LOOM_PARAM_APPCONFIG`.
- KV RBAC: the Console UAMI already holds **Key Vault Secrets Officer** on the
  admin-plane vault (includes `get`), so the default (same-vault) path needs no
  new role assignment. A **separate** param vault requires granting the Console
  identity **Key Vault Secrets User** on it (surfaced in the 503 message).
- App Config RBAC: bring-your-own App Configuration store + grant the Console
  identity **App Configuration Data Reader**; surfaced in the 503 message.

## Gov gap (pre-existing, logged)

The App Configuration private-DNS zone registered in `network.bicep`
(`privatelink.azconfig.io`) is the commercial zone. For GCC-High / IL5 the
correct zone is `privatelink.azconfig.azure.us`. Until that is parameterized,
App Config parameter sources in Gov require public network access or a manual
DNS override. KV resolution is unaffected (scope/host derived from the vault
URI). This gap predates F4 and is tracked separately.

## Verification

`lib/azure/__tests__/trigger-param-resolver.test.ts` (10 cases): direct
passthrough, empty-direct skip, 503 gates for unconfigured KV/App Config,
commercial + gov scope derivation for both sources, label query-param, and
verbatim 403 surfacing. Live check: create a schedule whose parameter is bound
to a real Key Vault secret with `LOOM_PARAM_KEYVAULT` set → trigger fires → the
run input shows the resolved value (no hard-coded value).
