# W0 receipt: API & AI Gateway Plane measurement spike

**Status: MEASURED 2026-10-29 and 2026-10-30 in Commercial and GCC-High.** IL5 (`deploy-fiab-il5.yml` has never run; supported-in-code) and GCC (no tenant; supported-in-code, never exercised) are **not measured** and are labelled so in every table. Plan: `apigw-W00-measurement-spike.md`. Tracking: #5179. W1 sub-issue: #5187.

- Instruments: PR #5181 (merge `d877782a8`) and the hardening PR #5183 (merge `0f1ff4d7b`). Each merged after an independent review approved it with no blocking findings (issue comments on the PRs), under the standing `--admin` terms.
- Probe runs, all on `main`: Commercial read-only first run **40956953993** (2026-10-29 21:20Z; telemetry, identity, foundry; it found the ambiguous sign-in app that the H7 fix resolved); Commercial, all families, **40974529572** (2026-10-29 23:38Z); GCC-High, all families, **40975571002** (approved 2026-10-30 00:17Z at the `gcc-high-deploy` gate). The last two ran the workflow files at `0f1ff4d7b`.
- Each section below opens with my reading, then pastes the probe's own redacted output verbatim. The artifacts contain names, resource groups, SKUs and states only: all three were scanned for GUID-shaped strings, IPv4 addresses and JWT or bearer shapes, and none were found.
- Cleanup: every write family ended with 0 leftover `w0-apiplane-*` objects in its own listing. For Commercial I also listed the gateway from outside after the run with the workstation identity (read-only GETs): 0 `w0-apiplane*` objects among 4 APIs and 100 named values, and the fragment list was empty. GCC-High has no independent listing (Government is reachable only through Actions), so its evidence is the probe's own end-of-run listing.
- Cell verdicts: `measured` (a value, with the HTTP status quoted), `not-measured:<reason>` (a structural limit; nothing was asked) and `unknown:<reason>` (a question was asked and the instrument will not guess). A family exits 3 when a required cell is unknown, which turns the workflow run red.

## Item status

| Item | Result |
|---|---|
| W0-1 telemetry tables | Measured in both clouds. `GatewayLlmLogs` present on Commercial, **absent on GCC-High** (section 1). |
| W0-2 `llm-*` family and friends | Measured in both clouds. Six elements accepted on both; 10 cells per cloud unknown by one shared signature (section 2). |
| W0-3 MCP API type | Commercial measured. GCC-High not measured: api-version `2025-09-01-preview` is not registered there (section 3). |
| W0-4 Entra Agent ID and Graph | Commercial measured. GCC-High unknown:permission (section 4). |
| W0-5 Retail Prices coverage | Measured (two runs). Government rows exist; 277 of 390 Commercial families have none (section 5). |
| W0-6 named-value propagation | Commercial 7.1 s. GCC-High not measured: the gateway is unreachable from a hosted runner (section 6). |
| W0-7 Anthropic-on-Foundry | Measured in both clouds: 14 models on Commercial, none on GCC-High (section 7). |
| W0-8 Loom facts at a pinned SHA | Done (section 8). The recorded ARM headroom of 7,624 B is stale: it is 196,393 B. |
| W0-9 decision pass | Done (section 9). |

## The answers

Gateways measured. Commercial: `apim-csa-loom-centralus`, PremiumV2 x1, VNet-internal, Succeeded, Central US. GCC-High: `apim-csa-loom-usgovvirginia`, Premium (classic) x1, VNet-internal, Succeeded, USGov Virginia. Government's ARM registers 25 api-versions for `Microsoft.ApiManagement/service` (read from the raw `az provider show` output the LHDS Government probe uploaded, run 39887825372, 2026-10-23); the newest is `2024-10-01-preview`, `2024-05-01` and `2024-06-01-preview` (the console client's pin) are registered, `2025-09-01-preview` is not.

| # | Question | Commercial (PremiumV2) | GCC-High (Premium) | IL5 / GCC |
|---|---|---|---|---|
| 1 | `GatewayLlmLogs` diagnostic category (W0-1) | **present** (5 log categories plus AllMetrics) | **absent** (only `GatewayLogs` and `AllMetrics`) | not measured |
| 2 | Live diagnostic setting `diag-loom-stdz` | legacy `AzureDiagnostics` destination; enables `GatewayLogs`, `DeveloperPortalAuditLogs`, `WebSocketConnectionLogs` (not `GatewayLlmLogs`) | legacy `AzureDiagnostics` destination; enables `GatewayLogs` | not measured |
| 3 | `ApiManagementGatewayLlmLog` table and `TraceRecords` column in the workspace schema | present (schema only) | present (schema only; nothing in APIM can feed the table, row 1) | not measured |
| 4 | `llm-token-limit` authorable (W0-2) | **accepted**, read back (201 then 200) | **accepted**, read back (201 then 200) | not measured |
| 5 | `llm-emit-token-metric`, `trace` with metadata, `validate-azure-ad-token`, `rate-limit-by-key`, `quota-by-key` | accepted, read back (x5) | accepted, read back (x5) | not measured |
| 6 | `include-fragment` | accepted at API scope; inside a fragment it is not retained (201 then 404) | same | not measured |
| 7 | Combined fragment; negative control | unknown (201 then 404; see "How to read the unknown cells") | same | not measured |
| 8 | MCP API type (W0-3) | accepted, type retained; `mcpProperties` reads back `{endpoints: null, isFederationRouter: false, federation: null}`; API-scoped policy accepted | **not measured**: `2025-09-01-preview` not registered in `usgovvirginia` | not measured |
| 9 | Blank-path API with a `.well-known` operation | accepted | accepted | not measured |
| 10 | Entra Agent ID app roles on the Graph service principal (W0-4) | **yes**: `AgentIdentity.Read.All` and five more | **unknown:permission** (the Government deploy SP gets 403; it needs `Application.Read.All`) | not measured |
| 11 | Console UAMI Graph app roles | 15 roles listed, none of them `AgentIdentity.*` | unknown:permission | not measured |
| 12 | Sign-in app `groupMembershipClaims` | **SecurityGroup** (exact-name match) | unknown:permission | not measured |
| 13 | Azure Retail Prices coverage (W0-5) | 1,863 rows in `eastus`; 390 model families | Government rows exist for `Foundry Models`: `usgovvirginia` 310, `usgovarizona` 301, `usgovtexas` 4, others 0; 114 families; **277 of 390 Commercial families have no Government row**; the `Azure OpenAI` serviceName has no rows anywhere | n/a |
| 14 | Named-value propagation (W0-6) | **7.1 s** (value B); 5.3 s (value A, includes API and policy propagation) | **not measured**: gateway unreachable from the hosted runner (DNS) | not measured |
| 15 | Anthropic-on-Foundry models (W0-7) | 14 listed in `centralus` (310 models, 12 formats) | **none listed** in `usgovvirginia` (22 models, `OpenAI` format only) | not measured |
| 16 | `*.services.ai.azure.com` resolution | resolves-private (from the in-VNet runner) | not measured (a hosted runner sees only the public view) | not measured |
| 17 | Prompt Shields availability (#4442 Wave 0 task 3) | n/a | **UNVERIFIED**: Learn is silent, no in-boundary call exists (section 7) | not measured |
| 18 | ARM `main.json` headroom (W0-8) | 196,393 B at `007da59c4` (the PRP set says 7,624 B) | same artifact | n/a |

Not established by W0: runtime enforcement of the accepted policies on GCC-High (the gateway cannot be reached from Actions, so only authoring and read-back were measured); `llm-semantic-cache-*` and any element beyond the seven tested; anything in IL5 or GCC.

### How to read the unknown cells in the `policies` family

Ten `policies` cells in each cloud read `unknown:tooling-error`. They share one signature: the PUT answers 201 and the immediate GET answers 404. The bogus-element control (`<w0-apiplane-not-a-policy />`), `include-fragment` placed inside a fragment, and the combined fragment that contains it all show it; the six valid elements show 201 then 200 with the element read back. Reading: APIM accepts the PUT and then drops a fragment that fails validation, so the PUT status is not a verdict and only the read-back is. The instrument did not guess, because it cannot tell "not retained" from a transient read failure; that is why those cells are unknown and why the `policies` family exits 3 and both runs are red. The bogus-element control is the calibration: it shows the signature means "invalid" on that gateway. The "not retained" reading of rows 6 and 7 is mine, not the instrument's. It does not touch rows 4 and 5, which are measured. Follow-up: #5186 item 1. The PRP's own rule ("a 2xx whose GET-back drops an element is recorded as rejected") would label these `rejected`.

## 1. W0-1: Government telemetry tables

Reading: the category list is the authoritative answer, and it is pasted whole. Commercial offers `DeveloperPortalAuditLogs`, `GatewayLlmLogs`, `GatewayLogs`, `GatewayMCPLogs`, `WebSocketConnectionLogs` and `AllMetrics`. GCC-High offers only `GatewayLogs` and `AllMetrics`, so **`GatewayLlmLogs` does not exist there**. The existing diagnostic setting on both gateways sends to the legacy `AzureDiagnostics` destination, not to a resource-specific table. `ApiManagementGatewayLlmLog` and `TraceRecords` are in both workspaces' schema (the Tables API listed 861 and 859 tables; a KQL `getschema` answered), which proves the table type exists, not that anything feeds it. A table that is absent would have been inconclusive; here it is present, so the category list decides. The Commercial gateway was reachable from the in-VNet pool runner (HTTP 200); the GCC-High gateway was not reachable from the hosted runner (DNS), as expected for a VNet-internal gateway.

#### commercial / telemetry - exit 0

APIM `apim-csa-loom-centralus` (resource group `rg-csa-loom-admin-centralus`): SKU PremiumV2 x1, state Succeeded, location Central US, virtualNetworkType Internal, publicNetworkAccess Enabled; runner in-vnet.

| control | status | detail |
|---|---|---|
| categories-contain-GatewayLogs | passed | GatewayLogs is in the category list |

| cell | verdict | evidence |
|---|---|---|
| telemetry.apim.sku | measured: PremiumV2 (HTTP 200) |  |
| telemetry.apim.capacity | measured: 1 (HTTP 200) |  |
| telemetry.apim.provisioningState | measured: Succeeded (HTTP 200) |  |
| telemetry.apim.location | measured: Central US (HTTP 200) |  |
| telemetry.apim.virtualNetworkType | measured: Internal (HTTP 200) |  |
| telemetry.apim.publicNetworkAccess | measured: Enabled (HTTP 200) |  |
| telemetry.gateway.reachability | measured: reachable (status endpoint answered HTTP 200) (HTTP 200) | {"runner":"in-vnet","virtualNetworkType":"Internal","errorClass":null} |
| telemetry.diag.categories | measured: {"logs":["DeveloperPortalAuditLogs","GatewayLlmLogs","GatewayLogs","GatewayMCPLogs","WebSocketConnectionLogs"],"metrics":["AllMetrics"],"total":6} (HTTP 200) |  |
| telemetry.diag.GatewayLlmLogs | measured: present (HTTP 200) | {"nearMatches":[]} |
| telemetry.law.discovered | measured: 1 workspace(s) via diagnostic-setting (HTTP 200) | {"diagnosticSettings":[{"name":"diag-loom-stdz","routesToWorkspace":true,"destinationType":"AzureDiagnostics (legacy)","enabledLogCategories":["GatewayLogs","DeveloperPortalAuditLogs","WebSocketConnectionLogs"]}],"diagnosticSettingsRead":{"status":200},"resourceGroupScan":null,"workspaceNames":["law-csa-loom-centralus"]} |
| telemetry.law.table.ApiManagementGatewayLlmLog | measured: present (HTTP 200) | {"workspaces":[{"workspace":"law-csa-loom-centralus","listed":true,"tableCount":862,"status":200}]} |
| telemetry.law.column.TraceRecords | measured: present (HTTP 200) | {"workspaces":[{"workspace":"law-csa-loom-centralus","listed":true,"tableCount":862,"status":200}]} |
| telemetry.law.kql.ApiManagementGatewayLlmLog | measured: present (HTTP 200) | {"workspace":"law-csa-loom-centralus"} |
| telemetry.law.kql.TraceRecords | measured: present (HTTP 200) | {"workspace":"law-csa-loom-centralus"} |

Pasted category list for `telemetry.diag.GatewayLlmLogs` (the full list, not a yes): AllMetrics, DeveloperPortalAuditLogs, GatewayLlmLogs, GatewayLogs, GatewayMCPLogs, WebSocketConnectionLogs

Requests logged: 9. Cells: 14 measured, 0 not-measured, 0 unknown.

#### gov / telemetry - exit 0

APIM `apim-csa-loom-usgovvirginia` (resource group `rg-csa-loom-admin-usgovvirginia`): SKU Premium x1, state Succeeded, location USGov Virginia, virtualNetworkType Internal, publicNetworkAccess Enabled; runner hosted.

| control | status | detail |
|---|---|---|
| categories-contain-GatewayLogs | passed | GatewayLogs is in the category list |

| cell | verdict | evidence |
|---|---|---|
| telemetry.apim.sku | measured: Premium (HTTP 200) |  |
| telemetry.apim.capacity | measured: 1 (HTTP 200) |  |
| telemetry.apim.provisioningState | measured: Succeeded (HTTP 200) |  |
| telemetry.apim.location | measured: USGov Virginia (HTTP 200) |  |
| telemetry.apim.virtualNetworkType | measured: Internal (HTTP 200) |  |
| telemetry.apim.publicNetworkAccess | measured: Enabled (HTTP 200) |  |
| telemetry.gateway.reachability | measured: unreachable from this runner (error class: dns) (source: network-probe) | {"runner":"hosted","virtualNetworkType":"Internal","errorClass":"dns"} |
| telemetry.diag.categories | measured: {"logs":["GatewayLogs"],"metrics":["AllMetrics"],"total":2} (HTTP 200) |  |
| telemetry.diag.GatewayLlmLogs | measured: absent (HTTP 200) | {"nearMatches":[]} |
| telemetry.law.discovered | measured: 1 workspace(s) via diagnostic-setting (HTTP 200) | {"diagnosticSettings":[{"name":"diag-loom-stdz","routesToWorkspace":true,"destinationType":"AzureDiagnostics (legacy)","enabledLogCategories":["GatewayLogs"]}],"diagnosticSettingsRead":{"status":200},"resourceGroupScan":null,"workspaceNames":["law-csa-loom-usgovvirginia"]} |
| telemetry.law.table.ApiManagementGatewayLlmLog | measured: present (HTTP 200) | {"workspaces":[{"workspace":"law-csa-loom-usgovvirginia","listed":true,"tableCount":859,"status":200}]} |
| telemetry.law.column.TraceRecords | measured: present (HTTP 200) | {"workspaces":[{"workspace":"law-csa-loom-usgovvirginia","listed":true,"tableCount":859,"status":200}]} |
| telemetry.law.kql.ApiManagementGatewayLlmLog | measured: present (HTTP 200) | {"workspace":"law-csa-loom-usgovvirginia"} |
| telemetry.law.kql.TraceRecords | measured: present (HTTP 200) | {"workspace":"law-csa-loom-usgovvirginia"} |

Pasted category list for `telemetry.diag.GatewayLlmLogs` (the full list, not a yes): AllMetrics, GatewayLogs

Requests logged: 9. Cells: 14 measured, 0 not-measured, 0 unknown.

## 2. W0-2: `llm-*` family and friends

Reading: see the answers table rows 4 to 7 and "How to read the unknown cells". On both gateways the named-value PUT, GET and DELETE worked (201, readable, 404 after delete), the positive control (a known-good `rate-limit-by-key` fragment) was accepted and read back, and cleanup ended at 0 leftovers.

#### commercial / policies - exit 3

APIM `apim-csa-loom-centralus` (resource group `rg-csa-loom-admin-centralus`): SKU PremiumV2 x1, state Succeeded, location Central US, virtualNetworkType Internal, publicNetworkAccess Enabled; runner in-vnet.

| control | status | detail |
|---|---|---|
| positive-known-good-fragment-accepted-and-returned | passed | a known-good rate-limit-by-key fragment was accepted and came back |
| negative-bogus-element-not-retained | unrunnable | the bogus element was not retained (unknown, HTTP 201) |

| cell | verdict | evidence |
|---|---|---|
| policies.namedValue.put | measured: accepted (HTTP 201) | {"put":{"status":201,"code":null,"message":null},"provisioningAfterPut":"Succeeded"} |
| policies.namedValue.get | measured: readable (displayName matches) (HTTP 201/200) | {"provisioningState":"Succeeded","displayNameMatches":true} |
| policies.namedValue.delete | measured: deleted (GET after DELETE: 404) (HTTP 200/404) |  |
| policies.control.positive | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"rate-limit-by-key":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><rate-limit-by-key calls=\\"10\\" renewal-period=\\"60\\" counter-key=\\"@(context.Request.IpAddress)\\" /></fragment>"} |
| policies.control.negative | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"sent":"<fragment><w0-apiplane-not-a-policy /></fragment>"} |
| policies.element.llm-token-limit.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"llm-token-limit":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /></fragment>"} |
| policies.element.llm-emit-token-metric.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"llm-emit-token-metric":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric></fragment>"} |
| policies.element.trace.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"trace":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace></fragment>"} |
| policies.element.validate-azure-ad-token.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"validate-azure-ad-token":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><audience>api://w0-apiplane-synthetic</audience></audiences></validate-azure-ad-token></fragment>"} |
| policies.element.include-fragment.single | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"sent":"<fragment><include-fragment fragment-id=\\"w0-apiplane-ctl-positive\\" /></fragment>"} |
| policies.element.rate-limit-by-key.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"rate-limit-by-key":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><rate-limit-by-key calls=\\"10\\" renewal-period=\\"60\\" counter-key=\\"@(context.Request.IpAddress)\\" /></fragment>"} |
| policies.element.quota-by-key.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"quota-by-key":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><quota-by-key calls=\\"10000\\" renewal-period=\\"3600\\" counter-key=\\"@(context.Request.IpAddress)\\" /></fragment>"} |
| policies.combined.put | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><audience>api://w0-apiplane-synthetic</audience></au... |
| policies.element.llm-token-limit.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"llm-token-limit","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><audi... |
| policies.element.llm-emit-token-metric.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"llm-emit-token-metric","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences... |
| policies.element.trace.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"trace","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><audience>api:/... |
| policies.element.validate-azure-ad-token.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"validate-azure-ad-token","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audienc... |
| policies.element.include-fragment.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"include-fragment","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><aud... |
| policies.element.rate-limit-by-key.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"rate-limit-by-key","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><au... |
| policies.element.quota-by-key.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"quota-by-key","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><audienc... |
| policies.include-fragment.apiScope | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"include-fragment":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<policies><inbound><base /><include-fragment fragment-id=\\"w0-apiplane-ctl-positive\\" /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>"} |
| policies.cleanup | measured: 0 leftovers (HTTP 200) | {"leftovers":0,"names":[],"sweep":{"start":{"deleted":0,"failed":[],"listFailures":[]},"end":{"deleted":8,"failed":[],"listFailures":[]}},"notOursButPrefixed":[]} |

