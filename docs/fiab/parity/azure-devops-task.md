# azure-devops-task — parity with the Fabric `fabric-devops-pipelines` Azure DevOps extension

**Surface:** `tools/ado-loom-task/` (Azure DevOps extension: `LoomDeploy@1`,
`LoomCompare@1`, `LoomListPipelines@1`) wrapping the Loom REST surface at
`apps/fiab-console/app/api/deployment-pipelines/loom/**`.

**Source UI / reference target:**
- Microsoft Fabric DevOps pipelines extension `ms-fabric.fabric-devops-pipelines`
  (Visual Studio Marketplace) — native ADO tasks that run Fabric CLI (`fab`)
  commands to deploy across deployment-pipeline stages, authenticating via an
  ADO service connection to the Fabric tenant.
- Learn: `learn.microsoft.com/fabric/cicd/deployment-pipelines/` (deployment
  pipelines, deploy/compare/rules) and
  `learn.microsoft.com/fabric/data-factory/cicd-pipelines#automate-ci-cd-with-fabric-cli-and-azure-devops-pipelines`.
- ADO custom-task mechanics: `learn.microsoft.com/azure/devops/extend/develop/add-build-task`.

Per `no-fabric-dependency.md`: the Fabric extension calls
`api.fabric.microsoft.com`; the Loom task calls **only the tenant's own Loom
Console URL** + Entra. It is cloud-agnostic by construction (Commercial / GCC /
GCC-High / IL5 / air-gapped), where Fabric is often unavailable.

## Fabric / ADO feature inventory → Loom coverage

| # | Capability in the Fabric ADO extension | Loom coverage | Backend |
|---|----------------------------------------|---------------|---------|
| 1 | A pipeline **task** addable to a build/release pipeline | ✅ `LoomDeploy@1` (+ `LoomCompare@1`, `LoomListPipelines@1`), declared via `vss-extension.json` contributions | Node20 task handler |
| 2 | **Deploy** content across deployment-pipeline stages (Dev→Test→Prod) | ✅ `LoomDeploy@1`, `deployMode=full` | `POST …/loom/{id}/deploy` → real Azure-native provisioners |
| 3 | **Selective** deploy of specific items | ✅ `LoomDeploy@1`, `deployMode=selective` + `items` (one `itemType:sourceItemId` per line) | same route, `items[]` body |
| 4 | Deploy **note** / annotation on the operation | ✅ `note` input → deploy receipt | `note` persisted to `pipeline-history` |
| 5 | Surface deploy **result / status** to the pipeline | ✅ outputs `operationId`, `status`, `deployedCount`; `failOnPartial` controls Failed vs SucceededWithIssues | route `{status, deployedItemIds, steps}` |
| 6 | **Stage compare** (what differs before deploy) | ✅ `LoomCompare@1`, `failOnDifferences` gate; outputs `same/different/onlyInSource/notInSource/differences` | `GET …/loom/{id}/compare` |
| 7 | **Discover** pipelines / stages for scripting | ✅ `LoomListPipelines@1`, `expectPipelineName` → `matchedPipelineId` | `GET …/loom` |
| 8 | **Authentication** for a headless agent | ✅ Bearer token (`LOOM_CI_TOKEN` / `LOOM_INTERNAL_TOKEN`) + `x-user-oid`, gated by `LOOM_PIPELINE_CI_ENABLED` (off by default, fail-closed) — `resolveCaller` in `_lib/pipeline-store.ts`, mirrors `/api/iq/mcp` | Console BFF |
| 9 | Per-stage **deployment rules** (data-source / parameter overrides) | ⚠️ Managed via the Console UI / `PUT …/stages/{id}/rules` (the same routes now also accept the CI token); a dedicated rules-management ADO task is intentionally **not** shipped in v1 — rules are environment config, set once, not per-build | `…/stages/{stageId}/rules` |
| 10 | Deploy **history** / receipts | ⚠️ Exposed via `GET …/loom/{id}/history` (CI-token-callable); not surfaced as a separate ADO task in v1 (the deploy task already returns + logs the receipt) | `pipeline-history` |
| 11 | Install from **Visual Studio Marketplace** | ✅ `tfx extension create` → publish; ⚠️ Gov / air-gapped Azure DevOps Server: **side-load** the `.vsix` (same constraint as the Fabric extension) | — |
| 12 | Service-connection-based auth | ⚠️ v1 uses a secret-variable Bearer token (simpler, dependency-free); a custom service-connection endpoint type is a documented future enhancement | — |

Zero ❌. Rows 9, 10, 12 are honest, documented scoping decisions (the
underlying routes exist and are CI-token-callable today), not stubs.

## Backend per control

Every task issues a real HTTPS call to the Loom Console BFF, which executes the
existing Azure-native deployment-pipeline engine (Cosmos for pipeline/stage/rule/
history docs + the same `PROVISIONERS` the install path uses, Managed-Identity
backed). No mock data; no Fabric / Power BI; works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset. The tasks themselves are zero-dependency
Node 20 scripts using the documented `INPUT_*` env + `##vso[...]` agent contracts.

## Verification

- `tools/ado-loom-task`: `node --test test/inputs.test.js` (9 passing) — input
  parsing, URL handling, item-line parsing, invalid-URL rejection, 401 hint.
- `apps/fiab-console`: `app/api/deployment-pipelines/loom/__tests__/resolve-caller.test.ts`
  — cookie-session mode, fail-closed when disabled, bad/empty Bearer, missing
  `x-user-oid`, valid internal-token fallback, dedicated `LOOM_CI_TOKEN` preference.
- E2E: deploy the Console with `loomPipelineCiEnabled=true`, set a secret
  `LOOM_CI_TOKEN`, run the `azure-pipelines.sample.yml` against a real pipeline,
  confirm the receipt (`operationId` / `status` / `steps`) in the task log and
  the new history record in the Console UI.
