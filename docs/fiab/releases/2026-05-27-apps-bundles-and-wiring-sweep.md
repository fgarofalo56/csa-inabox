---
title: "Release 2026-05-27 — App content bundles + console wiring sweep"
description: "Six PRs landed on 2026-05-27: 10 CSA apps install with rich starter content from examples/, 175 ribbon buttons wired, compute lifecycle + backing-service pickers, Monaco self-host + worker CSP, Activator workspace fix, /onelake WAF partial fix."
---

# Release 2026-05-27 — App content bundles + console wiring sweep

Six PRs landed on `main` on 2026-05-27, all live on the FedCiv DLZ
deployment at `loom-console-fvbbctd4eehqbkcs.b02.azurefd.net` (container
revision `loom-console--0000082`, image SHA `146d2158`). This page is
the operator-readable release log for that work.

Use this page when you need to know what's actually deployed today, what
changed from the prior state, and which test script section exercises
which change.

## What landed

<div class="grid cards" markdown>

-   :material-package-variant-closed: **All 10 CSA apps install with real code + data**

    Every curated app — Casino Analytics, IoT Real-Time, Healthcare,
    FedRAMP, RAG Builder, Pipeline Designer, Lakehouse Inspector,
    Data Steward, FinOps, Fabric Mirror — installs bundled items with
    rich starter content drawn from `examples/<industry>/`. Notebook
    cells, KQL queries, dbt models, dashboard tiles, semantic models,
    activator rules, OKR scorecards, AI Search index schemas — all
    populated, no placeholders.

    *5,903 lines of substantive starter content across 10 bundle
    modules.* Backed by `<BundleContentBar>` in the editor chrome,
    which surfaces the content via per-kind tab views (Cells / DDL /
    Tiles / dbt models / Glossary / etc.).

    [:octicons-arrow-right-24: Test it](../TEST_SCRIPT_2026_05_27.md)

-   :material-cursor-default-click-outline: **Ribbon header buttons wired**

    Every editor's header bar (the strip under the **Home** tab) is now
    functional. 82 ribbons across 18 editor files were converted from
    static module-scope constants to in-component `useMemo` factories
    that bind each action to the real inline handler. Where no handler
    exists yet (deferred features, missing BFF routes), the button stays
    disabled with an explicit `title` tooltip explaining why — per
    the no-vaporware rule, no silent dead buttons remain.

    *175 actions wired with `onClick`. 111 honestly disabled with
    explanatory tooltips.*

    [:octicons-arrow-right-24: Test it](../TEST_SCRIPT_2026_05_27.md)

-   :material-server-network: **Compute lifecycle UI**

    A shared `<ComputePicker>` component lists every available compute
    target (Synapse Spark, Databricks cluster, Synapse Dedicated SQL
    pool, Synapse Serverless SQL) with a state badge (Running / Paused /
    Stopped). When the selected target is paused, an inline **Resume**
    button appears. **Pause** + **Restart** appear when applicable.
    Hooked into the `dbt-job`, `warehouse`, `synapse-dedicated-sql-pool`,
    `synapse-spark-pool`, `ml-model`, and `ml-experiment` editors.

    New BFF route `POST /api/loom/compute-targets/[id]/[verb]` routes
    start / stop / restart to Databricks REST or Synapse ARM by id
    prefix.

    [:octicons-arrow-right-24: Test it](../TEST_SCRIPT_2026_05_27.md)

-   :material-form-select: **Backing-service pickers replace free-text Inputs**

    Nine editors that previously asked the user to paste an Azure
    resource name into a free-text field now show a `Select` dropdown
    populated by a real BFF route. Affected: CopyJob (linked services),
    DbtJob (workspace disclosure), Eventstream (workspace), UDF
    (Function Apps via ARM), AzureSqlDatabase (server + db cascading),
    SqlServer2025VectorIndex (same), GeoDataset (ADLS container),
    GeoPipeline (ADF pipeline), DataProductTemplate (workspace).

    Every picker shows a `MessageBar` with explicit remediation copy
    when the underlying ARM / Cosmos call returns empty or 401 / 403
    — exact env var, role grant, or bicep module needed.

    [:octicons-arrow-right-24: Test it](../TEST_SCRIPT_2026_05_27.md)

-   :material-code-tags-check: **Monaco editor self-hosted + worker CSP unblocked**

    Monaco's AMD loader and language workers are now served from
    `/monaco/vs` (copied at build time by
    `scripts/copy-monaco-assets.mjs`). CSP loosened to permit
    `blob:` and `data:` in `script-src`, `worker-src`, and `child-src`
    so the JSON / TypeScript / KQL workers initialize cleanly.

    Fixes the seven Monaco-bearing editors that were silently broken
    by `cdn.jsdelivr.net` being CSP-blocked: warehouse, synapse SQL
    serverless + dedicated, kql-database, eventstream, azure-sql-db,
    databricks-sql-warehouse.

    [:octicons-arrow-right-24: Test it](../TEST_SCRIPT_2026_05_27.md)

-   :material-page-layout-header: **Activator workspace dropdown corrected**

    `<WorkspacePicker>` in the shared Power BI / Fabric editor file
    fetches `/api/loom/workspaces` (Cosmos catalog) instead of
    `/api/powerbi/workspaces` (Power BI tenant groups). Drops the
    misleading `· F/P SKU` suffix on every entry that read to users
    as if the dropdown was listing capacity SKUs.

    [:octicons-arrow-right-24: Test it](../TEST_SCRIPT_2026_05_27.md)

</div>

## Smoke verdict against live

