# Test strategy

`assertion-design.md` governs every assertion: each names the input that
breaks it, and a test claimed to catch a defect is run against that defect in
a sandbox copy with the tracked tree proven untouched. `ux-baseline.md` G1
governs completion: tsc + vitest + DOM strings are never a done receipt.

## 1. Pure cores and their mutation receipts

Each wave that ships one of these functions attaches a mutation receipt
(RED with the mutation, green without, tree restored and proven by hash).

| Pure function | Load-bearing assertion (input that breaks it) | Mutation that must turn it RED |
|---|---|---|
| `plan(desired, observed, catalog)` | a publication whose backend exists but whose fragment is missing yields exactly `[noop backend, create fragment, create api, …]` in dependency order; input: delete the fragment from the snapshot | swap the fragment and backend steps |
| `digest(plan)` | changing one facet (e.g. `tokensPerMinute` 500 → 600) changes the digest; changing a display name does not | hash only step count |
| `apply()` existence re-read | a step planned as `create` whose resource now exists is **refused** (`409`), not overwritten; input: inject the resource between plan and apply | skip the re-read |
| `rollback()` ownership | only resources recorded as created by *this run* are deleted; input: a pre-existing product with the same name | delete by name |
| `renderPublicationFragment(spec)` | output contains `trace` metadata with `-` for every absent value; input: a spec with no client app | drop the `-` default |
| `renderMcpFragment(spec)` | strips `Authorization`, `Ocp-Apim-Subscription-Key`, `api-key`, `subscription-key`, caller `x-loom-on-behalf-of`; input: a request carrying all five | remove one header from the strip list |
| `assessDeployment()` | a `claude-*` deployment on a `cognitiveservices.azure.com` origin is **not publishable** with reason "needs a services.ai.azure.com origin"; a `gpt-4o` on the same account is `azureOpenAi` | treat all Foundry models as `foundryModels` |
| `permits(gatewayEnv, resourceEnv, settings)` | Production gateway × Unclassified endpoint = `blocked`; Unclassified × Development with require-classification off = `warning`, on = `blocked` | return `allowed` for unclassified |
| `parseAttributionTrace(message)` | `loom-attribution v=1 g=abc m=- a=xyz r=!` parses to `{grant:'abc', member:undefined, client:'xyz', ref:'invalid'}`; `mosaic-attribution …` is **not** parsed | accept any prefix |
| `matchPrice(usage, prices)` | a deployment-specific price beats a model-name price beats an alias beats a wildcard; ties go to the later effective date; a token price never applies to a provisioned deployment; an unpriced call returns `{reason:'noPrice'}` never `0` | return the first match |
| `evaluate(budgetState, spend)` | threshold 80 fires once per month even if spend dips and returns; a raised amount re-arms thresholds spend no longer reaches; a price correction that lowers spend re-arms nothing | re-arm on any decrease |
| `blockListValue(ids)` | `-` for none; comma-separated 12-hex SHA-256 prefixes; overflow beyond 4,096 chars drops the **newest** and reports the count | drop the oldest |
| `resolveCostCenter(call, grants)` | header → default-center direct grant → other direct grants oldest first → group grants most generous; a key with a mismatching header → `cost-center-mismatch` | ignore the header |
| `effectiveAccess(principal, grants)` | direct beats group within the same cost center; grants under different cost centers do not compete; overage token → group grants ignored | let the more generous group beat a direct grant |
| `ssrfGuard(url)` | `https://169.254.169.254/mcp`, `http://…`, `https://user:pw@host/mcp`, `https://10.0.0.5/mcp` all refused; `https://tools.example.test/mcp` accepted | allow private ranges |
| `sweep(snapshot, partialTypes)` | a type in `partialTypes` keeps prior documents; a type absent from a clean snapshot is swept | sweep everything |

## 2. Unit and route tests (vitest)

- In-memory repositories only; no Cosmos emulator; every Azure client is a
  double that records calls and returns recorded fixtures (lifted from real
  responses with identifiers scrubbed).
