---
name: apigw-W00-measurement-spike
status: shipped
allow_parallel: true
priority: P1
order: 21
depends_on: []
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
started: 2026-10-29
shipped: 2026-10-29
pr: 5188
branch: feat/apigw-w00-measurement-spike
---
# W0 — Measurement and decision spike (no product code)

**Goal**: settle, with receipts, the facts every later wave builds on and
that neither Learn nor Mosaic settles (`research/learn-apim-ai-gateway-sources.md`
§ "Facts this set relies on"). A negative is a successful W0: it redirects a
wave instead of invalidating it late. **Every measurement runs in both
clouds**: Commercial from the build pool against the live PremiumV2 gateway,
and GCC-High through a GitHub Actions workflow against the Premium classic
gateway, never local `az` (`csa_loom_gov_verify_via_actions_2026_07_30`). GCC
(no tenant) and IL5 (no deploy run) are recorded as **not measured**, never
assumed (`cloud-parity.md`). Per the operator's 2026-10-29 decision, **the
Government workflow run and the Commercial pool run are shared with #4442
Wave 0**: its tasks 1–3 (Premium classic stands up, `llm-*` policies, Prompt
Shields) ride the same runs, and results post to `W0-RECEIPT.md`, #4442 and
#4460. Scratch resources created for a measurement are deleted in the same run
and named `w0-apiplane-*`.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W0-1 | Government telemetry tables: in GCC-High, list diagnostic categories on the Gov APIM (`az monitor diagnostic-settings categories list`) and record whether `GatewayLlmLogs` exists; query the Gov Log Analytics workspace for `ApiManagementGatewayLlmLog` and for `TraceRecords` on `ApiManagementGatewayLogs`; repeat on the Commercial estate from the pool runner | `.github/workflows/apiplane-w0-gov-probe.yml` (new; pattern `health-w0-gov-probe.yml`), `W0-RECEIPT.md` § 1 | none | Sonnet | **required** (new Gov workflow) | `gh run view <id> --json conclusion` = success; receipt quotes run id, per-boundary yes/no per table and category |
| W0-2 | `llm-*` family and friends on **both** gateways (Commercial PremiumV2 in the pool run; Gov Premium classic in the Gov run, which is also #4442 Wave 0 task 2 / #4460, one measurement serving both programs): PUT a scratch policy fragment containing `llm-token-limit`, `llm-emit-token-metric`, `trace` with metadata, `validate-azure-ad-token`, `include-fragment`, `rate-limit-by-key`, `quota-by-key`; PUT and GET a scratch named value; GET the fragment back and compare element counts; record accepted/rejected per element per gateway; delete all | same workflow + the Commercial pool job, `W0-RECEIPT.md` § 2; comments on #4460 and #4442 | W0-1 | Sonnet | none | receipt table has one row per element per gateway with the HTTP status quoted; a 2xx whose GET-back drops an element is recorded as rejected |
| W0-3 | MCP API type: `GET …/apis?api-version=2025-09-01-preview&$filter=type eq 'mcp'` on Commercial and Gov; create a scratch passthrough MCP API against `https://learn.microsoft.com/api/mcp`, read `mcpProperties`, PUT an API-scoped policy, create a blank-path API with a `.well-known/...` operation, delete all | same workflow + a Commercial pool job, `W0-RECEIPT.md` § 3 | none | Sonnet | none | receipt quotes status codes and the observed `mcpProperties.endpoints` shape per boundary |
| W0-4 | Entra Agent ID and Graph: in each tenant the deploy identity can read, record whether the Microsoft Graph service principal exposes `AgentIdentity.Read.All`; list the Console UAMI's current Graph app-role assignments; record whether `groupMembershipClaims: SecurityGroup` is set on the sign-in app | `W0-RECEIPT.md` § 4 | none | Sonnet | none | each cell is yes / no / **unknown (reason)**; an unreadable Graph is unknown, never no |
| W0-5 | Azure Retail Prices API coverage: public, unauthenticated; count SKUs for `serviceName in ('Azure OpenAI','Foundry Models')` with `armRegionName` in Government regions vs Commercial; record which model families are absent in Government | `scripts/measure/apiplane/retail-prices-coverage.mjs` (new), `W0-RECEIPT.md` § 5 | none | Sonnet | none | script prints a table; receipt quotes counts per region family with the query URL |
| W0-6 | Named-value propagation latency on **both** gateways (Commercial PremiumV2 in the pool job; Gov Premium classic in the Gov run): write `w0-apiplane-latency` named value, poll a scratch API whose policy returns the value until it changes, record seconds; repeat with a second value; delete; operator notified in the tracking issue before the run | Commercial pool job + the Gov workflow, `W0-RECEIPT.md` § 6 | none | Sonnet | none | receipt quotes two latency measurements per gateway and proves deletion (`GET` → 404) on each |
| W0-7 | Anthropic-on-Foundry availability in **both** clouds: `az cognitiveservices account list-models` in `usgovvirginia` (Gov run) and in the Commercial estate's region (pool job), filtered to format `Anthropic`; Learn statement if any; record `services.ai.azure.com` resolvability from each VNet | same Gov workflow + the Commercial pool job, `W0-RECEIPT.md` § 7 | W0-1 | Sonnet | none | receipt quotes model names or "none listed" with the command, per cloud |
| W0-8 | Loom facts at head: `LOOM_APIM_NAME` gate sites (count and files); `app/api/apim/*` route list; `apim-client.ts` functions present vs needed (fragments, MCP APIs, pools/circuit breakers, diagnostics, loggers, Key Vault named values); `graph-identity-client.ts` / `graph-principals.ts` exports; `bootstrap-msal-app-reg.sh` functions for roles, scopes, consent; Container Apps Job pattern file; `main.json` headroom bytes; read the Mosaic port sources in full and record their commit SHA | `W0-RECEIPT.md` § 8 | none | Sonnet | none | every row has `file:line` at the named SHA or a Mosaic path + commit SHA |
| W0-9 | Decision pass: update `adr/ADR-00{3,4,7}` status lines and `RISKS-AND-OPEN-DECISIONS.md` D17 per boundary from W0-1/2/7; set the `apiplaneLlmLogs` per-boundary values W1-2 will write; record Q9–Q16 answers received; file W1's sub-issue; `python -S -E C:/Users/fgaro/.claude/kits/orchestrated-prp/prp_index.py check --root .` clean | `adr/*` (status lines only), `RISKS-AND-OPEN-DECISIONS.md`, `W0-RECEIPT.md` § 9, `PRP.md` execution state | W0-1..W0-8 | Sonnet | none | ADR status lines quote measured values; check is clean |

Lanes: L1 = W0-1 → W0-2 → W0-7 (one Gov workflow, three jobs, shared with
#4442 Wave 0 tasks 1–3); L2 = W0-3, W0-6 and the Commercial halves of W0-1,
W0-2 and W0-7 (one Commercial pool run); L3 = W0-4, W0-5, W0-8 (read-only);
W0-9 last. The two runs are independent and may execute the same day.

## Assertions that would break (assertion-design)

- "`GatewayLlmLogs` exists in Gov" breaks if the categories list omits it; the
  receipt pastes the list, not a yes.
- "`llm-token-limit` is authorable" breaks on any non-2xx PUT; the receipt
  quotes the status and the error code; a 2xx on the fragment PUT with the
  element silently dropped is caught by the GET-back comparing element count.
- "Retail Prices covers Government" breaks when the Government count is zero
  for a family present in Commercial; the script exits non-zero on a count it
  could not fetch (never prints zero for a failed query).
- "Named value propagates in N seconds" breaks if the poll never observes the
  second value within 15 minutes; the receipt then says **not observed**, not
  a number.

## Rollback

Scratch resources deleted in-run; the new workflow is `workflow_dispatch`
only and fails closed on missing secrets (pattern `deploy-fiab-gcc.yml:137-146`).

## Cost / credit estimate

~6 Sonnet sessions; Azure: scratch named values, two scratch APIs, Log
Analytics queries; no new resources retained.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W0-1 | merged | feat/apigw-w00-lane-a | sonnet | PRs #5181 #5183; Commercial run 40974529572 and GCC-High run 40975571002: GatewayLlmLogs present on Commercial and ABSENT on GCC-High; receipt section 1 | 2026-10-29 |
| W0-2 | merged | feat/apigw-w00-lane-a | sonnet | both clouds: llm-token-limit and five more elements accepted; 10 cells unknown per cloud by the 201-then-404 signature; receipt section 2 | 2026-10-29 |
| W0-3 | merged | feat/apigw-w00-lane-a | sonnet | Commercial measured; GCC-High not measured (api-version 2025-09-01-preview not registered); receipt section 3 | 2026-10-29 |
| W0-4 | merged | feat/apigw-w00-lane-a | sonnet | Commercial measured (Agent ID yes); GCC-High unknown:permission, needs Application.Read.All; receipt section 4 | 2026-10-29 |
| W0-5 | merged | feat/apigw-w00-lane-b | sonnet | PR #5181; 37 tests, 98 of 98 mutants RED; own runs exit 2 (default pair) and exit 3 (Foundry Models, 277 of 390 families absent in Government); receipt section 5 | 2026-10-29 |
| W0-6 | merged | feat/apigw-w00-lane-a | sonnet | Commercial 7.1 s; GCC-High not measured (gateway unreachable from a hosted runner); receipt section 6 | 2026-10-29 |
| W0-7 | merged | feat/apigw-w00-lane-a | sonnet | Commercial 14 Anthropic models; GCC-High none listed; Prompt Shields UNVERIFIED; receipt section 7 | 2026-10-29 |
| W0-8 | merged | feat/apigw-w00-receipts | sonnet | report verified at pin 007da59c4; ARM headroom 196,393 B not 7,624 B; receipt section 8 | 2026-10-29 |
| W0-9 | merged | feat/apigw-w00-receipts | sonnet | decision pass in receipt section 9: ADR-003/004/007, D17, D26, D27, Q17-Q20; issues #5184 #5185 #5186 #5187 | 2026-10-29 |

## Completion note

Shipped 2026-10-29. W0 measured both clouds that can be measured (Commercial and GCC-High); IL5 and GCC are not measured and are labelled so. The receipt is `W0-RECEIPT.md`.

- PRs: #5181 (probes, merge `d877782a8`), #5183 (hardening H1 to H7, merge `0f1ff4d7b`), and #5188 (receipts and decision pass). Probe runs: Commercial 40956953993 (read-only) and 40974529572 (all families); GCC-High 40975571002.
- Deviations from the blueprint: one shared probe script with two thin workflows instead of two bash probes; W0-4 folded into the same two runs; the Government workflow fails closed on missing secrets even on dispatch and runs behind the `gcc-high-deploy` approval; #4442 Wave 0 task 1 evidence came from W0-1's list call, and task 3 (Prompt Shields) is a Learn lookup whose result is UNVERIFIED; the combined fragment contained `include-fragment`, which is invalid at fragment scope.
- Descoped: none. Not measured, by the boundary: GCC-High named-value latency, runtime enforcement and VNet DNS (the gateway is unreachable from Actions); GCC-High Agent ID, UAMI roles and the sign-in app (the Government deploy SP lacks `Application.Read.All`); everything in IL5 and GCC.
- Ten `policies` cells per cloud stay unknown by one shared signature (a 2xx PUT then a 404 GET); the refinement is #5186 item 1. Follow-ups: #5184, #5185, #5186. W1 sub-issue: #5187.