Requests logged: 48. Cells: 12 measured, 0 not-measured, 10 unknown.

#### gov / policies - exit 3

APIM `apim-csa-loom-usgovvirginia` (resource group `rg-csa-loom-admin-usgovvirginia`): SKU Premium x1, state Succeeded, location USGov Virginia, virtualNetworkType Internal, publicNetworkAccess Enabled; runner hosted.

| control | status | detail |
|---|---|---|
| positive-known-good-fragment-accepted-and-returned | passed | a known-good rate-limit-by-key fragment was accepted and came back |
| negative-bogus-element-not-retained | unrunnable | the bogus element was not retained (unknown, HTTP 201) |

| cell | verdict | evidence |
|---|---|---|
| policies.namedValue.put | measured: accepted (HTTP 201) | {"put":{"status":201,"code":null,"message":null},"provisioningAfterPut":"Succeeded"} |
| policies.namedValue.get | measured: readable (displayName matches) (HTTP 201/200) | {"provisioningState":"Succeeded","displayNameMatches":true} |
| policies.namedValue.delete | measured: deleted (GET after DELETE: 404) (HTTP 200/404) |  |
| policies.control.positive | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"rate-limit-by-key":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><rate-limit-by-key calls=\\"10\\" renewal-period=\\"60\\" counter-key=\\"@(context.Request.IpAddress)\\" /></fragment>"} |
| policies.control.negative | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"sent":"<fragment><w0-apiplane-not-a-policy /></fragment>"} |
| policies.element.llm-token-limit.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"llm-token-limit":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /></fragment>"} |
| policies.element.llm-emit-token-metric.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"llm-emit-token-metric":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric></fragment>"} |
| policies.element.trace.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"trace":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace></fragment>"} |
| policies.element.validate-azure-ad-token.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"validate-azure-ad-token":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><audience>api://w0-apiplane-synthetic</audience></audiences></validate-azure-ad-token></fragment>"} |
| policies.element.include-fragment.single | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"sent":"<fragment><include-fragment fragment-id=\\"w0-apiplane-ctl-positive\\" /></fragment>"} |
| policies.element.rate-limit-by-key.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"rate-limit-by-key":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><rate-limit-by-key calls=\\"10\\" renewal-period=\\"60\\" counter-key=\\"@(context.Request.IpAddress)\\" /></fragment>"} |
| policies.element.quota-by-key.single | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"quota-by-key":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<fragment><quota-by-key calls=\\"10000\\" renewal-period=\\"3600\\" counter-key=\\"@(context.Request.IpAddress)\\" /></fragment>"} |
| policies.combined.put | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><audience>api://w0-apiplane-synthetic</audience></au... |
| policies.element.llm-token-limit.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"llm-token-limit","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><audi... |
| policies.element.llm-emit-token-metric.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"llm-emit-token-metric","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences... |
| policies.element.trace.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"trace","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><audience>api:/... |
| policies.element.validate-azure-ad-token.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"validate-azure-ad-token","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audienc... |
| policies.element.include-fragment.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"include-fragment","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><aud... |
| policies.element.rate-limit-by-key.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"rate-limit-by-key","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><au... |
| policies.element.quota-by-key.combined | unknown:tooling-error | {"put":{"status":201,"code":null,"message":null},"getBack":null,"getStatus":404,"note":null,"element":"quota-by-key","thisElement":null,"sent":"<fragment><llm-token-limit counter-key=\\"@(context.Request.IpAddress)\\" tokens-per-minute=\\"5000\\" estimate-prompt-tokens=\\"false\\" /><llm-emit-token-metric namespace=\\"w0-apiplane\\"><dimension name=\\"API ID\\" /></llm-emit-token-metric><trace source=\\"w0-apiplane\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"w0-apiplane\\" value=\\"probe\\" /></trace><validate-azure-ad-token tenant-id=\\"organizations\\"><audiences><audienc... |
| policies.include-fragment.apiScope | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"include-fragment":{"sent":1,"got":1}},"getStatus":200,"note":null,"sent":"<policies><inbound><base /><include-fragment fragment-id=\\"w0-apiplane-ctl-positive\\" /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>"} |
| policies.cleanup | measured: 0 leftovers (HTTP 200) | {"leftovers":0,"names":[],"sweep":{"start":{"deleted":0,"failed":[],"listFailures":[]},"end":{"deleted":8,"failed":[],"listFailures":[]}},"notOursButPrefixed":[]} |

Requests logged: 48. Cells: 12 measured, 0 not-measured, 10 unknown.

## 3. W0-3: MCP API type

