# CSA Loom — Azure DevOps deployment-pipeline tasks

An Azure DevOps **extension** that drives [CSA Loom](../../README.md) deployment
pipelines from a build/release pipeline, through the Loom REST API. It is the
1:1 parity for Microsoft's Fabric `ms-fabric.fabric-devops-pipelines` task
(Fabric Build 2026 #31, "Fabric CLI in Azure DevOps"), pointed at the tenant's
own Loom Console instead of `api.fabric.microsoft.com`.

## Why it exists

Loom already ships an Azure-native parity for **Fabric deployment pipelines**
(`apps/fiab-console/app/api/deployment-pipelines/loom/**`): ordered stages, each
bound to a distinct owned workspace, with selective/full promote, content-level
compare, deploy receipts (history), and per-stage deployment rules — all Cosmos +
the real Azure-native provisioners, **no Fabric / Power BI dependency**. Those
routes were cookie-session-only, so a headless ADO agent (which cannot present
the encrypted `loom_session` cookie) had no way in. This extension closes that
gap with the same dual-auth pattern `/api/iq/mcp` already uses for external
agents.

## Tasks

| Task | Purpose | Loom route |
|------|---------|-----------|
| `LoomDeploy@1` | Promote content from one stage to the next (full or selective). Sets `operationId`, `status`, `deployedCount` outputs. | `POST …/loom/{id}/deploy` |
| `LoomCompare@1` | Content-level diff between two stages. Optional `failOnDifferences` makes it a pre-deploy gate. Sets `same/different/onlyInSource/notInSource/differences`. | `GET …/loom/{id}/compare` |
| `LoomListPipelines@1` | List the tenant's pipelines + stage ids; optionally fail if a named pipeline is missing (`matchedPipelineId` output). | `GET …/loom` |

## Authentication

The deployment-pipeline routes accept **two** credentials (see
`apps/fiab-console/app/api/deployment-pipelines/loom/_lib/pipeline-store.ts`,
`resolveCaller`):

1. **Cookie session** — interactive Console users / the "Deploy" button. Always on.
2. **Bearer token** — headless CI. **Off by default**, fails closed. Enabled by
   `LOOM_PIPELINE_CI_ENABLED=true`. The presented Bearer must match
   `LOOM_CI_TOKEN` (preferred — isolates CI) or, when that is unset, the shared
   `LOOM_INTERNAL_TOKEN` that Bicep already wires. The acting tenant comes from
   the `x-user-oid` header (the task's `userOid` input).

The token is sent only to your `loomBaseUrl`. Store it in a **secret** pipeline
variable (e.g. `$(LOOM_CI_TOKEN)`), never inline.

### Enabling the Console side (Bicep)

`platform/fiab/bicep` exposes `loomPipelineCiEnabled` (top-level param → admin-plane):

```bash
az deployment sub create -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial-full.bicepparam \
  -p loomPipelineCiEnabled=true
```

When true the Console gets `LOOM_PIPELINE_CI_ENABLED=true` and the
`loom-internal-token` secret (`LOOM_INTERNAL_TOKEN`). To isolate CI from the
broader internal-trust token, add a dedicated `LOOM_CI_TOKEN` app setting /
Key Vault secret to the Console container — the routes prefer it when present.

## Packaging & publishing

The tasks are **zero-dependency** Node 20 scripts (built-in `https` + the
documented `INPUT_*` / `##vso[...]` agent contracts), so there is nothing to
`npm install` or transpile — the source in each `*V1/index.js` is exactly what
runs on the agent. Packaging only needs `tfx-cli`:

```bash
cd tools/ado-loom-task
npm test                       # node --test (zero-dep)
npx tfx-cli extension create --manifest-globs vss-extension.json --rev-version
```

- **Commercial / public ADO orgs**: publish the `.vsix` to the Visual Studio
  Marketplace via a Marketplace service connection, then install into the org.
- **GCC-High / IL5 / air-gapped Azure DevOps Server**: the Marketplace is a
  single public endpoint, so **side-load** the `.vsix` (Organization settings →
  Extensions → *Manage extensions* → *Upload extension*). The Fabric extension
  has the same constraint; the tasks themselves are fully cloud-agnostic.

Bump both the extension `version` (in `vss-extension.json`) and each task
`version` (in `*/task.json`) on every release — Azure DevOps caches tasks by
`{id, major.minor.patch}`.

## Files

```
tools/ado-loom-task/
  vss-extension.json          extension manifest (publisher, contributions, files)
  overview.md                 Marketplace details page
  package.json                test + package scripts
  azure-pipelines.sample.yml  end-to-end Dev→Test→Prod example
  common/loom-http.js         shared zero-dep HTTP + agent-contract helper
  LoomDeployV1/   task.json + index.js + icon.png
  LoomCompareV1/  task.json + index.js + icon.png
  LoomListPipelinesV1/ task.json + index.js + icon.png
  test/inputs.test.js         node:test unit tests
```

Parity matrix: `docs/fiab/parity/azure-devops-task.md`.
