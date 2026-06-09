# deployment-pipelines — parity with Fabric Deployment Pipelines (+ Azure ARM deployments)

**Source UI:**
- Fabric Deployment Pipelines — https://learn.microsoft.com/fabric/cicd/deployment-pipelines/intro-to-deployment-pipelines
- Fabric Deployment Pipelines REST — https://learn.microsoft.com/rest/api/fabric/core/deployment-pipelines
- Azure ARM deployments (infra rollouts) — https://learn.microsoft.com/rest/api/resources/deployments

**Loom surface:** `/deployment-pipelines` → `lib/components/deployment/deployment-pipelines-pane.tsx`
**Backend clients:** `lib/azure/fabric-client.ts` (Fabric REST), `lib/azure/arm-deployments-client.ts` (ARM REST)
**BFF routes:** `app/api/deployment-pipelines/**`

---

## Why this was rebuilt

The previous `/deployment-pipelines` page was **not** the Deployment Pipelines
experience at all — it was a generic `ItemsByTypePane` listing data-pipeline /
ADF-pipeline / synapse-pipeline *items*. That produced the operator's "none of
it is usable… 'no ADF linked service found'" dead-end: it tried to treat
authoring-pipeline items as a deployment surface. The real Fabric concept is
**deployment pipelines** = ordered stages (dev → test → prod), each bound to a
workspace, with content promotion between stages. That is now built one-for-one
against the Fabric REST surface, with the platform's own ARM/bicep rollout
history as a second section.

---

## Fabric/Azure feature inventory

### Fabric Deployment Pipelines
| # | Capability (real Fabric UI) | REST |
| --- | --- | --- |
| 1 | List the deployment pipelines you can access | `GET /v1/deploymentPipelines` |
| 2 | See a pipeline's ordered stages (Development → Test → Production, 2–10 stages) | `GET /v1/deploymentPipelines/{id}/stages` |
| 3 | See the workspace assigned to each stage | stage `.workspaceId` / `.workspaceName` |
| 4 | See the supported items in each stage's workspace | `GET /v1/deploymentPipelines/{id}/stages/{stageId}/items` |
| 5 | Deploy all content from a stage to the next stage | `POST /v1/deploymentPipelines/{id}/deploy` (no `items`) |
| 6 | Selective deploy — choose specific items to promote | `POST .../deploy` with `items[]` |
| 7 | Add a deployment note | `POST .../deploy` `note` |
| 8 | Deployment history (recent operations + status) | `GET /v1/deploymentPipelines/{id}/operations` |
| 9 | Public/private stage indicator | stage `.isPublic` |
| 10 | Create pipeline (2–10 ordered stages) | `POST /v1/deploymentPipelines` |
| 11 | Assign workspace to a stage | `POST /v1/deploymentPipelines/{id}/stages/{sid}/assignWorkspace` |
| 12 | Unassign workspace from a stage | `POST /v1/deploymentPipelines/{id}/stages/{sid}/unassignWorkspace` |
| 13 | Backward deploy (later stage → empty earlier stage) | `POST .../deploy` w/ `createdWorkspaceDetails` |
| 14 | Stage compare / sync status (Same / Different / Only-in-source / Not-in-source) | pair two stages' `.../stages/{sid}/items` (no compare endpoint exists; UI pairs client-side per the documented item-pairing rule) |
| 15 | Per-stage deployment rules (data-source / parameter / lakehouse rebinding) | **not in Fabric REST** — portal-only |
| 16 | Workspace folder hierarchy + parent/child items in stage list | **not in Fabric REST** — flat list only |

### Fabric Git integration (CI side)
| # | Capability (real Fabric UI) | REST |
| --- | --- | --- |
| G1 | View a workspace's Git connection + provider details + sync head | `GET /v1/workspaces/{ws}/git/connection` |
| G2 | Connect a workspace to Azure DevOps / GitHub repo+branch | `POST /v1/workspaces/{ws}/git/connect` |
| G3 | Initialize the connection (first-time sync handshake) | `POST /v1/workspaces/{ws}/git/initializeConnection` |
| G4 | Disconnect from Git | `POST /v1/workspaces/{ws}/git/disconnect` |
| G5 | Per-item Git sync status (uncommitted / incoming / conflict) | `GET /v1/workspaces/{ws}/git/status` |
| G6 | Commit workspace changes to the branch (all / selective) | `POST /v1/workspaces/{ws}/git/commitToGit` |
| G7 | Update workspace from the branch | `POST /v1/workspaces/{ws}/git/updateFromGit` |