Reading: on Commercial the type filter is accepted and the gateway holds 0 MCP APIs among its 4 APIs; a passthrough MCP API against `https://learn.microsoft.com/api/mcp` is accepted, its type is retained, and `mcpProperties` reads back as `{endpoints: null, isFederationRouter: false, federation: null}` (the shape was unknown beforehand; a passthrough API has no endpoints). An API-scoped policy (`rate-limit-by-key` plus `trace`) is accepted. The blank-path API and the `.well-known` operation are accepted on both gateways. On GCC-High every call that needs `2025-09-01-preview` fails with HTTP 400 `NoRegisteredProviderFound`: that version is not registered for `Microsoft.ApiManagement/service` in `usgovvirginia` (newest registered `2024-10-01-preview`, list in the answers section). The GCC-High control reads `unrunnable` because the unfiltered list used the same preview version (follow-up #5186 item 8).

#### commercial / mcp - exit 0

APIM `apim-csa-loom-centralus` (resource group `rg-csa-loom-admin-centralus`): SKU PremiumV2 x1, state Succeeded, location Central US, virtualNetworkType Internal, publicNetworkAccess Enabled; runner in-vnet.

| control | status | detail |
|---|---|---|
| a-list-call-answers-200-with-value | passed | the type-filtered list answered 200 with value[] |

| cell | verdict | evidence |
|---|---|---|
| mcp.list.typeFilter | measured: type filter accepted; 0 MCP API(s) returned (HTTP 200) | {"count":0} |
| mcp.list.mcpApiCount | measured: 0 of 4 API(s) are type mcp (HTTP 200) | {"total":4,"mcp":0,"truncated":false} |
| mcp.create.passthrough | measured: accepted (type mcp retained) (HTTP 201/200) | {"attempts":[{"variant":"A: transportType only","status":201,"code":null,"message":null,"sent":{"type":"mcp","path":"w0-apiplane-mcp","displayName":"w0-apiplane-mcp-api","description":"w0-apiplane scratch MCP API (deleted in the same run)","protocols":["https"],"serviceUrl":"https://learn.microsoft.com/api/mcp","subscriptionRequired":true,"mcpProperties":{"transportType":"streamable"}}}],"usedVariant":"A: transportType only","provisioningState":"Succeeded"} |
| mcp.create.mcpProperties | measured: {"endpoints":null,"isFederationRouter":false,"federation":null} (HTTP 200) | {"note":"verbatim GET-back of properties.mcpProperties; its shape was unknown a priori"} |
| mcp.create.policy | measured: accepted (HTTP 201/200) | {"put":{"status":201,"code":null,"message":null},"getBack":{"rate-limit-by-key":{"sent":1,"got":1},"trace":{"sent":1,"got":1}},"note":null,"sent":"<policies><inbound><base /><rate-limit-by-key calls=\\"5\\" renewal-period=\\"30\\" counter-key=\\"@(context.Request.IpAddress)\\" /><trace source=\\"w0-apiplane-mcp\\" severity=\\"information\\"><message>w0-apiplane probe</message><metadata name=\\"agent-id\\" value=\\"n/a\\" /></trace></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>"} |
| mcp.blankPath.api | measured: accepted (blank path) (HTTP 201) | {"sent":{"displayName":"w0-apiplane-mcp-wk","path":"","protocols":["https"],"subscriptionRequired":true}} |
| mcp.blankPath.wellKnownOperation | measured: accepted (urlTemplate retained) (HTTP 201/200) | {"sent":{"displayName":"w0-apiplane well-known","method":"GET","urlTemplate":"/.well-known/w0-apiplane-probe"},"gotUrlTemplate":"/.well-known/w0-apiplane-probe"} |
| mcp.cleanup | measured: 0 leftovers (HTTP 200) | {"leftovers":0,"names":[],"sweep":{"start":{"deleted":0,"failed":[],"listFailures":[]},"end":{"deleted":2,"failed":[],"listFailures":[]}},"notOursButPrefixed":[]} |

Requests logged: 24. Cells: 8 measured, 0 not-measured, 0 unknown.

#### gov / mcp - exit 0

APIM `apim-csa-loom-usgovvirginia` (resource group `rg-csa-loom-admin-usgovvirginia`): SKU Premium x1, state Succeeded, location USGov Virginia, virtualNetworkType Internal, publicNetworkAccess Enabled; runner hosted.

| control | status | detail |
|---|---|---|
| a-list-call-answers-200-with-value | unrunnable | no list call answered (filtered HTTP 400, unfiltered HTTP 400) |

| cell | verdict | evidence |
|---|---|---|
| mcp.list.typeFilter | not-measured:api-version-unsupported-in-boundary | {"status":400,"code":"NoRegisteredProviderFound","message":"No registered resource provider found for location 'usgovvirginia' and API version '2025-09-01-preview' for type 'service'. The supported api-versions are '2014-02-14, 2015-09-15, 2016-07-07, 2016-10-10, 2017-03-01, 2018-01-01, 2018-06-01-preview, 2019-01-01, 2019-12-01-preview, 2019-12-01, 2020-06-...","apiVersion":"2025-09-01-preview"} |
| mcp.list.mcpApiCount | not-measured:api-version-unsupported-in-boundary | {"status":400,"code":"NoRegisteredProviderFound","message":"No registered resource provider found for location 'usgovvirginia' and API version '2025-09-01-preview' for type 'service'. The supported api-versions are '2014-02-14, 2015-09-15, 2016-07-07, 2016-10-10, 2017-03-01, 2018-01-01, 2018-06-01-preview, 2019-01-01, 2019-12-01-preview, 2019-12-01, 2020-06-...","apiVersion":"2025-09-01-preview"} |
| mcp.create.passthrough | not-measured:api-version-unsupported-in-boundary | {"status":400,"code":"NoRegisteredProviderFound","message":"No registered resource provider found for location 'usgovvirginia' and API version '2025-09-01-preview' for type 'service'. The supported api-versions are '2014-02-14, 2015-09-15, 2016-07-07, 2016-10-10, 2017-03-01, 2018-01-01, 2018-06-01-preview, 2019-01-01, 2019-12-01-preview, 2019-12-01, 2020-06-...","apiVersion":"2025-09-01-preview"} |
| mcp.create.mcpProperties | not-measured:api-version-unsupported-in-boundary | {"dependsOn":"mcp.create.passthrough","status":400,"code":"NoRegisteredProviderFound","message":"No registered resource provider found for location 'usgovvirginia' and API version '2025-09-01-preview' for type 'service'. The supported api-versions are '2014-02-14, 2015-09-15, 2016-07-07, 2016-10-10, 2017-03-01, 2018-01-01, 2018-06-01-preview, 2019-01-01, 2019-12-01-preview, 2019-12-01, 2020-06-...","apiVersion":"2025-09-01-preview"} |
| mcp.create.policy | not-measured:api-version-unsupported-in-boundary | {"dependsOn":"mcp.create.passthrough","status":400,"code":"NoRegisteredProviderFound","message":"No registered resource provider found for location 'usgovvirginia' and API version '2025-09-01-preview' for type 'service'. The supported api-versions are '2014-02-14, 2015-09-15, 2016-07-07, 2016-10-10, 2017-03-01, 2018-01-01, 2018-06-01-preview, 2019-01-01, 2019-12-01-preview, 2019-12-01, 2020-06-...","apiVersion":"2025-09-01-preview"} |
| mcp.blankPath.api | measured: accepted (blank path) (HTTP 201) | {"sent":{"displayName":"w0-apiplane-mcp-wk","path":"","protocols":["https"],"subscriptionRequired":true}} |
| mcp.blankPath.wellKnownOperation | measured: accepted (urlTemplate retained) (HTTP 201/200) | {"sent":{"displayName":"w0-apiplane well-known","method":"GET","urlTemplate":"/.well-known/w0-apiplane-probe"},"gotUrlTemplate":"/.well-known/w0-apiplane-probe"} |
| mcp.cleanup | measured: 0 leftovers (HTTP 200) | {"leftovers":0,"names":[],"sweep":{"start":{"deleted":0,"failed":[],"listFailures":[]},"end":{"deleted":1,"failed":[],"listFailures":[]}},"notOursButPrefixed":[]} |

Requests logged: 20. Cells: 3 measured, 5 not-measured, 0 unknown.

## 4. W0-4: Entra Agent ID and Graph

Reading: on Commercial the Graph service principal exposes `AgentIdentity.Create.All`, `AgentIdentity.CreateAsManager`, `AgentIdentity.DeleteRestore.All`, `AgentIdentity.EnableDisable.All`, `AgentIdentity.Read.All` and `AgentIdentity.ReadWrite.All`. The count of app roles read 777 on the first run and 769 on the second, two hours apart: the count is not a stable quantity, the presence of those roles was. The Console UAMI holds 15 Graph roles (none `AgentIdentity.*`). The sign-in app is found by its exact display name (which contains the Key Vault name) and carries `groupMembershipClaims: SecurityGroup`. The first run matched two apps on the name prefix; the code-reading explanation (the in-bicep app is named with the resource group, the script with the Key Vault name) is tracked as #5184 and was not measured live. On GCC-High the Graph read answers 403 `Authorization_RequestDenied`: the Government deploy SP lacks `Application.Read.All` (application permission, admin-consented in the Government tenant), so all three cells are `unknown:permission`, never "no". Remediation: grant that permission, then re-run the `identity` family (Q19).

#### commercial / identity - exit 0

APIM `apim-csa-loom-centralus` (resource group `rg-csa-loom-admin-centralus`): SKU PremiumV2 x1, state Succeeded, location Central US, virtualNetworkType Internal, publicNetworkAccess Enabled; runner in-vnet.

| control | status | detail |
|---|---|---|
| graph-service-principal-read-succeeded | passed | the Graph service principal answered 200 with 769 app roles |

| cell | verdict | evidence |
|---|---|---|
| identity.graph.agentIdentityReadAll | measured: yes (HTTP 200) | {"appRoleCount":769,"applicationRoleCount":767,"agentIdentityRoles":["AgentIdentity.Create.All","AgentIdentity.CreateAsManager","AgentIdentity.DeleteRestore.All","AgentIdentity.EnableDisable.All","AgentIdentity.Read.All","AgentIdentity.ReadWrite.All"]} |
| identity.uami.graphAppRoles | measured: {"uami":"uami-loom-console-centralus","graphAppRoles":["Application.Read.All","Directory.Read.All","Files.Read.All","Group.Read.All","Group.ReadWrite.All","GroupMember.ReadWrite.All","InformationProtectionPolicy.Read.All","Policy.Read.All","SecurityEvents.Read.All","SecurityIncident.Read.All","SensitivityLabel.Evaluate","Sites.Read.All","User.Invite.All","User.Read.All","User.ReadWrite.All"],"graphAssignmentsWithUnresolvedRoleName":0,"assignmentsToOtherApis":1} (HTTP 200/200) | {"uamisMatched":1,"uamisRead":1} |
| identity.signinApp.groupMembershipClaims | measured: yes (HTTP 200) | {"groupMembershipClaims":"SecurityGroup","matchedApps":1,"matchedBy":"exact-display-name","matchedDisplayName":"CSA Loom Console (kv-loom-k6mvh5sm6z7do)","exactNamesSearched":["CSA Loom Console (kv-loom-k6mvh5sm6z7do)"],"exactNameStepSkipped":null,"searchedDisplayNamePrefix":"CSA Loom Console"} |

Requests logged: 7. Cells: 3 measured, 0 not-measured, 0 unknown.

#### gov / identity - exit 0

APIM `apim-csa-loom-usgovvirginia` (resource group `rg-csa-loom-admin-usgovvirginia`): SKU Premium x1, state Succeeded, location USGov Virginia, virtualNetworkType Internal, publicNetworkAccess Enabled; runner hosted.

| control | status | detail |
|---|---|---|
| graph-service-principal-read-succeeded | unrunnable | the Graph service principal could not be read (HTTP 403) |

| cell | verdict | evidence |
|---|---|---|
| identity.graph.agentIdentityReadAll | unknown:permission:Application.Read.All@tenant | {"status":403,"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."} |
| identity.uami.graphAppRoles | unknown:permission:Application.Read.All@tenant | {"note":"role names could not be resolved: the Graph service principal was not read"} |
| identity.signinApp.groupMembershipClaims | unknown:permission:Application.Read.All@tenant | {"status":403,"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation.","exactNamesSearched":["CSA Loom Console (kv-loom-dcmt6cqoezlgs)"],"exactNameStepSkipped":null,"searchedDisplayNamePrefix":"CSA Loom Console"} |

Requests logged: 6. Cells: 0 measured, 0 not-measured, 3 unknown.

## 5. W0-5: Azure Retail Prices coverage

Reading: two runs of `scripts/measure/apiplane/retail-prices-coverage.mjs` against the public API, on 2026-10-29, after the lane author's own two runs (identical counts, 26 minutes apart). The default service pair exits 2 by design: `Azure OpenAI` returns 0 rows in every Commercial region and in the all-region census, so the instrument says it is blind instead of printing a Government zero. The OpenAI rows are served under `Foundry Models` (productName `Azure OpenAI`, `Azure OpenAI GPT5`, and others). For `Foundry Models` Government **does** have rows, so Learn's "This version only supports prices on Commercial Cloud" sentence does not hold for these meters; a Government row is not proof the model can be deployed there. The family key is a documented heuristic (productName and the model parsed from the free-text meterName). Exit 3 is `--require-gov-coverage` firing: 277 Commercial families have no Government row.

Default pair (exit 2). Command: `node scripts/measure/apiplane/retail-prices-coverage.mjs --json <file>`. The `Foundry Models` section (lines 39 to 348 of the output) repeats the second run and is omitted here.

```text
Azure Retail Prices coverage - Azure OpenAI / Foundry Models (api-version 2023-01-01-preview, one request chain per region, page cap 200)

service        | region family                | region                 | rows         | distinct meters | query URL
---------------+------------------------------+------------------------+--------------+-----------------+----------
Azure OpenAI   | Government                   | usgovvirginia          | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'usgovvirginia'
Azure OpenAI   | Government                   | usgovarizona           | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'usgovarizona'
Azure OpenAI   | Government                   | usgovtexas             | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'usgovtexas'
Azure OpenAI   | Government                   | usgoviowa              | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'usgoviowa'
Azure OpenAI   | Government                   | usdodeast              | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'usdodeast'
Azure OpenAI   | Government                   | usdodcentral           | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'usdodcentral'
Azure OpenAI   | Commercial                   | eastus                 | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'eastus'
Azure OpenAI   | Commercial                   | eastus2                | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'eastus2'
Azure OpenAI   | Commercial                   | centralus              | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'centralus'
Azure OpenAI   | Commercial                   | westus                 | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'westus'
Azure OpenAI   | Commercial                   | westus3                | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'westus3'
Azure OpenAI   | Commercial                   | swedencentral          | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'swedencentral'
Azure OpenAI   | Census (all regions)         | (all regions) [census] | 0            | 0               | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'
Foundry Models | Government                   | usgovvirginia          | 310          | 306             | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usgovvirginia'
Foundry Models | Government                   | usgovarizona           | 301          | 297             | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usgovarizona'
Foundry Models | Government                   | usgovtexas             | 4            | 4               | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usgovtexas'
Foundry Models | Government                   | usgoviowa              | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usgoviowa'
Foundry Models | Government                   | usdodeast              | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usdodeast'
Foundry Models | Government                   | usdodcentral           | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usdodcentral'
Foundry Models | Government                   | US Gov [census]        | 4            | 4               | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'
Foundry Models | Commercial                   | eastus                 | 1863         | 1831            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'
Foundry Models | Commercial                   | eastus2                | 1934         | 1902            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus2'
Foundry Models | Commercial                   | centralus              | 1422         | 1397            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'centralus'
Foundry Models | Commercial                   | westus                 | 1823         | 1791            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'westus'
Foundry Models | Commercial                   | westus3                | 1836         | 1804            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'westus3'
Foundry Models | Commercial                   | swedencentral          | 1936         | 1905            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'swedencentral'
Foundry Models | Commercial (Global/DataZone) | Global [census]        | 18           | 18              | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'
Foundry Models | Census (all regions)         | (all regions) [census] | 39461        | 2081            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'

== Azure OpenAI ==
  positive control: NOT ESTABLISHED
  census: 0 armRegionName values, 0 rows; Global/DataZone-style: none; Government-style outside the queried 6: none
  ABSENT in Government: NOT COMPUTED (0 count(s) FAILED or the positive control failed; a family is never called absent from a partial read)

... (lines 39-348 omitted: the Foundry Models section, identical to the run below) ...
requests sent: 71 (sequential, >= 200 ms apart)
RESULT: FAILED - Azure OpenAI: INSTRUMENT BLIND - all 6 Commercial region queries returned 0 rows and the all-region census returned 0 rows too, so this serviceName has no price rows in any region (use --services to measure the names that do); a Government zero would be indistinguishable from a wrong filter (Learn: filter values are case sensitive) (exit 2)
```

`Foundry Models` with the coverage gate (exit 3). Command: `node scripts/measure/apiplane/retail-prices-coverage.mjs --services "Foundry Models" --require-gov-coverage --json <file>`. The list of 277 absent families (lines 52 to 330) is truncated to its first 20 names; the exact count is above and in the footer.

```text
Azure Retail Prices coverage - Foundry Models (api-version 2023-01-01-preview, one request chain per region, page cap 200)

service        | region family                | region                 | rows         | distinct meters | query URL
---------------+------------------------------+------------------------+--------------+-----------------+----------
Foundry Models | Government                   | usgovvirginia          | 310          | 306             | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usgovvirginia'
Foundry Models | Government                   | usgovarizona           | 301          | 297             | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usgovarizona'
Foundry Models | Government                   | usgovtexas             | 4            | 4               | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usgovtexas'
Foundry Models | Government                   | usgoviowa              | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usgoviowa'
Foundry Models | Government                   | usdodeast              | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usdodeast'
Foundry Models | Government                   | usdodcentral           | 0 (measured) | 0 (measured)    | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'usdodcentral'
Foundry Models | Government                   | US Gov [census]        | 4            | 4               | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'
Foundry Models | Commercial                   | eastus                 | 1863         | 1831            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'
Foundry Models | Commercial                   | eastus2                | 1934         | 1902            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus2'
Foundry Models | Commercial                   | centralus              | 1422         | 1397            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'centralus'
Foundry Models | Commercial                   | westus                 | 1823         | 1791            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'westus'
Foundry Models | Commercial                   | westus3                | 1836         | 1804            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'westus3'
Foundry Models | Commercial                   | swedencentral          | 1936         | 1905            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'swedencentral'
Foundry Models | Commercial (Global/DataZone) | Global [census]        | 18           | 18              | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'
Foundry Models | Census (all regions)         | (all regions) [census] | 39461        | 2081            | https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'

== Foundry Models ==
  positive control: eastus returned 1863 rows (a Commercial per-region query, the same filter shape as the Government ones)
  census: 51 armRegionName values, 39461 rows; Global/DataZone-style: Global (18); Government-style outside the queried 6: US Gov (4)
  product groups (the API productName; distinct meters, Commercial side / Government side):
    Azure AI Foundry Provisioned Throughput Reservation: 3 / 2
    Azure BFL Flux Models: 19 / 12
    Azure Baseten Models: 2 / 0
    Azure Deepseek Models: 65 / 32
    Azure Fal: 25 / 0
    Azure Fireworks Models: 71 / 0
    Azure Grok Models: 71 / 50
    Azure Kimi: 31 / 28
    Azure Llama Models: 27 / 8
    Azure Mistral Models: 43 / 22
    Azure OpenAI: 515 / 57
    Azure OpenAI Embedding: 3 / 0
    Azure OpenAI GPT5: 431 / 21
    Azure OpenAI GPT6: 134 / 0
    Azure OpenAI Media: 248 / 0
    Azure OpenAI OSS Models: 20 / 2
    Azure OpenAI PP FT GPT4s: 37 / 0
    Azure OpenAI Reasoning: 50 / 0
    Azure Phi Models: 77 / 0
    Cohere Models: 26 / 24
    FT Models: 20 / 4
    Foundry Local Azure Open AI: 1 / 1
    MAI Models: 61 / 51
    Managed Compute: 4 / 0
    Microsoft Agent Pre-Purchase Plan: 3 / 3
    Microsoft Decision Models: 1 / 0
  model families (heuristic: productName :: model from meterName; raw names in the JSON): Commercial 390, Government 114
  ABSENT in Government (277):
    - Azure BFL Flux Models :: provisioned managed
    - Azure Baseten Models :: provisioned managed
    - Azure Deepseek Models :: mai ds r1
    - Azure Deepseek Models :: provisioned managed
    - Azure Deepseek Models :: provisioned throughput
    - Azure Deepseek Models :: r1
    - Azure Deepseek Models :: v3
    - Azure Deepseek Models :: v3 1
    - Azure Fal :: fal test ltx 2 5 fast im vd 1080 video
    - Azure Fal :: fal test ltx 2 5 fast im vd 1440 video
    - Azure Fal :: fal test ltx 2 5 fast im vd 4k video
    - Azure Fal :: fal test ltx 2 5 fast txt vd 1080 video
    - Azure Fal :: fal test ltx 2 5 fast txt vd 1440 video
    - Azure Fal :: fal test ltx 2 5 fast txt vd 4k video
    - Azure Fal :: fal test ltx 2 5 fast txt vd 720 video
    - Azure Fal :: fal test ltx 2 5 pro im vd 1080 video
    - Azure Fal :: fal test ltx 2 5 pro im vd 720 video
    - Azure Fal :: fal test ltx 2 5 pro txt vd 720 video
    - Azure Fal :: fal test mm h3 mx im vd 1080 video
... (lines 72-330 omitted: 257 more family names; the JSON is not committed) ...
requests sent: 58 (sequential, >= 200 ms apart)
RESULT: COVERAGE_GAP - --require-gov-coverage: 277 model families present in Commercial have zero Government rows (Foundry Models: 277) (exit 3)
```

## 6. W0-6: named-value propagation latency

Reading: Commercial, 7.1 s for value B measured from the named-value update reaching `Succeeded` (7.3 s from the PUT returning), and 5.3 s for value A, whose clock starts when the API policy PUT is accepted, so it includes API and policy propagation. Both are far below the 15-minute "not observed" limit. The scratch API and the named value were deleted and read back as 404. GCC-High: all three data-plane cells are `not-measured:gateway-unreachable-from-runner` (DNS), the VNet-internal gateway against a hosted runner; cleanup is measured at 0 leftovers. Declared gap, section 9.

#### commercial / latency - exit 0

APIM `apim-csa-loom-centralus` (resource group `rg-csa-loom-admin-centralus`): SKU PremiumV2 x1, state Succeeded, location Central US, virtualNetworkType Internal, publicNetworkAccess Enabled; runner in-vnet.

| control | status | detail |
|---|---|---|
| value-A-observed-at-the-gateway | passed | the gateway answered the first value, so the scratch API works |

| cell | verdict | evidence |
|---|---|---|
| latency.valueA | measured: 5.3 s (HTTP 200) | {"polls":{"polls":5,"matched":1,"otherBodies":0,"notOk":4,"statuses":{"200":1,"404":4},"sampleOtherBody":null},"clockStartedAt":"the API policy PUT was accepted (so this also includes the API and policy propagation)","observedValue":"A"} |
| latency.valueB | measured: 7.1 s (HTTP 200) | {"polls":{"polls":8,"matched":1,"otherBodies":6,"notOk":1,"statuses":{"200":7,"404":1},"sampleOtherBody":"A-d2037b8c"},"clockStartedAt":"the named value update reached provisioningState Succeeded","secondsFromPutReturned":7.3,"observedValue":"B"} |
| latency.delete.proof | measured: both scratch objects deleted (GET: 404 / 404) (HTTP 404/404) |  |
| latency.cleanup | measured: 0 leftovers (HTTP 200) | {"leftovers":0,"names":[],"sweep":{"start":{"deleted":0,"failed":[],"listFailures":[]},"end":{"deleted":0,"failed":[],"listFailures":[]}},"notOursButPrefixed":[]} |

Requests logged: 26. Cells: 4 measured, 0 not-measured, 0 unknown.

#### gov / latency - exit 0

APIM `apim-csa-loom-usgovvirginia` (resource group `rg-csa-loom-admin-usgovvirginia`): SKU Premium x1, state Succeeded, location USGov Virginia, virtualNetworkType Internal, publicNetworkAccess Enabled; runner hosted.

| cell | verdict | evidence |
|---|---|---|
| latency.valueA | not-measured:gateway-unreachable-from-runner | {"errorClass":"dns","runner":"hosted"} |
| latency.valueB | not-measured:gateway-unreachable-from-runner | {"errorClass":"dns","runner":"hosted"} |
| latency.delete.proof | not-measured:gateway-unreachable-from-runner | {"errorClass":"dns","runner":"hosted"} |
| latency.cleanup | measured: 0 leftovers (HTTP 200) | {"leftovers":0,"names":[],"sweep":{"start":{"deleted":0,"failed":[],"listFailures":[]},"end":{"deleted":0,"failed":[],"listFailures":[]}},"notOursButPrefixed":[]} |

Requests logged: 14. Cells: 1 measured, 3 not-measured, 0 unknown.

## 7. W0-7: Anthropic-on-Foundry availability, and Prompt Shields

Reading: Commercial lists 14 Anthropic-format models in `centralus` (`claude-fable-5-1`, `claude-haiku-4-5`, `claude-haiku-5-5`, `claude-opus-4-5`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`, `claude-opus-5-5-fast`, `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-sonnet-5-5`) out of 310 models in 12 formats, and `*.services.ai.azure.com` resolves privately from the in-VNet runner for a discovered AI Services account. GCC-High lists 22 models in `usgovvirginia`, all `OpenAI` format, so **no Anthropic model is listed in Government** (a measured answer: the call returned 200 with a well-formed body). The Government VNet DNS verdict is not measured: a hosted runner's `nxdomain` is the public view. The Learn pages that describe Azure Government model availability list OpenAI-family models only and are silent on partner models.

#### commercial / foundry - exit 0

APIM `apim-csa-loom-centralus` (resource group `rg-csa-loom-admin-centralus`): SKU PremiumV2 x1, state Succeeded, location Central US, virtualNetworkType Internal, publicNetworkAccess Enabled; runner in-vnet.

| control | status | detail |
|---|---|---|
| models-list-is-a-real-list | passed | the Commercial list contains format OpenAI |

| cell | verdict | evidence |
|---|---|---|
| foundry.models.anthropic | measured: claude-fable-5-1, claude-haiku-4-5, claude-haiku-5-5, claude-opus-4-5, claude-opus-4-6, claude-opus-4-7, claude-opus-4-8, claude-opus-5, claude-opus-5-5, claude-opus-5-5-fast, claude-sonnet-4-5, claude-sonnet-4-6, claude-sonnet-5, claude-sonnet-5-5 (HTTP 200) | {"location":"centralus","command":"GET /subscriptions/{subscription}/providers/Microsoft.CognitiveServices/locations/centralus/models?api-version=2024-10-01","anthropicModelCount":14,"totalModels":310} |
| foundry.models.formats | measured: {"formats":["Alibaba","Anthropic","Black Forest Labs","Cohere","DeepSeek","Meta","Microsoft","Mistral AI","MoonshotAI","OpenAI","OpenAI-OSS","xAI"],"totalModels":310} (HTTP 200) | {"location":"centralus","command":"GET /subscriptions/{subscription}/providers/Microsoft.CognitiveServices/locations/centralus/models?api-version=2024-10-01"} |
| foundry.dns.servicesAiAzureCom | measured: resolves-private (source: dns-lookup-from-in-vnet-runner) | {"hostPattern":"*.services.ai.azure.com","nameSource":"discovered-ai-services-account","accountListStatus":200,"accountListTruncated":false,"runner":"in-vnet"} |

Requests logged: 4. Cells: 3 measured, 0 not-measured, 0 unknown.

#### gov / foundry - exit 0

APIM `apim-csa-loom-usgovvirginia` (resource group `rg-csa-loom-admin-usgovvirginia`): SKU Premium x1, state Succeeded, location USGov Virginia, virtualNetworkType Internal, publicNetworkAccess Enabled; runner hosted.

| control | status | detail |
|---|---|---|
| models-list-is-a-real-list | passed | a 200 with a well-formed body (22 entries; an empty list is a measured answer) |

| cell | verdict | evidence |
|---|---|---|
| foundry.models.anthropic | measured: none listed (HTTP 200) | {"location":"usgovvirginia","command":"GET /subscriptions/{subscription}/providers/Microsoft.CognitiveServices/locations/usgovvirginia/models?api-version=2024-10-01","anthropicModelCount":0,"totalModels":22} |
| foundry.models.formats | measured: {"formats":["OpenAI"],"totalModels":22} (HTTP 200) | {"location":"usgovvirginia","command":"GET /subscriptions/{subscription}/providers/Microsoft.CognitiveServices/locations/usgovvirginia/models?api-version=2024-10-01"} |
| foundry.dns.servicesAiAzureCom | not-measured:no-in-boundary-runner | {"hostPattern":"*.services.ai.azure.com","nameSource":"discovered-ai-services-account","accountListStatus":200,"accountListTruncated":false,"runner":"hosted","hostedRunnerView":"nxdomain","note":"a GitHub-hosted runner is not inside the boundary VNet: what it resolves is the public view, not a VNet verdict"} |

Requests logged: 3. Cells: 2 measured, 1 not-measured, 0 unknown.

### Prompt Shields in Azure Government - Learn lookup (#4442 Wave 0 task 3)

Retrieved 2026-10-29. No Azure call in any boundary (the task's own acceptance:
"a Learn/portal statement naming Azure Government explicitly, or an in-boundary
observation if one is cheaper").

| Page | ms.date | Names Azure Government for Prompt Shields? |
|---|---|---|
| ai-services/content-safety/overview | 2026-10-20 | No. Lists Prompt Shields as a feature; "region availability" is a link to the page below. |
| ai-services/content-safety/region-availability | 2026-09-18 | No. 10 mentions of Prompt Shields; 0 lines naming Gov / sovereign / FedRAMP / usgov / DoD / IL levels. |
| ai-services/content-safety/concepts/jailbreak-detection (Prompt Shields) | 2026-08-28 | No. 0 Gov lines. |
| foundry/foundry-models/concepts/models-sold-directly-by-azure-gov | 2026-09-01 | Silent on content filtering and Prompt Shields. Lists OpenAI-family models only for usgovarizona and usgovvirginia (GPT-5.6, GPT-5.1, GPT-4.1, o3-mini, GPT-4o, embeddings); no partner models. |
| azure-government/compare-azure-government-global-azure | 2025-08-21 | Silent. Endpoint table has no Azure AI Content Safety row (Content Moderator, Azure OpenAI `openai.azure.us` only). |

Method: `curl` the page, strip tags, grep `gov|sovereign|fedramp|usgov|dod|il[2456]`.
Positive controls, run before publishing "none": the same pipeline on the
Government comparison page returns 130 matching lines; the region page carries a
real region table (matches `east us|west europe|sweden`). So the empty result on
the Content Safety pages is a measured absence, not a blind grep.

**Result: UNVERIFIED.** Learn does not state Prompt Shields availability in Azure
Government (GCC-High or IL5). No in-boundary observation exists: IL5 has never
deployed and no `shieldPrompt` call has been made in GCC-High. #4442 Wave 0 task 3
therefore stays open as a declared gap; Prompt Shields coverage must not be
claimed for either boundary until a data-plane call is observed there.

Side facts confirmed on the comparison page (cross-check for the probe's endpoints):
ARM `management.usgovcloudapi.net`; Log Analytics data plane `api.loganalytics.us`;
APIM gateway suffix `azure-api.us`; only listed APIM Gov limitation is Azure AD B2C
integration. For W0-7: the Gov models page names no Anthropic or other partner model.

## 8. Loom facts at a pinned SHA and Mosaic port sources (W0-8)

**Loom pin:** `007da59c49350ccab0c79e4cbeab62e883c5264c` (origin/main)
**Mosaic pin:** `7e92e8753f49312bbb48e313812ef94a6e866793` (microsoft/mosaic-apim HEAD)

Produced by a read-only agent (Loom read only through `git show` / `git grep` at the pin;
Mosaic read only through raw.githubusercontent.com at the Mosaic pin, no clone, no file
written). **Verification by the orchestrator, 2026-10-29:** the same commands were re-run and
reproduce exactly: the 77 / 83 / 46 `LOOM_APIM_NAME` counts (8.1), the 24 non-comment lines in
23 files for `apimConfigGate()` (the two extra lines a plain grep finds are a comment at
`apps/fiab-console/app/api/apim/apis/route.ts:24` and a doc line at
`apps/fiab-console/docs/fiab/parity/apim-service.md:15`), `main.json` path, size and headroom
(8.7), the three citations of 7,624 at the pin, the `health.bicep` header (8.7), the Mosaic HEAD,
and #5143 being open. A repeat of the same command at a pinned SHA is deterministic, not an
independent method. NOT re-run by the orchestrator: the route, export and job listings (8.2-8.6)
and every Mosaic per-file line count and symbol line (8.8); those rest on the agent's reads, with
the commands shown at the end.

### Summary

1. `platform/fiab/bicep/main.json` does not exist at the pin. The ARM artifact is
   `apps/fiab-console/deploy-templates/main.json`: 3,997,911 B, so headroom is **196,393 B**. The
   7,624 B in `LOOM-INTEGRATION.md:87` and `RISKS-AND-OPEN-DECISIONS.md:65` is 4,194,304 -
   4,186,680, the W1-1 intermediate size (`health.bicep:5-11`), superseded when the stamp left
   `main.bicep`. It does not hold at the pin, so the premise that the plane's worker job and
   vault must be their own deploy units (W4-3, W8-1) was built on a stale number and needs a
   decision.
2. `LOOM_APIM_NAME`: 77 matching lines, 83 matches, 46 files tree-wide; 6 lines in 4 files read
   it at runtime. The real gate is `apimConfigGate()`, called at 23 sites.
3. `apim-client.ts` has no fragments, MCP, backend pools, circuit breakers, diagnostics or
   loggers (each greps to 0, positive control passes). Key Vault named values exist. It pins
   api-version `2024-06-01-preview`.
4. ADR-010 names no path for the operation sets or rollup fold rules; resolved to
   `model_apis.py`, `usage_rollup.py` and `usage_telemetry.py`.
5. All 20 Mosaic files were read in full. None has a per-file MIT header; only the root `LICENSE`
   is MIT, so the ADR-010 header is the only per-file notice.
6. The port files import six Mosaic modules that ADR-010 does not list (8.9): `domain.py`,
   `pricing.py`, `model_pools.py`, `policy_semantics.py`, `budgets.py`, `errors.py`. All six are
   UNREAD. The port list is therefore incomplete as a dependency closure.

### 8.0 Pins and method

| fact | value | source |
|---|---|---|
| Loom pin is a commit | commit; "docs(prp): Loom API & AI Gateway Plane PRD + PRP set (Mosaic fold-in) (#5180)", 2026-10-29 13:19 -0400 | `git cat-file -t 007da59c49350ccab0c79e4cbeab62e883c5264c`; `git log -1` |
| PRP set path at pin | `PRPs/backlog/loom-api-gateway-plane/` (the integration branch has `PRPs/active/...`). ADR-010 blob `f01229f2e882b29266fbe1cac2ccc1304876df84` and `research/mosaic-apim-sources.md` blob `1c2f5b97b086f73a74c68e3e04ab927f000938e3` are identical at the pin and on `feat/apigw-w00-measurement-spike`; the W00 PRP file differs (pin `004be3d9...`, branch `9920d77b...`) | `git rev-parse <ref>:<path>` on both sides |
| Mosaic SHA | `7e92e8753f49312bbb48e313812ef94a6e866793`, 2026-10-23T16:58:00Z, "Make capability menu width dynamic and prevent page overflow (#155)" | `curl https://api.github.com/repos/microsoft/mosaic-apim/commits/HEAD` and `git ls-remote https://github.com/microsoft/mosaic-apim HEAD` (identical; ls-remote re-run by the orchestrator) |
| Prescribed resolution command | FAILED: `gh api repos/microsoft/mosaic-apim/commits/HEAD --jq .sha` returned HTTP 403 "Resource protected by organization SAML enforcement" (the local gh token is not SSO-authorised for the microsoft org) | command output |
| Read-only discipline | Loom read only via `git show` / `git grep` at the pin; Mosaic read only via `curl -sL raw.githubusercontent.com/.../7e92e875.../<path> \| sed -n 'A,Bp'`; no clone, no file written | n/a |

### 8.1 `LOOM_APIM_NAME` gate sites (row 1)

| fact | value | source |
|---|---|---|
| Exact grep and units | `git grep -n -I LOOM_APIM_NAME <pin>` = 77 matching LINES (grep counts lines, not occurrences); `-o` = 83 matches (occurrences); `-l` = 46 files. Whole tree, all file types | commands block |
| Lines / files by class (file counts overlap across classes, so they sum above 46) | runtime read of `process.env.LOOM_APIM_NAME` 6/4; gate declared by name 4/4; message or comment text in app+lib 19/13; bicep or script wiring 2/2; tests 25/11; PRP text 4/4; docs 14/10; `.gitleaks.toml` 2/1; generated ARM 1/1. Lines sum to 77 | classifier run over the same grep output |
| Strict gate sites: runtime reads (6 lines, 4 files) | `apps/fiab-console/lib/azure/apim-client.ts:64` (default fallback), `:80` (empty-string gate), `:90` (`apimTarget`); `apps/fiab-console/app/api/admin/scaling/apim/route.ts:29`; `apps/fiab-console/app/api/admin/scaling/utilization/route.ts:257`; `apps/fiab-console/app/api/marketplace/_gate.ts:24` | each path:line at pin |
| Gate inputs declared by name (4 lines, 4 files) | `apps/fiab-console/lib/gates/registry/builders.ts:53` (`loaders: { LOOM_APIM_NAME: L.apim }`); `apps/fiab-console/lib/admin/env-checks/builders.ts:190`; `apps/fiab-console/lib/admin/env-checks/core.ts:317`; `apps/fiab-console/lib/deploy/adoption-catalog.ts:480` | each path:line at pin |
| Funnel | `apimConfigGate()` is defined at `apps/fiab-console/lib/azure/apim-client.ts:75`. Its `LOOM_APIM_NAME` arm (`:80`) fires only when the variable is the empty string, because unset falls back to `apim-csa-loom-eastus2` (`:64`, `:90`) | `apps/fiab-console/lib/azure/apim-client.ts:75-84` |
| 23 `apimConfigGate()` call sites in 23 files (non-test, non-comment; 24 lines incl. the definition at :75) | `apps/fiab-console/app/api/apim/` + `{apis:27, backends:30, developer-portal:31, gateways:20, import:30, named-values:37, operations:20, products:22, service:35, subscriptions/[sid]/keys:20, subscriptions/[sid]:27, subscriptions:24}/route.ts`; `apps/fiab-console/app/api/items/` + `{aip-logic/[id]/publish:86, apim-api/[id]/operations:29, apim-api:24, apim-policy:21, apim-product:24, data-product/[id]/publish-api:71, loom-app-runtime/[id]/publish-api:49, ontology-sdk/[id]/publish:61}/route.ts`; `apps/fiab-console/app/api/dab/[id]/publish/route.ts:42`; `apps/fiab-console/lib/admin/health-probes.ts:655`; `apps/fiab-console/lib/azure/apim-client.ts:404` | `git grep -n 'apimConfigGate()'` minus comments and tests (re-run by the orchestrator: 24 non-comment lines, 23 files) |
| Env wiring and generated | `platform/fiab/bicep/modules/admin-plane/main.bicep:5500`; `scripts/csa-loom/patch-navigator-env.sh:123`; `apps/fiab-console/deploy-templates/main.json:17065` (generated) | each path:line |
| Message-only files (13) | `app/admin/api-management/page.tsx`, `app/api/apim/developer-portal/route.ts`, `app/api/apim/service/route.ts`, `app/api/dab/[id]/publish/route.ts`, `app/api/items/apim-policy/route.ts`, `app/api/items/data-product/[id]/publish-api/route.ts`, `app/api/admin/scaling/apim/route.ts`, `app/api/admin/scaling/utilization/route.ts`, `app/api/marketplace/_gate.ts`, `lib/admin/env-checks/builders.ts`, `lib/admin/health-probes.ts`, `lib/components/apim/apim-tree.tsx`, `lib/components/marketplace/unified-discover.tsx` (all under `apps/fiab-console/`) | classifier over the grep output |
| Test files (11) | under `apps/fiab-console/`: `app/api/marketplace/__tests__/marketplace-routes.test.ts`, `app/api/items/__tests__/apim-items-routes.test.ts`, `app/api/apim/__tests__/apim-developer-portal-route.test.ts`, `app/api/apim/__tests__/apim-admin-routes.test.ts`, `app/api/items/data-product/[id]/__tests__/publish-api-route.test.ts`, `lib/azure/__tests__/{scaling-routes,scaling-clients,apim-subscriptions,apim-operations,apim-marketplace-client,apim-import}.test.ts` | same |
| Docs (10), PRP text (4), gitleaks (1) | `docs/fiab/parity/{api-marketplace,loom-marketplace,apim-developer-portal}.md`, `docs/fiab/audit/day-one-gap-closure-plan.md`, `docs/fiab/gate-registry.md`, `docs/fiab/design/{full-deployment-and-byo,data-api-builder-ui}.md`, `docs/fiab/admin/scaling.md`, `docs/decisions/api-center-vs-loom-native-marketplace.md`, `apps/fiab-console/docs/fiab/parity/apim-service.md`; `PRPs/backlog/loom-api-gateway-plane/{ARCHITECTURE,MOSAIC-CAPABILITY-MAP,PRD,apigw-W00-measurement-spike}.md`; `.gitleaks.toml:190,199` | same |

### 8.2 Route files under `apps/fiab-console/app/api/apim/` (row 2)

13 route files, 26 method exports. Every route file matched at least one method, so none escaped
the grep. Each also exports `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`.

| fact (file) | value (methods:line) | source |
|---|---|---|
| `apis/route.ts` | GET 48, POST 55, DELETE 74 | `apps/fiab-console/app/api/apim/apis/route.ts` |
| `backends/route.ts` | GET 50, POST 57, DELETE 99 | `.../backends/route.ts` |
| `developer-portal/route.ts` | GET 46, POST 78 | `.../developer-portal/route.ts` |
| `gateways/route.ts` | GET 31 | `.../gateways/route.ts` |
| `import/route.ts` | POST 45 | `.../import/route.ts` |
| `instances/route.ts` | GET 22 | `.../instances/route.ts` |
| `named-values/route.ts` | GET 61, POST 70, DELETE 122; plain `export async function`, auth is `requireTenantAdmin(getSession())` at `:62-63`, not `withSession` | `.../named-values/route.ts` |
| `operations/route.ts` | GET 31 | `.../operations/route.ts` |
| `products/route.ts` | GET 42, POST 49, DELETE 66 | `.../products/route.ts` |
| `service/route.ts` | GET 51, PATCH 65 | `.../service/route.ts` |
| `subscriptions/[sid]/keys/route.ts` | GET 19 | `.../subscriptions/[sid]/keys/route.ts` |
| `subscriptions/[sid]/route.ts` | PATCH 43, DELETE 64 | `.../subscriptions/[sid]/route.ts` |
| `subscriptions/route.ts` | GET 40, POST 47, DELETE 73 | `.../subscriptions/route.ts` |
| Not routes | `__tests__/apim-admin-routes.test.ts`, `__tests__/apim-developer-portal-route.test.ts` | `git ls-tree -r --name-only <pin> -- apps/fiab-console/app/api/apim/` |

### 8.3 `apps/fiab-console/lib/azure/apim-client.ts` (row 3)

File: 1,583 lines, 58,211 B, 79 `^export` lines = 52 functions, 24 interfaces, 2 types, 1 class
(`ApimError` :94).

| fact | value | source |
|---|---|---|
| Exported functions with lines (52) | gate/service: apimConfigGate 75, apimTarget 86, getApimService 169, updateApimSku 202, listGateways 1477, getServiceInfo 1488. APIs: listApis 267, getApi 273, upsertApi 279, deleteApi 303, publishGraphqlApi 325, importApiFromOpenApi 395, getApiSpec 665, testApiCall 1133, listApiRevisions 978, createApiRevision 997, listApiReleases 1032, createApiRelease 1048. Operations: listOperations 532, getOperation 546, upsertOperation 634, deleteOperation 652. Products: listProducts 714, getProduct 720, upsertProduct 726, deleteProduct 751, listProductApis 1067, addApiToProduct 1074, removeApiFromProduct 1084, listProductSubscriptions 1094. Policy: getPolicy 780, upsertPolicy 799. Subscriptions: listSubscriptions 843, getSubscription 849, subscriptionScope 865, slugSid 872, createSubscription 902, deleteSubscription 919, updateSubscription 933, regenerateSubscriptionKey 958, getSubscriptionKeys 1106. Named values: listNamedValues 1261, getNamedValue 1267, upsertNamedValue 1287, deleteNamedValue 1311, getNamedValueSecret 1322. Backends: listBackends 1404, getBackend 1410, upsertBackend 1420, deleteBackend 1458. Portal: listPortalRevisions 1547, publishPortalRevision 1564 | `git grep -n -E '^export ' <pin> -- apps/fiab-console/lib/azure/apim-client.ts` |
| Policy fragments | ABSENT. `fragment` (case-insensitive) 0 lines in file; `policyFragments` 0 files in `apps/fiab-console/app` + `lib`. `policyPath()` builds `/{scope}/policies/policy` for service, `apis/{id}`, `products/{id}` only | `apps/fiab-console/lib/azure/apim-client.ts:762-778`; Bicep precedent `platform/fiab/bicep/modules/health/apim-fragment.bicep:44` |
| MCP APIs | ABSENT. `mcp` 0 lines; `mcpProperties` 0 files. All calls use `APIM_API = '2024-06-01-preview'`; the only `2025-09-01-preview` text is a comment saying PremiumV2 appears from that version and is deliberately not offered | `apps/fiab-console/lib/azure/apim-client.ts:31,114,172,208`; `apps/fiab-console/app/api/apim/service/route.ts:28-31` |
| Backend pools | ABSENT. `pool` 0 lines. `ApimBackendBody` has url, protocol, title, description, resourceId, credentials, tls only; `upsertBackend` writes url + protocol ("Single backend") | `apps/fiab-console/lib/azure/apim-client.ts:1364-1372,1417-1427`; Bicep precedent `platform/fiab/bicep/modules/admin-plane/apim.bicep:464` (`aoaiPool`) |
| Circuit breakers | ABSENT. `circuit` or `breaker` 0 lines; `circuitBreaker` 0 files in app+lib | Bicep precedent `platform/fiab/bicep/modules/admin-plane/apim.bicep:441` |
| Diagnostics | ABSENT. `diagnostic` 0 lines (the only app+lib hits are the unrelated `/api/admin/diagnostics/bundle` support bundle) | `git grep -c -i diagnostic` on the file |
| Loggers | ABSENT. `logger` 0 lines; `/loggers` 0 files in app+lib | Bicep precedent `platform/fiab/bicep/modules/admin-plane/apim.bicep:131` (`aiLogger`) |
| Key Vault named values | PRESENT. `ApimKeyVaultRef` :1207; `ApimNamedValueBody.keyVault` :1236; `shapeNamedValue` :1239-1258; `upsertNamedValue` KV branch :1292-1296 (forces `secret:true`); `getNamedValueSecret` :1322; BFF KV id regex `apps/fiab-console/app/api/apim/named-values/route.ts:54` | `apps/fiab-console/lib/azure/apim-client.ts:1207-1326` |
| Positive controls (same file and path set) | `namedValues` at :1262, :1268, :1274, :1302, :1313, :1321, :1323; `/backends` at :1405, :1411, :1449, :1459; tree-wide `/namedValues` found in 2 files (`apim-client.ts`, `lib/components/admin/apim-named-values-pane.tsx`) | `git grep -n` on the same pathspec |
| Other APIM lib | `apps/fiab-console/lib/azure/aoai-apim-gateway.ts` exists (`llm-token-limit` only in comments `:24,:42`); `llm-token-limit`/`llm-emit-token-metric` editor snippets at `apps/fiab-console/lib/editors/apim-editors/policy-editor.tsx:39,43` | `git grep -n` |

### 8.4 Graph clients (row 4)

| fact | value | source |
|---|---|---|
| `graph-identity-client.ts` (993 lines, 42,903 B): 30 exports | functions (17): searchUsers 266, searchGroups 296, searchServicePrincipals 326, searchAll 358, getGroupTransitiveMembers 401, getPrincipalDirectGroups 465, getGroupsByIds 514, getPrincipalsByIds 562, resolvePrincipalRef 603, fetchSubscribedSkus 684, listUsersWithLicenses 724, inviteExternalGuest 796, findGuestByEmail 828, createTenantUser 893, addPrincipalToGroup 933, setUserAccountEnabled 956, deleteTenantUser 976. consts (4): IDENTITY_APP_ROLES 125, INVITE_APP_ROLE 770, LIFECYCLE_APP_ROLES 859, `__testing` 986. classes (2): GraphIdentityNotConfiguredError 100, GraphIdentityError 109. interfaces/types (7): GraphIdentityNotConfiguredHint 92, IdentityKind 230, IdentityHit 232, GraphUserWithLicenses 652, TenantSubscribedSku 662, InvitedGuest 776, CreatedTenantUser 874 | `apps/fiab-console/lib/azure/graph-identity-client.ts` |
| Graph app roles it declares | IDENTITY_APP_ROLES (read): User.Read.All `df021288-bdef-4463-88db-98f22de89214`, Group.Read.All `5b567255-7703-4780-807c-7be8301ae99b`, Application.Read.All `9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30`. INVITE_APP_ROLE: User.Invite.All `09850681-111b-4a89-9bed-3f2cae46d706`. LIFECYCLE_APP_ROLES (write): User.ReadWrite.All `741f803b-c850-494e-b5df-cde7c675a1ca`, GroupMember.ReadWrite.All `dbaae8cf-10b5-4b86-a4a1-f871c94c6695` | `apps/fiab-console/lib/azure/graph-identity-client.ts:125-144,770-774,859-872` |
| `graph-principals.ts` (107 lines, 4,474 B): 4 exports | PrincipalKind (type) 22, EntraPrincipal (interface) 24, GraphPrincipalsError (class) 34, searchEntraPrincipals (async fn) 71 | `apps/fiab-console/lib/azure/graph-principals.ts` |
| Entra Agent ID in Loom code | `AgentIdentity.Read` and agent-identity-blueprint patterns: 0 hits outside `PRPs/` in `apps/fiab-console/lib`, `app`, `scripts`, `platform` (the only `AgentIdentity` hits are `buildAgentIdentity` in `lib/azure/copilot-router.ts:126`, unrelated). Positive control: `User.Read.All` found in 9 files of `apps/fiab-console/lib` | `git grep -n -i` at pin |
| `groupMembershipClaims` | set to `SecurityGroup` by the app-registration template (the code-side answer; the live tenant value is W0-4 section 4) | `platform/fiab/bicep/modules/admin-plane/entra-app-registration.bicep:185` |

### 8.5 `scripts/csa-loom/bootstrap-msal-app-reg.sh` (row 5)

1,629 lines, 101,551 B. No shell function handles app roles, scopes or consent. The 9 functions
are all Key Vault or utility helpers; roles, scopes and consent are top-level sections.

| fact | value | source |
|---|---|---|
| Functions (none for roles, scopes, consent) | kv_arm_base 480, kv_arm_host 514, kv_secret_put 528, kv_secret_patch_tags 550, kv_secret_get 572, iso_epoch 589, count_nonempty 597, cred_line 607, kv_secret_exists 620 | `scripts/csa-loom/bootstrap-msal-app-reg.sh` |
| Delegated Graph scope | `GRAPH_APP_ID` :100, `GRAPH_USER_READ` (delegated User.Read) :101, `GRAPH_OBJ`/`GRAPH_RA` requiredResourceAccess type `Scope` :102-103 | `scripts/csa-loom/bootstrap-msal-app-reg.sh:100-103` |
| Opt-in Power BI delegated scopes | `PBI_SCOPE_NAMES` :319; section "[opt-in] Resolving Power BI delegated scopes" :403-430, resolves by name through `oauth2PermissionScopes` at :415 | `scripts/csa-loom/bootstrap-msal-app-reg.sh:319,403-430` |
| Application ID URI | section "svc-loom-unity-authz": ensures `api://<APP_ID>`; reads `identifierUris` :1090, `az ad app update --identifier-uris` :1106 | `scripts/csa-loom/bootstrap-msal-app-reg.sh:1063-1124` |
| App roles | the sign-in app carries `appRoles: []` and `oauth2PermissionScopes: []` (comment :1133). Roles are created by the sibling script, invoked at :1175 and :1199-1202; default-ON opt-out `LOOM_CATALOG_APP_REG` :1165-1171 | `scripts/csa-loom/bootstrap-msal-app-reg.sh:1126-1214` |
| Sibling that writes app roles | `ROLE_VALUE_READWRITE='Catalog.ReadWrite'` :97; step 4 appRoles :175-224 (`az ad app update --app-roles` :219); step 6 grants the Console UAMI the role through Graph `appRoleAssignments` :250-294 (`ASSIGN_URL` :270). 355 lines, 21,646 B | `scripts/csa-loom/bootstrap-catalog-app-reg.sh` |
| Admin consent | opt-in (`--enable-powerbi-mcp`): `az sp show/create` :1226, `az ad app permission admin-consent --id` :1228, warn-and-continue :1230-1234; closing note on Graph consent :1627-1628 | `scripts/csa-loom/bootstrap-msal-app-reg.sh:1216-1249,1627-1628` |
| Other grant scripts present | `grant-graph-approles.sh`, `grant-identity-graph-approles.sh`, `grant-shortcut-graph-approles.sh`, `grant-uami-graph-roles.sh` (existence only, not read) | `git ls-tree -r --name-only <pin> -- scripts/csa-loom` |

### 8.6 Container Apps Job pattern (row 6)

| fact | value | source |
|---|---|---|
| Pattern file the PRP set names | `platform/fiab/bicep/modules/admin-plane/cost-anomaly-monitor-job.bicep` (146 lines); `LOOM-INTEGRATION.md:115` calls the planned `run-apiplane-worker.mjs` a sibling of `run-cost-anomaly.mjs` | `PRPs/backlog/loom-api-gateway-plane/ARCHITECTURE.md:58`; `.../MOSAIC-CAPABILITY-MAP.md:68`; `.../LOOM-INTEGRATION.md:83,115` |
| Job resource | `Microsoft.App/jobs@2025-02-02-preview` :88; UAMI identity :92-97; `triggerType: 'Schedule'` :101; `replicaTimeout` :102; `replicaRetryLimit: 1` :103; schedule block :104-108; ACR pull via UAMI :109-114; secrets :115 | `platform/fiab/bicep/modules/admin-plane/cost-anomaly-monitor-job.bicep:88-140` |
| `loom-uat` image and command | `param image = '${acrLoginServer}/loom-uat:latest'` :53; `command: [ 'node', 'e2e/run-cost-anomaly.mjs' ]` :122; resources 0.5 cpu / 1.0Gi :123-126 | same file `:52-53,121-126` |
| Token wiring | `@secure() param internalToken` :61-63; secret `loom-internal-token` :77-84; env `LOOM_URL` :129, `LOOM_UAMI_CLIENT_ID` :130, `LOOM_INTERNAL_TOKEN` secretRef :133 | same file |
| Cron | param default `'0 6 * * *'` :59 (daily). `*/15` default lives in the sibling `asset-reconciler-job.bicep` (172 lines; resource :108, command :145, secretRef :159) | `platform/fiab/bicep/modules/admin-plane/main.bicep:606,614` |
| Runner | 76 lines. `LOOM_URL` :27, `LOOM_INTERNAL_TOKEN` :28, url `${base}/api/internal/cost-anomaly/run` :29, exit 1 if token unset :32-35, POST with `x-loom-internal-token` and `Authorization: Bearer` :39-47, non-2xx exits 1 :54-57 | `apps/fiab-console/e2e/run-cost-anomaly.mjs` |
| Route and auth | auth doc :25-28; imports `isValidInternalToken`, `INTERNAL_TOKEN_HEADER` :35; `authed()` :50-54. Helper: `INTERNAL_TOKEN_HEADER = 'x-loom-internal-token'` :18, `isValidInternalToken` :39 | `apps/fiab-console/app/api/internal/cost-anomaly/run/route.ts`; `apps/fiab-console/lib/auth/internal-token.ts` |
| Module wiring | `costAnomalyEnabled` :605, `costAnomalyCron` :606, `loomInternalToken` :828, `costAnomalyActive` :8426, `module costAnomalyMonitor ... = if (costAnomalyActive)` :8428-8441 (params: location, environmentId, consoleUamiId, consoleUamiClientId, acrLoginServer, loomUrl, cronExpression, internalToken, complianceTags) | `platform/fiab/bicep/modules/admin-plane/main.bicep` |
| Other job modules with the same shape | `asset-reconciler-job.bicep` (wiring main.bicep:8497-8513), `lineage-gc-job.bicep` (command :130), `spark-keepwarm-job.bicep` (:206), `access-governance-sweeper-job.bicep` (:171), `synthetic-monitor-job.bicep` (:160) | `git grep -n 'e2e/run-' <pin> -- platform` |
| Runners at pin | 7 files: `run-access-sweep`, `run-asset-reconcile`, `run-cost-anomaly`, `run-lineage-reconcile`, `run-spark-keepwarm`, `run-synthetic`, `run-uat-unattended` (`.mjs`) | `git ls-tree -r --name-only <pin>` filtered to `e2e/run-*.mjs` |
| Internal routes at pin | 12 `route.ts` + 3 tests under `apps/fiab-console/app/api/internal/`: `assets/reconcile`, `copilot/{eval-probe, memory/consolidate, search-probe, skills/learn, tools, tools/[name]/invoke}`, `cost-anomaly/run`, `lineage/reconcile`, `scheduler/tick`, `spark/keep-warm`, `topology/register-domain` | `git ls-tree -r --name-only <pin> -- apps/fiab-console/app/api/internal` |
| Image build | `apps/fiab-console/Dockerfile.uat:82` `COPY . .`, `:105` ENTRYPOINT `node e2e/run-uat-unattended.mjs`; builder `scripts/csa-loom/deploy-loom-uat-job.sh`, `.github/workflows/deploy-loom-uat.yml` | those paths at pin |

### 8.7 `main.json` size and headroom (row 7)

| fact | value | source |
|---|---|---|
| Brief's path | ABSENT: `git cat-file -s 007da59c...:platform/fiab/bicep/main.json` prints `fatal: path 'platform/fiab/bicep/main.json' does not exist`. Only one `main.json` exists at the pin (orchestrator re-run) | `git ls-tree -r --name-only <pin>` filtered to `main.json` |
| Real artifact | `apps/fiab-console/deploy-templates/main.json`, blob `eb9062780b68684339265b868b45445c1a7d06aa`, the committed compile of `platform/fiab/bicep/main.bicep` | `apps/fiab-console/Dockerfile:188`; `apps/fiab-console/lib/setup/user-arm-deploy.ts:30-31`; `.github/workflows/loom-guardrails.yml:476-498` |
| Size | 3,997,911 B (orchestrator re-run: identical) | `git cat-file -s <pin>:apps/fiab-console/deploy-templates/main.json` |
| Headroom | 4,194,304 - 3,997,911 = **196,393 B** (4.68% of the limit) | arithmetic |
| Limit asserted by test | `expect(Buffer.byteLength(bundled)).toBeLessThan(4 * 1024 * 1024)`; `BUNDLED_ARM` = that file | `apps/fiab-console/lib/deploy/__tests__/redis-retirement-2642.test.ts:66,263-267` |
| Recorded 7,624 B (claims at pin) | present tense: `main.json has 7,624 B of ARM 4 MiB headroom` and `ARM template headroom (7,624 B)`; past tense, correct for its time: `main.json had 7,624 bytes of headroom` | `PRPs/backlog/loom-api-gateway-plane/LOOM-INTEGRATION.md:87`; `.../RISKS-AND-OPEN-DECISIONS.md:65`; `PRPs/active/loom-health-data-services/W01-control-plane-identity-stamp.md:63` |
| Where 7,624 comes from | `health.bicep` records main.json at 3,994,502 B before W1-1, 4,186,680 with W1-1, 4,239,225 with W1-3 (over the limit); "with the stamp moved out, main.json is back to 3,994,502". 4,194,304 - 4,186,680 = **7,624** (orchestrator re-read the header: confirmed) | `platform/fiab/bicep/health.bicep:5-11` |
| Does 7,624 hold at this SHA | NO. Current size 3,997,911 B is 3,409 B above the post-extraction 3,994,502 B (headroom then 199,802 B). The docs already track the inconsistency as open issue #5143 (title "reconcile main.json 4 MiB ARM headroom, 196,758 B vs 7,624 B", OPEN at 2026-10-29) | `docs/fiab/health/index.md:25,65` |

### 8.8 Mosaic port sources (row 8)

All reads at `7e92e8753f49312bbb48e313812ef94a6e866793`. Line count is `curl -sL <raw> | wc -l`;
every file except one ends with a newline. "MIT header: none" means a whole-file grep for
`MIT License`, `SPDX-License-Identifier`, `Copyright`, `Permission is hereby granted`,
`Licensed under` found nothing; the same grep hits `LICENSE:1,3,5` (positive control). Paths are
under `apps/api/src/mosaic_api/` unless they start with `scripts/` or are root files. "Mosaic
literals" counts case-insensitive `mosaic` in the file (ADR-010 rename surface).

| fact (ADR-010 entry, wave) | value | source |
|---|---|---|
| `data/model_prices.json` (pricing/model-prices.json, W4) | 4,843 lines; 146,287 B; MIT header none (line 1 is `{`); read in full (7 chunks); schemaVersion 1, USD, lastUpdated 2026-09-30, 10 sources all retrievedOn 2026-09-30, 201 prices (184 commercial, 17 government), 12 ptuThroughput; government regions seen only usgovarizona, usgovtexas, usgovvirginia | `microsoft/mosaic-apim apps/api/src/mosaic_api/data/model_prices.json:4 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `data/model_prices.schema.json` (pricing/model-prices.schema.json, W4) | 412 lines; 9,265 B; none; read in full; JSON Schema 2020-12, `$id` and title name mosaic-apim/"MOSAIC" (rename); `cloud` is a free pattern, not an enum | `microsoft/mosaic-apim apps/api/src/mosaic_api/data/model_prices.schema.json:1-412 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `scripts/price_seed.py` (scripts/csa-loom/price-seed.py, W4) | 1,023 lines; 39,104 B; none; read in full (3 chunks); `RETAIL_PRICES` :37, `SERVICE = "Foundry Models"` :38, `GOVERNMENT_REGIONS` :41, `CATALOG` :139, `carry_forward` :810; imports `mosaic_api.pricing` (PriceSeed, seed_json_schema) :31, not on the list | `microsoft/mosaic-apim scripts/price_seed.py:31-41 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `integrations/policy.py` (policy/*.ts, W2) | 214 lines; 8,785 B; none; read in full; `ANTHROPIC_MANAGED_IDENTITY_RESOURCE` :77, `METRIC_NAMESPACE = "mosaic"` :81, `render_publication_policy` :145; renders `llm-token-limit`, `llm-emit-token-metric`, `include-fragment`, `authentication-managed-identity`; 8 literals | `microsoft/mosaic-apim apps/api/src/mosaic_api/integrations/policy.py:77-145 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `integrations/access_policy.py` (policy/*.ts, W2/W6/W7) | 1,895 lines; 77,610 B; none; read in full (5 chunks); `MAX_FRAGMENT_BYTES` :66, `_COUNTER_PREFIX = "mosaic:governed:"` :72, trace prefixes :112-113, `x-mosaic-*` response headers :151-154, `append_budget_check` :412, `validate_cloud_access` :918 (Government = keys only, no Entra tokens), `render_governed_policy` :1782; 93 literals (68 `mosaic-*`, 6 `x-mosaic-*`); imports `mosaic_api.budgets` :22 | `microsoft/mosaic-apim apps/api/src/mosaic_api/integrations/access_policy.py:66-154 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `integrations/pool_policy.py` (policy/*.ts, W7) | 1,453 lines; 58,595 B; none; read in full (4 chunks); `ATTEMPT_TRACE_PREFIX` :131, AWS Bedrock `x-amzn-*` header strip list from :160 (Bedrock is not ported per ADR-010), `_COUNTER_PREFIX = "mosaic:pool:"` :197, `render_pool_policy` :709, `render_governed_pool_policy` :1358; 40 literals; imports `mosaic_api.model_pools` :108 (BreakerPreset, cascade_statuses), not on the list | `microsoft/mosaic-apim apps/api/src/mosaic_api/integrations/pool_policy.py:108-197 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `integrations/mcp_access_policy.py` (policy/*.ts, W6) | 791 lines; 31,231 B; none; read in full (2 chunks); `MAX_FRAGMENT_BYTES` :60, `_COUNTER_PREFIX = "mosaic:mcp:"` :64, comment "Observed live on native MCP APIs, and not publicly documented" :461, `render_mcp_policy` :712; 33 literals; imports private helpers of `access_policy.py` | `microsoft/mosaic-apim apps/api/src/mosaic_api/integrations/mcp_access_policy.py:60-64,461,712 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `integrations/backend_keys.py` (policy/*.ts, W2) | 145 lines; 5,820 B; none; read in full; `BACKEND_KEY_HEADERS` :27, `CALLER_CREDENTIAL_HEADERS` :36 (Ocp-Apim-Subscription-Key, api-key, x-api-key, Authorization), `CALLER_CREDENTIAL_QUERY_PARAMETERS` :42 (subscription-key, api-key); Key Vault named value with versionless secretIdentifier | `microsoft/mosaic-apim apps/api/src/mosaic_api/integrations/backend_keys.py:27-42 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `integrations/apim/model_apis.py` = curated operation sets (shapes/*.ts, W2). RESOLVED: ADR-010 names no path | 592 lines; 23,762 B; none; read in full (2 chunks); `CURATED_SHAPE_VERSION = "1.0"` :40; azureOpenAi 7 operations :69, foundryModels 3 :132, anthropicMessages 2 :161; Bedrock branch :287 (not ported); 30 literals | `microsoft/mosaic-apim apps/api/src/mosaic_api/integrations/apim/model_apis.py:40-161 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `integrations/loganalytics/__init__.py` (telemetry/kql.ts, W4) | 44 newline-terminated lines (45 including a final unterminated `]`); 877 B; none; read in full including the last line; re-exports client and kql names | `microsoft/mosaic-apim apps/api/src/mosaic_api/integrations/loganalytics/__init__.py:1-45 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `integrations/loganalytics/client.py` (W4) | 320 lines; 12,406 B; none; read in full; `MAX_ATTEMPTS = 4` :33, `query_scope` :86, `LogAnalyticsClient` :197, resource-centric URL `/v1{resource_id}/query` :245 (needs Monitoring Reader on the APIM instance); Python-only deps httpx, structlog, azure-core | `microsoft/mosaic-apim apps/api/src/mosaic_api/integrations/loganalytics/client.py:33,86,197,245 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `integrations/loganalytics/kql.py` (telemetry/kql.ts, W4) | 514 lines; 23,327 B; none; read in full (2 chunks); tables `ApiManagementGatewayLogs` :100 and `ApiManagementGatewayLlmLog` :131; trace markers `mosaic-attribution` :114, `mosaic-deny` :115, `mosaic-attempt` :438; `calls_query` :241, `peaks_query` :290, `deployment_peaks_query` :312, `pool_health_query` :413, `denials_query` :482, `probe_query` :501; imports `usage_telemetry` | `microsoft/mosaic-apim apps/api/src/mosaic_api/integrations/loganalytics/kql.py:100-501 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `usage_telemetry.py` (telemetry/rollup.ts, W4). RESOLVED: rollup types for ADR 0019 | 660 lines; 25,560 B; none; read in full (2 chunks); `LATENCY_BUCKETS_MS` :34, `STALE_INTERVALS = 2` :40, `INGESTION_ALLOWANCE` 30 min :41, `SUMMARY_SHARD_SIZE = 1000` :118, `UsageMetrics` :151, `UsageFact` :345; pydantic models; clouds limited to commercial/government | `microsoft/mosaic-apim apps/api/src/mosaic_api/usage_telemetry.py:34-345 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `services/usage_rollup.py` (telemetry/rollup.ts, W4). RESOLVED: the fold rules | 1,457 lines; 60,071 B; none; read in full (4 chunks); `TRACE_VERSION` :111, `LEASE_SECONDS = 900` :112, `BACKFILL_DAYS_PER_CYCLE = 7` :113, `MAX_BACKFILL_DAYS = 730` :115, `REFRESH_COOLDOWN` 1 min :116, `DayFold` :289, `fold_month` :613, `merge_apis` :654, `merge_run` :709, `UsageRollupService` :794, query windows halved on too-large `_query` :1218, a re-read never lowers a day :1286-1291 or a month :1350; in-process asyncio loop (must become a Job); depends on repositories and services not on the list | `microsoft/mosaic-apim apps/api/src/mosaic_api/services/usage_rollup.py:111-1350 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `scripts/verify_model_access.py` (scripts/measure/apiplane/verify-model-access.mjs, W3) | 1,565 lines; 65,404 B; none; read in full (4 chunks); `LOGIN_ORIGIN` hard-codes commercial `login.microsoftonline.com` :32, `ANTHROPIC_VERSION` :35, Agent ID grant check (`principalKind == agentIdentity`) :973-974; env names `MOSAIC_SMOKE_*`; 35 literals | `microsoft/mosaic-apim scripts/verify_model_access.py:32-35,973-974 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `scripts/verify_mcp_access.py` (scripts/measure/apiplane/verify-mcp-access.mjs, W6) | 2,570 lines; 107,919 B; none; read in full (7 chunks); imports `scripts.verify_model_access` :45; `PROTOCOL_VERSION = "2025-11-25"` :53, `MCP_SCOPE` :61, `MCP_ROLE` :65, `COST_CENTER_HEADER = "x-mosaic-cost-center"` :66, `METADATA_PREFIX` :68; 54 literals (5 `x-mosaic-*`) | `microsoft/mosaic-apim scripts/verify_mcp_access.py:45-68 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `environments.py` (environments/catalog.ts seed, W1) | 567 lines; 20,283 B; none (line 1 `import json`); read in full (2 chunks); `built_in_environments` :57 (6: development, test, qc, staging, production, sandbox), `validate_catalog` :128 (max 30), `permits` :223 | `microsoft/mosaic-apim apps/api/src/mosaic_api/environments.py:57-223 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `clouds.py` (pricing/clouds.ts, W4) | 126 lines; 4,469 B; none; read in full; `AzureCloud = Literal["commercial","government"]` :8, `_COMMERCIAL` :32, `_GOVERNMENT` :46; two clouds only, Government deliberately excludes Foundry/Anthropic hosts | `microsoft/mosaic-apim apps/api/src/mosaic_api/clouds.py:8-46 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `DESIGN.md` (docs/fiab/ux-standards.md additions, W1) | 81 lines; 5,375 B; none; read in full; sections at :3, :10, :46, :55, :77 | `microsoft/mosaic-apim DESIGN.md:1-81 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |
| `LICENSE` (third-party notices text) | 21 lines; 1,066 B; IS the MIT text, "Copyright (c) 2026 Microsoft" :3; read in full | `microsoft/mosaic-apim LICENSE:1-21 @ 7e92e8753f49312bbb48e313812ef94a6e866793` |

### 8.9 Unknown, UNREAD, and not verified

| fact | value | source |
|---|---|---|
| `deploy-templates/main.json` matches a fresh bicep compile | UNKNOWN. Not compiled (read-only). The sync guard exists and was not run | `.github/workflows/loom-guardrails.yml:496-498` (`scripts/ci/check-deploy-template-sync.mjs`) |
| New `e2e/run-apiplane-worker.mjs` reaching the `loom-uat` image | UNKNOWN. `Dockerfile.uat:82` is `COPY . .`, but `.dockerignore` was not checked | `apps/fiab-console/Dockerfile.uat:82` |
| Mosaic modules the port files import but ADR-010 does not list | UNREAD (outside the port list; sizes from the tree listing only): `domain.py` 163,809 B; `pricing.py` 39,556 B; `model_pools.py` 36,635 B; `integrations/apim/policy_semantics.py` 25,550 B; `budgets.py` 23,913 B; `errors.py` 5,091 B | `GET https://api.github.com/repos/microsoft/mosaic-apim/git/trees/7e92e8753f49312bbb48e313812ef94a6e866793?recursive=1` (not truncated, 1,042 entries) |
| Mosaic ADRs 0010, 0012, 0019 | Not read in full; only lines 90-104 (0010), 36-52 (0012) and grep hits (0019), used solely to locate the op sets and fold rules | raw URLs at the Mosaic pin |
| Loom files read partially (fact rows, not "read in full" claims) | `apim-client.ts` (lines 25-35, 55-110, 760-822, 1195-1470 read; rest grepped), `graph-identity-client.ts` (1-30, 88-232, 764-776, 852-874 read; rest grepped), `bootstrap-msal-app-reg.sh` (1-104, 1063-1252 read; rest grepped) | `git show <pin>:<path>` |
| The `gh api` resolution form | FAILED (HTTP 403, SAML); public-API fallback used and cross-checked with `git ls-remote` | see 8.0 |

### Commands run for counts

```
S=007da59c49350ccab0c79e4cbeab62e883c5264c
git grep -n -I 'LOOM_APIM_NAME' $S | wc -l            # 77 matching lines
git grep -I -o 'LOOM_APIM_NAME' $S | wc -l            # 83 matches
git grep -l -I 'LOOM_APIM_NAME' $S | wc -l            # 46 files
git grep -n -E 'export[[:space:]]+(async[[:space:]]+)?(function|const)[[:space:]]+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b' $S -- apps/fiab-console/app/api/apim/   # 26 lines, 13 files
git grep -c -E '^export ' $S -- apps/fiab-console/lib/azure/apim-client.ts   # 79
git grep -c -i -E 'fragment' $S -- apps/fiab-console/lib/azure/apim-client.ts   # no output = 0; same for mcp, pool, circuit or breaker, diagnostic, logger
git grep -n -E 'namedValues|/backends' $S -- apps/fiab-console/lib/azure/apim-client.ts   # positive control
git cat-file -s $S:apps/fiab-console/deploy-templates/main.json   # 3997911
git cat-file -s $S:platform/fiab/bicep/main.json                  # fatal: path does not exist
curl -sL https://raw.githubusercontent.com/microsoft/mosaic-apim/7e92e8753f49312bbb48e313812ef94a6e866793/<path> | wc -l
```

## 9. W0-9: decision pass

### 9.1 ADR status lines

Updated in place (status line only). ADR-003: authorable element set measured on both clouds; `include-fragment` is API-scope only; fragment PUT is not a verdict, apply must verify by read-back. ADR-004: Agent ID roles exposed on Commercial Graph, Government unknown:permission; the sign-in app carries `SecurityGroup`. ADR-007: `GatewayLlmLogs` offered on Commercial, absent on GCC-High; the live diagnostic setting is the legacy destination on both.

### 9.2 D17, the sovereign LLM-policy gap, per boundary

| Boundary | `llm-token-limit` and `llm-emit-token-metric` | LLM logs | MCP API type | Status |
|---|---|---|---|---|
| Commercial (receipt) | authorable | available | available | no gap |
| GCC-High (receipt) | authorable; runtime enforcement not measured | **absent** | **not registered (api-version)** | the gap #4460 assumed (no token limits) does not exist; the measured gaps are LLM logs and the MCP type |
| IL5 | not measured | not measured | not measured | the existing rule stands: refuse token limits where unavailable, never substitute silently |
| GCC | not measured | not measured | not measured | supported-in-code, never exercised |

### 9.3 Values W1-2 will write

`apiplaneLlmLogs` per boundary: Commercial `true`; GCC-High `false`; IL5 `false`; GCC `false`. IL5 and GCC are off because they are not measured, not because they are known to lack the category. Recorded as D26 in `RISKS-AND-OPEN-DECISIONS.md`; D27 records that the existing legacy diagnostic setting is never flipped silently.

### 9.4 Questions raised, recorded as open (Q17 to Q20)

Q17 the plane's worker job and management vault as their own deploy units, given 196,393 B of headroom. Q18 an in-boundary measurement path for GCC-High. Q19 the Government deploy SP's `Application.Read.All`. Q20 which sign-in app name form is canonical. Q9 to Q16 were answered on 2026-10-29 and are recorded beside their defaults in `RISKS-AND-OPEN-DECISIONS.md` section 2 (verified present).

### 9.5 Declared gaps (cloud-parity: an owner and a date each)

| Gap | Boundary | Owner and next step | Review |
|---|---|---|---|
| `GatewayLlmLogs` absent | GCC-High | W4: meter from `llm-emit-token-metric` and `GatewayLogs`; re-read the category list at each Government registration | 2026-12-01 |
| MCP API type (api-version `2025-09-01-preview` not registered) | GCC-High | W6: console-hosted MCP behind the gateway as a plain API (D15); re-run the `mcp` family when a newer version registers | 2026-12-01 |
| Agent ID, UAMI roles, sign-in app | GCC-High | operator: grant `Application.Read.All` (Q19), then re-run `identity` | on grant |
| Named-value latency and runtime enforcement | GCC-High | W1 Government verifier from an in-boundary runner (Q18) | W1 merge |
| `services.ai.azure.com` VNet resolution | GCC-High | same in-boundary runner | W1 merge |
| Everything | IL5, GCC | measured when an IL5 deploy run exists, or a GCC tenant exists | on first receipt |

### 9.6 Filed

W1 sub-issue #5187. Follow-ups: probe follow-ups #5186 (including the classifier refinement for the 201-then-404 signature), wrong Graph app id in console hints #5185, sign-in app name drift #5184.

### 9.7 Index check

`python -S -E $HOME/.claude/kits/orchestrated-prp/prp_index.py check --root .` reports `OK` after this change (run before the PR was opened).

## Run ledger

| Run | Workflow | What | Result |
|---|---|---|---|
| 40956953993 | `apiplane-w0-commercial-probe` (`d877782a8`) | read-only families | success; telemetry 14 measured; identity 2 measured and 1 unknown (the ambiguity H7 fixed); foundry 3 measured |
| 40974529572 | `apiplane-w0-commercial-probe` (`0f1ff4d7b`) | all families | exit 3 on `policies` (10 unknown); the other five families exit 0 |
| 40975571002 | `apiplane-w0-gov-probe` (`0f1ff4d7b`) | all families, approved at `gcc-high-deploy` | exit 3 on `policies` (10 unknown); the other five families exit 0 |

The two red runs are visible as failed checks on `main`'s head commit. They gate nothing (not required contexts) and are red by the instrument's design, see "How to read the unknown cells".
