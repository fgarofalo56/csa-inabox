# PRP-11 — Per-Boundary Deploy Validation Workflows

## Context

GitHub Actions that nightly-validate the platform Bicep against each
in-scope boundary using the `limitlessdata_deploy` SP. Reduced scope
in v1 (no Marketplace package publishing per AMENDMENTS A4).

PRD ref: `temp/fiab-prd/07-deployment.md` §7.8.

## Goal

Three nightly workflows (Commercial / GCC / GCC-High) that deploy a
clean Loom Admin Plane + 1 DLZ into a test sub, run a smoke test
(workspace creation, sample data ingest, query, deploy semantic
model), then tear down the test RGs.

## Acceptance criteria

- [ ] `.github/workflows/deploy-fiab-commercial.yml` — nightly + on
  PR to `platform/fiab/`
- [ ] `.github/workflows/deploy-fiab-gcc.yml` — nightly
- [ ] `.github/workflows/deploy-fiab-gcch.yml` — nightly with manual
  approval gate
- [ ] Each workflow uses `limitlessdata_deploy` SP for auth (per
  [[azure-deployment-principal]])
- [ ] Provisions clean RG named `fiab-test-<run-id>`
- [ ] Runs `az deployment sub create` with boundary `.bicepparam`
- [ ] Smoke-test E2E (workspace creation, sample data, query,
  semantic model deploy)
- [ ] Tears down RG on success; retains on failure with notification
  to Teams `csa-inabox-ci-alerts` channel

## Validation gates

- 3 nights in a row clean run across all 3 boundaries
- Manual deploy via `gh workflow run` succeeds against staging

## Implementation outline

1. Author each workflow YAML following existing `deploy-gov.yml`
   patterns in the repo
2. Wire `limitlessdata_deploy` SP secret per [[azure-deployment-principal]]
3. Implement smoke-test bash script that calls the Loom Console REST
   API to create a workspace + verify
4. Wire teardown to the workflow's `always()` step
5. Failure notification via Teams webhook

## File changes

```
.github/workflows/deploy-fiab-commercial.yml             created
.github/workflows/deploy-fiab-gcc.yml                    created
.github/workflows/deploy-fiab-gcch.yml                   created
.github/scripts/fiab-smoke-test.sh                       created
.github/scripts/fiab-teardown.sh                         created
```

## Out of scope (deferred per AMENDMENTS A4)

- `validate-marketplace-package.yml` — no Marketplace package in v1
- `publish-marketplace.yml` — no Marketplace publishing in v1

## References

- `temp/fiab-prd/07-deployment.md` §7.8
- `temp/fiab-prd/AMENDMENTS.md` §A4
- Memory: [[azure-deployment-principal]]
