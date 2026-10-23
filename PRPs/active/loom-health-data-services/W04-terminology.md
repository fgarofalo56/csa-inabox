---
name: W04-terminology
status: backlog
priority: P1
order: 5
depends_on: [W02-fhir-core]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W4 — Terminology service and bundled vocabularies

**Goal**: per-stamp terminology service (HAPI terminology module, ADR-013)
with the bundled free vocabularies packaged, versioned and attributed, a
customer loader for licensed content (SNOMED, full RxNorm, CPT) behind a
genuine, disclosed licence gate, and `$lookup` / `$validate-code` / `$expand`
/ `$translate` within SLO.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W4-1 | Package builder: scripts that download each bundled vocabulary from its official source, verify checksums, produce FHIR package artifacts with the licence notice files, push to the per-cloud Blob feed (no runtime egress) | `tools/health-terminology/**`, `docs/fiab/health/terminology.md` (notices section) | none | Sonnet | none | Each package has a notice file; the builder fails on a checksum mismatch (positive control with a tampered file) |
| W4-2 | Terminology Deployment per stamp: stamp-level DB + per-tenant DB, loader job, version pinning per tenant | `apps/loom-health-terminology/**`, `platform/fiab/bicep/modules/health/engines.bicep` (terminology workload) | W4-1, W2-2 | Sonnet | none | 1 % sample parity per code system (`TEST-STRATEGY.md` section 8); `$validate-code` p95 < 50 ms |
| W4-3 | Customer loader + licence gate (`health-terminology-licensed`): SNOMED RF2, RxNorm full, VSAC API key path, CPT; attestation recorded; nothing bundled | `apps/loom-health-cp/src/jobs/terminology-load-*.ts`, `apps/fiab-console/lib/gates/registry/health.ts` (one entry), `lib/editors/health/terminology-editor.tsx` (Loader tab) | W4-2 | Sonnet | none | Loading a SNOMED RF2 sample (SNOMED's public example files only) succeeds; gate shows the exact licence needed with Fix-it = loader wizard |
| W4-4 | Loom item `health-terminology` + editor (Packages, Loader, tester, Notices), BFF route, Copilot `health_terminology_lookup`, parity doc | `apps/fiab-console/lib/install/provisioners/health-terminology.ts`, `lib/editors/health/terminology-editor.tsx`, `app/api/health/[tenant]/terminology/**`, `lib/copilot/health-tools.ts` (one tool), `docs/fiab/parity/health-terminology.md` | W4-2 | Sonnet | none (G1) | Playwright walk; tester shows a real `$expand` result |

Lanes: L1 = W4-1 -> W4-2 -> W4-3; L2 = W4-4 (after W4-2 contract). Bicep:
one `engines.bicep` PR, queued.

## Done receipt
Commercial + GCC-High: sample parity green, SLO met, notices page rendered,
licence gate walk recorded.

## Rollback
Feature flag; packages are immutable artifacts.

## Cost / credit estimate
~6 Sonnet sessions.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W4-1 | todo | | sonnet | | 2026-10-22 |
| W4-2 | todo | | sonnet | | 2026-10-22 |
| W4-3 | todo | | sonnet | | 2026-10-22 |
| W4-4 | todo | | sonnet | | 2026-10-22 |
