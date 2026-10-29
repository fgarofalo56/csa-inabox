---
name: apigw-W09-approvals-copilot-hardening
status: backlog
priority: P1
order: 30
depends_on: [apigw-W03-identity-entitlements, apigw-W05-budgets-notifications]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W9 — Approvals automation, advisory AI, Copilot tools, hardening, docs, final parity

**Goal**: routine access decisions can be scheduled under strict rules, an
advisory recommendation can be drafted by a governed model, Copilot can read
the plane, administration scoping is hardened, and the program closes with
greenfield / brownfield / Government docs, zero ❌ parity and receipts in both
clouds. No gateway writes beyond those already reviewed. `review: none`.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W9-1 | Scheduled approval policies: disabled by default; structured scope (resource type, environment, cost center, requester group), current eligibility, minimum age, local-time window, production-class requires explicit opt-in, moved or unclassified environments and ambiguous rules stay manual; no mode applies a gateway plan; policy editor under Entitlements → Approval policies; worker phase evaluating due requests with the same atomic approval as W3-6 | `lib/api-gateway/entitlements/scheduled-approvals.ts`, `app/api/admin/api-gateway/approval-policies/**`, `app/admin/api-gateway/entitlements/approval-policies/**`, `apps/fiab-console/e2e/run-apiplane-worker.mjs` (one phase) | none | Sonnet | none | a request younger than the minimum age is not approved; a production-class resource without opt-in stays manual; an approval never records a plan apply |
| W9-2 | Advisory AI recommendations: a governed model the plane itself published (a `platform` publication), called as the console's own application grant through the gateway (normal cost center, limits, budget); strict structured output (recommendation, confidence, cited facts); shown on the request detail; invalidated when the request's facts change; never authorizes a decision, tool, policy change or gateway write | `lib/api-gateway/entitlements/advisor.ts`, request detail UI (one card), `lib/api-gateway/platform-publication.ts` (ensures the platform publication exists via a reviewed plan the operator approves once) | W9-1 | Sonnet | none | the advisor call carries the console's token and `x-loom-cost-center: platform`; changing the request's cost center marks the recommendation stale; the advisor module exports no function that writes |
| W9-3 | Copilot tools and in-product guidance: read-only tools `apiplane_effective_access`, `apiplane_usage_summary`, `apiplane_gateway_health`, `apiplane_price_lookup`; draft tool `apiplane_draft_access_decision`; registration with the skills registry; LearnPopovers and a Copilot entry on every plane surface; Copilot can resolve the plane's registered gates through the existing Fix-it machinery | `lib/copilot/api-gateway-tools.ts` (new), `lib/copilot/skill-registry-core.ts` (descriptors), plane pages (LearnPopover props) | W3, W4 | Sonnet | none | tool test: each read tool returns the same result as its route for the same session (paired with a 403 for a non-admin session on admin-scoped tools); no tool imports from `lib/api-gateway/plan/` |
| W9-4 | Scoped-admin hardening (the `apiplane-admin` capability itself ships in W1-8 per Q9, 2026-10-29): a route-enumeration test over every plane admin route, kept current as surfaces grow across W2–W8; end-to-end check that every audited write records the capability used; docs for assigning and reviewing the group | `lib/api-gateway/__tests__/admin-routes.enumeration.test.ts` (new), `docs/fiab/admin/api-management.md` (one section) | W1-8, W3 | Sonnet | none | the enumeration test lists every `app/api/admin/api-gateway` route and fails when any accepts a session holding neither tenant admin nor the capability (a deliberately unguarded scratch route turns it red); a capability-only session gets 200 on a read route |
| W9-5 | Hardening and closure: drift findings UI across publications, pools and MCP; recovery flows exercised end to end; retention jobs verified (expired facts gone, monthly kept); RU/day and Log Analytics query cost recorded on the estate; quarterly "re-diff against Mosaic `main`" D-item added to `RISKS-AND-OPEN-DECISIONS.md`; `make validate` green; docs `docs/fiab/api-gateway/{greenfield,brownfield,government}.md` per `deploy-integrity.md` R8; `docs/fiab/parity/apim-ai-gateway.md` zero ❌; full G1 walks dark + light, narrow width, first-open; GCC-High receipts for every verifier; `MASTER-INDEX.md` row updated; the program's "Done" line in `PRP.md` § 7 met and reported as "merged, not deployed" until the roll is verified | docs listed, `e2e/api-gateway-*.uat.ts` (full suite), `PRPs/MASTER-INDEX.md` (one row), `PRPs/active/loom-api-gateway-plane/**` (status lines) | W9-1..W9-4, W6, W7, W8 | Sonnet | none (G1 walks) | parity doc zero ❌ (a script counts ❌ and fails on > 0, paired with a count of ✅ > 0); every verifier run id in both clouds; `make validate` output attached |

Lanes: L1 = W9-1 → W9-2; L2 = W9-3; L3 = W9-4; W9-5 last after W6, W7, W8
ship. No bicep.

## Done receipt (per cloud)

Commercial: scheduled approval observed on a qualifying request; advisor
recommendation rendered and invalidated; Copilot answers an effective-access
question from the tool; scoped admin enforced; full G1 suite green. GCC-High:
every verifier's run id listed in the closure receipt.

## Rollback

Scheduled policies disabled by default; advisor hidden by setting; Copilot
tools unregistered by removing descriptors; capability removal restores
tenant-admin-only.

## Cost / credit estimate

~10 Sonnet sessions.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W9-1 | todo | | sonnet | | 2026-10-28 |
| W9-2 | todo | | sonnet | | 2026-10-28 |
| W9-3 | todo | | sonnet | | 2026-10-28 |
| W9-4 | todo | | sonnet | | 2026-10-28 |
| W9-5 | todo | | sonnet | | 2026-10-28 |
