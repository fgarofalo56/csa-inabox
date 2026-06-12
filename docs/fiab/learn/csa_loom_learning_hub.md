# Learning Hub — notebook import wizard

The **Learning Hub** (`/learn`) is the CSA Loom learning portal: a searchable,
filterable catalogue of every tutorial, per-editor guide, and service guide,
plus the **one-click hands-on actions** that drop a ready-to-run scenario into a
real workspace. The headline hands-on action is the **notebook import wizard** —
"Import notebook" in the *Start hands-on in a workspace* band.

This page documents that wizard: its three inputs, the
**with / without sample data** semantics, and how the import resolves to a real
Azure data engine in every cloud. Like everything else in Loom, the wizard is
Azure-native by default and **never requires a real Microsoft Fabric tenant**
(see [no-fabric-dependency](../parity/learning-hub-copilot.md) policy).

## What the wizard does

Pick a prebuilt notebook from the app content bundles, pick the workspace to
import it into, and choose whether to also seed real sample data. On **Import**
the wizard:

1. Creates the chosen notebook as a real Cosmos workspace item, fully populated
   with its cells (it opens ready to run — no empty canvas).
2. *(optional)* When you choose **with sample data**, creates the bundle's
   sample-data lakehouse(s) and auto-attaches them to the notebook as data
   sources.
3. Runs the **existing provisioning engine** — the same one the app-install
   dialog uses — which dispatches the notebook provisioner (and, when seeding,
   the lakehouse provisioner) against your live Azure backend.
4. Renders the returned **provision report**: a per-step status badge
   (`created` / `exists` / `remediation` / `failed`), the Azure resource id,
   an honest remediation gate where infrastructure is missing, and an
   expandable step-log — identical affordances to the app-install dialog.

The wizard is a guided Fluent dialog with **dropdowns and a fixed radio group**
— never a raw-JSON config surface — per the Loom no-freeform-config standard.

## The three inputs

| Input | Source | Notes |
|-------|--------|-------|
| **Workspace** | `GET /api/workspaces` | A dropdown of the workspaces you own. If you have exactly one it is preselected. If you have none, a MessageBar links you to `/workspaces` to create one. The import route re-verifies ownership server-side (`workspaceId` + your `oid`) before writing anything. |
| **Notebook** | `GET /api/learn/notebook-import` | A dropdown of every prebuilt notebook across the in-process app content bundles, labelled `<notebook> · <bundle>` with its cell count. Picking one shows its description and item-type badge (`notebook`, `databricks-notebook`, or `synapse-notebook`). |
| **Sample data** | fixed two-choice radio | **With sample data** seeds the matching lakehouse tables; **Without sample data** imports the notebook only. The "with" option is auto-disabled (and the choice forced to "without") for bundles that ship no seedable tables — surfaced with an info MessageBar so the choice is never a dead control. |

## With vs. without sample data

**Without sample data** — only the notebook item is created and provisioned.
Nothing touches ADLS. Use this when you already have data in the workspace's
lakehouse, or you just want the notebook's code to read.

**With sample data** — in addition to the notebook, the wizard creates the
bundle's sample-data lakehouse item(s) and provisions them. The lakehouse
provisioner's Azure-native path writes the bundle's real `sampleRows` as CSVs
into the **DLZ ADLS Gen2 container** (`Tables/<name>/<name>.csv`) and, when a
Synapse workspace is configured, registers serverless `OPENROWSET` views over
them in a `[loom_lakehouse]` user database. The seeded lakehouse(s) are then
**auto-attached** to the notebook, so it opens with its data sources wired and
its first read cell returns rows immediately. No Fabric, no OneLake — real
ADLS Gen2 the notebook (Synapse or Databricks) can read directly.

## Per-cloud backend resolution

The import calls **no new env vars** — it consumes the same variables the DLZ
and admin-plane bicep already emit (`LOOM_SYNAPSE_WORKSPACE`,
`LOOM_DATABRICKS_HOSTNAME`, the ADLS landing/bronze URLs). The notebook
provisioner resolves a backend in this order; the first configured one wins:

1. **Azure Synapse Spark notebook** — when `LOOM_SYNAPSE_WORKSPACE` is set.
   Real Synapse Studio notebook artifact via the dev plane:
   `PUT https://{ws}.dev.azuresynapse.net/notebooks/{name}?api-version=2020-12-01`.
   In sovereign clouds the dev-endpoint suffix differs (e.g.
   `.dev.azuresynapse.azure.us` for Azure Government); the URL is derived from
   the cloud, not hard-coded. A 401/403 gates with the **Synapse Artifact
   Publisher** role grant required.
2. **Azure Databricks notebook** — when `LOOM_DATABRICKS_HOSTNAME` is set and
   Synapse is not. Real `POST /api/2.0/workspace/import` (SOURCE format,
   `overwrite=true`) landing the notebook under `/Shared/loom-installs/`. The
   gate names the UAMI SCIM bootstrap + `CAN MANAGE` requirement.
3. **Microsoft Fabric notebook** — **opt-in only.** Used solely when
   `LOOM_NOTEBOOK_BACKEND=fabric` **and** a Fabric workspace is bound. Fabric
   is never required and is not available in sovereign clouds; the default path
   never reaches a Fabric host.

When **none** of these is configured, the wizard does not fail silently or
fabricate success — it shows an **honest remediation gate** naming the exact
env var to set (`LOOM_SYNAPSE_WORKSPACE` or `LOOM_DATABRICKS_HOSTNAME`), with a
Microsoft Learn link. Binding a Fabric workspace is offered only as an optional
alternative, never as the blocking requirement.

Sample-data seeding uses the **DLZ landing / bronze ADLS Gen2** URLs (real
ADLS Gen2 DFS PUT). Those URLs derive from `environment().suffixes.storage` in
bicep, so they are cloud-correct in Commercial and Gov alike. A 403 gates with
the **Storage Blob Data Contributor** role grant required.

## Where it lives in the UI

- **Trigger** — the **Import notebook** button in the *Start hands-on in a
  workspace* quick-action band at the top of `/learn`.
- **Component** — `apps/fiab-console/lib/learn/notebook-import-wizard.tsx`.
- **Route** — `apps/fiab-console/app/api/learn/notebook-import/route.ts`
  (`GET` lists notebooks; `POST` imports + provisions).
- **Provisioners** — `lib/install/provisioners/notebook.ts` (Synapse →
  Databricks → Fabric-opt-in) and `lib/install/provisioners/lakehouse.ts`
  (ADLS Gen2 sample-data seeding).

## Gateway-timeout handling

Live Azure provisioning can exceed the Front Door edge timeout. If the import
returns an HTML 502/504 instead of JSON, the wizard shows a precise message:
the notebook was created and provisioning may still be finishing — refresh the
workspace in a minute — rather than a raw error. This mirrors the app-install
dialog's tolerance.

## Related

- [Notebooks (Spark)](notebooks-spark.md) — the notebook editor itself.
- [Lakehouse shortcuts](lakehouse-shortcuts.md) — the lakehouse editor and
  ADLS Gen2 backing.
- [Deployment & BYO](deployment-and-byo.md) — wiring `LOOM_SYNAPSE_WORKSPACE` /
  `LOOM_DATABRICKS_HOSTNAME` for your deployment.
