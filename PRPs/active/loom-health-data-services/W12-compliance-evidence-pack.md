---
name: W12-compliance-evidence-pack
status: backlog
priority: P1
order: 30
depends_on: [W11b-hardening-bicep, W08b-breakglass-audit-siem]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W12 — Compliance evidence pack (design mapping and generated evidence; never a certification claim)

Shared rules: `PRP.md` section 5. Source list: `SECURITY-AND-COMPLIANCE.md` section 16.

## Goal
The platform generates the evidence list in `SECURITY-AND-COMPLIANCE.md` section 16 on demand per cloud, with control mappings (HIPAA, NIST 800-53 High with the Azure Gov CRM as the inheritance source, 42 CFR Part 2, HITRUST domains, VA 6500 / IHS package inputs). Every page states that it is design mapping and evidence, not an authorization.

## Why
Operator decision 8: compliance is mapped and evidenced, never claimed. Assessors need reproducible, hash-stamped evidence.

## Scope / Non-goals
In: W12-1 .. W12-4. Out: any ATO, certification or FedRAMP claim; HITRUST assessment.

## Acceptance criteria
- [ ] W12-1: the pack generates in under 1 h; every evidence item is present or marked "not produced: why"; a tampered input changes the pack hash. Fails if an item missing its source is silently omitted.
- [ ] W12-2: every mapping row cites a design element and an evidence item id; a row with no evidence is flagged, not hidden. Fails on a row citing an id that the generator does not emit.
- [ ] W12-3: the download hash in the Evidence tab equals the generator's hash; Playwright ISSO walk.
- [ ] W12-4: `prp_index.py check` is clean; the per-cloud status table carries run ids; the needle scan for "certified", "authorized", "compliant" in `docs/fiab/health/**` returns only disclaimer sentences (a regression guard, the review is the check).

## Read first
`SECURITY-AND-COMPLIANCE.md` sections 15 and 16, `OPERATIONS-AND-BCDR.md`, `TEST-STRATEGY.md` section 9, W08b audit-chain report, W11 drill receipts, `apps/loom-health-cp/src/jobs/runner.ts`.

## Owns
`apps/loom-health-cp/src/evidence/**`, `apps/fiab-console/app/api/health/evidence/**`, `docs/fiab/health/compliance/**`, `apps/fiab-console/lib/editors/health/tenant-editor.tsx` (Evidence tab), `apps/fiab-console/app/api/health/tenants/[id]/evidence/**`, `README.md`, `ARCHITECTURE.md` section 6, `PRP.md` status lines (W12-4 only).

## Must NOT touch
Control-plane auth code, PDP policies, bicep, other editor tabs.

## Consumes
W08b audit chain verification, W11a/W11b drill and restore receipts, W02a scrubber receipts, W06c isolation gate, SBOM and cosign data from the image workflows.

## Provides
The evidence pack and mapping tables; the closing status for the program.

## Steps
1. W12-1 generator. 2. W12-2 mappings (Opus pass) beside it (different files). 3. W12-3 tab. 4. W12-4 close-out.

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W12-1 | Evidence generator job, each item stamped with cloud + Actions run id | W11, W8-4 | Sonnet | required (assurance artefacts) | Pack under 1 h; tamper changes hash |
| W12-2 | Control mapping tables (CSV/OSCAL + docs) | W12-1 | Opus mapping pass | required | Every row cites design + evidence id |
| W12-3 | Evidence tab and ISSO walk | W12-1 | Sonnet | none (G1) | Download hash equals generator |
| W12-4 | Final per-cloud status and PRP close-out | W12-1..W12-3 | Sonnet | none | `prp_index.py check` clean |

## Validation
```
cd apps/loom-health-cp && npx vitest run src/evidence && npx tsc --noEmit -p tsconfig.test.json
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/editors/health
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
```
Receipts: pack generated in Commercial and GCC-High (run ids); one reviewer on the mapping docs. Mutation receipt on a sandbox copy: alter one input byte and the pack hash changes. "Merged, not deployed" until then. IL5, DoD, GCC supported-in-code only.

## Rollback
Docs and a generator; nothing to roll back beyond reverting the PR.

## Docs to update
`docs/fiab/health/compliance/**`, `README.md`, `ARCHITECTURE.md` section 6.

## Wave / Blocked-by / Branch / Worktree
`Wave: 9 · Blocked-by: W11b-hardening-bicep, W08b-breakglass-audit-siem · Branch: feat/lhds-w12-evidence-pack · Worktree: E:/Repos/_lhds-w12`

## Hot files
`tenant-editor.tsx` (last editor of the program), `README.md`/`PRP.md` (close-out only). `touches_bicep: no`.

## Kickoff prompt
```
Wave W12 (LHDS compliance evidence pack). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w12, branch feat/lhds-w12-evidence-pack.
Read first: PRP.md, this file, SECURITY-AND-COMPLIANCE.md sections 15-16, W08b and W11 receipts.
Never write that the platform is certified, authorized or compliant; mapping and evidence only.
Do W12-1 and W12-2, then W12-3, then W12-4.
Proof: cd apps/loom-health-cp && npx vitest run src/evidence ; tampered input changes the pack hash.
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W12-1 | todo | | sonnet | | 2026-11-14 |
| W12-2 | todo | | opus | | 2026-11-14 |
| W12-3 | todo | | sonnet | | 2026-11-14 |
| W12-4 | todo | | sonnet | | 2026-11-14 |
