# Tutorial: Data quality editor

> CSA Loom `data-quality` editor — a workspace-scoped run configuration over the
> shared Data Quality Rule Engine. Pin a backend (**Azure Data Explorer**,
> **Databricks SQL**, or **Synapse SQL**) plus a target, run your tenant's
> enabled rules against live data, and read a composite scorecard, per-rule
> breakdown, and persisted run history. Azure-native — **no Microsoft Fabric**.

## What it is

Rules live centrally in **Governance → Data quality** (not-null, unique, range,
regex, freshness). This item is the *runner*: it decides **where** those rules
execute and **against what**, then keeps the scorecard and history with the item
so a workspace has a durable quality record.

Four tabs — the last two appear when the N7d depth flag is on:

| Tab | What it does |
|---|---|
| **Run** | Backend + target configuration, and the live scorecard |
| **History** | Every run persisted with the item (newest first, up to 50) |
| **Runner checks** | Rule-builder checks executed on the transform runner with anomaly baselines |
| **Data diff** | Exact changed cells / added rows / removed rows between two Delta versions |

## When to use it

- You need a repeatable quality score for a workspace's tables that survives
  page reloads and is auditable.
- You need to compare a table before and after a pipeline run and see exactly
  which cells changed.
- If the promise belongs to a *product*, author it as a `data-contract` instead —
  that enforces at publish time. This item measures.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Data quality**, then **Create
   data-quality check**.
2. **Pick the backend.** In **Backend & target**, choose **Azure Data
   Explorer**, **Databricks SQL**, or **Synapse SQL**. The remaining fields
   change to match:
   - **ADX** — *ADX database* (blank defaults to the deployment's database).
   - **Databricks** — *SQL warehouse id* (defaults to
     `LOOM_DATABRICKS_SQL_WAREHOUSE_ID`), *Catalog*, *Schema*.
   - **Synapse** — *Pool* (`Serverless` / `Dedicated`) and *Database*
     (serverless defaults to `master`).
3. **Narrow the scope (optional).** **Table filter** takes a comma-separated
   list; blank means every enabled rule runs.
4. **Run the checks.** **Run quality checks** (also **Run checks** in the
   ribbon) saves any pending edits first, then executes the tenant's enabled
   rules against the live backend.
5. **Read the scorecard.** The card shows the composite score as a large
   percentage with a colour-coded progress gauge (green at 90+, amber at 70+,
   red below), a status badge (`passed` / `failed` / `no rules` / `errored`),
   passing and failing counts, and the backend, target, and timestamp. Beneath
   it, the per-rule breakdown table lists rule, check, scope, the measured
   percentage, a detail string, and pass/fail/error.
6. **Review history.** **History** shows every run: when, backend, target,
   score, `passing/total` rules, and status. Runs are persisted with the item,
   newest first, up to 50 retained.
7. **Build runner checks (N7d).** The **Runner checks** tab lets you assemble
   checks from dropdowns only — the vocabulary is the same `QUALITY_RULES` set
   the data-contract designer uses — and executes them on the **transform
   runner** with anomaly baselines. Findings are emitted to the incident console.
8. **Diff two versions (N7d).** The **Data diff** tab takes two sides (two Delta
   versions of a table, or two environments / paths) and returns the exact
   changed cells, added rows, and removed rows. DuckDB reconstructs each side's
   active Parquet file set from `_delta_log` and reads it in place — nothing is
   copied. Optionally emit a `data-diff` finding to the incident console.

## The Azure backend it rides on

- **Rule execution:** your chosen backend — **Azure Data Explorer** (KQL),
  **Databricks SQL** (a real warehouse), or **Synapse SQL** (serverless or
  dedicated) — through the shared data-quality client.
- **Rule definitions:** the tenant rule set managed at
  **Governance → Data quality**.
- **Runner checks:** the transform runner.
- **Data diff:** the in-boundary **DuckDB** engine reading Delta `_delta_log` +
  Parquet in place on your own ADLS Gen2 — IL5-disconnected, nothing copied.
- **Persistence:** the item's own state holds the run history.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| Chosen backend not configured | Warning MessageBar *"&lt;backend&gt; backend not configured"* naming the **exact** env var to set | Set the named variable on the `loom-console` env, or select a different backend |
| No enabled rules match the target | Status `no rules` with an info MessageBar | Add rules in **Governance → Data quality**, then run again |
| Run fails | Error MessageBar with the error and the backend's hint when one is returned | Follow the hint (usually a grant or an unreachable target) |
| `n7d-data-quality-diff` flag off | The **Runner checks** and **Data diff** tabs are hidden; Run and History are unaffected | Re-enable the flag in **Admin → Runtime flags** |

## No Fabric required

ADX / Databricks / Synapse / DuckDB, all Azure-native. No Fabric capacity,
workspace, OneLake path, or Power BI workspace is used on any path.

## Learn more

- Data contract editor tutorial: `editor-data-contract.md`
- Parity source: `docs/fiab/parity/data-quality-run-results.md`
- Azure Data Explorer: <https://learn.microsoft.com/azure/data-explorer/>