### Azure infra deployments (the bicep rollouts)
| # | Capability | REST |
| --- | --- | --- |
| 11 | List ARM deployments across the Loom resource groups, newest first | `GET .../{rg}/providers/Microsoft.Resources/deployments` |
| 12 | Per-deployment state / duration / mode / resource count / error | deployment `.properties` |
| 13 | Per-resource operation breakdown | `GET .../deployments/{name}/operations` (client helper present) |

---

## Loom coverage

| # | Capability | State | Notes |
| --- | --- | --- | --- |
| 1 | List deployment pipelines | ✅ built | Dropdown picker, paginated `listDeploymentPipelines()` |
| 2 | Ordered stages | ✅ built | Stage columns, sorted by `order` |
| 3 | Assigned workspace per stage | ✅ built | Shows workspace name (or id) or "No workspace assigned" |
| 4 | Items per stage | ✅ built | Fetched per stage with a workspace; empty stages disclosed honestly |
| 5 | Deploy all → next stage | ✅ built | "Deploy all" in the deploy dialog |
| 6 | Selective deploy | ✅ built | Checkbox per item → `items[]` |
| 7 | Deployment note | ✅ built | Textarea (≤1024 chars) → `note` |
| 8 | Deployment history | ✅ built | History table (From → To, status, by, note) |
| 9 | Public stage badge | ✅ built | `Public` badge |
| 11 | ARM deployment history | ✅ built | Infra deployments tab — table across Loom RGs |
| 12 | State/duration/mode/resources/error | ✅ built | Columns + Failed-deployment error text |
| 13 | Per-resource operations | ✅ built | Each ARM deployment row has a **Steps** button → `OperationsDialog` fetches `GET /api/deployment-pipelines/arm/{name}/operations?rg={rg}` (real `Microsoft.Resources/deployments/{name}/operations` REST) and renders a sortable/filterable `LoomDataTable` of per-resource operations (resource, type, state, status code, duration, timestamp) — the portal's expand-deployment view. |
| 10 | Create pipeline | ✅ built | "New pipeline" dialog — name + 2–10 named stages (add/remove, public toggle) → `POST /v1/deploymentPipelines` |
| 11 | Assign workspace to stage | ✅ built | Inline workspace dropdown on each empty stage → assign |
| 12 | Unassign workspace from stage | ✅ built | "Unassign workspace" with the history/rules-loss warning |
| 13 | Backward deploy | ✅ built | Reverse deploy button shown when the earlier stage is empty; prompts for the new workspace name |
| 14 | Stage compare / sync status | ✅ built | "Compare / sync status" section — pick stage, paired item table with Same/Different/Only-in-source/Not-in-source + green/orange roll-up |
| G1–G7 | Git integration (connect / status / commit / update) | ✅ built | "Git integration" tab — connect form, connection panel, source-control change table, commit all/selective + update |
| — | Fabric API not authorized | ⚠ honest-gate | 401/403 → MessageBar with the exact admin action (enable "Service principals can use Fabric APIs" + add UAMI as pipeline admin) |
| — | LOOM_SUBSCRIPTION_ID / Loom RGs unset | ⚠ honest-gate | Infra tab → MessageBar naming the env var |
| — | Git connect as UAMI/SPN | ⚠ honest-gate | Connect form asks for a Git credentials connection id; 401/403 names the workspace-admin role + connection requirement |
| 15 | Per-stage deployment rules | ⚠ honest-gate | "Deployment rules" dialog renders the full affordance + a MessageBar: rules are **not in the Fabric REST surface** (portal-only); lists the supported rule types per item from Learn |
| 16 | Folder hierarchy + parent/child items | ⚠ honest-gate | Stage items render flat with an info MessageBar: the stage-items REST returns a flat list; folder tree is a portal-only preview |
| — | Content/change review (line-by-line diff) | ⚠ honest-gate | Compare section discloses the schema-diff window is portal-only; authoritative new/different/identical counts come from the deploy operation and show in history |

**Zero ❌.** Every row is either built ✅ against real Fabric REST or an honest
infra/portal gate ⚠ that still renders the full surface — no dead buttons, no
stub banners. Deployment rules, the folder tree, and the line-by-line change
review are the three capabilities Fabric does **not** expose via public REST;
each is disclosed precisely rather than faked.

---

## Per-cloud notes

Fabric Deployment Pipelines REST is a **Fabric** surface (`api.fabric.microsoft.com`), so it is unavailable where Fabric is not offered. The **ARM/bicep infra-deployments tab** is pure Azure Resource Manager and works in every cloud. Per `no-fabric-dependency.md`, the page renders fully with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — the Fabric tab shows the honest 401/403 SP gate and the infra tab carries the operator's own bicep rollout history.

