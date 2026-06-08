# fiab-label-propagation

CSA Loom — **sensitivity-label downstream propagation** timer Function (feature
F15). Azure Functions, Node.js v4 programming model, TypeScript.

## What it does

Every `LABEL_PROPAGATION_CRON` interval (default **every 15 minutes**) the
`labelPropagation` timer trigger:

1. reads the Loom `workspaces` + `items` from the shared Cosmos `loom` database,
2. rebuilds the lineage edge graph from typed `state` references (the same
   reference keys the Console lineage view uses),
3. computes, per tenant, the **most-restrictive** sensitivity label each item
   should inherit from its upstream lineage sources (`computePropagation` in
   `src/propagation-core.ts`), and
4. **upserts one row per item** (`id = prop:<itemId>`, partition `/tenantId`)
   into the Cosmos `label-propagation` container.

The Console lineage view (`/governance/lineage`) reads that container to show a
real **propagation-status indicator** per node, and the semantic-model editor
reads it for its read-only "Sensitivity (inherited from upstream)" field (F17).

There is **no Microsoft Fabric dependency** — the Function operates purely on
the Loom Cosmos store. See `.claude/rules/no-fabric-dependency.md`.

## Propagation rules

The canonical rules + the exhaustive unit tests live in
`apps/fiab-console/lib/governance/label-propagation.ts` and the full write-up is
`docs/fiab/parity/label-inheritance.md`. `src/propagation-core.ts` is a
self-contained mirror (this app builds independently of the Next.js console);
`src/propagation-core.test.ts` guards behavioural parity.

| Status      | Meaning                                                            |
|-------------|-------------------------------------------------------------------|
| in-sync     | current label == expected (inherited) label                       |
| pending     | upstream is more restrictive — propagation needed                 |
| overridden  | item raised above upstream (deliberate manual raise — allowed)    |
| unlabeled   | has upstream, neither it nor its upstream carries a label         |
| no-upstream | root item — nothing to inherit                                    |

## App settings

| Setting                  | Purpose                                                        |
|--------------------------|----------------------------------------------------------------|
| `LOOM_COSMOS_ENDPOINT`   | Loom Cosmos account endpoint (required).                       |
| `LOOM_COSMOS_DATABASE`   | Database id (default `loom`).                                  |
| `LABEL_PROPAGATION_CRON` | NCRONTAB schedule (default `0 */15 * * * *`).                  |
| `AZURE_CLIENT_ID`        | User-assigned identity client id (optional; system identity otherwise). |

## Identity / RBAC

The Function App identity must hold **Cosmos DB Built-in Data Contributor**
(`00000000-0000-0000-0000-000000000002`) at the account. Granted during
post-deploy bootstrap by `scripts/csa-loom/grant-navigator-rbac.sh`
(`LABEL_PROP_FUNC_NAME`).

## Local development

```bash
npm install
npm run build
npm test          # vitest — propagation-core parity tests
func start        # requires Azure Functions Core Tools v4 + local.settings.json
```

`local.settings.json` (not committed):

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "LOOM_COSMOS_ENDPOINT": "https://<acct>.documents.azure.com:443/",
    "LOOM_COSMOS_DATABASE": "loom",
    "LABEL_PROPAGATION_CRON": "0 */15 * * * *"
  }
}
```

## Deployment

Provisioned by `platform/fiab/bicep/modules/admin-plane/label-propagation-function.bicep`
(Linux Consumption plan + backing Storage + system identity), wired into
`modules/admin-plane/main.bicep` behind `labelPropagationEnabled`. Code is
published by the standard app-deploy workflow (`func azure functionapp publish`
or zip-deploy).
