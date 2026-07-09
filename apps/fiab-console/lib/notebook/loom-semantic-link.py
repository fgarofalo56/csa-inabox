# loom_semantic_link.py — CSA Loom Semantic Link (SemPy parity), Azure-native.
#
# The notebook-importable equivalent of Microsoft Fabric's `sempy.fabric`
# ("Semantic Link"): read a Loom semantic model's tables / measures /
# relationships into pandas and pull DAX-evaluated measure values — with ZERO
# Power BI / Fabric dependency. Every call goes to the CSA Loom Console BFF
# (/api/items/semantic-model/<id>/semantic-link), which evaluates against the
# Azure-native tabular backend (Synapse serverless SQL by default; Azure
# Analysis Services only when LOOM_SEMANTIC_BACKEND=analysis-services is opted
# in). api.powerbi.com / api.fabric.microsoft.com are NEVER called.
#
# Injected two ways (parity with lib/notebook/ai-display.py):
#   1. As a Livy/AML session preamble — `LoomDataFrame`, `read_table`,
#      `evaluate_measure`, `list_*`, `validate_relationships` become available
#      with no pip install (see lib/notebook/loom-semantic-link-preamble.ts,
#      which embeds this file's text).
#   2. As a module on the AML compute-instance PYTHONPATH via the curated AML
#      Environment startup (bicep: platform/fiab/bicep/modules/deploy-planner/
#      ml-workspace.bicep).
#
# Auth: the notebook environment carries the caller's minted Loom session token
# in LOOM_SESSION_TOKEN (the same session cookie every BFF call uses) and the
# Console origin in LOOM_CONSOLE_BASE_URL. No separate service-principal flow.
#
# Idempotent: guarded by sys._loom_semantic_link_v1 so re-running the preamble
# or the startup module is safe.

import sys

