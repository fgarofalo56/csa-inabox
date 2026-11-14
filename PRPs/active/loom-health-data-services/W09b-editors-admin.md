---
name: W09b-editors-admin
status: backlog
priority: P1
order: 27
depends_on: [W04-terminology, W05-conversion-hl7v2-ccda, W06c-lakehouse-sink, W08b-breakglass-audit-siem, W09a-viewer-copilot]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W9b — Editor A-grade pass, `/admin/health-services`, onboarding docs

Split from the old W09. Shared rules: `PRP.md` section 5. Rules: `ux-baseline.md`, `ui-parity.md`, `web3-ui.md`.

## Goal
Every health editor brought to `docs/fiab/ux-standards.md` section 7 A-grade (G1 browser E2E, G2 Fix-it gates registered, G3 SplitPane, badge wrap, clean first open), the admin page `/admin/health-services` reading live control-plane data, and the onboarding, feeds and per-cloud status docs.

## Why
A surface is not done below the Fabric-grade floor. This is the last editor pass once every item type exists.

## Scope / Non-goals
In: W9-2, W9-3, W9-5b. Out: new item types, the viewer and Copilot write tools (W09a).

## Acceptance criteria
- [ ] W9-2: for each of `health-tenant`, `health-fhir-service`, `health-dicom-service`, `health-terminology`, `health-conversion-pipeline`, `health-deid-job`, `health-lakehouse-sink` the section 7.0 + 7.2 checklist is attached with zero unchecked applicable boxes; a first-open of a fresh item shows no error banner. Fails on any red banner at first open.
- [ ] W9-3: the admin page shows stamps, tenants, SLO state, capacity headroom, deploy SHA, pause state, last DR drill and gates from the live control plane (minted-session probe returns non-empty rows for the dev stamp); a stubbed array fails G1.
- [ ] W9-5b: docs name only files and commands that exist; the greenfield and brownfield walkthroughs were executed once each.

## Read first
`docs/fiab/ux-standards.md` sections 7 and 9, `docs/fiab/parity/health-*.md` (existing parity docs), `apps/fiab-console/lib/editors/health/`, `apps/fiab-console/lib/gates/registry/`, `docs/fiab/health/greenfield.md`, `brownfield.md`.

## Owns
`apps/fiab-console/lib/editors/health/**` (all editors; W09a's `viewer-editor.tsx` excluded), `docs/fiab/parity/health-*.md` (except `health-imaging-viewer.md`), `apps/fiab-console/app/admin/health-services/**`, `apps/fiab-console/app/api/admin/health/**`, one nav entry in `apps/fiab-console/lib/nav/**`, `docs/fiab/health/**` (onboarding, feeds, per-cloud status), `tests/health/uat/**`.

## Must NOT touch
`apps/fiab-console/lib/copilot/health-tools.ts`, viewer files (W09a), control-plane code, bicep.

## Consumes
All editors and item types from W02b..W06c; the control-plane admin API (W1-3); gate registry.

## Provides
A-grade editors and the admin page that W11b updates (cost, drills) and W12 links.

## Steps
1. W9-3 admin page (parallel with W9-2 on disjoint files). 2. W9-2 per-editor passes, one PR per editor group. 3. W9-5b docs last.

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W9-2 | Editor A-grade pass for seven item types | W2-7, W3-6, W4-4, W5-3, W6-6a, W6-6b | Sonnet | none (G1) | Checklist + screenshots + `pnpm uat` per editor |
| W9-3 | Admin page with live data and estate-power actions | W1-3 | Sonnet | none (G1) | Minted-session probe |
| W9-5b | Docs: tenant onboarding, feeds, per-cloud table with run ids, Learn popovers | W9-2, W9-3 | Sonnet | none | Existence check, executed walkthrough |

## Validation
```
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/editors/health
cd apps/fiab-console && pnpm uat
```
Receipts: per editor, dark and light screenshots, click-walk, a narrow-width pass and a first-open pass in Commercial; GCC-High Actions Playwright run id. Parity docs show zero missing rows. "Merged, not deployed" until a live walk exists. IL5, DoD, GCC supported-in-code only.

## Rollback
Editors are additive and flag-gated per item type; the admin page is a new route.

## Docs to update
`docs/fiab/parity/health-*.md`, `docs/fiab/health/index.md`, `ARCHITECTURE.md` section 6.

## Wave / Blocked-by / Branch / Worktree
`Wave: 7 · Blocked-by: W04-terminology, W05-conversion-hl7v2-ccda, W06c-lakehouse-sink, W08b-breakglass-audit-siem, W09a-viewer-copilot · Branch: feat/lhds-w09b-editors-admin · Worktree: E:/Repos/_lhds-w09b`

## Hot files
`apps/fiab-console/lib/editors/health/tenant-editor.tsx` (earlier edited by W08b; W12 adds the Evidence tab later), nav registry (one entry). `touches_bicep: no`.

## Kickoff prompt
```
Wave W09b (LHDS editors A-grade + admin page). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w09b, branch feat/lhds-w09b-editors-admin.
Read first: PRP.md (section 5), this file, docs/fiab/ux-standards.md sections 7 and 9, the existing parity docs.
Do W9-3 and W9-2 (disjoint files), then W9-5b. One PR per editor group.
G1 is blocking: real browser walk, real data, dark and light, narrow width, first-open.
Proof: cd apps/fiab-console && npx vitest run lib/editors/health && pnpm uat.
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W9-2 | todo | | sonnet | | 2026-11-14 |
| W9-3 | todo | | sonnet | | 2026-11-14 |
| W9-5b | todo | | sonnet | | 2026-11-14 |