- Route tests assert the envelope (`{ok, data|error}`), the wrapper
  (`withCapability('apiplane-admin')` refuses a session holding neither the capability nor tenant admin with 403, `withSession`
  self routes ignore any `subject` parameter), and the audit write
  (`kind:'apiplane.*'` present with the expected actor).
- Absence-only assertions are paired with a positive one (rule § done #4):
  e.g. "no XML in the plan document" is paired with "the plan document has the
  expected facets and digest".
- An OpenAPI-shaped enumeration test asserts every `app/api/admin/api-gateway`
  route refuses a `withSession`-only caller, so new routes are covered
  automatically (Mosaic ADR 0008 pattern).

## 3. Live verifiers (the only evidence that counts for Gov)

`scripts/measure/apiplane/*.mjs`, run from GitHub Actions for GCC-High and
from the Commercial pool for Commercial; each prints a table and exits
non-zero on a failed expectation. Each expectation names what breaks it.

| Verifier | Expectations |
|---|---|
| `telemetry-probe.mjs` | diagnostic setting routes `GatewayLogs` + `GatewayLlmLogs` (or records the category rejection), Monitoring Reader resolves, a 24-hour query returns rows for a known call, `TraceRecords` carries a `loom-attribution` message after one governed call |
| `verify-model-access.mjs` | anonymous → 401; wrong-audience token → 401; valid token with no grant → 403 with `r=no-grant`; valid grant → 200 with `x-loom-remaining-tokens` when a token limit applies; key + mismatching cost-center header → 403 `cost-center-mismatch` |
| `verify-mcp-access.mjs` | anonymous `401` with `WWW-Authenticate … resource_metadata=`; `GET /.well-known/oauth-protected-resource/<path>/mcp` returns the RFC 9728 document with the runtime scope; bad bearer → `error="invalid_token"`; a metadata document that only works at a different URL is a failure |
| `budget-probe.mjs` | after a forced block: 403 `r=budget` within 30 min; named value equals the computed list; unblock on raise |
| `pool-probe.mjs` | with one member forced to 429, the next request succeeds on another member and `loom-attempt` traces show two attempts; final failure keeps `Retry-After` and names no member |

Receipts quote the Actions run ID and the boundary. A verifier that could not
run (missing role, missing tier feature) reports **unknown**, never pass.

## 4. Browser E2E (G1)

Playwright `e2e/api-gateway-*.uat.ts` against a seeded test tenant: register
gateway → preflight → observe inventory → switch to manage → register
endpoint → readiness → publish (plan, review, apply) → grant (key and token)
→ marketplace request → approve → My access → connection details → key create
→ real call through the gateway → usage appears after one rollup → budget set
→ block → unblock → unpublish review. Narrow-width pass, first-open pass on a
freshly registered gateway, dark and light screenshots. The walk is attached
to the wave's done receipt; `pnpm uat` must include it.

## 5. Things that cannot be proven offline (carried from Mosaic, measured in W0 or at first live apply)

`.well-known` routing on the live gateway; `mcpProperties.endpoints` shape;
policy writes on MCP APIs under `2025-09-01-preview`; whether `on-error` sees
the 401 after token validation; streaming through the MCP policy; VS Code
consent flow; `groups` claim in app-only agent tokens; named-value propagation
time on PremiumV2 and Premium classic; whether `retry` sees connection
failures; per-attempt traces; route-based deployment names behind one backend
pool; Graph mail acceptance per cloud; whether a content-filter-blocked 400 is
billed. Each has a row in `apigw-W00-measurement-spike.md` or in the first live
apply of its wave, and is reported as **unknown** until measured.

## 6. Gates per item

`powershell -NoProfile -ExecutionPolicy Bypass -File .claude/hooks/run-tests.ps1 -Fast`
for the touched tests; `make validate` before a wave is declared done; the
mutation receipt and the G1 walk in the PR body (≤ 3 KB, link to artifacts).
