---
name: W03a-dicom-core-a
status: backlog
priority: P1
order: 6
depends_on: [W01b-close-deploy-receipts]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/lhds-w3a-dicom-core
allow_parallel: true
---
# W3a — DICOM core, part A: dcm4chee image, Blob storage layout, DICOMweb gateway

## Goal
dcm4chee-arc-light runs per tenant on a stamp with hardened defaults, pixel data in per-tenant Azure Blob (CMK, versioning, lifecycle), and the Loom DICOMweb gateway in front exposes the AHDS-shaped `/v1` surface with PDP
filtering and audit. Change feed, tags, partitions, lifecycle, item/editor, viewer and load are `W03b-dicom-core-b.md`.

## Why
Imaging is the largest data volume and runs as a parallel track to FHIR (operator decision 3). The security defaults (AE registration enforced, HL7 auth on, DIMSE off) and the irreversible Blob layout must be right
before anything is stored.

## Scope / Non-goals
Items W3-1, W3-2, W3-3. Non-goals: everything in W03b; W6 DICOM export; the viewer product (W09). License posture: dcm4chee is MPL/LGPL, acceptable; Orthanc is off the table (AGPL, `OPERATOR-DECISIONS-2026-10-22.md` Q3).
> ASSUMPTION: W0-2 (dcm4chee on DEV, #5107) passed the ADR-002 bar, so dcm4chee is the engine; the fallback (Loom-built DICOMweb-on-Blob) is not in scope here. Confirm in `adr/ADR-002-dicom-engine.md` status line before starting.
GCC supported-in-code only, never exercised.

## Acceptance criteria
- [ ] W3-1: image pinned >= 5.35.2, Trivy CRITICAL = 0, cosign verify passes; a STOW from an UNREGISTERED AE title is rejected (fails if it is accepted), and a STOW from a registered AE succeeds (positive control); DIMSE listener port closed (a TCP connect to 11112 fails).
- [ ] W3-2: STOW then WADO is byte-equal (sha256 of the returned bytes equals the sent file); blob listing matches the documented tenant-year path layout; container shows CMK, versioning, soft delete on; Gov endpoint suffix test (`blob.core.usgovcloudapi.net`) fails if the Commercial suffix leaks.
- [ ] W3-3: the DICOMweb suite in `TEST-STRATEGY.md` section 3 has 0 failures; cross-tenant QIDO with tenant B token returns 0 rows (and 403 on direct study fetch); a 2 GB STOW keeps RSS < 2x request size (fails above 4 GB RSS); unauthenticated request is 401/403, a PDP timeout is 503.
- [ ] Live rows are claimed only against the W01b stamp; Commercial and GCC-High are separate receipts; GCC-High not exercised until an Actions run exists.

## Read first
`W0-RECEIPT.md` section W0-2 (dcm4chee findings); `adr/ADR-002`, `adr/ADR-004`; `apps/loom-health-pdp/README.md`; `scripts/measure/health/dicom-engine-{deploy,lib,ops}.sh` (reuse the W0 recipe); `AHDS-MODEL-MAP.md` (DICOMweb surface); `TEST-STRATEGY.md` section 3;
`platform/fiab/bicep/modules/health/{tenant,storage,aks}.bicep`; `CONTRACT-FREEZE-W2.md`.

## Owns
`apps/loom-health-dicom/**`; `apps/loom-health-dicom-gateway/**` (W3-3, `src/` root only; `src/{changefeed,tags,partitions,lifecycle}/**` belong to W03b);
`platform/fiab/bicep/modules/health/tenant.bicep` (DICOM storage block only); `apps/loom-health-cp/src/jobs/dicom-tenant-*.ts` (new); `.github/workflows/build-fiab-images-acr-tasks.yml` (dicom + gateway matrix rows only, last commit, freeze order).

## Must NOT touch
`apps/loom-health-fhir/**`; `engines.bicep` (W02a/W04/W05); `apps/loom-health-cp/src/relay/**`; `lib/copilot/health-tools.ts`, `lib/gates/registry/health.ts`, `lib/catalog/item-types/health.ts` (W03b/W02b); `apps/loom-health-pdp/policies/**`; `main.bicep`.

## Consumes
PDP decision API and its PROVISIONAL input fields (`CONTRACT-FREEZE-W2.md` section 1; W3-3 builds against them and MERGES after W2-3); tenant DB and keys from W1-2; stamp from W01b.

## Provides
Hardened engine image + Helm chart, tenant storage layout and `dicom-tenant.*` jobs, the gateway skeleton W03b extends (routes, PDP middleware, audit, Valkey cache).

## Steps
1. W3-1 image/Helm/LDAP (reviewed: security defaults), matrix row last.
2. W3-2 storage + CMK + lifecycle + content-hash table (one bicep PR, queued per INTERLOCK).
3. W3-3 gateway (after W3-1 contract; merge after W2-3 if it changed the PDP input).
W3-1 -> W3-2 and W3-1 -> W3-3 in parallel worktrees.

## Validation
```bash
node --test apps/loom-health-dicom/tests/                                  # static contract (hardened-defaults file check); fails if AE enforcement flag is absent
helm lint apps/loom-health-dicom/chart && helm template apps/loom-health-dicom/chart | grep -c 'AE_ENFORCE'   # must be >= 1
cd apps/loom-health-dicom-gateway && npm ci && npm test                    # PDP filter, streaming memory assertion, QIDO caps
az bicep build --file platform/fiab/bicep/health.bicep --stdout >/dev/null
node scripts/ci/check-bicep-sync.mjs
# on-stamp (after W01b): STOW/WADO byte-equality + cross-tenant QIDO probe via scripts/measure/health/dicom-engine-ops.sh (reuse) - receipt table attached
```
Mutation receipts on a sandbox copy: flip AE enforcement off (unregistered-AE test RED); remove the PDP filter from QIDO (cross-tenant probe RED). Merged is "merged, not deployed".

## Rollback
Gateway + engine scaled to 0; Blob containers retained (never deleted on rollback); `LOOM_HEALTH_DICOM_ENABLED=false`.

## Docs to update
`docs/fiab/health/index.md` per-cloud table, `ARCHITECTURE.md` section 6, `adr/ADR-002` and `ADR-004` status lines, `docs/fiab/health/runbooks` (storage layout).

## Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: W01b-close-deploy-receipts (live verification) · Branch: feat/lhds-w3a-dicom-core · Worktree: E:/Repos/_lhds-w3a

## Hot files
`tenant.bicep`, `health.bicep`, `build-fiab-images-acr-tasks.yml` matrix (after W2-5's row), `apps/loom-health-pdp/input-contract.json` (read only). `touches_bicep: yes` (W3-2; serialized with W02a's W2-2).

## Kickoff prompt
Fresh session, Sonnet. Read `PRPs/active/loom-health-data-services/W03a-dicom-core-a.md`, `CONTRACT-FREEZE-W2.md`, `adr/ADR-002-dicom-engine.md`, `adr/ADR-004-dicom-storage-layout.md`, and the W0-2 section of `W0-RECEIPT.md`. Reuse `scripts/measure/health/dicom-engine-*.sh`.
Review required on all three items (security defaults, irreversible layout, authorization). Proof of done: the Validation block plus the on-stamp receipt after W01b. Report merged vs deployed separately.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W3-1 dcm4chee image + hardened defaults + Helm | todo | | sonnet | | 2026-11-14 |
| W3-2 Blob storage layout, CMK, lifecycle | todo | | sonnet | | 2026-11-14 |
| W3-3 DICOMweb gateway | todo | | sonnet | | 2026-11-14 |
