---
name: apigw-W08-cross-cloud-connections
status: backlog
priority: P1
order: 46
depends_on: [apigw-W01b-close-gaps, apigw-W02b-endpoints, apigw-W04a-cost-centers-pricing, apigw-W04b-diagnostics-rollup-job, apigw-W05-budgets-notifications]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W8 - Cross-cloud connections (opt-in): manage Government gateways from a Commercial Loom

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md` (wave table and bicep rules). Shared context is linked, not repeated:
`ARCHITECTURE.md`, `TEST-STRATEGY.md`, `LOOM-INTEGRATION.md`, `W0-RECEIPT.md` in the same folder. Program rules: `.claude/rules/`.

## Goal
With `LOOM_APIPLANE_CROSS_CLOUD=true` and an isolated management vault, a Commercial Loom registers Government gateways and endpoints through a Government-tenant service principal, publishes with key-only runtime access, meters and prices by the served cloud, and discloses the data boundary (ADR-009). Sovereign-native remains the default and needs nothing from this wave.

## Why
Offers cross-cloud management without making it the default; credential handling is why review is required.

## Scope / Non-goals
**Scope:** work items W8-1, W8-2, W8-3, W8-4 below.

**Non-goals:** Government sign-in, Graph expansion, runtime tokens, federation, certificates, backend-secret vault flows (the blocked list).

## Acceptance criteria
Each names the value or output that would make it fail (the per-item Verify column below is part of this list).
- W8-1: `build-params` on every boundary; what-if on Commercial shows the vault only when the flag is true; a role-assignment scan shows exactly one principal with data access.
- W8-2: flag off gives 404 on every connection route and no code path references the management vault URI; a saved secret is never returned by any route; a cloud inferred from an environment tag fails the test.
- W8-3: a Government publication requesting Entra access is refused with reason; a failed Government query shows freshness "failing", Commercial intact, no zero shown; a Government call is priced only from Government rates.
- W8-4: probe run id; each step measured or unknown with reason; the disclosure text in the screenshot.

## Read first
- `ARCHITECTURE.md` ADR-009; `SECURITY-AND-COMPLIANCE.md`; `OPERATOR-DECISIONS-2026-10-29.md` (Q13).
- `W0-RECEIPT.md` sections 1, 3, 4, 6 (what is not measurable in GCC-High).
- `platform/fiab/bicep/modules/admin-plane/` (existing vault pattern).

## Owns
- `platform/fiab/bicep/modules/admin-plane/apiplane-mgmt-vault.bicep`
- `platform/fiab/bicep/modules/admin-plane/main.bicep` (two env vars only)
- `platform/fiab/bicep/params/*.bicepparam` (one param each)
- `apps/fiab-console/lib/api-gateway/connections/**`
- `apps/fiab-console/lib/api-gateway/secrets/key-vault-writer.ts` (management vault mode)
- `apps/fiab-console/app/api/admin/api-gateway/connections/**`
- `apps/fiab-console/app/admin/api-gateway/settings/connections/**`
- `apps/fiab-console/scripts/measure/apiplane/cross-cloud-probe.mjs`
- `.github/workflows/apiplane-cross-cloud-probe.yml`
- `docs/fiab/api-gateway/cross-cloud.md`
- `apps/fiab-console/e2e/api-gateway-connections.uat.ts`

## Must NOT touch
- Government Graph calls (blocked).
- APIM identity access to the vault.
- Any default other than `false` for the flag in any param file.

## Consumes
- W02b endpoints; W04a pricing by cloud; W04b telemetry; W05 budgets; W01b gate registry fix.

## Provides
- `azureConnection` entity and cloud-profile binding; Government-via-connection publication; cross-cloud probe workflow.

## Steps
Ordered; W8-1 then W8-2 then W8-3 then W8-4 (one lane). Bicep: W8-1 only.

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W8-1 | todo | | sonnet | | 2026-10-28 |
| W8-2 | todo | | sonnet | | 2026-10-28 |
| W8-3 | todo | | sonnet | | 2026-10-28 |
| W8-4 | todo | | sonnet | | 2026-10-28 |

#### Integration step (serialized)

- `apps/fiab-console/lib/gates/registry/api-gateway.ts` (gate `api-gateway.cross-cloud-vault`, Fix-it `provision`): owned by W01b; add one gate after it merges.
- Connection parameter in `lib/api-gateway/**` client entry points and cloud/connection branches of `lib/api-gateway/{registry,plan,telemetry,pricing,budgets}/**`: owned by W01b (registry), W02a (plan), W04b (telemetry), W04a (pricing), W05 (budgets); apply after each owner merges. Analytics per-cloud filters: owned by W04c.

## Validation
```bash
for p in commercial commercial-full gcc gcc-high il5 dod tenant-dmlz; do az bicep build-params --file platform/fiab/bicep/params/$p.bicepparam --stdout > /dev/null && echo "$p: OK"; done
node scripts/ci/check-bicepparam-compiled.mjs
node scripts/ci/check-bicep-param-cap.mjs
node scripts/ci/check-bicep-sync.mjs
make validate-bicep
pnpm --dir apps/fiab-console vitest run lib/api-gateway/connections lib/api-gateway/secrets
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
```
Per-cloud receipts: Commercial (managing side): vault deployed only when enabled; connection created, tested, secret replaced, removed. GCC-High (managed side): Actions probe run id (workflow fails closed on missing secrets). Sovereign-native GCC-High Loom unaffected. GCC/IL5: not exercised.
Merged is not done (`deploy-integrity.md` R2): until the deploy rolled and `/build-marker.txt` matches, report "merged, not deployed". A boundary without a receipt is named unexercised; GCC is supported-in-code, never exercised.

Done receipt: Commercial: vault only when enabled; connection lifecycle; disclosure shown. Government: probe run id covering authentication, inventory, reviewed publication, key accept/reject, backend identity, rotation, revocation, telemetry.

## Rollback
Flag off: routes 404, clients ignore connections, vault left in place (opt-in resource); removing a connection deletes only the stored credential; the operator removes the Government service principal.

## Docs to update
`docs/fiab/api-gateway/cross-cloud.md` (new); `docs/fiab/parity/apim-ai-gateway.md` and `docs/fiab/admin/api-management.md` (section-scoped rows only; no PRP owns these files, so they are edited last in the PR and rebased on conflict; ASSUMPTION: orchestrator assigns the docs slot in `PRPs/reference/GLOBAL-SCHEDULE.md`).

## Wave / Blocked-by / Branch / Worktree
Wave: 8 · Blocked-by: apigw-W01b-close-gaps, apigw-W02b-endpoints, apigw-W04a-cost-centers-pricing, apigw-W04b-diagnostics-rollup-job, apigw-W05-budgets-notifications · Branch: feat/apigw-w08 · Worktree: E:/Repos/_apigw-w08

> ASSUMPTION: The brief named W02b and W04a as the real edges; W04b, W05 and W01b are added because W8-3 edits telemetry and budgets branches and W8-1 adds a gate to the registry file W01b owns. Drop them if lane 1 owns those paths differently.

## Hot files
`platform/fiab/bicep/modules/admin-plane/main.bicep`, `platform/fiab/bicep/params/*.bicepparam`, `lib/gates/registry/api-gateway.ts`.
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md
`touches_bicep: yes`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W08-cross-cloud-connections.md, ARCHITECTURE.md ADR-009, W0-RECEIPT.md.
Goal: W8-1 vault infra (bicep slot) then W8-2 connections, W8-3 Gov via connection, W8-4 probe workflow.
Edit Owns paths only; shared files per Integration step.
Branch feat/apigw-w08 in E:/Repos/_apigw-w08. Check the bicep slot first.
Proof: build-params on 7 boundaries + vitest run lib/api-gateway/connections; flag-off route enumeration is 404.
"merged, not deployed" until rolled.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W8-1 | todo | | sonnet | | 2026-11-14 |
| W8-2 | todo | | sonnet | | 2026-11-14 |
| W8-3 | todo | | sonnet | | 2026-11-14 |
| W8-4 | todo | | sonnet | | 2026-11-14 |

Cost / credit estimate: ~8 Sonnet sessions; Azure: one Key Vault (opt-in), scratch Government resources deleted in the probe.
