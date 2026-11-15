---
name: gov-W2-ges-core
status: backlog
priority: P2
order: 17
depends_on: []
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w2-ges-core
---
# W2 - Binding model, Governance Enrollment Service core, backingStore field, name rules, reconcile engine

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
A tested, idempotent enrollment core: the `governance-binding` model (one doc per backing source), `purviewName` sanitisation, the reconcile state machine, and a `backingStore` field on every catalog item type. No scans and no Purview writes yet (W4). This is the contract every later wave consumes.

## 2. Why
Every other wave (scans, triggers, labels, tools, UI) consumes the binding model and the `backingStore` map. Getting idempotency and dedupe wrong here corrupts Purview registration for everything downstream. DESIGN s5.1, s5.3, s5.4.

## 3. Scope / Non-goals
In: `lib/governance/enrollment/**` (new), `backingStore` field in `lib/catalog/fabric-item-types.ts` and `lib/catalog/item-types/types.ts`, new `governance-bindings` Cosmos container in `lib/azure/cosmos-client.ts`, unit tests. Non-goals: scan create/run (W4), triggers/hooks (W5a), bicep (W3), UI (W8). Reuse `lib/governance/backing-resolver.ts` (merged in W0) rather than rewriting it.
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] `purviewName("My Lakehouse (x)")` returns a name that satisfies the Purview ruleset; a 64-char input is cut to <=63 and a second colliding input gets a deterministic suffix; a test input of 64 chars that returns 64 fails.
- [ ] Second `enroll(item)` on an unchanged item is a no-op: the binding etag is unchanged; a test where etag changes on the second call fails.
- [ ] Two lakehouses on one storage account produce exactly 1 binding doc with 2 `scanScopes`; 2 binding docs fails.
- [ ] Every slug in `fabric-item-types.ts` has an explicit `backingStore` treatment (a kind or `none`); a slug with `undefined` fails the coverage test.

## 5. Read first
- `apps/fiab-console/lib/governance/backing-resolver.ts` (`resolveBackingSource`)
- `apps/fiab-console/lib/azure/purview-autoonboard.ts` (current per-item behaviour; lines ~182-232 keys)
- `apps/fiab-console/lib/azure/cosmos-client.ts` (container registry pattern)
- `apps/fiab-console/lib/catalog/fabric-item-types.ts`
- DESIGN.md s5.1, s5.3, s5.4, s6.4 W2; W0-RECEIPT.md s2a (key per item type)

## 6. Owns
- `apps/fiab-console/lib/governance/enrollment/**` (new)
- `apps/fiab-console/lib/catalog/fabric-item-types.ts`, `lib/catalog/item-types/types.ts` (add `backingStore` only)
- `apps/fiab-console/lib/azure/cosmos-client.ts` (new container entry only)
- tests under `lib/governance/__tests__/` and `lib/governance/enrollment/__tests__/`

## 7. Must NOT touch
- `lib/azure/purview-client.ts`, `item-crud.ts`, `purview-autoonboard.ts` (W4 / W5a)
- any `platform/fiab/bicep/**`
- `copilot-orchestrator.ts`

## 8. Consumes
- W0 resolver table (`backing-resolver.ts`)
- `purview-client.ts` read functions (no calls in this wave)

## 9. Provides
- `governance-binding` type + store API (`upsertBinding`, `getBindingBySource`)
- `enroll(item, op)` dry-run-capable core that W4/W5a/W7a/W8a call
- `backingStore` map consumed by W3 (which principals/scopes) and W9

## 10. Steps
1. Opus design pass (one session section): reconcile state machine + idempotency + lease (Cosmos etag), written into the PR description.
2. Add `governance-bindings` container (PK `/tenantKey`).
3. Implement `purviewName`, binding upsert, dedupe, `enroll`/`reconcile` with an injected Purview port (no live calls).
4. Add `backingStore` to every slug; coverage test.
5. Run mutations (below) against a sandbox copy.

## 11. Validation
```bash
make validate-typescript
pnpm --dir apps/fiab-console vitest run lib/governance
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run lib/governance lib/catalog
Mutation: in a SANDBOX COPY drop the etag check and the dedupe key; both must turn tests RED; prove the tracked tree untouched with `git hash-object` before/after.
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Pure additive code plus one empty Cosmos container; revert the PR. The container can stay empty.

## 13. Docs to update
`docs/fiab/governance-autopilot.md` is W10; here only update DESIGN.md s5.3 if the binding shape changed.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 1 · Blocked-by: none · Branch: feat/gov-w2-ges-core · Worktree: E:/Repos/_gov-w2

## 15. Hot files
`fabric-item-types.ts`, `cosmos-client.ts` (this wave is the ONLY owner in the program for these two). touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s5.1/5.3/5.4 and this file. Do the Opus design pass first, then implement lib/governance/enrollment/** with an injected Purview port. Proof: vitest on lib/governance + the sandbox mutation RED/green record in the PR.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W2-1 reconcile state-machine design note (Opus) | todo | | sonnet | | |
| W2-2 governance-bindings container + store | todo | | sonnet | | |
| W2-3 purviewName + dedupe + enroll core | todo | | sonnet | | |
| W2-4 backingStore on every slug | todo | | sonnet | | |
| W2-5 mutation receipt | todo | | sonnet | | |
