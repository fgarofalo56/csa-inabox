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
| 10 | Create / delete pipeline; assign/unassign workspace; manage users; deployment rules | (admin lifecycle — see "honest gate / not built" below) |

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
| 13 | Per-resource operations | ⚙ client-only | `listArmDeploymentOperations()` shipped; not yet surfaced in UI (history table is sufficient for the operator's ask) |
| — | Fabric API not authorized | ⚠ honest-gate | 401/403 → MessageBar with the exact admin action (enable "Service principals can use Fabric APIs" + add UAMI as pipeline admin) |
| — | LOOM_SUBSCRIPTION_ID / Loom RGs unset | ⚠ honest-gate | Infra tab → MessageBar naming the env var |
| 10 | Pipeline create/delete, assign/unassign workspace, users, deployment rules | ⚠ disclosed | Admin lifecycle is performed in Fabric; the deploy/promote workflow (the operator's actual ask) is fully built. These admin actions are candidates for a follow-up and are not presented as dead buttons. |

**Zero ❌ on the core promote-content workflow** the operator asked for
(stages → items → deploy → history). The non-built admin-lifecycle rows are
*not* rendered as disabled buttons; they're done in Fabric, consistent with the
no-stub-banner rule.

---

## Backend per control

| Control | Backend |
| --- | --- |
| Pipeline picker | `GET /api/deployment-pipelines` → `listDeploymentPipelines()` → Fabric `GET /v1/deploymentPipelines` |
| Stage columns | `GET /api/deployment-pipelines/[id]/stages` → Fabric `GET .../{id}/stages` |
| Stage items | `GET /api/deployment-pipelines/[id]/stages/[stageId]/items` → Fabric `GET .../{id}/stages/{sid}/items` |
| Deploy button (all / selective + note) | `POST /api/deployment-pipelines/[id]/deploy` → Fabric `POST .../{id}/deploy` (202 LRO) |
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
- `pnpm build` clean (the `/deployment-pipelines` page + all 6 API routes compile).
