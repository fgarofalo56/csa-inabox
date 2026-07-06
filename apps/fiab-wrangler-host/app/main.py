"""CSA Loom — Data Wrangler pandas host (Container App).

Azure-native 1:1 for Microsoft Fabric's **Data Wrangler** (the notebook-based,
visual data-prep tool that applies a gallery of cleaning operations to a
DataFrame sample and generates pandas / PySpark code). Microsoft Learn:
  https://learn.microsoft.com/fabric/data-science/data-wrangler
  https://learn.microsoft.com/fabric/data-science/data-wrangler-spark

No Microsoft Fabric dependency: this is a plain FastAPI + pandas service. The
Console's Data Wrangler panel POSTs a DATA SAMPLE ({columns, rows}) plus an
ordered list of structured transform STEPS chosen from the operation gallery;
this service:
  1. materializes the sample into a real pandas DataFrame,
  2. applies each queued step (REAL pandas — no mock preview), and
  3. generates the equivalent **pandas AND PySpark** code so the panel can
     export it into a notebook cell (Fabric parity: the sample drives the live
     preview, the generated code runs on the user's full DataFrame).

Security posture (documented honestly): the operation gallery is a CLOSED set —
this service runs NO arbitrary user code (there is no `eval`/`exec` of a
user-supplied expression). It also touches NO Azure data plane: the sample is
in the request, the result in the response. The assigned managed identity
therefore needs only AcrPull. Internal ingress only; the Console BFF is the
sole caller over the CAE VNet.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="loom-wrangler-host", version="1.0.0")

# Guardrails on the sample the panel sends (defense-in-depth; the panel already
# samples). These mirror Fabric's "sample for preview" model — the wrangler
# never processes the full dataset, only a bounded sample.
MAX_ROWS = 5000
MAX_COLS = 512
MAX_STEPS = 100


# ── Request / response models ────────────────────────────────────────────────
class TransformRequest(BaseModel):
    columns: list[str] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    steps: list[dict[str, Any]] = Field(default_factory=list)
    # DataFrame variable name the generated code operates on (Fabric uses `df`).
    df_var: str = "df"
    out_var: str = "df_clean"


class StepResult(BaseModel):
    index: int
    op: str
    ok: bool
    error: str | None = None


class ColumnSummary(BaseModel):
    name: str
    dtype: str
    missing: int
    unique: int


class TransformResponse(BaseModel):
    ok: bool
    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int
    summary: list[ColumnSummary]
    steps: list[StepResult]
    code: dict[str, str]  # { "pandas": "...", "pyspark": "..." }
    error: str | None = None


# ── Health ───────────────────────────────────────────────────────────────────
@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.get("/health")
def health() -> dict[str, bool]:  # alias — some probes hit /health
    return {"ok": True}


@app.get("/operations")
def operations() -> dict[str, Any]:
    """The closed operation gallery — the panel renders this list."""
    return {"ok": True, "operations": OPERATION_CATALOG}


# ── Operation gallery (the closed set — grounds the panel's gallery) ──────────
# Each entry documents the op id, label, category, and the parameter fields the
# panel collects. Kept in sync with the appliers + code generators below.
OPERATION_CATALOG: list[dict[str, Any]] = [
    {"op": "drop_columns", "label": "Drop columns", "category": "Schema",
     "fields": [{"name": "columns", "type": "columns", "label": "Columns"}]},
    {"op": "select_columns", "label": "Keep columns", "category": "Schema",
     "fields": [{"name": "columns", "type": "columns", "label": "Columns to keep"}]},
    {"op": "rename_column", "label": "Rename column", "category": "Schema",
     "fields": [{"name": "column", "type": "column", "label": "Column"},
                {"name": "newName", "type": "text", "label": "New name"}]},
    {"op": "cast_type", "label": "Change type", "category": "Schema",
     "fields": [{"name": "column", "type": "column", "label": "Column"},
                {"name": "dtype", "type": "select", "label": "New type",
                 "options": ["int", "float", "str", "bool", "datetime"]}]},
    {"op": "filter_rows", "label": "Filter rows", "category": "Rows",
     "fields": [{"name": "column", "type": "column", "label": "Column"},
                {"name": "operator", "type": "select", "label": "Condition",
                 "options": ["eq", "ne", "gt", "ge", "lt", "le", "contains",
                             "startswith", "notnull", "isnull"]},
                {"name": "value", "type": "text", "label": "Value"}]},
    {"op": "sort", "label": "Sort", "category": "Rows",
     "fields": [{"name": "column", "type": "column", "label": "Column"},
                {"name": "ascending", "type": "bool", "label": "Ascending"}]},
    {"op": "drop_duplicates", "label": "Drop duplicate rows", "category": "Rows",
     "fields": [{"name": "columns", "type": "columns", "label": "Subset (optional)"}]},
    {"op": "drop_missing", "label": "Drop rows with missing values", "category": "Missing",
     "fields": [{"name": "columns", "type": "columns", "label": "Columns (optional)"},
                {"name": "how", "type": "select", "label": "Drop when",
                 "options": ["any", "all"]}]},
    {"op": "fill_missing", "label": "Fill missing values", "category": "Missing",
     "fields": [{"name": "column", "type": "column", "label": "Column"},
                {"name": "strategy", "type": "select", "label": "Strategy",
                 "options": ["value", "mean", "median", "mode", "ffill", "bfill"]},
                {"name": "value", "type": "text", "label": "Value (for 'value')"}]},
    {"op": "one_hot_encode", "label": "One-hot encode", "category": "Formulas",
     "fields": [{"name": "columns", "type": "columns", "label": "Columns"}]},
    {"op": "split_column", "label": "Split column by delimiter", "category": "Formulas",
     "fields": [{"name": "column", "type": "column", "label": "Column"},
                {"name": "delimiter", "type": "text", "label": "Delimiter"}]},
    {"op": "replace_text", "label": "Find and replace", "category": "Text",
     "fields": [{"name": "column", "type": "column", "label": "Column"},
                {"name": "find", "type": "text", "label": "Find"},
                {"name": "replace", "type": "text", "label": "Replace with"}]},
    {"op": "change_case", "label": "Change text case", "category": "Text",
     "fields": [{"name": "column", "type": "column", "label": "Column"},
                {"name": "mode", "type": "select", "label": "Case",
                 "options": ["lower", "upper", "title"]}]},
    {"op": "strip_whitespace", "label": "Trim whitespace", "category": "Text",
     "fields": [{"name": "column", "type": "column", "label": "Column"}]},
    {"op": "scale_minmax", "label": "Min-max scale", "category": "Numeric",
     "fields": [{"name": "column", "type": "column", "label": "Column"},
                {"name": "min", "type": "text", "label": "New min"},
                {"name": "max", "type": "text", "label": "New max"}]},
    {"op": "group_by", "label": "Group by and aggregate", "category": "Aggregate",
     "fields": [{"name": "by", "type": "columns", "label": "Group by"},
                {"name": "column", "type": "column", "label": "Aggregate column"},
                {"name": "func", "type": "select", "label": "Aggregation",
                 "options": ["sum", "mean", "min", "max", "count", "median"]}]},
]


# ── Helpers ──────────────────────────────────────────────────────────────────
def _s(v: Any) -> str:
    return "" if v is None else str(v)


def _pyrepr(v: Any) -> str:
    """Python literal repr for codegen (numbers stay bare, strings quoted)."""
    if v is None:
        return "None"
    if isinstance(v, bool):
        return "True" if v else "False"
    if isinstance(v, (int, float)):
        return repr(v)
    # try numeric coercion so filter value 5 renders as 5, not '5'
    sv = str(v)
    try:
        f = float(sv)
        return repr(int(f)) if f.is_integer() and "." not in sv else repr(f)
    except (ValueError, TypeError):
        return repr(sv)


def _collist(cols: Any) -> list[str]:
    if isinstance(cols, list):
        return [str(c) for c in cols]
    if cols in (None, ""):
        return []
    return [str(cols)]


_PANDAS_DTYPE = {"int": "'Int64'", "float": "float", "str": "str", "bool": "bool"}
_SPARK_DTYPE = {"int": "'int'", "float": "'double'", "str": "'string'",
                "bool": "'boolean'", "datetime": "'timestamp'"}


# ── Appliers: REAL pandas execution per op ───────────────────────────────────
def _apply(df: pd.DataFrame, step: dict[str, Any]) -> pd.DataFrame:
    op = step.get("op")
    if op == "drop_columns":
        cols = [c for c in _collist(step.get("columns")) if c in df.columns]
        return df.drop(columns=cols)
    if op == "select_columns":
        cols = [c for c in _collist(step.get("columns")) if c in df.columns]
        return df[cols] if cols else df
    if op == "rename_column":
        return df.rename(columns={step["column"]: step["newName"]})
    if op == "cast_type":
        col, dtype = step["column"], step.get("dtype", "str")
        if dtype == "datetime":
            df[col] = pd.to_datetime(df[col], errors="coerce")
        elif dtype == "int":
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
        elif dtype == "float":
            df[col] = pd.to_numeric(df[col], errors="coerce")
        elif dtype == "bool":
            df[col] = df[col].astype("bool")
        else:
            df[col] = df[col].astype("str")
        return df
    if op == "filter_rows":
        return _filter(df, step)
    if op == "sort":
        asc = step.get("ascending", True)
        asc = asc if isinstance(asc, bool) else str(asc).lower() != "false"
        return df.sort_values(by=step["column"], ascending=asc)
    if op == "drop_duplicates":
        subset = [c for c in _collist(step.get("columns")) if c in df.columns] or None
        return df.drop_duplicates(subset=subset)
    if op == "drop_missing":
        subset = [c for c in _collist(step.get("columns")) if c in df.columns] or None
        how = step.get("how", "any")
        return df.dropna(subset=subset, how=how if how in ("any", "all") else "any")
    if op == "fill_missing":
        return _fill(df, step)
    if op == "one_hot_encode":
        cols = [c for c in _collist(step.get("columns")) if c in df.columns]
        return pd.get_dummies(df, columns=cols) if cols else df
    if op == "split_column":
        col, delim = step["column"], step.get("delimiter", ",")
        parts = df[col].astype("str").str.split(delim, expand=True)
        parts.columns = [f"{col}_{i + 1}" for i in range(parts.shape[1])]
        return pd.concat([df, parts], axis=1)
    if op == "replace_text":
        col = step["column"]
        df[col] = df[col].astype("str").str.replace(
            _s(step.get("find")), _s(step.get("replace")), regex=False)
        return df
    if op == "change_case":
        col, mode = step["column"], step.get("mode", "lower")
        fn = {"lower": str.lower, "upper": str.upper, "title": str.title}.get(mode, str.lower)
        df[col] = df[col].astype("str").map(fn)
        return df
    if op == "strip_whitespace":
        col = step["column"]
        df[col] = df[col].astype("str").str.strip()
        return df
    if op == "scale_minmax":
        return _scale(df, step)
    if op == "group_by":
        by = [c for c in _collist(step.get("by")) if c in df.columns]
        col, func = step.get("column"), step.get("func", "sum")
        if not by or not col:
            return df
        return df.groupby(by, as_index=False)[col].agg(func)
    raise ValueError(f"unknown operation '{op}'")


def _filter(df: pd.DataFrame, step: dict[str, Any]) -> pd.DataFrame:
    col, opr = step["column"], step.get("operator", "eq")
    raw = step.get("value")
    if opr == "notnull":
        return df[df[col].notna()]
    if opr == "isnull":
        return df[df[col].isna()]
    if opr in ("contains", "startswith"):
        s = df[col].astype("str")
        mask = s.str.contains(_s(raw), regex=False) if opr == "contains" else s.str.startswith(_s(raw))
        return df[mask]
    # numeric-aware comparison
    val: Any = raw
    series = df[col]
    try:
        val = float(raw)
        series = pd.to_numeric(df[col], errors="coerce")
    except (ValueError, TypeError):
        val = _s(raw)
        series = df[col].astype("str")
    cmp = {"eq": series == val, "ne": series != val, "gt": series > val,
           "ge": series >= val, "lt": series < val, "le": series <= val}
    return df[cmp.get(opr, series == val)]


def _fill(df: pd.DataFrame, step: dict[str, Any]) -> pd.DataFrame:
    col, strat = step["column"], step.get("strategy", "value")
    if strat == "value":
        df[col] = df[col].fillna(step.get("value"))
    elif strat == "mean":
        num = pd.to_numeric(df[col], errors="coerce").astype("float64")
        df[col] = num.fillna(num.mean())
    elif strat == "median":
        num = pd.to_numeric(df[col], errors="coerce").astype("float64")
        df[col] = num.fillna(num.median())
    elif strat == "mode":
        m = df[col].mode()
        if not m.empty:
            df[col] = df[col].fillna(m.iloc[0])
    elif strat == "ffill":
        df[col] = df[col].ffill()
    elif strat == "bfill":
        df[col] = df[col].bfill()
    return df


def _scale(df: pd.DataFrame, step: dict[str, Any]) -> pd.DataFrame:
    col = step["column"]
    try:
        lo, hi = float(step.get("min", 0)), float(step.get("max", 1))
    except (ValueError, TypeError):
        lo, hi = 0.0, 1.0
    s = pd.to_numeric(df[col], errors="coerce")
    rng = s.max() - s.min()
    df[col] = lo if rng == 0 else lo + (s - s.min()) * (hi - lo) / rng
    return df


# ── Code generators: pandas + PySpark per op ─────────────────────────────────
def _pandas_line(step: dict[str, Any], v: str) -> list[str]:
    op = step.get("op")
    if op == "drop_columns":
        return [f"    {v} = {v}.drop(columns={_collist(step.get('columns'))!r})"]
    if op == "select_columns":
        return [f"    {v} = {v}[{_collist(step.get('columns'))!r}]"]
    if op == "rename_column":
        return [f"    {v} = {v}.rename(columns={{{step['column']!r}: {step['newName']!r}}})"]
    if op == "cast_type":
        col, dt = step["column"], step.get("dtype", "str")
        if dt == "datetime":
            return [f"    {v}[{col!r}] = pd.to_datetime({v}[{col!r}], errors='coerce')"]
        if dt in ("int", "float"):
            cast = ".astype('Int64')" if dt == "int" else ""
            return [f"    {v}[{col!r}] = pd.to_numeric({v}[{col!r}], errors='coerce'){cast}"]
        return [f"    {v}[{col!r}] = {v}[{col!r}].astype({_PANDAS_DTYPE.get(dt, 'str')})"]
    if op == "filter_rows":
        return [f"    {v} = {v}[{_pandas_mask(step, v)}]"]
    if op == "sort":
        return [f"    {v} = {v}.sort_values(by={step['column']!r}, ascending={bool(step.get('ascending', True))})"]
    if op == "drop_duplicates":
        sub = _collist(step.get("columns"))
        arg = f"subset={sub!r}" if sub else ""
        return [f"    {v} = {v}.drop_duplicates({arg})"]
    if op == "drop_missing":
        sub = _collist(step.get("columns"))
        args = []
        if sub:
            args.append(f"subset={sub!r}")
        args.append(f"how={step.get('how', 'any')!r}")
        return [f"    {v} = {v}.dropna({', '.join(args)})"]
    if op == "fill_missing":
        return _pandas_fill(step, v)
    if op == "one_hot_encode":
        return [f"    {v} = pd.get_dummies({v}, columns={_collist(step.get('columns'))!r})"]
    if op == "split_column":
        col, d = step["column"], step.get("delimiter", ",")
        return [f"    {v}[[c for c in ({v}[{col!r}].astype('str').str.split({d!r}, expand=True)"
                f".add_prefix({col + '_'!r})).columns]] = {v}[{col!r}].astype('str').str.split({d!r}, expand=True)"]
    if op == "replace_text":
        col = step["column"]
        return [f"    {v}[{col!r}] = {v}[{col!r}].astype('str').str.replace({_s(step.get('find'))!r}, {_s(step.get('replace'))!r}, regex=False)"]
    if op == "change_case":
        col, mode = step["column"], step.get("mode", "lower")
        meth = {"lower": "lower", "upper": "upper", "title": "title"}.get(mode, "lower")
        return [f"    {v}[{col!r}] = {v}[{col!r}].astype('str').str.{meth}()"]
    if op == "strip_whitespace":
        col = step["column"]
        return [f"    {v}[{col!r}] = {v}[{col!r}].astype('str').str.strip()"]
    if op == "scale_minmax":
        col = step["column"]
        lo, hi = _pyrepr(step.get("min", 0)), _pyrepr(step.get("max", 1))
        return [f"    _s = pd.to_numeric({v}[{col!r}], errors='coerce')",
                f"    {v}[{col!r}] = {lo} + (_s - _s.min()) * ({hi} - {lo}) / (_s.max() - _s.min())"]
    if op == "group_by":
        by, col, func = _collist(step.get("by")), step.get("column"), step.get("func", "sum")
        return [f"    {v} = {v}.groupby({by!r}, as_index=False)[{col!r}].agg({func!r})"]
    return [f"    # (unsupported op {op!r} skipped)"]


def _pandas_mask(step: dict[str, Any], v: str) -> str:
    col, opr, raw = step["column"], step.get("operator", "eq"), step.get("value")
    if opr == "notnull":
        return f"{v}[{col!r}].notna()"
    if opr == "isnull":
        return f"{v}[{col!r}].isna()"
    if opr == "contains":
        return f"{v}[{col!r}].astype('str').str.contains({_s(raw)!r}, regex=False)"
    if opr == "startswith":
        return f"{v}[{col!r}].astype('str').str.startswith({_s(raw)!r})"
    sym = {"eq": "==", "ne": "!=", "gt": ">", "ge": ">=", "lt": "<", "le": "<="}.get(opr, "==")
    return f"{v}[{col!r}] {sym} {_pyrepr(raw)}"


def _pandas_fill(step: dict[str, Any], v: str) -> list[str]:
    col, strat = step["column"], step.get("strategy", "value")
    if strat == "value":
        return [f"    {v}[{col!r}] = {v}[{col!r}].fillna({_pyrepr(step.get('value'))})"]
    if strat in ("mean", "median"):
        return [f"    _num = pd.to_numeric({v}[{col!r}], errors='coerce').astype('float64')",
                f"    {v}[{col!r}] = _num.fillna(_num.{strat}())"]
    if strat == "mode":
        return [f"    {v}[{col!r}] = {v}[{col!r}].fillna({v}[{col!r}].mode().iloc[0])"]
    return [f"    {v}[{col!r}] = {v}[{col!r}].{strat}()"]  # ffill / bfill


def _spark_line(step: dict[str, Any], v: str) -> list[str]:
    op = step.get("op")
    if op == "drop_columns":
        cols = ", ".join(repr(c) for c in _collist(step.get("columns")))
        return [f"    {v} = {v}.drop({cols})"]
    if op == "select_columns":
        cols = ", ".join(repr(c) for c in _collist(step.get("columns")))
        return [f"    {v} = {v}.select({cols})"]
    if op == "rename_column":
        return [f"    {v} = {v}.withColumnRenamed({step['column']!r}, {step['newName']!r})"]
    if op == "cast_type":
        col, dt = step["column"], step.get("dtype", "str")
        spark_dt = _SPARK_DTYPE.get(dt, "'string'")
        return [f"    {v} = {v}.withColumn({col!r}, F.col({col!r}).cast({spark_dt}))"]
    if op == "filter_rows":
        return [f"    {v} = {v}.filter({_spark_cond(step)})"]
    if op == "sort":
        asc = bool(step.get("ascending", True))
        order = f"F.col({step['column']!r}).asc()" if asc else f"F.col({step['column']!r}).desc()"
        return [f"    {v} = {v}.orderBy({order})"]
    if op == "drop_duplicates":
        sub = _collist(step.get("columns"))
        return [f"    {v} = {v}.dropDuplicates({sub!r})" if sub else f"    {v} = {v}.dropDuplicates()"]
    if op == "drop_missing":
        sub = _collist(step.get("columns"))
        how = step.get("how", "any")
        arg = f"how={how!r}" + (f", subset={sub!r}" if sub else "")
        return [f"    {v} = {v}.dropna({arg})"]
    if op == "fill_missing":
        return _spark_fill(step, v)
    if op == "one_hot_encode":
        # PySpark one-hot = StringIndexer + OneHotEncoder pipeline (real MLlib).
        cols = _collist(step.get("columns"))
        idx = [f"{c}_idx" for c in cols]
        ohe = [f"{c}_ohe" for c in cols]
        return [
            "    from pyspark.ml.feature import StringIndexer, OneHotEncoder",
            f"    {v} = StringIndexer(inputCols={cols!r}, outputCols={idx!r},"
            " handleInvalid='keep').fit(" + v + ").transform(" + v + ")",
            f"    {v} = OneHotEncoder(inputCols={idx!r}, outputCols={ohe!r}).fit(" + v + ").transform(" + v + ")",
        ]
    if op == "split_column":
        col, d = step["column"], step.get("delimiter", ",")
        return [f"    {v} = {v}.withColumn({col + '_parts'!r}, F.split(F.col({col!r}), {d!r}))"]
    if op == "replace_text":
        col = step["column"]
        return [f"    {v} = {v}.withColumn({col!r}, F.regexp_replace(F.col({col!r}).cast('string'), "
                f"{_s(step.get('find'))!r}, {_s(step.get('replace'))!r}))"]
    if op == "change_case":
        col, mode = step["column"], step.get("mode", "lower")
        fn = {"lower": "lower", "upper": "upper", "title": "initcap"}.get(mode, "lower")
        return [f"    {v} = {v}.withColumn({col!r}, F.{fn}(F.col({col!r}).cast('string')))"]
    if op == "strip_whitespace":
        col = step["column"]
        return [f"    {v} = {v}.withColumn({col!r}, F.trim(F.col({col!r}).cast('string')))"]
    if op == "scale_minmax":
        col = step["column"]
        lo, hi = _pyrepr(step.get("min", 0)), _pyrepr(step.get("max", 1))
        return [
            f"    _mn, _mx = {v}.agg(F.min({col!r}), F.max({col!r})).first()",
            f"    {v} = {v}.withColumn({col!r}, {lo} + (F.col({col!r}) - _mn) * ({hi} - {lo}) / (_mx - _mn))",
        ]
    if op == "group_by":
        by, col, func = _collist(step.get("by")), step.get("column"), step.get("func", "sum")
        return [f"    {v} = {v}.groupBy({by!r}).agg(F.{func}(F.col({col!r})).alias({f'{func}_{col}'!r}))"]
    return [f"    # (unsupported op {op!r} skipped)"]


def _spark_cond(step: dict[str, Any]) -> str:
    col, opr, raw = step["column"], step.get("operator", "eq"), step.get("value")
    c = f"F.col({col!r})"
    if opr == "notnull":
        return f"{c}.isNotNull()"
    if opr == "isnull":
        return f"{c}.isNull()"
    if opr == "contains":
        return f"{c}.contains({_s(raw)!r})"
    if opr == "startswith":
        return f"{c}.startswith({_s(raw)!r})"
    sym = {"eq": "==", "ne": "!=", "gt": ">", "ge": ">=", "lt": "<", "le": "<="}.get(opr, "==")
    return f"({c} {sym} {_pyrepr(raw)})"


def _spark_fill(step: dict[str, Any], v: str) -> list[str]:
    col, strat = step["column"], step.get("strategy", "value")
    if strat == "value":
        return [f"    {v} = {v}.fillna({{{col!r}: {_pyrepr(step.get('value'))}}})"]
    if strat in ("mean", "median"):
        agg = "F.avg" if strat == "mean" else "F.percentile_approx"
        arg = f"F.col({col!r})" + (", 0.5" if strat == "median" else "")
        return [f"    _val = {v}.agg({agg}({arg})).first()[0]",
                f"    {v} = {v}.fillna({{{col!r}: _val}})"]
    # ffill/bfill/mode need a window — emit an honest note + a simple fallback.
    return [f"    # {strat} fill needs a Window in PySpark; using column mode as a portable fallback",
            f"    _val = {v}.groupBy({col!r}).count().orderBy(F.desc('count')).first()[0]",
            f"    {v} = {v}.fillna({{{col!r}: _val}})"]


def _gen_code(steps: list[dict[str, Any]], df_var: str, out_var: str) -> dict[str, str]:
    """Generate the pandas + PySpark clean_data() functions (Fabric parity)."""
    def _comment(step: dict[str, Any]) -> str:
        cat = next((o["label"] for o in OPERATION_CATALOG if o["op"] == step.get("op")), step.get("op"))
        return f"    # {cat}"

    pd_body: list[str] = []
    sp_body: list[str] = []
    for st in steps:
        pd_body.append(_comment(st))
        pd_body.extend(_pandas_line(st, "df"))
        sp_body.append(_comment(st))
        sp_body.extend(_spark_line(st, "df"))
    if not steps:
        pd_body = ["    # No operations queued yet."]
        sp_body = ["    # No operations queued yet."]

    pandas_code = (
        "import pandas as pd\n\n"
        "def clean_data(df):\n"
        + "\n".join(pd_body)
        + "\n    return df\n\n"
        f"{out_var} = clean_data({df_var}.copy())\n"
        f"{out_var}.head()\n"
    )
    pyspark_code = (
        "from pyspark.sql import functions as F\n\n"
        "def clean_data(df):\n"
        + "\n".join(sp_body)
        + "\n    return df\n\n"
        f"{out_var} = clean_data({df_var})\n"
        f"{out_var}.show()\n"
    )
    return {"pandas": pandas_code, "pyspark": pyspark_code}


def _summary(df: pd.DataFrame) -> list[ColumnSummary]:
    out: list[ColumnSummary] = []
    for c in df.columns:
        col = df[c]
        try:
            uniq = int(col.nunique(dropna=True))
        except TypeError:
            uniq = int(col.astype("str").nunique())
        out.append(ColumnSummary(
            name=str(c), dtype=str(col.dtype),
            missing=int(col.isna().sum()), unique=uniq))
    return out


def _jsonable_rows(df: pd.DataFrame, limit: int = 200) -> list[dict[str, Any]]:
    """Return preview rows as JSON-safe dicts (NaN→None, numpy→python)."""
    head = df.head(limit).replace({np.nan: None})
    records = head.to_dict(orient="records")
    safe: list[dict[str, Any]] = []
    for rec in records:
        safe.append({str(k): (v.item() if isinstance(v, np.generic)
                              else (None if (isinstance(v, float) and pd.isna(v)) else v))
                     for k, v in rec.items()})
    return safe


# ── Route ────────────────────────────────────────────────────────────────────
@app.post("/preview", response_model=TransformResponse)
def preview(req: TransformRequest) -> TransformResponse:
    steps = req.steps[:MAX_STEPS]
    # Build the sample DataFrame (bounded).
    rows = req.rows[:MAX_ROWS]
    if req.columns:
        df = pd.DataFrame(rows, columns=req.columns[:MAX_COLS])
    else:
        df = pd.DataFrame(rows)
        if df.shape[1] > MAX_COLS:
            df = df.iloc[:, :MAX_COLS]

    results: list[StepResult] = []
    for i, st in enumerate(steps):
        op = str(st.get("op", ""))
        try:
            df = _apply(df, st)
            results.append(StepResult(index=i, op=op, ok=True))
        except Exception as e:  # per-step failure is reported, never fatal
            results.append(StepResult(index=i, op=op, ok=False, error=str(e)))

    code = _gen_code(steps, req.df_var or "df", req.out_var or "df_clean")
    return TransformResponse(
        ok=True,
        columns=[str(c) for c in df.columns],
        rows=_jsonable_rows(df),
        row_count=int(df.shape[0]),
        summary=_summary(df),
        steps=results,
        code=code,
    )


@app.post("/codegen")
def codegen(req: TransformRequest) -> dict[str, Any]:
    """Code-only (no sample) — used when the panel just needs export code."""
    code = _gen_code(req.steps[:MAX_STEPS], req.df_var or "df", req.out_var or "df_clean")
    return {"ok": True, "code": code}
