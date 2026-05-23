# From "Deploy to Azure" button

The portal-click deployment path. Best for evaluators who prefer
the Azure portal over CLI.

## How to use

1. Open the [csa-inabox README](https://github.com/fgarofalo56/csa-inabox#csa-loom)
2. Click the **Deploy to Azure** button under the CSA Loom section
3. Azure portal opens with the pre-rendered ARM template
4. Fill in the form (same parameters as `azd up`):
   - Subscription
   - Region
   - Boundary (Commercial / GCC / GCC-High)
   - Deployment mode (single-sub / multi-sub)
   - Capacity SKU
   - Admin Entra group object ID
   - Hub VNet CIDR
5. Click **Review + create**
6. Wait ~35-55 minutes for Admin Plane + ~15-40 min for first DLZ

## Behind the scenes

The Deploy to Azure button uses a special URL format that loads a
GitHub-hosted ARM template into Azure portal's deployment UI:

```
https://portal.azure.com/#create/Microsoft.Template/uri/<URL-encoded ARM template URL>
```

The ARM template is `mainTemplate.json` — compiled from `platform/fiab/bicep/main.bicep`
via `az bicep build`. Re-rendered per release and published to a
public GitHub Pages URL.

## Per-boundary variants

The README shows three Deploy to Azure buttons:

| Button | Pre-set boundary |
|---|---|
| Deploy to Azure Commercial | Commercial |
| Deploy to Azure (GCC pair) | GCC |
| Deploy to Azure Government | GCC-High |

Each links to a separately-rendered ARM template with the boundary
parameter pre-filled. The portal still lets the customer override.

## Limitations vs `azd up`

| Capability | Deploy button | azd up |
|---|---|---|
| One-click portal install | ✅ | ❌ |
| Per-env reproducibility | ❌ (manual re-fill) | ✅ |
| Bicep visibility | ❌ (ARM template only) | ✅ |
| Custom Bicep modules | ❌ | ✅ |
| CI/CD integration | ❌ | ✅ |
| Best for | Evaluators | Production / platform engineers |

## Federal customers

For GCC-High / IL5, the Azure Government portal is at
`portal.azure.us` (not `portal.azure.com`). The Deploy to Azure URL
format is slightly different for Gov:

```
https://portal.azure.us/#create/Microsoft.Template/uri/<URL-encoded ARM template URL>
```

Loom's Gov Deploy-to-Azure button uses this format.

## After deploy

Same as `azd up` — Loom Console comes up at the output URL; sign in
with your Entra identity; create your first workspace via [Tutorial 01](../tutorials/01-first-workspace.md).

## Tear down

Delete the resource groups from the Azure portal (search for
"fiab-*" in your sub). Or:

```bash
az group list --query "[?starts_with(name, 'fiab-')].name" -o tsv | \
  xargs -I {} az group delete --name {} --yes --no-wait
```

## Related

- [Quick Start](quickstart.md) — same flow via CLI
- [azd CLI deployment](azd-cli.md)