| Cloud | Fabric Deployment Pipelines (rows 1–16, G1–G7) | Infra ARM deployments (rows 11–13) |
|---|---|---|
| Commercial | ✅ Fabric REST at `api.fabric.microsoft.com` | ✅ ARM `management.azure.com` |
| GCC | ❌ **Fabric is not available in GCC** — the Fabric tab shows the honest infra-gate MessageBar, not a dead surface | ✅ ARM `management.usgovcloudapi.net` |
| GCC-High / IL4 | ✅ Fabric REST at `api.fabric.high.azure.us` (Fabric available) | ✅ ARM `management.usgovcloudapi.net` |
| DoD / IL5 | ✅ Fabric REST (Fabric available) | ✅ ARM `management.usgovcloudapi.net` |

The GCC Fabric absence is structural (not timing-fixable). The existing 401/403 honest-gate already covers it; this table names the boundary explicitly so the gate reads as expected behavior in GCC rather than a defect.

---

## Backend per control

| Control | Backend |
| --- | --- |
| Pipeline picker | `GET /api/deployment-pipelines` → `listDeploymentPipelines()` → Fabric `GET /v1/deploymentPipelines` |
| Stage columns | `GET /api/deployment-pipelines/[id]/stages` → Fabric `GET .../{id}/stages` |
| Stage items | `GET /api/deployment-pipelines/[id]/stages/[stageId]/items` → Fabric `GET .../{id}/stages/{sid}/items` |
| Deploy button (all / selective + note / backward) | `POST /api/deployment-pipelines/[id]/deploy` → Fabric `POST .../{id}/deploy` (202 LRO) |
| Compare / sync status | `GET /api/deployment-pipelines/[id]/compare?source&target` → 2× Fabric `GET .../stages/{sid}/items`, paired client-side |
| New pipeline | `POST /api/deployment-pipelines/create` → Fabric `POST /v1/deploymentPipelines` |
| Assign / unassign workspace | `POST` / `DELETE /api/deployment-pipelines/[id]/stages/[stageId]/workspace` → Fabric `.../assignWorkspace` / `.../unassignWorkspace` |
| Git connection (view / connect / disconnect) | `GET` / `POST` / `DELETE /api/deployment-pipelines/git/[workspaceId]/connection` → Fabric `git/connection` / `git/connect` / `git/disconnect` |
| Git initialize | `POST /api/deployment-pipelines/git/[workspaceId]/initialize` → Fabric `git/initializeConnection` |
| Git status | `GET /api/deployment-pipelines/git/[workspaceId]/status` → Fabric `git/status` (LRO) |
| Git commit (all / selective) | `POST /api/deployment-pipelines/git/[workspaceId]/commit` → Fabric `git/commitToGit` |
| Git update | `POST /api/deployment-pipelines/git/[workspaceId]/update` → Fabric `git/updateFromGit` |
| Workspace pickers (assign / Git) | `GET /api/fabric/workspaces` → `listFabricWorkspaces()` |
| Deployment history | `GET /api/deployment-pipelines/[id]/operations` → Fabric `GET .../{id}/operations` |
| Infra deployments table | `GET /api/deployment-pipelines/arm` → ARM `GET .../{rg}/providers/Microsoft.Resources/deployments` |

Auth: Console UAMI via `ChainedTokenCredential(ManagedIdentityCredential, DefaultAzureCredential)`.
Fabric calls need the UAMI as a deployment-pipeline **admin** + contributor on the
stage workspaces; ARM calls need **Reader** on the Loom subscription/RGs.

---

## Verification

- Backend Vitest contract tests (29, all green):
  - `lib/azure/__tests__/fabric-deployment-pipelines.test.ts` — list/stages/items/deploy (all+selective)/operations + 403 hint
  - `lib/azure/__tests__/arm-deployments-client.test.ts` — config gate, list shape, ISO-duration parse, sort, operations
  - `app/api/deployment-pipelines/__tests__/deployment-pipelines-routes.test.ts` — 401/gate/happy-path + **content-type guard** (JSON not HTML) + deploy payload forwarding
- `pnpm build` clean (the `/deployment-pipelines` page + API routes compile).
- **Guided-forms / no-JSON audit (no-freeform-config):** all three tabs use
  guided Fluent controls only — pipelines (name/description `Input`, per-stage
  name `Input` + public `Switch`, selective-deploy `Checkbox`, workspace
  `Dropdown`), Git (provider/workspace `Dropdown`s, connect form), infra (ARM
  history table + Steps drill-in). The only multi-line input is the optional
  ≤1024-char deployment **note** (free text, not config). No raw-JSON textarea
  anywhere on the Deployment page.
- New route `app/api/deployment-pipelines/arm/[name]/operations/route.ts`
  (per-resource operation drill-in) — `tsc --noEmit` clean.
