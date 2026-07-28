# Tutorial: Transformation project editor

> CSA Loom `transformation-project` editor — model your warehouse with **dbt
> (default)** or **SQLMesh (opt-in)** from **one** engine-neutral model graph,
> with a Terraform-style **plan → impact diff → apply** wizard. Everything runs
> in your own VNet — **no Fabric, no dbt Cloud, no Tobiko Cloud**.

## What it is

One item holds one model graph. A **backend selector** decides which project
files get generated from it: dbt for continuity with an existing ecosystem, or
SQLMesh for virtual data environments, a real breaking / non-breaking plan, and
column-level model diff. Switching the engine changes only the generated files —
the graph itself is untouched, which is the whole point of shipping both.

Five tabs:

| Tab | What it does |
|---|---|
| **Build** | The guided model graph + engine selector |
| **Plan & apply** | Environment → impact-diff grid → apply wizard |
| **Model DAG** | The software-defined-asset canvas |
| **Generated files** | The real project files sent to the runner |
| **History** | Every plan previewed and every apply authorized |

## When to use it

- You already run dbt and want it hosted in-boundary with a governed plan step.
- You want SQLMesh's virtual environments and column-level diffs without
  rewriting your models for a new engine.
- You need an auditable record of who applied which change, to which
  environment, with what blast radius.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Transformation project**, then **Create
   transformation project**. A fresh item opens **clean** — guided empty states,
   no red banners. The honest runner gate only appears after an engine call is
   actually attempted.
2. **Pick the engine.** On **Build**, the engine selector offers **dbt**
   (default) or **SQLMesh**. You can flip it later; the graph carries over.
3. **Build the model graph.** Every control is a dropdown or picker: sources,
   models, **medallion layer**, **materialization** (defaulted from the layer),
   refresh cadence, `ref` dependencies, tests, owners, and tags. The **per-model
   SQL body is the one freeform surface** — edited in Monaco, the documented
   transformation-IDE exception to the no-freeform-config rule.
4. **Save.** The ribbon's **Save** persists the project to the item's state; the
   button reads **Saved** when there is nothing pending. Editing the graph
   invalidates any previewed plan, so you always plan against what you saved.
5. **Preview the impact.** Go to **Plan & apply** (three guided steps):
   1. **Environment** — pick the SQLMesh virtual data environment or the dbt
      target. The list comes from the engine's **own state store**, not a
      hard-coded set.
   2. **Impact** — the diff grid: model, change type, **breaking /
      non-breaking**, downstream blast radius, and the column-level changes.
      **Nothing has been written at this point.**
   3. **Apply** — SQLMesh performs the virtual-environment **view swap** and
      backfills only the intervals that need it. dbt runs `dbt build` over the
      modified models and their downstream, stated plainly. **Production
      requires an explicit second confirmation.**
6. **Read the DAG.** **Model DAG** renders the graph on the shared canvas kit,
   annotated with the current plan's impact so you can see the blast radius
   visually.
7. **Inspect what actually runs.** **Generated files** shows the real files for
   the selected engine — `dbt_project.yml` + `profiles.yml` + models for dbt, or
   `config.yaml` + `MODEL(...)` files for SQLMesh — and states plainly that this
   is exactly what the runner executes.
8. **Audit the record.** **History** lists every plan and apply: when, engine,
   environment, an impact summary (`N breaking`, `+added / ~modified / −removed`),
   who planned it, and whether it was applied, failed, or was preview-only.
   After a dbt apply Loom persists the deployed `manifest` / `catalog` artifacts
   so the **next** dbt plan diffs against what is genuinely deployed (dbt has no
   server-side state store of its own).

## The Azure backend it rides on

- **Runner:** the in-VNet transformation runner that executes the generated dbt
  or SQLMesh project against your warehouse.
- **Environments:** read from the engine's own state store via
  `POST /api/transform/<id>/environments`.
- **Plan history:** `GET /api/transform/<id>/history`.
- **Project state:** the item's own state document
  (`/api/items/transformation-project/<id>`), including the last dbt
  `manifest` / `catalog` used for diffing.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| Model graph incomplete | *"Finish the model graph first"* with the exact validation messages and a **Go to Build** action | Add at least one model on **Build** |
| No models yet (Files tab) | *"No project files yet"* explaining which files each engine generates | Add a model on **Build** |
| No plans yet (History tab) | *"No plans yet"* with a **Plan & apply** action | Run a plan |
| `n4-transform-plan-apply` flag off | **Plan & apply** and **Model DAG** show a guided notice; Build and Generated files keep working | Re-enable the flag on `/admin/runtime-flags` — no roll required |
| Runner unreachable | An error MessageBar appears **only after** an engine call actually fails | Check the runner's health and network path |

## No Fabric required

Both engines run in your own VNet against your own warehouse. No Fabric
capacity, workspace, OneLake path, dbt Cloud account, or Tobiko Cloud account is
required.

## Learn more

- dbt job editor tutorial: `editor-dbt-job.md`
- Warehouse editor tutorial: `editor-warehouse.md`
- Parity source: `docs/fiab/parity/transformation-project.md`
