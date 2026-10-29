---
name: apigw-W00-measurement-spike
status: backlog
priority: P1
order: 21
depends_on: []
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W0 — Measurement and decision spike (no product code)

**Goal**: settle, with receipts, the facts every later wave builds on and
that neither Learn nor Mosaic settles (`research/learn-apim-ai-gateway-sources.md`
§ "Facts this set relies on"). A negative is a successful W0: it redirects a
wave instead of invalidating it late. Government measurements come from
GitHub Actions runs in the boundary, never local `az`
(`csa_loom_gov_verify_via_actions_2026_07_30`). Scratch resources created for
a measurement are deleted in the same run and named `w0-apiplane-*`.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W0-1 | Government telemetry tables: in GCC-High, list diagnostic categories on the Gov APIM (`az monitor diagnostic-settings categories list`) and record whether `GatewayLlmLogs` exists; query the Gov Log Analytics workspace for `ApiManagementGatewayLlmLog` and for `TraceRecords` on `ApiManagementGatewayLogs`; repeat on the Commercial estate from the pool runner | `.github/workflows/apiplane-w0-gov-probe.yml` (new; pattern `health-w0-gov-probe.yml`), `W0-RECEIPT.md` § 1 | none | Sonnet | **required** (new Gov workflow) | `gh run view <id> --json conclusion` = success; receipt quotes run id, per-boundary yes/no per table and category |
| W0-2 | `llm-*` family and friends on Gov Premium classic: consume #4442 Wave 0 task 2 / #4460 if a receipt exists; otherwise, in the same Gov run, PUT a scratch policy fragment containing `llm-token-limit`, `llm-emit-token-metric`, `trace` with metadata, `validate-azure-ad-token`, `include-fragment`, `rate-limit-by-key`, `quota-by-key`; PUT and GET a scratch named value; record accepted/rejected per element; delete all | same workflow, `W0-RECEIPT.md` § 2; a comment on #4460 | W0-1 | Sonnet | none | receipt table has one row per element per boundary with the HTTP status quoted |
| W0-3 | MCP API type: `GET …/apis?api-version=2025-09-01-preview&$filter=type eq 'mcp'` on Commercial and Gov; create a scratch passthrough MCP API against `https://learn.microsoft.com/api/mcp`, read `mcpProperties`, PUT an API-scoped policy, create a blank-path API with a `.well-known/...` operation, delete all | same workflow + a Commercial pool job, `W0-RECEIPT.md` § 3 | none | Sonnet | none | receipt quotes status codes and the observed `mcpProperties.endpoints` shape per boundary |
| W0-4 | Entra Agent ID and Graph: in each tenant the deploy identity can read, record whether the Microsoft Graph service principal exposes `AgentIdentity.Read.All`; list the Console UAMI's current Graph app-role assignments; record whether `groupMembershipClaims: SecurityGroup` is set on the sign-in app | `W0-RECEIPT.md` § 4 | none | Sonnet | none | each cell is yes / no / **unknown (reason)**; an unreadable Graph is unknown, never no |
| W0-5 | Azure Retail Prices API coverage: public, unauthenticated; count SKUs for `serviceName in ('Azure OpenAI','Foundry Models')` with `armRegionName` in Government regions vs Commercial; record which model families are absent in Government | `scripts/measure/apiplane/retail-prices-coverage.mjs` (new), `W0-RECEIPT.md` § 5 | none | Sonnet | none | script prints a table; receipt quotes counts per region family with the query URL |
| W0-6 | Named-value propagation latency on the Commercial PremiumV2 estate: write `w0-apiplane-latency` named value, poll a scratch API whose policy returns the value until it changes, record seconds; repeat with a second value; delete; operator notified in the tracking issue before the run | Commercial pool job, `W0-RECEIPT.md` § 6 | none | Sonnet | none | receipt quotes two latency measurements and proves deletion (`GET` → 404) |
| W0-7 | Anthropic-on-Foundry in Government: `az cognitiveservices account list-models -l usgovvirginia` filtered to format `Anthropic`; Learn statement if any; record `services.ai.azure.com` resolvability in the Gov VNet | same Gov workflow, `W0-RECEIPT.md` § 7 | W0-1 | Sonnet | none | receipt quotes model names or "none listed" with the command |
| W0-8 | Loom facts at head: `LOOM_APIM_NAME` gate sites (count and files); `app/api/apim/*` route list; `apim-client.ts` functions present vs needed (fragments, MCP APIs, pools/circuit breakers, diagnostics, loggers, Key Vault named values); `graph-identity-client.ts` / `graph-principals.ts` exports; `bootstrap-msal-app-reg.sh` functions for roles, scopes, consent; Container Apps Job pattern file; `main.json` headroom bytes; read the Mosaic port sources in full and record their commit SHA | `W0-RECEIPT.md` § 8 | none | Sonnet | none | every row has `file:line` at the named SHA or a Mosaic path + commit SHA |
| W0-9 | Decision pass: update `adr/ADR-00{3,4,7}` status lines and `RISKS-AND-OPEN-DECISIONS.md` D17 per boundary from W0-1/2/7; set the `apiplaneLlmLogs` per-boundary values W1-2 will write; record Q9–Q16 answers received; file W1's sub-issue; `python -S -E C:/Users/fgaro/.claude/kits/orchestrated-prp/prp_index.py check --root .` clean | `adr/*` (status lines only), `RISKS-AND-OPEN-DECISIONS.md`, `W0-RECEIPT.md` § 9, `PRP.md` execution state | W0-1..W0-8 | Sonnet | none | ADR status lines quote measured values; check is clean |

Lanes: L1 = W0-1 → W0-2 → W0-7 (one Gov workflow, three jobs); L2 = W0-3,
W0-6 (Commercial pool); L3 = W0-4, W0-5, W0-8 (read-only); W0-9 last.

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
| W0-1 | todo | | sonnet | | 2026-10-28 |
| W0-2 | todo | | sonnet | | 2026-10-28 |
| W0-3 | todo | | sonnet | | 2026-10-28 |
| W0-4 | todo | | sonnet | | 2026-10-28 |
| W0-5 | todo | | sonnet | | 2026-10-28 |
| W0-6 | todo | | sonnet | | 2026-10-28 |
| W0-7 | todo | | sonnet | | 2026-10-28 |
| W0-8 | todo | | sonnet | | 2026-10-28 |
| W0-9 | todo | | sonnet | | 2026-10-28 |
