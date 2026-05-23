# CSA Loom — Platform (deployable layer)

This is the deployable platform layer for CSA Loom. It produces:

- A **Bicep platform** (`bicep/`) that deploys the full Loom stack
  across Commercial / GCC / GCC-High (v1) and IL5 (v1.1)
- An **`azd` project** (`azd/`) wrapping the Bicep for `azd up`
- (Backlog per AMENDMENTS A4) a **Managed App package**
  (`managed-app/`) for Azure Marketplace publishing

The runtime applications (Loom Console, Setup Orchestrator, MCP
server, parity services) live under `apps/fiab-*/`. This `platform/`
folder is just the IaC.

## Structure

```
platform/fiab/
├── README.md                 # this file
├── bicep/
│   ├── main.bicep            # top-level orchestrator (subscription scope)
│   ├── README.md             # Bicep authoring + extension guide
│   ├── params/
│   │   ├── commercial.bicepparam
│   │   ├── gcc.bicepparam
│   │   └── gcc-high.bicepparam
│   │   # IL5 (v1.1): il5.bicepparam
│   └── modules/
│       ├── admin-plane/      # DMZ-equivalent modules
│       │   ├── network.bicep
│       │   ├── privatednszones.bicep
│       │   ├── acr.bicep
│       │   ├── container-platform.bicep
│       │   ├── console-app.bicep
│       │   ├── mcp-app.bicep
│       │   ├── setup-orchestrator.bicep
│       │   ├── copilot-app.bicep
│       │   ├── catalog.bicep     # Purview / Atlas dispatch
│       │   ├── ai-foundry.bicep
│       │   ├── ai-search.bicep
│       │   ├── apim.bicep
│       │   ├── identity.bicep
│       │   ├── monitoring.bicep
│       │   ├── key-vault.bicep
│       │   ├── sentinel-ai-rules.bicep
│       │   ├── presidio-sidecar.bicep    # Gov tiers only
│       │   └── policy-initiative.bicep
│       ├── landing-zone/     # DLZ per-domain modules
│       │   ├── network.bicep
│       │   ├── databricks.bicep
│       │   ├── synapse-serverless.bicep
│       │   ├── adx-database.bicep
│       │   ├── storage.bicep
│       │   ├── power-bi-workspace.bicep
│       │   ├── activator-engine.bicep
│       │   ├── mirroring-engine.bicep
│       │   ├── direct-lake-shim.bicep
│       │   ├── workspace-identity.bicep
│       │   ├── metadata.bicep
│       │   ├── logging.bicep
│       │   └── runtimes.bicep    # opt-in SHIR
│       └── shared/
│           ├── adx-cluster.bicep
│           ├── role-definitions.bicep
│           └── tagging.bicep
├── azd/
│   ├── azure.yaml            # azd project definition
│   └── infra → ../bicep      # symlink
└── managed-app/              # BACKLOG per AMENDMENTS A4
    └── README.md             # explains the deferral
```

## Status

**SCAFFOLDED.** Module stubs + parameter files + `main.bicep`
top-level orchestrator are in place. Per-module Bicep implementation
is the engineering work tracked under
[PRP-02](../../PRPs/active/csa-loom/PRP-02-platform-bicep.md).

To validate the scaffold:
```bash
cd platform/fiab/bicep
az bicep build --file main.bicep
# Should compile; modules with `param` declarations only will emit
# a deployment that creates no resources
```

To deploy (once modules are implemented):
```bash
cd platform/fiab/azd
azd init -t .
azd env new csa-loom-dev
azd env set CSA_LOOM_BOUNDARY Commercial
azd env set CSA_LOOM_DEPLOYMENT_MODE single-sub
azd env set CSA_LOOM_CAPACITY_SKU F8
azd env set CSA_LOOM_ADMIN_GROUP_ID <group-guid>
azd up
```

## Reuse from existing csa-inabox

Per [`temp/fiab-research/05-eslz-marketplace.md` §1](../../temp/fiab-research/05-eslz-marketplace.md)
and [PRP-02](../../PRPs/active/csa-loom/PRP-02-platform-bicep.md):

**Reuse 1:1 from `Azure/data-management-zone` + `Azure/data-landing-zone`**:
- `modules/network.bicep` → `modules/admin-plane/network.bicep`
- `modules/services/privatednszones.bicep` → `modules/admin-plane/privatednszones.bicep`
- `modules/container.bicep` → `modules/admin-plane/acr.bicep`
- `modules/metadata.bicep` + `modules/logging.bicep`

**Reuse from existing csa-inabox `deploy/bicep/gov/`**:
- ~70% per [PRP-07 existing-repo-scope research](../../temp/fiab-research/07-existing-repo-scope.md)

## Related

- [Deployment overview](../../docs/fiab/deployment/index.md)
- [Reference architecture](../../docs/fiab/architecture.md)
- [Per-boundary dispatch matrix](../../docs/fiab/architecture.md#per-boundary-dispatch-matrix)
- PRP: [PRP-02](../../PRPs/active/csa-loom/PRP-02-platform-bicep.md)
- ADR: [fiab-0008 Deployment shape](../../docs/fiab/adr/0008-deployment-shape.md), [fiab-0010 Container host](../../docs/fiab/adr/0010-container-host.md)
