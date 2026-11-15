---
name: W08b-breakglass-audit-siem
status: backlog
priority: P1
order: 25
depends_on: [W08a-labels-pdp]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W8b — Break-glass, immutable audit chain, SIEM rules, accounting-of-disclosures surface

Split from the old W08. Shared rules: `PRP.md` section 5.

## Goal
Time-boxed break-glass with reason capture and mandatory post-hoc review, hourly immutable audit blobs chained by SHA-256 with a nightly verification job, `LhdsAudit_CL` SIEM rules (break-glass, mass read, export, cross-tenant 403 bursts), and the patient accounting-of-disclosures and audit search surfaces with Copilot `health_audit_summary`.

## Why
Assessors need an audit trail that cannot be silently altered and a break-glass path that is reviewed. Operator decision 8 (mapping, no ATO claim) and `SECURITY-AND-COMPLIANCE.md`.

## Scope / Non-goals
In: W8-3, W8-4, W8-5. Out: policy bundle (W08a), certification claims.

## Acceptance criteria
- [ ] W8-3: elevation expires at its deadline (clock-advanced test, the read one tick after the deadline is denied); every break-glass read has an `AuditEvent`; the alert rule fires in the Sentinel rule test. Fails if an expired elevation still reads.
- [ ] W8-4: modifying one byte of a stored audit blob breaks chain verification; an overwrite attempt is rejected by storage (immutability positive control); the rules deploy. Fails if verification passes on a tampered blob.
- [ ] W8-5: the report for the canary patient lists every access the test performed (count equals the test's request count); Playwright walk of both Audit tabs.

## Read first
`SECURITY-AND-COMPLIANCE.md` (audit, break-glass), `adr/ADR-011-consent-pdp.md`, `OPERATIONS-AND-BCDR.md` section 2, `platform/fiab/bicep/modules/health/storage.bicep` and `stamp.bicep`, `monitoring/` (existing alerts layout), W08a bundle v2 break-glass hooks.

## Owns
`apps/loom-health-cp/src/auth/break-glass.ts`, `apps/loom-health-cp/src/audit/**`, `apps/fiab-console/lib/editors/health/tenant-editor.tsx` (Access and Audit tabs), `apps/fiab-console/app/api/health/[tenant]/break-glass/**`, `apps/fiab-console/app/api/health/[tenant]/audit/**`, `monitoring/health-sentinel-rules/**`, immutable container policy in `platform/fiab/bicep/modules/health/stamp.bicep` (one bicep PR).

## Must NOT touch
PDP policies (W08a), export/sink (W06*), `engines.bicep`, other editors.

## Consumes
W08a bundle v2; W02b audit interceptor (W2-3); the job runner; Sentinel/Log Analytics workspace from the stamp.

## Provides
Audit chain reports and break-glass events consumed by W12 (evidence generator) and W11a (drill checks).

## Steps
1. W8-4 audit chain + bicep (queue the bicep PR on the ledger). 2. W8-3 break-glass. 3. W8-5 surfaces and tool.

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W8-3 | Break-glass flow, BTG event, alert, review queue | W8-2 | Sonnet | required | Expiry and alert tests |
| W8-4 | Audit chain, verification job, immutability, SIEM rules, container policy bicep | W2-3 | Sonnet | required (bicep + evidence control) | Tamper breaks chain; overwrite rejected |
| W8-5 | Accounting of disclosures, audit search, report export, `health_audit_summary` | W8-4 | Sonnet | none (G1) | Playwright walk; canary patient report |

### Integration step (serialized)
- `apps/fiab-console/lib/editors/health/fhir-service-editor.tsx` (Audit tab only; owner `W02b-fhir-core-ops`) and `apps/fiab-console/lib/copilot/health-tools.ts` (tool `health_audit_summary`, counts only; owner `W02b-fhir-core-ops`). Both are in the `depends_on` chain via W08a.

## Validation
```
cd apps/loom-health-cp && npx vitest run src/audit src/auth && npx tsc --noEmit -p tsconfig.test.json
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/copilot/__tests__/health-tools.test.ts
make lint-bicep
```
Receipts: Commercial run id and a GCC-High Actions run id for chain verification and the SIEM rule test; surfaces walked in a browser. Mutation receipt on a sandbox copy: flip one byte in a fixture blob (red), restore and prove with `git hash-object`. "Merged, not deployed" until then. IL5, DoD, GCC supported-in-code only.

## Rollback
Audit chain is append-only (no rollback by design; the verification job can be disabled); the bicep policy PR reverts by parameter; break-glass flag off falls back to deny.

## Docs to update
`docs/fiab/health/security.md`, `docs/fiab/health/runbooks.md` (break-glass review), `docs/fiab/parity/health-tenant.md` (Access, Audit).

## Wave / Blocked-by / Branch / Worktree
`Wave: 6 · Blocked-by: W08a-labels-pdp · Branch: feat/lhds-w08b-breakglass-audit · Worktree: E:/Repos/_lhds-w08b`

## Hot files
`tenant-editor.tsx` (also W09b, W12: later tiers), `health-tools.ts` (one tool), `stamp.bicep` (ledger). `touches_bicep: yes`.
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
```
Wave W08b (LHDS break-glass, audit chain, SIEM). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w08b, branch feat/lhds-w08b-breakglass-audit.
Read first: PRP.md (section 5), this file, SECURITY-AND-COMPLIANCE.md audit sections, adr/ADR-011.
One bicep PR at a time (PRPs/reference/INTERLOCK.md).
Do W8-4 first, then W8-3, then W8-5.
Proof: cd apps/loom-health-cp && npx vitest run src/audit src/auth ; tampered blob fails verification.
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W8-3 | todo | | sonnet | | 2026-11-14 |
| W8-4 | todo | | sonnet | | 2026-11-14 |
| W8-5 | todo | | sonnet | | 2026-11-14 |
