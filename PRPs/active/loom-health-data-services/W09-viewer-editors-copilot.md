---
name: W09-viewer-editors-copilot
status: backlog
priority: P1
order: 10
depends_on: [W08-consent-segmentation-audit, W05-conversion-hl7v2-ccda]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W9 — Imaging viewer, portal editors to A-grade, Copilot write tools, parity docs

**Goal**: the OHIF-based `health-imaging-viewer` item and editor; every health
editor brought to `ux-standards.md` section 7 A-grade (G1 browser E2E, G2 zero
day-one gates with Fix-it, G3 SplitPane, badges, first-open); the admin
`/admin/health-services` page; Copilot write tools with confirm + audit;
parity docs with zero missing rows; UX side-by-side against the AHDS blades
and Fabric healthcare data solutions as references.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W9-1 | Viewer item + editor: study list (QIDO, filters, paging), OHIF pane (SplitPane `sizingKey`), series browser, patient banner from FHIR, archive-rehydration state, token in header via BFF | `apps/fiab-console/lib/install/provisioners/health-imaging-viewer.ts`, `lib/editors/health/viewer-editor.tsx`, `app/api/health/[tenant]/viewer/**`, `apps/loom-health-viewer/**` (Loom extension), `docs/fiab/parity/health-imaging-viewer.md` | W3-7 | Sonnet | none (G1) | Playwright: load CT, scroll, W/L, measure, switch series; canvas checksum; narrow-width; dark/light |
| W9-2 | Editor A-grade pass for `health-tenant`, `health-fhir-service`, `health-dicom-service`, `health-terminology`, `health-conversion-pipeline`, `health-deid-job`, `health-lakehouse-sink`: section 7.0 + 7.2 checklist, LearnPopovers, Copilot entry, EmptyState launchers, first-open clean | `apps/fiab-console/lib/editors/health/**`, `docs/fiab/parity/health-*.md` | W2-7, W3-6, W4-4, W5-3, W6-6 | Sonnet | none (G1) | Checklist attached per editor; screenshots; `pnpm uat` spec per editor |
| W9-3 | Admin page `/admin/health-services`: stamps, tenants, SLO state, capacity headroom, deploy SHA, pause state, last DR drill, gates; estate-power actions wired | `apps/fiab-console/app/admin/health-services/**`, `app/api/admin/health/**`, `lib/nav/**` (one entry) | W1-3 | Sonnet | none (G1) | Page reads live control-plane data (minted-session probe) |
| W9-4 | Copilot write tools `health_create_tenant`, `health_start_export`, `health_start_deid_job` with `confirm:false` first-call, capability checks, rate limit, `emitAuditEvent`; tool-contract tests | `apps/fiab-console/lib/copilot/health-tools.ts` (write tools), `lib/copilot/__tests__/health-tools.test.ts` | W6-6 | Sonnet | **required** (write tools + authorization) | Non-admin denied; confirm required; 11th call rate-limited; every call audited |
| W9-5 | Docs: tenant onboarding, feeds, export/de-id, viewer pages; per-cloud status table refreshed with run ids; Learn popover content | `docs/fiab/health/**` | W9-1..W9-4 | Sonnet | none | Docs name only files/commands that exist (hygiene rule); walkthrough executed |

Lanes: L1 = W9-1; L2 = W9-2; L3 = W9-3 -> W9-4; L4 = W9-5.

## Done receipt
Every editor: G1 receipt (screenshots dark/light, click-walk, narrow-width,
first-open), parity doc zero missing, gate registry rows; Commercial live walk
+ GCC-High Actions E2E (Playwright job against the Gov stamp).

## Rollback
Editors are additive; feature flags per item type.

## Cost / credit estimate
~12 Sonnet sessions.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W9-1 | todo | | sonnet | | 2026-10-22 |
| W9-2 | todo | | sonnet | | 2026-10-22 |
| W9-3 | todo | | sonnet | | 2026-10-22 |
| W9-4 | todo | | sonnet | | 2026-10-22 |
| W9-5 | todo | | sonnet | | 2026-10-22 |
