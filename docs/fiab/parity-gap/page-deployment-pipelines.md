# Parity gap — `/deployment-pipelines`

**Loom route:** `/deployment-pipelines` (rendered by `apps/fiab-console/app/deployment-pipelines/page.tsx` → `ItemsByTypePane` filtered to data-pipeline, synapse-pipeline, adf-pipeline, copy-job, dbt-job, airflow-job)
**Fabric reference:** Microsoft Fabric deployment pipelines — https://learn.microsoft.com/fabric/cicd/deployment-pipelines/intro-to-deployment-pipelines (Dev → Test → Prod stage promotion across workspaces)
**Loom screenshot:** `temp/parity/page-deployment-pipelines-loom.png`
**Captured:** 2026-05-26

## Critical conceptual mismatch

**Fabric's "Deployment pipelines" is NOT the same thing as "data pipelines."**

Fabric Deployment Pipelines is a **stage-promotion feature**: Dev workspace → Test workspace → Prod workspace, with diff-then-promote semantics. It's a Power-BI-borrowed feature for CI/CD-lite without YAML.

Loom's `/deployment-pipelines` lists **execution pipelines** (data-pipeline, ADF pipeline, Synapse pipeline, copy-job, dbt-job, airflow-job). The page title borrows Fabric's term but delivers an entirely different surface.

The page subtitle even says "Promote items across Development → Test → Production" but then renders a flat list of pipeline-items, with no Dev/Test/Prod columns, no Compare action, no Deploy action, no stage selectors.

## Phase 3 — Side-by-side gap matrix

| # | Fabric Deployment Pipelines element | Loom Deployment pipelines element | Status | Severity |
|---|---|---|---|---|
| 1 | 3-column layout: Development / Test / Production | Single grid of pipeline items | missing | **BLOCKER** |
| 2 | Workspace assigned to each stage | Not present | missing | **BLOCKER** |
| 3 | Item list per stage with diff indicator (changed / new / deleted) | Not present | missing | **BLOCKER** |
| 4 | "Deploy to Test" / "Deploy to Production" buttons | Not present | missing | **BLOCKER** |
| 5 | Compare changes view (side-by-side diff) | Not present | missing | **BLOCKER** |
| 6 | Stage rules / per-stage configuration overrides | Not present | missing | MAJOR |
| 7 | Deployment history / audit | Not present | missing | MAJOR |
| 8 | Per-pipeline "+ Create deployment pipeline" wizard | "+ New item" opens generic Fabric-style picker (creates a data-pipeline, not a deployment pipeline) | missing | **BLOCKER** |
| 9 | Page header "Deployment pipelines" | Present but title is misleading | misleading | MAJOR |
| 10 | Subtitle accurately describes what's listed | Subtitle says "Promote items across Development → Test → Production" but page shows item-list, not promotion UX | dishonest | **BLOCKER** |

## Phase 4 — Functional verification

| Control | Result |
|---|---|
| New item dialog | Creates a data-pipeline, not a deployment pipeline | Misleading |
| Filter input | Filters across pipeline-item types | OK as item-list |
| Card link | Goes to `/items/[type]/[id]` (individual pipeline editor, not deployment pipeline) | OK as item-list |

## Honest grade

**Grade: D — Conceptual vaporware**

This is a particularly bad case under `no-vaporware.md`:
- The page title and subtitle promise a Dev→Test→Prod **deployment pipeline** feature.
- The page actually delivers a **filtered list of execution pipelines** (data-pipeline, ADF, Synapse pipelines).
- There is **no stage promotion UI**, no diff, no deploy action.
- The header is misleading branding without the underlying feature.

This is exactly the pattern banned by `no-vaporware.md`: "looks like data but isn't, crashes on click" — substituting "looks like a feature but isn't" — and the rule explicitly forbids: "honest config-only state: when a runtime requires infrastructure that isn't deployed yet, the UI MUST show a Fluent UI MessageBar with `intent='warning'`, the exact env var name to set / role to grant / resource to provision."

There is no MessageBar telling the user "Deployment Pipelines feature requires Fabric workspaces + diff service + bicep module X."

## Recommended next actions (URGENT)

1. **Either build the real Deployment Pipelines feature**: 3-column Dev/Test/Prod stage view, workspace selectors per stage, real item-diff via Cosmos compare, real Deploy action (which creates an item in the target workspace), deployment history persisted. This is a significant feature.
2. **Or rename the page** to "Pipelines" (no "Deployment") and rewrite the subtitle to honestly say "Every data-pipeline, ADF pipeline, Synapse pipeline, copy job, dbt job, and Airflow job in your tenant." Remove the "Promote items across Development → Test → Production" language since it's not implemented.
3. Update the left nav label accordingly.
4. If keeping the "Deployment" name, add a top-of-page MessageBar saying "Deployment Pipelines feature is in progress — see `docs/fiab/deployment-pipelines-parity-spec.md`. The list below shows execution pipelines available to promote once the Deploy action lands."
