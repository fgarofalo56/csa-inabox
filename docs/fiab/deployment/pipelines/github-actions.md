# Deploy CSA Loom from GitHub Actions

Production-ready workflow for promoting Loom through Dev → Stage → Prod
subscriptions using OIDC federated credentials and per-environment
approvals.

This is the canonical pattern used by `.github/workflows/deploy-fiab-commercial.yml`
in this repo. Copy-paste into your fork or downstream repo.

## Prerequisites

| Item | Notes |
|---|---|
| Azure subscription (target) | One per environment if doing multi-env promotion |
| Service principal **with OIDC federated credential** | No long-lived secret in GitHub |
| GitHub repo **Environments** configured | `dev`, `stage`, `prod` — each with required reviewers |
| GitHub secrets per environment | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` |
| Optional: `LOOM_ADMIN_GROUP_OBJECT_ID` | Pre-existing Entra group for Loom Admins role assignment |

The SP needs **Contributor + User Access Administrator** on the target
subscription. See [scripts/csa-loom/setup-deploy-sp.sh](../../../../scripts/csa-loom/setup-deploy-sp.sh)
for the federated-credential setup.

## Workflow

Save as `.github/workflows/deploy-loom.yml`:

```yaml
name: Deploy CSA Loom

on:
  workflow_dispatch:
    inputs:
      environment:
        description: Target environment
        required: true
        type: choice
        options: [dev, stage, prod]
        default: dev
      boundary:
        description: Azure cloud boundary
        required: true
        type: choice
        options: [commercial, gcc, gcc-high]
        default: commercial
      run_mode:
        description: deploy / validate / teardown
        required: true
        type: choice
        options: [deploy, validate, teardown]
        default: deploy

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4

      - name: Azure login (OIDC)
        uses: azure/login@v2
        with:
          client-id:       ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id:       ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Install azd
        run: curl -fsSL https://aka.ms/install-azd.sh | bash

      - name: Validate Bicep
        if: inputs.run_mode == 'validate'
        run: |
          az bicep build --file platform/fiab/bicep/main.bicep
          az deployment sub validate \
            --location eastus2 \
            --template-file platform/fiab/bicep/main.bicep \
            --parameters platform/fiab/bicep/params/${{ inputs.boundary }}.bicepparam

      - name: Deploy
        if: inputs.run_mode == 'deploy'
        run: |
          az deployment sub create \
            --name loom-${{ inputs.environment }}-${{ github.run_number }} \
            --location eastus2 \
            --template-file platform/fiab/bicep/main.bicep \
            --parameters platform/fiab/bicep/params/${{ inputs.boundary }}.bicepparam \
            --parameters loomAdminGroupObjectId=${{ secrets.LOOM_ADMIN_GROUP_OBJECT_ID }}

      - name: Post-deploy bootstrap
        if: inputs.run_mode == 'deploy'
        run: |
          # Power BI tenant SP grant, Databricks SCIM, Dataverse AppUser
          bash scripts/csa-loom/bootstrap-all.sh \
            --boundary ${{ inputs.boundary }} \
            --environment ${{ inputs.environment }}

      - name: Smoke test live URL
        if: inputs.run_mode == 'deploy'
        run: |
          node apps/fiab-console/tests/build-marker-probe.mjs \
            --url https://loom-console-${{ inputs.environment }}.azurewebsites.net

      - name: Teardown (destructive — requires approval)
        if: inputs.run_mode == 'teardown'
        run: bash scripts/csa-loom/teardown-loom.sh --confirm
```

## What happens

1. **Manual dispatch** with environment + boundary + mode picker.
2. **Environment approval** gates production (configure required
   reviewers under repo Settings → Environments → prod).
3. **OIDC token** swapped for an Azure access token — no long-lived
   client secret on disk.
4. **Bicep validate** (dry run) or **deploy** (real) or **teardown**.
5. **Post-deploy bootstrap** runs Power BI tenant SP grant + Databricks
   SCIM + Dataverse AppUser provisioning.
6. **Smoke test** asserts the build marker on the live URL matches the
   commit SHA.

## Promotion across environments

Run `dev` → check build marker + smoke → run `stage` (approver
required) → repeat → run `prod` (approver required).

Each environment uses its own secrets, so a single workflow file
covers all three subscriptions without secret rotation between runs.

## Related

- [`azd up` CLI deployment](../azd-cli.md) — same Bicep, run locally
- [Bicep CLI direct](bicep-cli.md) — no azd / no GitHub
- [Azure DevOps pipeline](azure-devops.md) — same flow under YAML pipelines
- [`scripts/csa-loom/`](../../../../scripts/csa-loom/) — bootstrap scripts
- This repo's actual workflows: `.github/workflows/deploy-fiab-*.yml`
