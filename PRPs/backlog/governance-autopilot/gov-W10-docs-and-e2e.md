---
name: gov-W10-docs-and-e2e
status: backlog
priority: P2
order: 29
depends_on: [gov-W7b-copilot-governance-write-tools, gov-W8b-item-chip-gates-parity-doc, gov-W9-brownfield-adopt]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: docs/gov-w10-docs-e2e
---
# W10 - Docs (greenfield + brownfield, both clouds), operator-prompt E2E, per-cloud Gov Actions receipt

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
The program is provably done: walkthroughs agree with the wizard, the operator prompt passes live, clean-create/self-heal/paused-skip/brownfield E2Es pass live, and a GCC-High Actions receipt exists.

## 2. Why
DESIGN s12 definition of done is deployed-and-verified, not merged. deploy-integrity.md R8: docs carry both paths.

## 3. Scope / Non-goals
In: `docs/fiab/governance-autopilot.md`, link from `docs/fiab/purview-setup.md`, a governance receipt job reusing existing workflow lanes (no new Gov deploy lane), `tests/e2e/**` acceptance test. Non-goals: product code.
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] mkdocs build passes (note the known mkdocs-material warning if it trips).
- [ ] Each doc step maps to a wizard step; a doc step the wizard lacks fails the R8 review.
- [ ] GCC-High receipt is an Actions run id; IL5, DoD and GCC are stated as exercised or not (default: not).
- [ ] Operator prompt passes live (DESIGN s7.1).

## 5. Read first
- DESIGN.md s7, s12
- deploy-integrity.md R8
- W0-RECEIPT.md s4 (Gov), s7

## 6. Owns
- `docs/fiab/governance-autopilot.md` (new)
- `docs/fiab/purview-setup.md` (link only)
- `.github/workflows/governance-autopilot-receipt.yml` (new; a receipt job calling the existing reusable lanes; no edits to existing workflow files, no new Gov deploy lane)
- `tests/e2e/**` governance spec

## 7. Must NOT touch
- product code
- new Gov deploy workflow lanes

## 8. Consumes
- all other waves merged and DEPLOYED

## 9. Provides
- closing receipts for the program tracking issue

## 10. Steps
1. Walkthroughs.
2. E2E spec.
3. Actions receipt job; dispatch for Commercial and GCC-High.
4. Report merged vs deployed vs verified per wave.

## 11. Validation
```bash
make validate-typescript
pnpm --dir apps/fiab-console vitest run lib/governance
pnpm --dir apps/fiab-console exec tsc --noEmit
mkdocs build
pnpm uat + the E2E spec
gh run view <id> --json conclusion  (Gov receipt)
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Docs only; revert.

## 13. Docs to update
this wave is the docs.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 6 · Blocked-by: gov-W7b-copilot-governance-write-tools, gov-W8b-item-chip-gates-parity-doc, gov-W9-brownfield-adopt · Branch: docs/gov-w10-docs-e2e · Worktree: E:/Repos/_gov-w10

## 15. Hot files
none. touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s7/s12 and deploy-integrity.md R8; confirm every other wave is merged AND deployed. Write the two walkthroughs, the E2E spec and the Actions receipt job. Proof: mkdocs build, E2E pass, Commercial live receipt, GCC-High Actions run id.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W10-1 greenfield + brownfield walkthroughs | todo | | sonnet | | |
| W10-2 operator-prompt E2E spec | todo | | sonnet | | |
| W10-3 Gov Actions receipt job | todo | | sonnet | | |
| W10-4 receipts to tracking issue | todo | | sonnet | | |
