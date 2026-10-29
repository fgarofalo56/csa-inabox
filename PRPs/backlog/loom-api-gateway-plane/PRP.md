---
name: loom-api-gateway-plane
status: backlog
allow_parallel: true
priority: P1
order: 20
depends_on: []
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# PRP: Loom API & AI Gateway Plane — master

| Field | Value |
|---|---|
| Status | DRAFT — design complete; W0 (measurement spike, no product code) may start immediately; everything else waits for W0's receipt. **Q9–Q16 and #4442 Q5 answered 2026-10-29** (`OPERATOR-DECISIONS-2026-10-29.md`); no open operator question remains before W0 |
| Created | 2026-10-28 |
| Decision source | Operator mandate 2026-10-28 (verbatim in `README.md`), operator decisions Q1–Q8 (`OPERATOR-DECISIONS-2026-10-28.md`) and Q9–Q16 + #4442 Q5 + sequencing (`OPERATOR-DECISIONS-2026-10-29.md`) |
| Tracking issue | filed with this PR: "API & AI Gateway Plane (PRP): fold Mosaic into Loom — W0 measurement spike" |
| Related rules | every file in `.claude/rules/` — section 8 says how each is met |
| Related programs | `apim-ai-gateway` (#4442; greenlit 2026-10-28; W7 depends on its Waves A/B1; shares `apim.bicep`), `loom-health-data-services` (bicep collision rule; `health/apim-fragment.bicep` fragment pattern), `governance-autopilot`, `per-workspace-spark-identity` |
| Boundaries | Commercial, GCC-High (receipts); IL5 supported-in-code via params (no deploy run); GCC supported-in-code only, never exercised |
| Implemented by this PR | Nothing. Docs only |

Evidence convention: repo claims carry `file:line` measured on `origin/main`
at `b9decb4a8` (2026-10-28); external claims carry a URL in `research/` with
the retrieval date; anything not read in full is **UNVERIFIED**. Per-wave
`review` is set in each wave file's frontmatter and governs; this master's
`review: none` carries no items of its own.

## 1. Goals

G1. One API & AI Gateway plane inside the Loom console that onboards any
number of API Management instances, publishes models and MCP servers through
reviewed plans, governs access with keys and Entra tokens, meters usage from
gateway logs, prices it, allocates it to cost centers, enforces budgets and
notifies — the Mosaic capability set (`MOSAIC-CAPABILITY-MAP.md`), Azure-native,
no second sign-in, no second portal.
G2. The same capabilities in Commercial and GCC-High with per-cloud receipts;
IL5 by params; GCC supported-in-code, never exercised and always labelled so.
G3. Zero plumbing for users: the deploy registers its own gateway, creates a
cost center per workspace, provisions the runtime registrations and roles;
the only human step is switching a gateway to manage.
G4. Nothing stored that must not be: no policy XML, no keys, no secrets; no
gateway write outside a reviewed plan except the two disclosed ones.
G5. A-grade surfaces: parity doc zero ❌, G1 walks, mutation receipts.
G6. Loom's own AI traffic governed by the same plane (#4442 B1 → W7).

## 2. Non-goals

`PRD.md` § 4: no runtime proxy; no Bedrock / Vertex / SaaS backends (Q3, review
2027-04-28); no Government sign-in or Graph; no second portal; no APIM
developer-portal designer, certificates, custom domains or workspaces; no
compliance claim; no replacement of #4442's bicep gateway before W7's reviewed
adoption.

## 3. Waves overview

| Wave | File | Ships | Review | Depends on |
|---|---|---|---|---|
| W0 | `apigw-W00-measurement-spike.md` | measurements (Gov LLM logs/traces, `llm-*` policies, MCP API type, Agent ID, Retail Prices Gov, named-value latency, Anthropic-on-Foundry in Gov, Loom facts), decision pass | none (W0-1 item: required, new Gov workflow) | — |
| W1 | `apigw-W01-gateway-registry-observe.md` | five containers; gateway registry + preflight + auto-registration; inventory sync + policy facets + detection; environment catalog + `permits()`; admin hub shell with the existing eight panes under Manage; gates; scoped `apiplane-admin` capability (Q9); parity doc | none | W0 |
| W2 | `apigw-W02-publishing-plan-apply.md` | plan/apply/rollback engine (Opus design pass); renderers + three shapes; endpoint registry + readiness; key-authenticated endpoints; publications workbench; adoption of existing APIs incl. the deploy-owned pool | **required** | W1 |
| W3 | `apigw-W03-identity-entitlements.md` | two runtime registrations in bootstrap; principals; grants; governed-access renderer (Opus design pass); keys and reveal; access requests on the F16 engine; marketplace Models / My access; `verify-model-access.mjs` | **required** | W2 |
| W4 | `apigw-W04-cost-centers-usage-pricing.md` | cost centers with per-workspace auto-bind; diagnostics writer + Telemetry card; rollup job; pricing; Analytics; chargeback join; user Usage & cost | none | W1 (items W4-3+ need W3-4 for attribution) |
| W5 | `apigw-W05-budgets-notifications.md` | budgets + forecast; named-value enforcement; notification engine; Graph email; Teams Workflows; preferences; digests | **required** | W4 |
| W6 | `apigw-W06-mcp-publishing.md` | MCP registry + discovery; MCP publication + PRM; MCP grants; model caller + on-behalf; Loom's own agents through the gateway; REST → MCP | **required** | W3 (W6-4 needs W4-3) |
| W7 | `apigw-W07-model-pools-deployments.md` | model pools; health and suggestions; per-pool access; reviewed model deployment; adoption of the day-one gateway; console principal under `platform` | **required** | W2; #4442 Waves A/B1 (external) for W7-5 |
| W8 | `apigw-W08-cross-cloud-connections.md` | management vault (opt-in); Azure connections; Government gateways via connection; disclosure; verifier | **required** | W2 |
| W9 | `apigw-W09-approvals-copilot-hardening.md` | scheduled approval policies; advisory AI; Copilot tools; scoped-admin hardening; drift and recovery hardening; greenfield/brownfield/government docs; final parity | none | W3, W5 |

## 4. Dependency graph and run order

```
W0 ─► W1 ─┬─► W2 ─┬─► W3 ─┬─► W6 ─┐
          │       │       └─► W9 ◄┼─ W5 ◄─ W4
          │       ├─► W7 (after #4442 A/B1)
          │       └─► W8
          └─► W4 ─► W5
```

Parallel after W1: {W2} ‖ {W4}. After W2: {W3} ‖ {W8} ‖ {W7 once #4442 A/B1
merged}. After W3: {W6}. W9 last. W4 items that need grant attribution
(W4-3 onward) wait for W3-4's renderer to emit traces, which is an item-level
edge, not a wave edge.

## 5. Lanes, WIP and the bicep collision rule

- At most **4** lanes in flight (WIP limit, review capacity).
- **One bicep PR in flight at a time** across this set, #4442, LHDS,
  governance-autopilot and spark-identity. This set's bicep items: W1-2
  (`apim.bicep` outputs, Monitoring Reader, `GatewayLlmLogs`, params;
  `landing-zone/cosmos.bicep`), W4-3 (`apiplane-worker-job.bicep`, own deploy
  unit), W7-5 (`loomBackends.aoaiGateway: 'plane'`), W8-1
  (`apiplane-mgmt-vault.bicep`, own deploy unit). W1-2 must queue behind
  #4442 Wave A's `apim.bicep` change or be the same PR by agreement.
- File ownership is declared per item; items sharing no files and no
  dependency edge are parallel candidates. Shared files (`apim-client.ts`,
  `cosmos-client.ts`, `admin-shell.tsx`, `apim.bicep`) are sequenced, never
  parallelised.
- Every item pushes before dispatching a reviewer; a content push voids a
  verdict (`csa_loom_review_verdict_mechanics_index`).

## 6. Cost rules (from `MASTER-INDEX.md` / `finish-2026-10` lean mode)

Fresh small sessions; Sonnet default; **Opus only for W2-1 and W3-4**; one
reviewer, one round where possible, findings fixed in-round; PR bodies
≤ 3 KB; no polling (queue merges, background watcher); Azure spend limited to
Log Analytics ingestion of governed calls, Cosmos RU for rollups (measured
and recorded in W4-6), and W0's scratch resources (deleted in the same run).
Estimate: ~116 Sonnet sessions + 2 Opus passes across W0–W9.

## 7. Verification and "done"

A wave is done when, per `deploy-integrity.md` R2: every item merged; the
deploy rolled and `/build-marker.txt` matches; the G1 browser walk is
attached (Commercial) and the Gov verifier run ID is quoted (GCC-High via
Actions); the mutation receipts named in `TEST-STRATEGY.md` are in the PR
bodies; the parity doc rows the wave claims are flipped; `make validate` is
green. Until the roll is verified the wave is reported as **"merged, not
deployed"**. A boundary without a receipt is named unexercised.

The program's "Done" line: W9's receipt attached; `docs/fiab/parity/apim-ai-gateway.md`
zero ❌; Loom's own Copilot traffic attributed under `platform` in Analytics
on the Commercial estate; GCC-High gateway registered, publishing, metering
and blocking with run IDs.

## 8. How each die-hard rule is met

| Rule | How |
|---|---|
| `no-vaporware.md` | every surface calls real ARM / Log Analytics / Graph / Cosmos; honest gates only where the platform cannot act (tenant consent, mailbox, boundary gaps), each registered with Fix-it; Bicep sync items in `LOOM-INTEGRATION.md` § 5 |
| `no-fabric-dependency.md` | nothing touches Fabric or Power BI; APIM, Foundry, Log Analytics, Cosmos, Graph only |
| `cloud-parity.md` | per-cloud receipts per wave; declared gaps with owner, date, substitute (D17; #4460); GCC/IL5 labels on every table; cross-cloud never substitutes Commercial values for Government |
| `auto-bind-by-default.md` | deploy-owned gateway auto-registers; cost center per workspace; registrations and roles by bootstrap/bicep; role-grant Fix-its; the single human step is observe → manage |
| `deploy-integrity.md` | R2 wording; R4 greenfield + brownfield receipts (W1-7, W9-5); R5 brownfield discovery offers, never adopts silently; R6 classified failures with exact remediation; R7 unknown is reported as unknown; R8 docs for both paths |
| `ui-parity.md` | `AZURE-PARITY-INVENTORY.md` → `docs/fiab/parity/apim-ai-gateway.md`; rows it closes in `apim-service.md` named; nothing claimed beyond them |
| `ux-baseline.md` | G1 walks per wave; G2 gates with Fix-it; G3 `SplitPane` in workbenches; first-open clean on freshly registered resources |
| `web3-ui.md` | Fluent v9 + tokens, `AdminShell`, `TileGrid`, `EmptyState`, `SplitPane`; side-by-side with Marketplace and Governance in each PR |
| `assertion-design.md` | `TEST-STRATEGY.md` § 1 mutation table; every verifier expectation names what breaks it; absence assertions paired |
| `session-end.md` / `task-tracking.md` | tracking issue + per-wave sub-issues; execution state tables; issues close only on deployed-and-verified |

## 9. Rollback

Feature flag `LOOM_APIPLANE_ENABLED=false` hides the hub, the marketplace
offering kinds and the self routes and stops the worker job; existing
`/admin/api-management` panes keep working against the deploy-owned gateway.
Plane-owned APIM resources are removed only through reviewed unpublish plans.
Containers are retained. Bootstrap registrations are left in place (removal is
a documented manual step).

## 10. Decisions needed

None open. Q9–Q16 were answered on 2026-10-29 (`OPERATOR-DECISIONS-2026-10-29.md`;
answers beside their defaults in `RISKS-AND-OPEN-DECISIONS.md` § 2): Q9 scoped
`apiplane-admin` capability from W1 (the one departure from a default, hence
W1-8); Q10 adopt the day-one gateway in W7; Q11 new shared mailbox per
boundary; Q12 Teams Workflows only; Q13 the operator creates the Government
service principal; Q14 price seed per release plus an on-demand check; Q15
no default budget on auto-created cost centers; Q16 platform traffic governed
and visible in chargeback. #4442 Q5: stay on PremiumV2. W0's Commercial and
Government probe runs are shared with #4442 Wave 0. New questions raised by a
wave are filed as Q17+ in the risks file and wait for an answer.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W0 | todo | | sonnet | `apigw-W00-measurement-spike.md` | 2026-10-28 |
| W1 | todo | | sonnet | `apigw-W01-gateway-registry-observe.md` | 2026-10-28 |
| W2 | todo | | sonnet (W2-1 opus) | `apigw-W02-publishing-plan-apply.md` | 2026-10-28 |
| W3 | todo | | sonnet (W3-4 opus) | `apigw-W03-identity-entitlements.md` | 2026-10-28 |
| W4 | todo | | sonnet | `apigw-W04-cost-centers-usage-pricing.md` | 2026-10-28 |
| W5 | todo | | sonnet | `apigw-W05-budgets-notifications.md` | 2026-10-28 |
| W6 | todo | | sonnet | `apigw-W06-mcp-publishing.md` | 2026-10-28 |
| W7 | todo | | sonnet | `apigw-W07-model-pools-deployments.md` | 2026-10-28 |
| W8 | todo | | sonnet | `apigw-W08-cross-cloud-connections.md` | 2026-10-28 |
| W9 | todo | | sonnet | `apigw-W09-approvals-copilot-hardening.md` | 2026-10-28 |