if not getattr(sys, "_loom_semantic_link_v1", False):
    import os
    import json
    import urllib.request
    import urllib.error

    _BASE = (os.environ.get("LOOM_CONSOLE_BASE_URL", "") or "").rstrip("/")
    # LOOM_SESSION_TOKEN is preferred; fall back to LOOM_SESSION for parity with
    # other Loom notebook helpers.
    _TOKEN = os.environ.get("LOOM_SESSION_TOKEN") or os.environ.get("LOOM_SESSION") or ""
    _TIMEOUT = int(os.environ.get("LOOM_SEMANTIC_LINK_TIMEOUT", "90") or "90")

    class LoomSemanticLinkError(Exception):
        """Raised when a Semantic Link request fails or the environment is not wired."""

    def _request(method, model_id, body=None):
        if not _BASE:
            raise LoomSemanticLinkError(
                "LOOM_CONSOLE_BASE_URL is not set. Set it to the CSA Loom Console origin "
                "(e.g. https://csa-loom.example.com) so Semantic Link can reach the model."
            )
        if not model_id:
            raise LoomSemanticLinkError("model_id is required.")
        url = "{base}/api/items/semantic-model/{mid}/semantic-link".format(base=_BASE, mid=model_id)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("content-type", "application/json")
        req.add_header("accept", "application/json")
        if _TOKEN:
            # Same minted session cookie the browser BFF calls carry.
            req.add_header("cookie", "loom_session={t}".format(t=_TOKEN))
            req.add_header("authorization", "Bearer {t}".format(t=_TOKEN))
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
                raw = resp.read().decode("utf-8") or "{}"
                payload = json.loads(raw)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="replace")
                msg = json.loads(detail).get("error", detail)
            except Exception:
                msg = detail or str(e)
            raise LoomSemanticLinkError("HTTP {c}: {m}".format(c=e.code, m=msg))
        except urllib.error.URLError as e:
            raise LoomSemanticLinkError("Could not reach the Loom Console at {u}: {e}".format(u=url, e=e))
        if not payload.get("ok", False):
            raise LoomSemanticLinkError(payload.get("error", "request failed"))
        return payload

    # ── Metadata (SemPy: list_datasets / list_tables / list_measures) ─────────

    def list_tables(model_id):
        """Return the model's tables: [{name, columns:[{name,dataType}], measureNames}]."""
        return _request("GET", model_id).get("tables", [])

    def list_measures(model_id):
        """Return the model's measures: [{name, table, expression, formatString?}]."""
        return _request("GET", model_id).get("measures", [])

    def list_relationships(model_id):
        """Return the model's relationships (SemPy: list_relationships)."""
        return _request("GET", model_id).get("relationships", [])

    def validate_relationships(model_id):
        """Validate relationships (SemPy parity). Returns {ok, issues:[...], findings:[...]}.

        `ok` is False when a relationship points at a missing table/column (a
        broken relationship) — exactly what the model-health scan flags."""
        payload = _request("POST", model_id, {"op": "validate-relationships"})
        return {
            "ok": payload.get("ok", False) and not any(
                f.get("severity") == "error" for f in payload.get("findings", [])
            ),
            "issues": payload.get("issues", []),
            "findings": payload.get("findings", []),
        }

    def evaluate_dax(model_id, dax):
        """Run an EVALUATE query and return {columns:[...], rows:[{...}], backend, sql?}."""
        return _request("POST", model_id, {"op": "evaluate-dax", "dax": dax})

    def evaluate_measure(model_id, measure_name, groupby=None):
        """Evaluate a model measure. groupby is an optional list of 'Table[Column]'
        keys (grouped evaluation needs the Analysis Services backend; the
        loom-native backend supports the ungrouped aggregate case). Returns the
        raw {columns, rows, dax, backend} payload."""
        return _request(
            "POST", model_id,
            {"op": "add-measure", "measure": measure_name, "groupby": groupby or []},
        )

    def _to_dataframe(payload):
        """Turn a {columns, rows} payload into a LoomDataFrame (or a plain list if
        pandas is unavailable)."""
        rows = payload.get("rows", [])
        try:
            import pandas as pd  # noqa: F401
        except Exception:
            return rows
        df = LoomDataFrame(rows)
        return df

    def read_table(model_id, table, top_n=1000):
        """Read a model table into a LoomDataFrame (SemPy: read_table)."""
        tbl = "'{t}'".format(t=table) if any(ch for ch in table if not (ch.isalnum() or ch == "_")) else table
        payload = evaluate_dax(model_id, "EVALUATE\nTOPN({n}, {t})".format(n=int(top_n), t=tbl))
        df = _to_dataframe(payload)
        if isinstance(df, LoomDataFrame):
            df._loom_model_id = model_id
        return df

    # ── LoomDataFrame — pandas subclass carrying semantic-model lineage ──────

    try:
        import pandas as _pd

        class LoomDataFrame(_pd.DataFrame):
            """A pandas DataFrame that remembers the Loom semantic model it came
            from and can pull DAX-evaluated measures into new columns
            (SemPy `FabricDataFrame` parity)."""

            # Preserve _loom_model_id across pandas operations.
            _metadata = ["_loom_model_id"]

            @property
            def _constructor(self):
                return LoomDataFrame

            @property
            def model_id(self):
                return getattr(self, "_loom_model_id", None)

            def add_measure(self, measure_name, model_id=None, groupby=None):
                """Evaluate `measure_name` and add it as a column.

                With no `groupby`, the measure is evaluated to a single value
                (the grand total, per SemPy) and broadcast to every row. With
                `groupby` (a list of 'Table[Column]' keys), the grouped result
                is merged onto the frame — grouped evaluation runs on the
                Analysis Services backend; the loom-native backend raises an
                honest LoomSemanticLinkError for the grouped case."""
                mid = model_id or self._loom_model_id
                if not mid:
                    raise LoomSemanticLinkError(
                        "No model_id — pass model_id=... or build this frame with read_table()."
                    )
                payload = evaluate_measure(mid, measure_name, groupby=groupby)
                rows = payload.get("rows", [])
                out = self.copy()
                if not groupby:
                    value = None
                    if rows:
                        first = rows[0]
                        value = first.get(measure_name)
                        if value is None and first:
                            # Fall back to the single non-key value in the row.
                            value = list(first.values())[0]
                    out[measure_name] = value
                    return out
                # Grouped: merge on the group-by column names (strip Table[..]).
                keys = [_column_name(k) for k in groupby]
                grouped = _pd.DataFrame(rows)
                merged = out.merge(grouped, how="left", on=[k for k in keys if k in out.columns])
                return LoomDataFrame(merged)

            def list_relationships(self):
                if not self._loom_model_id:
                    raise LoomSemanticLinkError("No model_id on this frame.")
                return list_relationships(self._loom_model_id)

            def validate_relationships(self):
                if not self._loom_model_id:
                    raise LoomSemanticLinkError("No model_id on this frame.")
                return validate_relationships(self._loom_model_id)

    except Exception:
        # pandas unavailable — provide a clear error if someone constructs one.
        class LoomDataFrame(object):  # type: ignore
            def __init__(self, *a, **k):
                raise LoomSemanticLinkError(
                    "LoomDataFrame requires pandas. Install pandas in this kernel/environment."
                )

    def _column_name(table_column):
        """'Table[Column]' -> 'Column'; 'Column' -> 'Column'."""
        s = str(table_column)
        if "[" in s and s.endswith("]"):
            return s[s.index("[") + 1: -1]
        return s

    # Publish the helper into builtins so notebook cells can use it without an
    # explicit import (parity with the ai-display display() helper).
    try:
        import builtins

        for _name in (
            "LoomDataFrame", "LoomSemanticLinkError", "read_table", "evaluate_dax",
            "evaluate_measure", "list_tables", "list_measures", "list_relationships",
            "validate_relationships",
        ):
            setattr(builtins, _name, globals()[_name])
    except Exception:
        pass

    sys._loom_semantic_link_v1 = True
