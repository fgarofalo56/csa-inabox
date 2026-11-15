---
name: apigw-W01b-close-gaps
status: backlog
priority: P1
order: 22
depends_on: [apigw-W01-gateway-registry-observe]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
issues: [5210, 5200, 5203, 5202, 5201, 5186, 5187, 5179]
---
# W1b - Close the declared W1 gaps

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md`. W1 (PR #5191) shipped with declared gaps; this PRP owns them so they are not orphaned. Context: `apigw-W01-gateway-registry-observe.md` Completion note, `W0-RECEIPT.md`.

## Goal
Every gap W1 declared is either fixed with a live receipt or recorded as an owned, dated limitation.

## Why
W1 closed with its done receipt unmet (deploy-owned gateway not auto-registered live, G1 walk incomplete, specs never run). Later waves (W02 to W09) build on the registry and the gateway-scoped panes; leaving the gaps unowned violates `deploy-integrity.md` R2/R3 and `auto-bind-by-default.md`.

## Scope / Non-goals
**Scope:** W1b-1 to W1b-5 below.

**Non-goals:** new product capability; GCC-High items that cannot be measured from Actions (Q18 stays a declared gap unless the in-boundary measurement is possible).

## Acceptance criteria
- A fresh Commercial roll lists the deploy-owned gateway with `access.canRead=true` with no manual registration; value that breaks it: `GET /api/admin/api-gateway/gateways` returning zero gateways with `ownedBy: deploy`.
- The APIs, Products, Policies and Named values tabs show data (not "not gateway-scoped") for a registered non-default gateway; breaks if any tab shows that banner.
- The Telemetry card reports read access truthfully: a gateway without Monitoring Reader shows `accessDenied`, never a green check.
- `API_GATEWAY_GATES` appear in the central `GATES` list, on the admin gate page and resolvable by Copilot; breaks if `GATES` lacks `api-gateway.gateway-role`.
- The two Playwright specs run and pass, light theme and 390 px width included; the GCC-High probe compares APIs, products, backends and named values counts to ARM, not only API count.

## Read first
- `apps/fiab-console/lib/api-gateway/registry/gateway-service.ts`, `register.ts`, `resolve-gateway.ts`; env `LOOM_APIPLANE_DEPLOY_GATEWAY_ID` in `platform/fiab/bicep/modules/admin-plane/main.bicep`.
- `apps/fiab-console/lib/gates/registry/api-gateway.ts` (`API_GATEWAY_GATES`) and `lib/gates/registry/index.ts` (comment at line 48: exported beside GATES).
- `apps/fiab-console/lib/components/admin/apim-named-values-pane.tsx`, `apim-pane-fetch.ts`; `app/api/items/apim-{api,product,policy}/route.ts`.
- `apps/fiab-console/e2e/api-gateway-registry.uat.ts`, `api-gateway-hub.uat.ts`; `scripts/measure/apiplane/registry-probe.mjs`.
- Issues #5210, #5200, #5203, #5202, #5201, #5186, #5187 (read at head before trusting any body).

## Owns
- `apps/fiab-console/lib/api-gateway/registry/gateway-service.ts`
- `apps/fiab-console/lib/api-gateway/registry/register.ts`
- `apps/fiab-console/app/api/items/apim-api/route.ts`
- `apps/fiab-console/app/api/items/apim-product/route.ts`
- `apps/fiab-console/app/api/items/apim-policy/route.ts`
- `apps/fiab-console/lib/components/admin/apim-named-values-pane.tsx`
- `apps/fiab-console/lib/gates/registry/api-gateway.ts`
- `apps/fiab-console/lib/gates/registry/index.ts` (one import line only)
- `apps/fiab-console/app/admin/api-gateway/gateway-detail.tsx` (Telemetry card)
- `apps/fiab-console/e2e/api-gateway-registry.uat.ts`
- `apps/fiab-console/e2e/api-gateway-hub.uat.ts`
- `apps/fiab-console/scripts/measure/apiplane/registry-probe.mjs`

## Must NOT touch
- `platform/fiab/bicep/**` unless W1b-1 proves the env var is not wired (then stop and re-plan; bicep needs the single slot).
- Any W02+ owned path.

## Consumes
- W1 registry, observe, hub shell, gates.

## Provides
- A registry that auto-binds on a clean roll; gateway-scoped panes; gates visible to Admin and Copilot; a G1 receipt W02 to W09 can rely on.

## Steps
| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W1b-1 | Auto-register the deploy-owned gateway (#5210): find why first-load registration from `LOOM_APIPLANE_DEPLOY_GATEWAY_ID` did not register on the live estate (both live gateways are hand-registered); fix and make idempotent | `lib/api-gateway/registry/{gateway-service,register}.ts` | none | Sonnet | none | route test: a double with the env var set and an empty store registers exactly one `ownedBy: deploy` gateway; a second call adds none; live: clean roll lists it |
| W1b-2 | Gateway-scope the remaining panes (#5200, #5203): `scopeRoute` on `items/apim-api,product,policy`; Named values pane gateway-scoped with the Key Vault picker | the three route files, `apim-named-values-pane.tsx` | none | Sonnet | none | each route returns the selected gateway's data (a double with two gateways returns different bodies); the pane no longer shows the not-scoped banner |
| W1b-3 | Telemetry card read access (#5202) and gates into `GATES`, admin gate page and Copilot (#5201) | `gateway-detail.tsx`, `lib/gates/registry/{api-gateway,index}.ts` | none | Sonnet | none | card shows `accessDenied` when the double lacks Monitoring Reader; `GATES` contains the three gate ids; mutation: remove the import and the registry test goes RED |
| W1b-4 | Probes and measurements: W0 probe follow-ups (#5186); GCC-High probe compares APIs, products, backends, named values (not API count only); Q18 in-boundary measurement | `scripts/measure/apiplane/registry-probe.mjs` | W1b-1 | Sonnet | none | Actions run id with per-count MATCH or recorded mismatch; Q18 measured or recorded as impossible with the reason |
| W1b-5 | G1 receipts: run both Playwright specs, light theme, narrow width, Settings and MCP tabs, Commercial click-walk; update trackers #5187 and #5179 only after the roll is verified | the two `e2e/api-gateway-*.uat.ts` specs | W1b-1, W1b-2, W1b-3 | Sonnet | none (G1 walk) | spec output attached; screenshots dark + light + narrow |

> ASSUMPTION: Q18 (in-boundary GCC-High measurement) has no issue; step W1b-4 should open one (orchestrator or implementer, not this drafting pass).

> ASSUMPTION: `lib/gates/registry/api-gateway.ts` is edited only here in wave 2 among this program's PRPs; W08 adds its gate after W01b merges.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/registry lib/gates app/admin/api-gateway
pnpm --dir apps/fiab-console exec tsc --noEmit
node apps/fiab-console/scripts/measure/apiplane/registry-probe.mjs --help
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
```
Per-cloud receipts: Commercial: clean-roll gateway list plus G1 walk. GCC-High: Actions run id for the full-count probe. GCC and IL5: not exercised. Merged is not done: report "merged, not deployed" until `/build-marker.txt` matches the merge.

## Rollback
Revert the PR; registry data is additive and retained; `LOOM_APIPLANE_ENABLED=false` hides the hub.

## Docs to update
`docs/fiab/parity/apim-ai-gateway.md` W1 rows (only after the G1 walk); `docs/fiab/admin/api-management.md` (not-scoped note removed).

## Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: apigw-W01-gateway-registry-observe · Branch: feat/apigw-w01b · Worktree: E:/Repos/_apigw-w01b

## Hot files
`lib/gates/registry/api-gateway.ts`, `lib/gates/registry/index.ts`.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W01b-close-gaps.md and the W01 Completion note.
Goal: auto-register the deploy-owned gateway, scope the remaining panes, wire gates, run the G1 walk.
Edit only Owns paths. Branch feat/apigw-w01b in E:/Repos/_apigw-w01b.
Read issues #5210 #5200 #5203 #5202 #5201 #5186 at head first.
Proof: pnpm --dir apps/fiab-console vitest run lib/api-gateway/registry lib/gates; clean-roll gateway list.
Report "merged, not deployed" until /build-marker.txt matches.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W1b-1 | todo | | sonnet | #5210 | 2026-11-14 |
| W1b-2 | todo | | sonnet | #5200 #5203 | 2026-11-14 |
| W1b-3 | todo | | sonnet | #5202 #5201 | 2026-11-14 |
| W1b-4 | todo | | sonnet | #5186 | 2026-11-14 |
| W1b-5 | todo | | sonnet | #5187 #5179 | 2026-11-14 |

Cost / credit estimate: ~4 Sonnet sessions.
