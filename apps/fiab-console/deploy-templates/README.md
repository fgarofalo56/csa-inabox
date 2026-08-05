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

## CI enforces this (#2945)

`scripts/ci/check-deploy-template-sync.mjs` runs in the merge-blocking
`guardrails` job (`.github/workflows/loom-guardrails.yml`, **no path filter** —
it runs on every PR). It recompiles `main.bicep` and requires the committed
`main.json` to be **byte-identical**; any difference fails the job and prints
the regenerate command above.

It was needed because this file had already drifted, silently, and the drift
shipped: four merged fixes were **inert** in the deploying artifact, including
#2682's ACR-mirroring supply-chain fix (airflow was still pulled straight from
Docker Hub) and a role assignment against a Website Contributor GUID that does
not exist.

Two details worth knowing before you "fix" a failure:

- **Line endings are not content.** `az bicep build` always writes LF and
  `.gitattributes` pins this file to `text eol=lf`. If the guard reports an
  *eol* difference, your checkout predates that pin — run
  `git add --renormalize apps/fiab-console/deploy-templates/main.json`. Do not
  "fix" it by rewriting the file.
- **Regenerate from an LF bicep checkout.** bicep embeds the line endings of its
  own source into emitted string values — a `'''…'''` multi-line literal in a
  `.bicep` file, and every file pulled in by `loadTextContent()`, are copied
  byte-for-byte. The artifact committed before this gate had been generated on
  Windows and carried **1195** escaped CRLFs inside its embedded bash,
  PowerShell, Python and KQL, including
  `"scriptContent": "set -euo pipefail\r\n…"` — CRLF bash handed to an ARM
  deploymentScript, i.e. `$'\r': command not found`. `.gitattributes` now pins
  `platform/fiab/bicep/** text eol=lf`, which makes the compile byte-identical
  on Windows and Linux; the guard also fails with a named message if escaped
  CRLFs ever reappear, rather than printing an opaque diff.
- **The bicep CLI version is pinned by the file itself.** `az bicep build`
  output varies across CLI versions in `metadata._generator.version` *and*
  `templateHash` (measured 2026-08-04: 0.45.15 vs 0.46.1 differ in 840 lines,
  every one of them a `_generator` line). Rather than mask those fields, the
  guard reads `metadata._generator.version` out of the committed artifact and
  installs exactly that bicep before compiling — so nothing is normalized away
  and a new bicep release cannot cause a false failure. Regenerating with a
  newer bicep is fine: the stamp moves and the guard follows it.
