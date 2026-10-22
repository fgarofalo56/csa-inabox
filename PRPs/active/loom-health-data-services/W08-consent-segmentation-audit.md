---
name: W08-consent-segmentation-audit
status: backlog
priority: P1
order: 9
depends_on: [W06-bulk-export-deid-lakehouse-sink]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W8 — Consent, sensitive-data segmentation (42 CFR Part 2), break-glass, audit surfaces

**Goal**: security labels applied at write, `Consent`-driven PDP decisions with
redaction on reads/exports/sink, redisclosure obligations, break-glass with
mandatory review, the immutable audit chain with verification job, patient
accounting-of-disclosures surface, SIEM rules.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W8-1 | Labeling service: ValueSet-membership and source-tag rules -> `meta.security`; relabel job; DICOM extended tags for labels | `apps/loom-health-fhir/plugin/src/labeling/**`, `apps/loom-health-cp/src/jobs/relabel.ts`, `apps/loom-health-dicom-gateway/src/labels/**` | W4-2 | Sonnet | **required** | A `Condition` coded in the SUD ValueSet gets `SUD`; one outside does not |
| W8-2 | PDP consent bundle v2: `Consent` evaluation (purpose, recipient, period, revocation), label-based redaction, redisclosure obligation, break-glass rules, cached decisions with outbox invalidation | `apps/loom-health-pdp/policies/**`, `apps/loom-health-pdp/tests/**` | W8-1, W1-5 | **Opus** (policy design pass) | **required** | Consent suite (`TEST-STRATEGY.md` section 7): absent / present / BTG-with-audit; PDP-down fails closed |
| W8-3 | Break-glass flow: time-boxed elevation, reason capture, BTG `AuditEvent`, real-time alert, post-hoc review record and surface | `apps/loom-health-cp/src/auth/break-glass.ts`, `apps/fiab-console/lib/editors/health/tenant-editor.tsx` (Access tab: review queue), `app/api/health/[tenant]/break-glass/**` | W8-2 | Sonnet | **required** | Elevation expires at the deadline (clock-advanced test); every BTG read has an event; the alert fires (Sentinel rule test) |
| W8-4 | Audit chain: hourly immutable blobs, SHA-256 chaining, nightly verification job, immutability positive control, `LhdsAudit_CL` SIEM rules shipped (BTG, mass read, export, cross-tenant 403 bursts) | `apps/loom-health-cp/src/audit/**`, `platform/fiab/bicep/modules/health/stamp.bicep` (immutable container policy — bicep lane), `monitoring/health-sentinel-rules/**` | W2-3 | Sonnet | **required** (bicep + evidence-bearing control) | A modified byte breaks the chain; overwrite attempt rejected by storage; rules deploy |
| W8-5 | Patient accounting of disclosures + audit search surface (tenant editor Audit tab, FHIR editor Audit tab), export of the audit report; Copilot read tool `health_audit_summary` (counts only) | `apps/fiab-console/lib/editors/health/*-editor.tsx` (Audit tabs), `app/api/health/[tenant]/audit/**`, `lib/copilot/health-tools.ts` (one tool) | W8-4 | Sonnet | none (G1) | Playwright walk; report for the canary patient lists every access made by the test |

Lanes: L1 = W8-1 -> W8-2 -> W8-3; L2 = W8-4 (bicep queued) -> W8-5.

## Done receipt
Commercial + GCC-High: consent suite, chain verification report, SIEM rule
test, surfaces walked.

## Rollback
Policy bundle version pinned per tenant; rollback = previous bundle; the audit
chain is append-only (no rollback by design).

## Cost / credit estimate
~10 Sonnet sessions, 1 Opus pass.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W8-1 | todo | | sonnet | | 2026-10-22 |
| W8-2 | todo | | opus | | 2026-10-22 |
| W8-3 | todo | | sonnet | | 2026-10-22 |
| W8-4 | todo | | sonnet | | 2026-10-22 |
| W8-5 | todo | | sonnet | | 2026-10-22 |
