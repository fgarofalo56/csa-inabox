# Semantic Link in CSA Loom notebooks (`loom_semantic_link`)

Read a Loom **semantic model** into pandas and pull **DAX-evaluated measures** —
the notebook-facing equivalent of Microsoft Fabric's `sempy.fabric`
("Semantic Link"), with **zero Power BI / Fabric dependency**. Every call reaches
the CSA Loom Console BFF, which evaluates against the Azure-native tabular backend
(Synapse serverless SQL by default; Azure Analysis Services when opted in).

The helper is available automatically in a fresh notebook Spark session (it is
injected as a session preamble; set `LOOM_SEMANTIC_LINK=0` to opt out) and on AML
compute instances via the curated `loom-pylsp-env` environment. On any other
kernel, `import loom_semantic_link`.

## Environment

| Variable | Meaning |
|---|---|
| `LOOM_CONSOLE_BASE_URL` | CSA Loom Console origin (e.g. `https://csa-loom.example.com`) |
| `LOOM_SESSION_TOKEN` | your minted Loom session token (set by the notebook environment) |
| `LOOM_SEMANTIC_LINK_TIMEOUT` | per-request timeout seconds (default 90) |

## Quickstart

```python
# model_id is the semantic-model item id (from the model's URL).
model_id = "sm-1234"

# 1) Inspect the model.
list_tables(model_id)         # [{name, columns:[{name,dataType}], measureNames}]
list_measures(model_id)       # [{name, table, expression, formatString?}]
list_relationships(model_id)  # [{fromTable, fromColumn, toTable, toColumn, cardinality, active}]

# 2) Read a table into a semantic-lineage-aware DataFrame.
df = read_table(model_id, "Sales", top_n=1000)   # -> LoomDataFrame
df.head()

# 3) Pull a measure into a column (grand total broadcast to every row).
df = df.add_measure("Total Sales")               # uses df's model_id
df[["OrderId", "Total Sales"]].head()

# 4) Group a measure by keys (AAS backend required for grouped evaluation).
evaluate_measure(model_id, "Total Sales", groupby=["Customer[Country]"])

# 5) Run ad-hoc DAX.
evaluate_dax(model_id, "EVALUATE TOPN(10, Sales)")

# 6) Validate relationships (flags broken/missing ones).
report = validate_relationships(model_id)
report["ok"], report["issues"]
```

## Notes

- `add_measure` with **no** `groupby` evaluates the measure to a single value and
  broadcasts it (SemPy semantics). With `groupby` it merges the grouped result —
  grouped evaluation requires the opt-in AAS backend
  (`LOOM_SEMANTIC_BACKEND=analysis-services`); the loom-native Synapse backend
  raises an honest `LoomSemanticLinkError` for unsupported patterns rather than
  returning a fake result.
- `LoomDataFrame` is a `pandas.DataFrame` subclass — every pandas operation works,
  and the frame remembers the model it came from (`df.model_id`).
- All access is owner-scoped: you can only read models you own.