Captured via the automated probes at `apps/fiab-console/tests/`:

| Probe | Coverage | Result |
|---|---|---|
| `apps-install-e2e.mjs` | All 10 apps install + second-install idempotency | **10 / 10 PASS** |
| `editors-render-smoke.mjs` | Each of 85 editor types: Cosmos item create + `/items/[type]/[id]` page load + `/api/cosmos-items/...` hydrate | **85 / 85 PASS** |
| `service-health.mjs` | 23 BFF endpoints across 12 Azure service families | **23 / 23 GREEN** |
| `walkthrough.mjs` | 30 top-level pages + 18 editor surfaces via Playwright | **46 / 48 PASS** |

The two remaining walkthrough failures are documented in [Known
gaps](#known-gaps-as-of-this-release).

## Test it yourself

The end-to-end manual test script is [TEST_SCRIPT_2026_05_27.md](../TEST_SCRIPT_2026_05_27.md).
Walk it section by section against the live URL. Each check is a
single-line pass / fail with explicit next-step actions on failure.

Run the automated probes locally with a session cookie minted from
the Key Vault secret:

```powershell
# From any workstation with az login + reader on kv-loom-m56yejezt7bjo
$env:SESSION_SECRET = (
  az keyvault secret show `
    --vault-name kv-loom-m56yejezt7bjo `
    --name loom-session-secret `
    --query value -o tsv
)
node apps/fiab-console/tests/apps-install-e2e.mjs
node apps/fiab-console/tests/editors-render-smoke.mjs
node apps/fiab-console/tests/service-health.mjs
node apps/fiab-console/tests/walkthrough.mjs   # requires Playwright + headless Chromium
```

## Known gaps as of this release

These are tracked separately and explicitly out of scope for the
2026-05-27 cut:

1. **`/onelake` Front Door WAF partial fix only.** The diagnosis was
   right — DRS rule 921180 (HTTP Parameter Pollution) flagged the
   multi-value `?type=A&type=B&...` query the page emitted on load.
   Switching to comma-separated `?types=A,B,C` reduces that rule's
   trigger but the Bot Manager rule set still flags the initial
   request burst when the page renders. Resolution needs Front Door
   diagnostic log analysis from FedCiv DLZ Log Analytics. Until then
   the page shows mostly-empty with seven console 403s. Investigation
   notes at `temp/onelake-403-investigation.md`.

2. **Monaco JSON language worker URL on `/items/eventstream/new`.**
   `scripts/copy-monaco-assets.mjs` only copies `monaco-editor/min/vs`.
   The JSON / TS / CSS language workers live in a separate subdirectory
   and aren't yet served from `/monaco/vs/language/...`. Two paths:
   extend the copy script to include language workers, or move the
   eventstream JSON view onto plaintext Monaco.

3. **Phase 2 — real backing-service provisioning at install time.**
   Today's apps install seeds Cosmos `state.content` with rich starter
   templates. It does NOT yet create the real Fabric notebook in a
   Fabric workspace, provision an ADX KQL DB with ingested sample
   rows, push documents into AI Search, deploy the dbt project to a
   Fabric warehouse, or any other live-resource side-effect. That is
   a separate multi-PR initiative tracked as task #134.

## What the validator workflow now checks

`.claude/workflows/fabric-parity-loop.md` gained a **Phase 4.6** —
ribbon, compute, and backing-service wiring checks. Future PRs that
regress any of the patterns shipped today will be flagged by the
validator with a `MAJOR` or `BLOCKER` verdict, depending on severity:

- Dead ribbon button (no `onClick`, no honest `title`) → MAJOR
- Compute editor missing picker, state badge, or resume affordance → MAJOR / BLOCKER
- Free-text `Input` where the user must paste an Azure resource name → BLOCKER
- Run action against a paused compute target with no Resume disclosure → BLOCKER

Reference picker implementation: `apps/fiab-console/lib/components/compute-picker.tsx`.

## Operator chain (how the PRs deployed)

For every PR merged to `main` today the operator chain was:

1. `gh api -X PUT repos/.../pulls/<n>/merge -f merge_method=squash`
2. Open ACR public network: `az acr update --name acrloomm56yejezt7bjo --public-network-enabled true --default-action Allow`
3. Dispatch build: `gh workflow run build-fiab-images.yml --ref main`
4. Wait for `success`, then re-lock ACR: `az acr update --name acrloomm56yejezt7bjo --public-network-enabled false`
5. Roll container app to the new SHA: `az containerapp update -n loom-console -g rg-csa-loom-admin-eastus2 --image acrloomm56yejezt7bjo.azurecr.io/loom-console:<sha>`
6. Verify revision: `az containerapp revision show ... --query "{health:properties.healthState,running:properties.runningState}"`

The SP `95ca491e-f841-43ba-93f2-3315804f55e7` (`limitlessdata_deploy`)
secret was rotated once during the chain when the cached value
expired. The new secret was pushed to the GitHub secret
`AZURE_CLIENT_SECRET` via `gh secret set` — never written to disk.

## Reference

- **Live URL:** [https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net](https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net)
- **Test script:** [TEST_SCRIPT_2026_05_27.md](../TEST_SCRIPT_2026_05_27.md)
- **Editor audit (input to the ribbon-wiring sweep):** `temp/editor-audit-2026-05-27.md`
- **/onelake WAF investigation:** `temp/onelake-403-investigation.md`
- **Validator update:** [`.claude/workflows/fabric-parity-loop.md`](https://github.com/fgarofalo56/csa-inabox/blob/main/.claude/workflows/fabric-parity-loop.md) — Phase 4.6 section
