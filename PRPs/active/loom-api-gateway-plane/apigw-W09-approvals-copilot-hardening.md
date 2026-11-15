---
name: apigw-W09-approvals-copilot-hardening
status: backlog
priority: P1
order: 50
depends_on: [apigw-W02c-workbench-adopt, apigw-W03c-requests-marketplace, apigw-W04c-analytics-verifier, apigw-W05-budgets-notifications, apigw-W06c-mcp-on-behalf-docs, apigw-W07c-adopt-day-one, apigw-W08-cross-cloud-connections]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W9 - Approvals automation, advisory AI, Copilot tools, hardening, docs, final parity

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md` (wave table and bicep rules). Shared context is linked, not repeated:
`ARCHITECTURE.md`, `TEST-STRATEGY.md`, `LOOM-INTEGRATION.md`, `W0-RECEIPT.md` in the same folder. Program rules: `.claude/rules/`.

## Goal
Routine access decisions can be scheduled under strict rules, an advisory recommendation can be drafted by a governed model, Copilot can read the plane, administration scoping is hardened, and the program closes with greenfield / brownfield / Government docs, zero missing parity rows and receipts in both clouds. No gateway writes beyond those already reviewed.

## Why
Closure wave: nothing in the program is done until its parity doc has zero missing rows and every verifier has a run id in both clouds.

## Scope / Non-goals
**Scope:** work items W9-1, W9-2, W9-3, W9-4, W9-5 below.

**Non-goals:** New gateway writes; any change to W2 to W8 behaviour beyond hardening fixes.

## Acceptance criteria
Each names the value or output that would make it fail (the per-item Verify column below is part of this list).
- W9-1: a request younger than the minimum age is not approved; a production-class resource without opt-in stays manual; an approval never records a plan apply.
- W9-2: the advisor call carries the console token and `x-loom-cost-center: platform`; changing the request cost center marks the recommendation stale; the advisor module exports no function that writes.
- W9-3: each read tool returns the same result as its route for the same session, paired with a 403 for a non-admin session on admin-scoped tools; no tool imports from `lib/api-gateway/plan/`.
- W9-4: the enumeration test fails when a deliberately unguarded scratch route exists; a capability-only session gets 200 on a read route.
- W9-5: the parity-doc missing-row count is zero (script fails above 0, paired with a done count above 0); every verifier run id present in both clouds; `make validate` output attached.

## Read first
- `PRP.md` section 7 (Done line) and section 9.
- `docs/fiab/parity/apim-ai-gateway.md`; `RISKS-AND-OPEN-DECISIONS.md`.
- `apps/fiab-console/lib/copilot/skill-registry-core.ts`; `apps/fiab-console/e2e/run-apiplane-worker.mjs`.

## Owns
- `apps/fiab-console/lib/api-gateway/entitlements/scheduled-approvals.ts`
- `apps/fiab-console/app/api/admin/api-gateway/approval-policies/**`
- `apps/fiab-console/app/admin/api-gateway/entitlements/approval-policies/**`
- `apps/fiab-console/lib/api-gateway/entitlements/advisor.ts`
- `apps/fiab-console/lib/api-gateway/platform-publication.ts`
- `apps/fiab-console/lib/copilot/api-gateway-tools.ts`
- `apps/fiab-console/lib/api-gateway/__tests__/admin-routes.enumeration.test.ts`
- `docs/fiab/api-gateway/greenfield.md`
- `docs/fiab/api-gateway/brownfield.md`
- `docs/fiab/api-gateway/government.md`
- `docs/fiab/parity/apim-ai-gateway.md`
- `apps/fiab-console/e2e/api-gateway-closure.uat.ts`
- `PRPs/active/loom-api-gateway-plane/PRP.md` (Execution state rows only)

## Must NOT touch
- `PRPs/MASTER-INDEX.md`, `PRPs/INDEX.md`, `PRPs/REGISTER.md` (orchestrator owns; request the row update in the PR body).
- Gateway write paths (`lib/api-gateway/plan/**`).

## Consumes
- Everything W02 to W08; W3 requests engine; W4 analytics; W6/W7/W8 verifiers.

## Provides
- Closure receipt and the program Done line (`PRP.md` section 7).

## Steps
Ordered; W9-1 then W9-2; W9-3; W9-4 (parallel lanes); W9-5 last after W06c, W07c, W08 have shipped. No bicep.

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W9-1 | todo | | sonnet | | 2026-10-28 |
| W9-2 | todo | | sonnet | | 2026-10-28 |
| W9-3 | todo | | sonnet | | 2026-10-28 |
| W9-4 | todo | | sonnet | | 2026-10-28 |
| W9-5 | todo | | sonnet | | 2026-10-28 |

#### Integration step (serialized)

- `apps/fiab-console/e2e/run-apiplane-worker.mjs` (one approval phase): owned by W04b.
- `apps/fiab-console/lib/copilot/skill-registry-core.ts` descriptors and LearnPopover props on plane pages: shared; edit as the last step of W9-3 after every wave merged (ASSUMPTION: no other PRP owns skill-registry-core.ts; confirm).
- Request detail UI advisory card: owned by W03c.
- `docs/fiab/admin/api-management.md` (one section, W9-4): no PRP owns it; section-scoped append.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway lib/copilot
make validate
pnpm --dir apps/fiab-console uat   # full G1 walks: dark + light, narrow width, first-open
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
```
Per-cloud receipts: Commercial: scheduled approval observed, advisor recommendation rendered and invalidated, Copilot answers an effective-access question, full G1 suite. GCC-High: every verifier run id listed in the closure receipt. GCC/IL5: labelled not exercised.
Merged is not done (`deploy-integrity.md` R2): until the deploy rolled and `/build-marker.txt` matches, report "merged, not deployed". A boundary without a receipt is named unexercised; GCC is supported-in-code, never exercised.

Done receipt: Commercial and GCC-High receipts above; program Done line in `PRP.md` section 7 met; reported as "merged, not deployed" until the roll is verified.

## Rollback
Scheduled policies disabled by default; advisor hidden by setting; Copilot tools unregistered by removing descriptors; capability removal restores tenant-admin-only.

## Docs to update
`docs/fiab/api-gateway/{greenfield,brownfield,government}.md` per `deploy-integrity.md` R8; `docs/fiab/parity/apim-ai-gateway.md` zero missing; add a quarterly "re-diff against Mosaic main" D-item to `RISKS-AND-OPEN-DECISIONS.md` (section-scoped append; shared file).

## Wave / Blocked-by / Branch / Worktree
Wave: 9 · Blocked-by: apigw-W02c-workbench-adopt, apigw-W03c-requests-marketplace, apigw-W04c-analytics-verifier, apigw-W05-budgets-notifications, apigw-W06c-mcp-on-behalf-docs, apigw-W07c-adopt-day-one, apigw-W08-cross-cloud-connections · Branch: feat/apigw-w09 · Worktree: E:/Repos/_apigw-w09

> ASSUMPTION: The brief states W9-5 needs W06c, W07c, W08, W9-3 needs W04c, W9-2 needs W02c; all are listed in depends_on for the whole PRP because Owns is PRP-wide.
> ASSUMPTION: `e2e/api-gateway-closure.uat.ts` is a new aggregate spec replacing the original "e2e/api-gateway-*.uat.ts (full suite)" glob.

## Hot files
`lib/copilot/skill-registry-core.ts`, `e2e/run-apiplane-worker.mjs`, `docs/fiab/parity/apim-ai-gateway.md`.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W09-approvals-copilot-hardening.md, PRP.md sections 7 and 9.
Goal: W9-1..W9-4 then W9-5 closure (docs, parity zero missing, receipts).
Start W9-5 only when W06c, W07c, W08 have merged and rolled.
Branch feat/apigw-w09 in E:/Repos/_apigw-w09.
Proof: make validate; vitest run lib/api-gateway lib/copilot; the parity-doc count script exits 0.
"merged, not deployed" until rolled.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W9-1 | todo | | sonnet | | 2026-11-14 |
| W9-2 | todo | | sonnet | | 2026-11-14 |
| W9-3 | todo | | sonnet | | 2026-11-14 |
| W9-4 | todo | | sonnet | | 2026-11-14 |
| W9-5 | todo | | sonnet | | 2026-11-14 |

Cost / credit estimate: ~10 Sonnet sessions.
