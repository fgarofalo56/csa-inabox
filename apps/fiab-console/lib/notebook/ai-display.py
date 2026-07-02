# ai_display.py — CSA Loom rich display() helper
#
# Injected at two points so display(df) renders the Loom interactive grid +
# chart recommendations instead of a plain text/HTML table:
#   1. As Livy session statement 0 (pyspark kernel) when LOOM_RICH_DISPLAY=1
#      — see lib/notebook/ai-display-preamble.ts, which embeds this file's text.
#   2. As an AML compute-instance startup script copied to
#      /etc/ipython/profile_default/startup/99_loom_display.py (bicep deploys it).
#
# It replaces the notebook display() with one that, for a Spark or pandas
# DataFrame, samples up to LOOM_DISPLAY_SAMPLE_ROWS rows, computes real per-
# column stats, and publishes application/vnd.loom.display+json alongside a
# text/plain fallback. Non-DataFrame objects fall through to the built-in
# display() unchanged (plots, HTML, widgets keep working).
#
# Idempotent: guarded by sys._loom_display_v1, so prepending to every session
# or re-running the startup file is safe.

import sys

if not getattr(sys, "_loom_display_v1", False):
    import os

    _LOOM_DISPLAY_MIME = "application/vnd.loom.display+json"
    _SAMPLE_ROWS = int(os.environ.get("LOOM_DISPLAY_SAMPLE_ROWS", "5000") or "5000")
    # Last reason the rich grid couldn't render (surfaced in the cell output so a
    # silent fall-through to the plain repr is diagnosable instead of mysterious).
    _loom_display_reason = ""

    def _is_nan(v):
        try:
            return isinstance(v, float) and v != v
        except Exception:
            return False

    def _json_safe(v):
        # NaN/inf -> None; numpy scalars -> python scalars; everything else stringifies
        # only if it isn't already a JSON-native type.
        if v is None or _is_nan(v):
            return None
        if isinstance(v, (bool, int, float, str)):
            try:
                if isinstance(v, float) and (v == float("inf") or v == float("-inf")):
                    return None
            except Exception:
                pass
            return v
        item = getattr(v, "item", None)
        if callable(item):
            try:
                return _json_safe(item())
            except Exception:
                pass
        return str(v)

    def _num_col_stats(non_null):
        """min/max/mean/stddev for a pure-Python list of numbers."""
        mn = min(non_null)
        mx = max(non_null)
        mean = sum(non_null) / len(non_null)
        var = sum((x - mean) ** 2 for x in non_null) / len(non_null)
        return {
            "min": str(mn), "max": str(mx),
            "mean": "{:.4f}".format(float(mean)),
            "stddev": "{:.4f}".format(float(var ** 0.5)),
        }

    def _cat_col_stats(non_null):
        """cardinality + top values for a pure-Python list of categoricals."""
        counts = {}
        for v in non_null:
            k = str(v)
            counts[k] = counts.get(k, 0) + 1
        top = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:10]
        return {
            "cardinality": int(min(len(counts), 1000)),
            "topValues": [{"value": k, "count": int(c)} for k, c in top],
        }

    def _serialize_df(df, df_var_name=None):
        """Serialize a Spark or pandas DataFrame -> LoomDisplayPayload dict, or None.

        The Spark path uses collect() + pure-Python stats — NOT toPandas()/Arrow,
        which is fragile across pool configs (Arrow type mismatches, missing
        pyarrow) and was the silent failure that left display() falling back to
        the plain DataFrame repr. On any failure we record _loom_display_reason so
        the caller can surface it instead of failing mysteriously.
        """
        global _loom_display_reason
        is_spark = hasattr(df, "limit") and hasattr(df, "collect") and hasattr(df, "schema")
        try:
            if is_spark:
                try:
                    total = int(df.count())
                except Exception:
                    total = None
                rows_raw = df.limit(_SAMPLE_ROWS).collect()
                fields = list(df.schema.fields)
                names = [f.name for f in fields]
                dtypes = {f.name: f.dataType.simpleString() for f in fields}
                rows = [[_json_safe(r[i]) for i in range(len(names))] for r in rows_raw]
                columns = []
                for ci, name in enumerate(names):
                    vals = [r[ci] for r in rows_raw]
                    non_null = [v for v in vals if v is not None and not _is_nan(v)]
                    col = {"name": str(name), "dtype": dtypes.get(name, ""),
                           "nullCount": int(len(vals) - len(non_null))}
                    nums = [v for v in non_null if isinstance(v, (int, float)) and not isinstance(v, bool)]
                    if non_null and len(nums) == len(non_null):
                        col.update(_num_col_stats(nums))
                    else:
                        col.update(_cat_col_stats(non_null))
                    columns.append(col)
                payload = {
                    "version": 1, "columns": columns, "rows": rows,
                    "totalCount": total if total is not None else len(rows),
                    "sampleSize": len(rows), "chartRecs": [],
                }
                if df_var_name:
                    payload["dfVarName"] = df_var_name
                return payload

            # pandas DataFrame path (optional — only needs pandas for pandas DFs).
            try:
                import pandas as pd
            except Exception:
                _loom_display_reason = "object is not a Spark DataFrame and pandas is unavailable"
                return None
            if isinstance(df, pd.DataFrame):
                total = int(len(df))
                sample = df.head(_SAMPLE_ROWS)
                columns = []
                for name in sample.columns:
                    s = sample[name]
                    dtype = str(s.dtype)
                    null_count = int(s.isna().sum())
                    col = {"name": str(name), "dtype": dtype, "nullCount": null_count}
                    if pd.api.types.is_numeric_dtype(s) and not pd.api.types.is_bool_dtype(s):
                        nn = s.dropna()
                        if len(nn):
                            col.update(_num_col_stats([float(x) for x in nn.tolist()]))
                    else:
                        col.update(_cat_col_stats(s.dropna().astype(str).tolist()))
                    columns.append(col)
                rows = [[_json_safe(v) for v in row] for row in sample.itertuples(index=False, name=None)]
                payload = {"version": 1, "columns": columns, "rows": rows,
                           "totalCount": total, "sampleSize": len(rows), "chartRecs": []}
                if df_var_name:
                    payload["dfVarName"] = df_var_name
                return payload

            _loom_display_reason = "object is not a DataFrame ({})".format(type(df).__name__)
            return None
        except Exception as e:
            _loom_display_reason = "serialize error: {}: {}".format(type(e).__name__, e)
            return None

    def _guess_var_name(obj):
        try:
            frame = sys._getframe(2)
            for k, v in list(frame.f_locals.items()):
                if v is obj and not k.startswith("_"):
                    return k
            for k, v in list(frame.f_globals.items()):
                if v is obj and not k.startswith("_"):
                    return k
        except Exception:
            pass
        return None

    def _looks_like_df(obj):
        return hasattr(obj, "limit") or type(obj).__name__ == "DataFrame"

    def display(obj, *args, **kwargs):
        """Loom-enhanced display(): rich MIME for DataFrames, built-in otherwise."""
        global _loom_display_reason
        _loom_display_reason = ""
        payload = _serialize_df(obj, _guess_var_name(obj))
        if payload is not None:
            ip = None
            try:
                from IPython import get_ipython

                ip = get_ipython()
            except Exception as e:
                _loom_display_reason = "IPython import failed: {}".format(e)
            if ip is not None:
                try:
                    ip.display_pub.publish(
                        data={
                            _LOOM_DISPLAY_MIME: payload,
                            "text/plain": "<Loom display: {}/{} rows>".format(
                                payload["sampleSize"], payload["totalCount"]
                            ),
                        },
                        metadata={},
                    )
                    return
                except Exception as e:
                    _loom_display_reason = "publish failed: {}: {}".format(type(e).__name__, e)
            elif not _loom_display_reason:
                _loom_display_reason = "no IPython shell (get_ipython() is None)"
        # For a DataFrame-like object, surface WHY the rich grid was skipped (so a
        # silent fall-through to the plain repr is diagnosable), then fall back.
        if _loom_display_reason and _looks_like_df(obj):
            try:
                print("[Loom display] rich grid unavailable — " + _loom_display_reason)
            except Exception:
                pass
        # Fall through to the original display() for non-DataFrames or any failure.
        try:
            from IPython.core.display_functions import display as _orig

            _orig(obj, *args, **kwargs)
        except Exception:
            try:
                from IPython.display import display as _orig2

                _orig2(obj, *args, **kwargs)
            except Exception:
                print(obj)

    try:
        import builtins

        builtins.display = display
    except Exception:
        pass

    sys._loom_display_v1 = True
