# deploy-templates — bundled compiled ARM template

`main.json` is the **compiled ARM template** for `platform/fiab/bicep/main.bicep`.
It is committed into the image so the Setup Wizard's user-delegated DLZ deploy
(`lib/setup/user-arm-deploy.ts` → `resolveDlzTemplateInline`) can submit the
subscription-scoped `Microsoft.Resources/deployments` PUT with the template
**INLINE** in the request body (`properties.template`) — no storage account,
no `templateLink`, no SAS.

## Why inline

The compiled template is ~3.4 MB, which is under ARM's 4 MB inline-template
limit (`az deployment sub validate --template-file main.json` returns
`provisioningState=Succeeded` on **both** Commercial and Gov). The prior
`templateLink` + SAS path worked on Commercial but Gov ARM cannot fetch a
SAS'd Gov blob, and user-delegation SAS expires in ~7 days. Bundling the
compiled template makes the deploy **durable and cloud-agnostic** — it is
always available at runtime, with the `LOOM_DLZ_TEMPLATE_URI` (`templateLink`)
path kept only as a fallback.

## Regenerating (required when main.bicep changes)

Regenerate from the repo root whenever `platform/fiab/bicep/main.bicep` (or any
module it references) changes:

```bash
az bicep build -f platform/fiab/bicep/main.bicep \
  --outfile apps/fiab-console/deploy-templates/main.json
```

Commit the regenerated `main.json`. The CI template-publish step already
recompiles from the same source, so the bundled copy must be kept in sync.
