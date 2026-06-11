# CSA Loom — DevOps deployment pipelines

Drive **CSA Loom deployment pipelines** straight from Azure DevOps. This
extension adds three pipeline tasks that call the Loom REST API:

| Task | Verb | Wraps |
|------|------|-------|
| **LoomDeploy@1** | Promote content between stages | `POST /api/deployment-pipelines/loom/{id}/deploy` |
| **LoomCompare@1** | Content-level diff between two stages (pre-deploy gate) | `GET /api/deployment-pipelines/loom/{id}/compare` |
| **LoomListPipelines@1** | Discover pipelines + stage ids | `GET /api/deployment-pipelines/loom` |

This is the Azure-native parity for the Fabric `fabric-devops-pipelines`
extension. The tasks talk **only to your own Loom Console URL** — never
`api.fabric.microsoft.com` or `api.powerbi.com` — so they work in Commercial,
GCC, GCC-High, IL5, and air-gapped Azure DevOps Server.

## Setup

1. Deploy (or update) the Loom Console with the CI token path enabled:
   `loomPipelineCiEnabled=true` (or app setting `LOOM_PIPELINE_CI_ENABLED=true`).
2. Add a **secret** pipeline variable `LOOM_CI_TOKEN` = the Console's
   `LOOM_CI_TOKEN` (or `LOOM_INTERNAL_TOKEN` when no dedicated CI token is set).
3. Reference the tasks as shown in `azure-pipelines.sample.yml`.

See the repo README for the full parity matrix and the `userOid` requirement.
