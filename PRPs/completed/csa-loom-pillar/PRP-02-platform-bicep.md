# PRP-02 — Platform Bicep + ESLZ Reuse + Per-Boundary Params

## Context

CSA Loom needs a Bicep platform layer that deploys the full Admin
Plane + N Data Landing Zones across Commercial / GCC / GCC-High
boundaries (IL5 in v1.1). Reuse ~50% from Azure/data-management-zone
+ Azure/data-landing-zone where appropriate; build new modules where
ESLZ doesn't cover Loom-specific workloads.

PRD ref: `temp/fiab-prd/07-deployment.md` §7.2-7.4;
`temp/fiab-prd/04-reference-architecture.md` §4.6-4.7.

## Goal

`platform/fiab/bicep/` is a complete, working Bicep platform that
deploys CSA Loom end-to-end via `azd up` or `az deployment sub create`
against Commercial / GCC / GCC-High parameter sets.

## Acceptance criteria

- [ ] `platform/fiab/bicep/main.bicep` orchestrates the full deploy
  at subscription scope with `deploymentMode` parameter
  (`single-sub` | `multi-sub`)
- [ ] Per-boundary `.bicepparam` files exist:
  `commercial.bicepparam`, `gcc.bicepparam`, `gcc-high.bicepparam`
  (IL5 deferred to PRP-101 v1.1)
- [ ] Admin Plane modules complete: network, privatednszones, acr,
  container-platform, console-app, mcp-app, copilot-app, catalog,
  ai-foundry, ai-search, apim, identity, monitoring, key-vault,
  policy-initiative
- [ ] Data Landing Zone modules complete: network, databricks,
  synapse-serverless, adx-database, storage, power-bi-workspace,
  activator-engine, mirroring-engine, direct-lake-shim,
  workspace-identity, metadata, logging
- [ ] Shared modules: adx-cluster, purview, role-definitions, tagging
- [ ] All resources deploy with `publicNetworkAccess = disabled` +
  Private Endpoints
- [ ] All boundary-specific dispatch is via `.bicepparam` (separate
  files per AMENDMENTS A16; not inline conditionals)
- [ ] `containerPlatform` parameter flips Container Apps → AKS for
  GCC-High
- [ ] `azd up --environment csa-loom-commercial-dev` completes within
  60 minutes against a clean Commercial sub
- [ ] `azd up --environment csa-loom-gcch-test` completes within
  90 minutes against a clean GCC-High sub
- [ ] `bicep build main.bicep` clean (no warnings beyond expected)
- [ ] `bicep what-if` shows no destructive changes on re-run against
  the same params

## Validation gates

- GitHub Actions nightly: `deploy-fiab-commercial.yml` runs to
  completion; smoke-test creates a workspace in the Loom Console (when
  PRP-03 lands; before then, smoke-test asserts the Console URL
  returns 200)
- Manual Gov test: `azd up` against `gcc-high.bicepparam` succeeds
  in `usgovvirginia` using the `limitlessdata_deploy` SP
- All Bicep `@allowed` constraints enforce the dispatch matrix from
  PRD §4.3

## Implementation outline

1. Fork the relevant modules from Azure/data-management-zone and
   Azure/data-landing-zone (per PRD §7.2 reuse map). Lift these
   into `platform/fiab/bicep/modules/` with our adjustments
2. Write the new modules (databricks, adx-cluster, etc.)
3. Author the per-boundary `.bicepparam` files (drafts in
   `temp/fiab-research/02-gov-boundary-availability.md §8`)
4. Wire main.bicep orchestration
5. Add `azd init` template at `platform/fiab/azd/azure.yaml`
6. Add Deploy-to-Azure button in README (links to a pre-rendered
   `mainTemplate.json` published per release)
7. Document parameter conventions in `platform/fiab/bicep/README.md`

## File changes

```
platform/fiab/bicep/main.bicep                                created
platform/fiab/bicep/README.md                                 created
platform/fiab/bicep/params/commercial.bicepparam              created
platform/fiab/bicep/params/gcc.bicepparam                     created
platform/fiab/bicep/params/gcc-high.bicepparam                created
platform/fiab/bicep/modules/admin-plane/*.bicep               created (15 files)
platform/fiab/bicep/modules/landing-zone/*.bicep              created (12 files)
platform/fiab/bicep/modules/shared/*.bicep                    created (4 files)
platform/fiab/azd/azure.yaml                                  created
platform/fiab/azd/infra (symlink → ../bicep)                  created
.github/workflows/deploy-fiab-commercial.yml                  created (by PRP-11)
README.md                                                     modified (add Deploy-to-Azure button)
```

## Open questions / risks

- UC managed availability in Gov is the unknown (CY2026 commitment,
  no quarter); `databricksUnityCatalogEnabled = false` for Gov in v1
  per AMENDMENTS A7; module ships ready to flip when GA arrives
- ESLZ modules are frozen at v1.2.0 (Dec 2021); selective forking
  rather than vendoring keeps maintenance burden low

## References

- `temp/fiab-prd/07-deployment.md`
- `temp/fiab-prd/04-reference-architecture.md`
- `temp/fiab-research/02-gov-boundary-availability.md`
- `temp/fiab-research/05-eslz-marketplace.md`
- `Azure/data-management-zone` repo (MIT)
- `Azure/data-landing-zone` repo (MIT)
- Memory: [[azure-deployment-principal]]
