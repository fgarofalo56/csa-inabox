# Tutorial: Synapse notebook editor

> CSA Loom `synapse-notebook` editor — the Synapse Studio-style Spark notebook
> designer: multi-language cells on a Synapse Big Data pool via **Livy**,
> authored over the Synapse dev plane. **No Microsoft Fabric required.**

## What it is

A Synapse notebook is the Spark authoring surface in Synapse Studio —
multi-language cells (PySpark, Spark Scala, Spark SQL, SparkR, .NET Spark C#)
run interactively on a Synapse Big Data pool via Livy. In Loom it reads/writes
the workspace notebook artifact over the Synapse dev plane and runs cells
against a live Livy session through the Console managed identity.

## When to use it

- Interactive Spark data engineering / exploration against the lake with the
  full Synapse cell model (per-cell language, parameters cell, outline).
- You want notebooks stored as real Synapse workspace artifacts (and backed up
  to ADLS), runnable later from pipelines.

## Step-by-step in Loom

1. **Open the editor.** Choose **+ New item → Notebook** and pick the
   **Synapse notebook** flavor (or open an existing one). The editor opens at
   `/items/synapse-notebook/<id>`.
2. **Attach a Spark pool.** Pick a Big Data pool from the attach picker; the
   first run cold-starts the session (about 2–3 minutes).
3. **Attach an environment (optional).** Pick a Spark configuration to apply
   library packages and Spark session settings to the pool — surfaced from the
   workspace's `sparkconfigurations`.
4. **Author cells.** Add code or markdown cells between any two cells, set the
   notebook default language and per-cell language, reorder, duplicate, and
   collapse cells in the designer.
5. **Mark a parameters cell.** Designate one code cell as the parameters cell
   so its variables can be overridden when the notebook runs from a pipeline
   (papermill / ADF).
6. **Navigate with the outline.** The left-panel outline tracks headings from
   markdown cells; click an entry to scroll to that cell.
7. **Run and inspect.** Run a cell or **Run all**; output and error tracebacks
   render inline from the Livy statement result.
8. **Publish.** **Save** publishes the notebook back to the Synapse workspace
   as an artifact and backs up the `.ipynb` to ADLS
   `silver/loom/notebooks/`.

## The Azure backend it rides on

- **Artifacts:** the Synapse **dev plane** (workspace notebook artifacts).
- **Execution:** **Livy** sessions on a Synapse Big Data pool via the Console
  managed identity.
- **Backup:** `.ipynb` copies to ADLS Gen2.

## No Fabric required

Authoring and execution are Synapse + ADLS; no Fabric capacity, workspace, or
OneLake is involved.

## Learn more

- Synapse notebooks:
  <https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks>
