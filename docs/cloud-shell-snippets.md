# Try snippets in Cloud Shell

_Last updated: 2026-05-08_

Most code blocks on this site can be tried directly in **Azure Cloud
Shell** — Microsoft's authenticated, browser-hosted terminal. This
page explains the two patterns and the realistic limits.

> **Why this matters:** documentation that you can only read, not run,
> looks like marketing. The patterns below close that gap without
> requiring you to install anything locally.

## Pattern 1 — "Try in Cloud Shell" button (any shell snippet)

When you hover over an `azurecli`, `bash`, `shell`, or `pwsh` code block
on this site, a **💻 Try in Cloud Shell** button appears in the corner.
Clicking it:

1. Copies the snippet to your clipboard.
2. Opens [`https://shell.azure.com`](https://shell.azure.com) in a new
   tab. Sign in with the Azure account that has the resource group /
   subscription you want to run the command against.
3. Surfaces a toast that reminds you to paste with `Ctrl+Shift+V`
   (Linux / Windows) or `⌘+V` (Mac).

### Realistic limits

Cloud Shell does **not** accept a pre-filled command via URL
parameter. This is a Microsoft design decision — see the
[Cloud Shell overview](https://learn.microsoft.com/en-us/azure/cloud-shell/overview)
which lists every supported access point and none of them accept a
command-line. The button therefore can't auto-execute the snippet;
you have to paste it. That's the same UX as the GitHub
[`Open in Cloud Shell`](https://github.com/Azure/cloudshell) experience.

If the snippet uses placeholders like `<your-rg>` or `<subscription-id>`,
edit them after pasting — Cloud Shell's editor is keyboard-first.

### Try it

```azurecli
az group list --output table
```

```bash
echo "Hello from Cloud Shell!"
date
az account show --query "{subscription:name,tenant:tenantDisplayName}" --output yaml
```

```pwsh
Get-AzSubscription | Select-Object Name, TenantId, Id
```

## Pattern 2 — "Deploy to Azure" button (Bicep / ARM templates)

For complete templates (whole IaC modules, end-to-end deployments),
the **Deploy to Azure** button is a true 1-click deploy. Microsoft
documents the URL format at
[Deploy to Azure button](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deploy-to-azure-button).

The format is:

```
https://portal.azure.com/#create/Microsoft.Template/uri/<URL-encoded raw template URL>
```

A few constraints:

- **ARM JSON only.** Bicep files are NOT directly deployable via the
  button — you must compile to ARM JSON first (`az bicep build`).
- **Template must be public-readable.** GitHub raw URLs work
  (`https://raw.githubusercontent.com/<owner>/<repo>/<branch>/path/to/azuredeploy.json`).
  Azure Storage with SAS also works.
- The URL must be **URL-encoded** before appending to the base.

### How CSA-in-a-Box uses this

Each canonical Bicep module under `deploy/bicep/` is compiled to
ARM JSON during the `mkdocs build` workflow and placed beside the
`.bicep` file in the repo (`azuredeploy.json`). Doc pages then
embed:

```markdown
[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/<encoded-url>)
```

You'll see this on:

- [Data Landing Zone (DLZ) main template](https://github.com/fgarofalo56/csa-inabox/tree/main/deploy/bicep/DLZ)
- Sample resource modules under `deploy/bicep/shared/modules/`
- The Copilot Cosmos IaC at `azure-functions/copilot-chat/deploy/main.bicep`

### What a deploy button gets you

Clicking opens the Azure Portal's **Custom Deployment** pane with:

- Subscription / resource group selectors pre-populated with your
  account's options
- Each parameter from the template surfaced as a form field (with the
  template's default values pre-filled)
- A **Review + create** flow that does a what-if before deploying
- Full deployment history under the resource group's **Deployments**
  blade

The button cannot bypass RBAC — the user must have write access on
the chosen scope.

## Using these patterns in your own docs

### To make a shell snippet runnable

Tag the fence with `azurecli` (preferred for Azure CLI commands),
`bash`, `shell`, or `pwsh`:

````markdown
```azurecli
az functionapp list --output table
```
````

The button is added automatically.

### To opt-in a non-shell block

Add `data-cloudshell` to the rendered `<pre>`. With mkdocs-material,
the cleanest way is via `pymdownx.attr_list`:

````markdown
```azurecli {data-cloudshell}
az group list
```
````

### To add a Deploy-to-Azure button

Compile your Bicep, commit the resulting ARM JSON to a public path
(or have CI do it), then embed:

```markdown
[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Ffgarofalo56%2Fcsa-inabox%2Fmain%2Fpath%2Fto%2Fazuredeploy.json)
```

URL-encode the raw template URL with the PowerShell snippet from
Microsoft's docs:

```pwsh
$url = "https://raw.githubusercontent.com/fgarofalo56/csa-inabox/main/path/to/azuredeploy.json"
[uri]::EscapeDataString($url)
```

## Privacy

The "Try in Cloud Shell" button is purely client-side — no analytics
event is sent when you click it. Opening Cloud Shell itself takes you
to Microsoft's `shell.azure.com`, which is governed by Microsoft's
privacy terms.

## Out of scope

Two patterns we intentionally did **not** ship:

- **Embedded Cloud Shell iframe.** Microsoft offers an embed pattern
  for trusted partners but discourages broad adoption — it's not
  GA-stable across browsers.
- **Sandbox subscription.** Microsoft Learn's "activate a sandbox"
  flow uses an internal MS subscription pool. Reproducing that is a
  significant infrastructure project (managed identities, lifecycle,
  cost ceilings) — out of scope for an open-source docs site.

## Related

- [Microsoft — Azure Cloud Shell overview](https://learn.microsoft.com/en-us/azure/cloud-shell/overview)
- [Microsoft — Deploy to Azure button](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deploy-to-azure-button)
- Issue tracking this work: [#178](https://github.com/fgarofalo56/csa-inabox/issues/178)
- Architecture: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)

## See also

- ← Previous: [Quickstart](QUICKSTART.md)
- → Next: [Getting Started](GETTING_STARTED.md)
- ⌂ Index: [Documentation home](index.md)
