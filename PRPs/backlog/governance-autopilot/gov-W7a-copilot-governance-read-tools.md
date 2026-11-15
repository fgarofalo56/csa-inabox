---
name: gov-W7a-copilot-governance-read-tools
status: backlog
priority: P2
order: 24
depends_on: [gov-W2-ges-core]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w7a-read-tools
---
# W7a - Copilot governance READ tools (status, coverage, scan results), tenant scope for admins

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
Copilot can answer "what is enrolled, scanned, classified and labeled" through registered read tools, with tenant scope for tenant admins only and every tenant-scope call audited (D10).

## 2. Why
The operator asked that Copilot act on the governance tools. Read tools ship early (they need only W2) and write tools follow in W7b, sequenced on the same orchestrator file. DESIGN s5.8.

## 3. Scope / Non-goals
In: new `lib/copilot/governance-tools.ts` (read tools), registration and loop truncation behaviour in `copilot-orchestrator.ts`. Non-goals: write tools (W7b), UI.
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] Tool schema tests pass; a non-admin asking `scope:"tenant"` is denied; an admin is allowed and an audit row exists.
- [ ] Rate limit trips on the 11th call in the window; a limit that never trips fails.
- [ ] Results page via cursor: 600 bindings returns `total=600`, `returned<=pageSize`, `truncated:true`.

## 5. Read first
- `apps/fiab-console/lib/azure/copilot-orchestrator.ts` (tool registration, confirmation, audit)
- `apps/fiab-console/lib/governance/inventory-tool.ts` (the W1 pattern to copy)
- W0-RECEIPT.md s2g
- DESIGN.md s5.8, s11 D10

## 6. Owns
- `apps/fiab-console/lib/copilot/governance-tools.ts` (new)
- `apps/fiab-console/lib/azure/copilot-orchestrator.ts` (registration lines only; W7b is serialized AFTER this PR)
- tests

## 7. Must NOT touch
- `item-crud.ts`
- purview-client.ts
- W1 inventory files except to import

## 8. Consumes
- gov-W2 binding store
- W1 `governance_inventory`

## 9. Provides
- read-tool contract that W7b extends and W8a mirrors

## 10. Steps
1. Define read tools in `governance-tools.ts`.
2. Register + auth + audit + rate limit.
3. Acceptance test: DESIGN s7.1 read half.

## 11. Validation
```bash
make validate-typescript
pnpm --dir apps/fiab-console vitest run lib/governance
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run lib/copilot lib/azure/__tests__/copilot
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Unregister the tools (one registration block); revert the PR.

## 13. Docs to update
DESIGN.md s5.8.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: gov-W2-ges-core · Branch: feat/gov-w7a-read-tools · Worktree: E:/Repos/_gov-w7a

## 15. Hot files
`copilot-orchestrator.ts` (W7a then W7b, serialized, never concurrent). touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s5.8, lib/governance/inventory-tool.ts (copy its pattern). Implement read tools in lib/copilot/governance-tools.ts and register them. Proof: vitest on lib/copilot including the non-admin tenant-scope denial and the 11th-call rate-limit trip.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W7a-1 read tool definitions | todo | | sonnet | | |
| W7a-2 registration + auth + audit | todo | | sonnet | | |
| W7a-3 rate limit + paging tests | todo | | sonnet | | |
