# ai-foundry-project — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/ai-foundry-project/new`
**Fabric reference**: ai.azure.com — AI Foundry project (child workspace under a hub)
**Loom screenshot**: `temp/parity/ai-foundry-project-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/ai-foundry-project` | 200 | Real project `loom-project-default` (Succeeded, eastus2) |
| `POST /api/items/ai-foundry-project` | not exercised; form wires to it | — |

Page renders a list table (1 row: `loom-project-default`) + a New Project form with Name / Display name / Description inputs + a Create button.

## Phase 3 — Fabric vs Loom

| Fabric element | Loom present? | Severity |
|---|---|---|
| Project list with state + location | YES | — |
| New project wizard (region + Hub binding + identity) | NO — form has only Name/Display/Desc | MAJOR — region defaults to hub, but no hub-id picker, no identity picker |
| Project detail page (overview · connections · models · datasets · flows · evals · endpoints · tracing) | NO — Loom only shows top-level metadata when an existing project is opened | MAJOR |
| Cost · members · access | NO | MAJOR |
| Resource graph diagram | NO | COSMETIC |

## Functional

- Create button wired to POST (per source); not executed live to avoid creating a project in this tenant
- Detail render only shows 4 fields (name / state / location / hub) when an existing project is open — way under Fabric depth

## Grade — **D**

Backend list works. Create form persists to real ARM. But the project detail page has none of the sub-surfaces Fabric expects (every sub-asset opens as a separate Loom editor instead), and the New form is missing the hub-id picker + identity picker. Multiple BLOCKER-level gaps: dropping to **D**. This editor is essentially a thin CRUD form, not a parity-grade project surface.
