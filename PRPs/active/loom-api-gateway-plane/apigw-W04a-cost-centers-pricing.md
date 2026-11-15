---
name: apigw-W04a-cost-centers-pricing
status: backlog
priority: P1
order: 29
depends_on: [apigw-W01-gateway-registry-observe]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---

# PRP: W4a - Cost centers (auto-bound per workspace) and pricing

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md`. Shared context (read only the cited part): `PRPs/active/loom-api-gateway-plane/ARCHITECTURE.md`, `TEST-STRATEGY.md`, and the ADRs named below. Rules: no-vaporware, no-fabric-dependency, cloud-parity, auto-bind-by-default, deploy-integrity, ux-baseline (G1/G2/G3), assertion-design (`.claude/rules/`).

## Goal
Every workspace has a cost center on day one (auto-bound at workspace creation, backfilled for existing workspaces), with the Cost centers pages; and a dated, source-cited price list with `matchPrice` and the Pricing page.

## Why
Cost centers are the attribution key for grants (apigw-W03a W3-3), usage (apigw-W04b) and budgets (apigw-W05). Pricing is needed by analytics (apigw-W04c). Neither needs the publishing engine, so this PRP runs in parallel with apigw-W02a. ADR-006, ADR-007.

## Scope / Non-goals
**Scope:** items W4-1 (cost centers) and W4-4 (pricing).

**Non-goals:**
- No worker, rollup or diagnostics (apigw-W04b).
- No analytics pages or chargeback sections (apigw-W04c).
- No budgets (apigw-W05).
- No bicep and no gateway writes.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] Creating a workspace creates its cost center with `code` = workspace slug and no user step (auto-bind receipt); value that breaks it: no cost-center document after workspace create, or a different code.
- [ ] Deleting the built-in `general` returns 409 `builtIn`; value that breaks it: 200.
- [ ] `resolveCostCenter` mutation receipt run in a sandbox copy goes RED.
- [ ] Removing a member revokes dependent access and shows Recheck pending; value that breaks it: access surviving removal.
- [ ] The backfill job creates a center for each existing workspace once; value that breaks it: a second run creating duplicates (deterministic dedupe).
- [ ] `matchPrice` mutation receipt (precedence, ties, token vs PTU applicability) goes RED in a sandbox copy.
- [ ] Schema test: every seed price cites a listed source; value that breaks it: a price with no source.
- [ ] "No price" renders for an unknown deployment type, paired with a priced row rendering its price; value that breaks it: 0 shown for unpriced.

## Read first
- `adr/ADR-006-cost-centers-per-workspace-and-budgets.md`, `adr/ADR-007-usage-from-gateway-logs.md`, `adr/ADR-010-native-rebuild-and-port-list.md` (price list port and MIT attribution).
- Workspace creation path: `apps/fiab-console/app/api/workspaces/route.ts` (`POST`, calls `applyWorkspaceBindings`) and `apps/fiab-console/lib/azure/workspace-bindings.ts` (`applyWorkspaceBindings`, `BindingResult`). The earlier reference to `lib/install/provisioners/workspace*.ts` was stale: only `workspace-monitor.ts` matches that glob and it is not a workspace-create provisioner.
- `apps/fiab-console/lib/api-gateway/types.ts` (`apiplane-*` containers exist; cost centers live in `apiplane-desired`), `lib/api-gateway/audit.ts` (`buildApiplaneAuditRecord`).
- `scripts/measure/apiplane/retail-prices-coverage.mjs` (existing price-source probe).

## Owns
Exact repo-relative paths:
- `apps/fiab-console/lib/api-gateway/cost-centers/**`
- `apps/fiab-console/app/api/admin/api-gateway/cost-centers/**`
- `apps/fiab-console/app/admin/api-gateway/cost-centers/**`
- `apps/fiab-console/lib/azure/workspace-bindings.ts`
- `apps/fiab-console/e2e/run-apiplane-backfill-cost-centers.mjs`
- `apps/fiab-console/lib/api-gateway/pricing/**`
- `apps/fiab-console/app/api/admin/api-gateway/pricing/**`
- `apps/fiab-console/app/admin/api-gateway/pricing/**`
- `scripts/csa-loom/price-seed.py`

## Must NOT touch
- `lib/api-gateway/types.ts` (apigw-W02a owns it in this program): keep cost-center and pricing types in their own module directories.
- `app/api/workspaces/route.ts`: the hook lives in `applyWorkspaceBindings`, not the route.
- Any `platform/fiab/bicep/**` file.
- Anything owned by another PRP in this program, including the lane files `apigw-W06*`, `apigw-W07*`, `apigw-W08*`, `apigw-W09*` and the hub `PRP.md`.

## Consumes
- apigw-W01-gateway-registry-observe (merged, not deployed): audit helper, containers, admin gate (`admin-gate.ts`), environments.
- `applyWorkspaceBindings` as the auto-bind hook point. ASSUMPTION: this is the correct provisioner seam (it is what `POST /api/workspaces` calls to bind backing resources); confirm by reading it before adding the hook, and add exactly one call.

## Provides
- Cost-center entity, `resolveCostCenter` and membership rules consumed by apigw-W03a (grants) and apigw-W04b (attribution).
- `matchPrice`, `priceVersion` docs and Pricing page consumed by apigw-W04c.
- Backfill one-shot `e2e/run-apiplane-backfill-cost-centers.mjs`.

## Steps
1. Cost centers (W4-1): entity (`code` rules, `general` built-in, owners, members, keys-allowed, per-person defaults, pooled quotas), tenant default setting, membership rules with revocation on removal and **Recheck pending**, deletion blockers (409 reasons), `resolveCostCenter`; Cost centers pages (list, detail with Members, New).
2. Auto-bind: one hook call in `applyWorkspaceBindings` creates the center (`code` = slug, deterministic dedupe, owners = workspace admins); backfill one-shot for existing workspaces. Record the cross-program order: `PRPs/backlog/per-workspace-spark-identity` PRPs also edit `workspace-bindings.ts`; whichever lands second rebases (additive hook).
3. Pricing (W4-4): ported `model-prices.json` + schema with attribution header (MIT notices), `priceVersion` docs (never edited; effective dates; author; audit `pricing.priceRecorded`), `matchPrice`, cost at read time (whole days; cached tokens at input rate; provisioned split by token share; idle months separate), cloud inference from host + admin override, Pricing page (Prices with date filter, Sources, Unpriced deployments, Clouds and endpoints), `price-seed.py` (`--check`, `--cache`, `--date`).
4. Mutation arms in a sandbox copy; Commercial receipt: create a workspace, show its cost center.

### Integration step (serialized)
- Hub navigation: add Cost centers and Pricing links in `app/admin/api-gateway/_lib/hub-model.ts` (owner: apigw-W01, shipped), one additive line each.
- Cross-program order: coordinate with `PRPs/backlog/per-workspace-spark-identity` on `lib/azure/workspace-bindings.ts` (additive hook; rebase on whichever lands first).

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/cost-centers lib/api-gateway/pricing app/api/admin/api-gateway/cost-centers app/api/admin/api-gateway/pricing
make validate-typescript
python scripts/csa-loom/price-seed.py --check
# Commercial receipt: create a workspace on the estate, then GET the cost-centers route and quote the document
```
Per-cloud receipts (cloud-parity; a boundary is claimed only with its own receipt):

| Boundary | Receipt required | State |
|---|---|---|
| Commercial | live run against the estate gateway, ids quoted | to be produced by this PRP |
| GCC-High | Actions run in-boundary (never local `az`); or the declared gap with its W0 measurement (`W0-RECEIPT.md`) | to be produced by this PRP; if the Gov estate is stood down, lifting the pause-declaration file is the operator's step |
| GCC | vitest / `az bicep build` parity only | supported-in-code, never exercised (no GCC tenant); not claimed |
| IL5 / DoD | vitest / `az bicep build` parity only | supported-in-code, never exercised; not claimed |

Merged is not done (`deploy-integrity.md` R2): until the change is rolled and the receipt observed on the estate, report it as "merged, not deployed".

## Rollback
Pages hidden by feature flag; hook call removable (centers retained, harmless); backfill is idempotent so re-running after revert changes nothing. No bicep.

## Docs to update
Doc sections are chained to apigw-W04c (analytics and pricing in `api-management.md`); record facts in the PR body for it. Third-party notice entry for the price list (MIT) in the repo notices file used by W1 ports.

## Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: apigw-W01-gateway-registry-observe · Branch: feat/apigw-w04a · Worktree: E:/Repos/_apigw-w04a

## Hot files
`lib/azure/workspace-bindings.ts` (one hook call; shared with spark-identity program). No gates or bicep.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W04a-cost-centers-pricing.md, ADR-006, ADR-007.
Goal: cost centers auto-bound to workspaces via applyWorkspaceBindings, plus pricing (W4-1, W4-4). Runs in parallel with apigw-W02a.
Edit only files under Owns. Worktree E:/Repos/_apigw-w04a, branch feat/apigw-w04a.
Proof: vitest on cost-centers + pricing + routes; make validate-typescript; python scripts/csa-loom/price-seed.py --check; create a workspace on Commercial and quote its cost center.
Report merged-not-deployed.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W4-1 cost centers + auto-bind | todo | | sonnet | | 2026-11-14 |
| W4-4 pricing | todo | | sonnet | | 2026-11-14 |
