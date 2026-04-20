"""Output formatters for the CSA CLI.

Supports three output modes:

* ``table``  — human-readable tabular text (default)
* ``json``   — pretty-printed JSON
* ``yaml``   — YAML (using stdlib only; no PyYAML dependency)
"""

from __future__ import annotations

import json
from typing import Any

# ── JSON ───────────────────────────────────────────────────────────────────────


def format_json(data: Any) -> str:
    """Return *data* as indented JSON."""
    return json.dumps(data, indent=2, default=str)


# ── YAML ──────────────────────────────────────────────────────────────────────


def _yaml_value(v: Any, indent: int = 0) -> str:
    """Recursively serialise a Python value to YAML-like text.

    This is a minimal implementation that covers the dict/list/scalar
    types returned by the API — sufficient for CLI output without
    requiring PyYAML as a dependency.
    """
    pad = "  " * indent
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        # Quote strings that would be ambiguous in YAML.
        if any(c in v for c in (":", "#", "{", "}", "[", "]", ",", "&", "*", "?", "|", "-", "<", ">", "=", "!", "'", '"', "@", "`", "\n")):
            escaped = v.replace("\\", "\\\\").replace('"', '\\"')
            return f'"{escaped}"'
        return v
    if isinstance(v, list):
        if not v:
            return "[]"
        items = []
        for item in v:
            if isinstance(item, dict):
                items.append(f"\n{pad}-")
                for dk, dv in item.items():
                    if isinstance(dv, (dict, list)):
                        items.append(f"\n{pad}  {dk}:{_yaml_value(dv, indent + 2)}")
                    else:
                        items.append(f"\n{pad}  {dk}: {_yaml_value(dv, indent + 2)}")
            else:
                items.append(f"\n{pad}- {_yaml_value(item, indent + 1)}")
        return "".join(items)
    if isinstance(v, dict):
        if not v:
            return "{}"
        parts = []
        for dk, dv in v.items():
            if isinstance(dv, (dict, list)):
                parts.append(f"\n{pad}{dk}:{_yaml_value(dv, indent + 1)}")
            else:
                parts.append(f"\n{pad}{dk}: {_yaml_value(dv, indent + 1)}")
        return "".join(parts)
    return str(v)


def format_yaml(data: Any) -> str:
    """Return *data* serialised as YAML text."""
    if isinstance(data, dict):
        lines = []
        for k, v in data.items():
            if isinstance(v, (dict, list)):
                lines.append(f"{k}:{_yaml_value(v, 1)}")
            else:
                lines.append(f"{k}: {_yaml_value(v)}")
        return "\n".join(lines)
    if isinstance(data, list):
        parts = []
        for item in data:
            if isinstance(item, dict):
                first = True
                for k, v in item.items():
                    prefix = "- " if first else "  "
                    first = False
                    if isinstance(v, (dict, list)):
                        parts.append(f"{prefix}{k}:{_yaml_value(v, 2)}")
                    else:
                        parts.append(f"{prefix}{k}: {_yaml_value(v)}")
            else:
                parts.append(f"- {_yaml_value(item)}")
        return "\n".join(parts)
    return _yaml_value(data)


# ── Tables ────────────────────────────────────────────────────────────────────


def _col_widths(rows: list[list[str]], headers: list[str]) -> list[int]:
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            if i < len(widths):
                widths[i] = max(widths[i], len(cell))
    return widths


def _render_table(headers: list[str], rows: list[list[str]]) -> str:
    widths = _col_widths(rows, headers)
    sep = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    fmt_row = lambda cells: "|" + "|".join(f" {c:<{widths[i]}} " for i, c in enumerate(cells)) + "|"  # noqa: E731
    lines = [sep, fmt_row(headers), sep]
    for row in rows:
        lines.append(fmt_row(row))
    lines.append(sep)
    return "\n".join(lines)


def _truncate(s: str, width: int = 40) -> str:
    return s if len(s) <= width else s[: width - 3] + "..."


def _ts(value: str | None) -> str:
    """Format an ISO timestamp for table display."""
    if not value:
        return "-"
    return value[:16].replace("T", " ")


# ── Domain-specific table formatters ──────────────────────────────────────────


def sources_table(sources: list[dict]) -> str:
    headers = ["ID", "Name", "Type", "Domain", "Status", "Updated"]
    rows = [
        [
            s.get("id", ""),
            _truncate(s.get("name", ""), 30),
            s.get("source_type", ""),
            s.get("domain", ""),
            s.get("status", ""),
            _ts(s.get("updated_at")),
        ]
        for s in sources
    ]
    return _render_table(headers, rows) if rows else "(no sources found)"


def source_detail(source: dict) -> str:
    """Render a single source as a key-value detail block."""
    fields = [
        ("ID", source.get("id", "")),
        ("Name", source.get("name", "")),
        ("Type", source.get("source_type", "")),
        ("Domain", source.get("domain", "")),
        ("Status", source.get("status", "")),
        ("Classification", source.get("classification", "")),
        ("Description", _truncate(source.get("description", ""), 60)),
        ("Pipeline ID", source.get("pipeline_id", "-")),
        ("Created", _ts(source.get("created_at"))),
        ("Updated", _ts(source.get("updated_at"))),
        ("Provisioned", _ts(source.get("provisioned_at"))),
    ]
    owner = source.get("owner") or {}
    if owner:
        fields.append(("Owner", f"{owner.get('name', '')} <{owner.get('email', '')}>"))
        fields.append(("Team", owner.get("team", "")))
    tags = source.get("tags") or {}
    if tags:
        fields.append(("Tags", ", ".join(f"{k}={v}" for k, v in tags.items())))
    width = max(len(f[0]) for f in fields)
    return "\n".join(f"{k:<{width}}  {v}" for k, v in fields)


def pipelines_table(pipelines: list[dict]) -> str:
    headers = ["ID", "Name", "Type", "Status", "Last Run", "Source"]
    rows = [
        [
            p.get("id", ""),
            _truncate(p.get("name", ""), 32),
            p.get("pipeline_type", ""),
            p.get("status", ""),
            _ts(p.get("last_run_at")),
            p.get("source_id", ""),
        ]
        for p in pipelines
    ]
    return _render_table(headers, rows) if rows else "(no pipelines found)"


def pipeline_runs_table(runs: list[dict]) -> str:
    headers = ["Run ID", "Status", "Started", "Duration (s)", "Rows Read", "Rows Written", "Error"]
    rows = [
        [
            r.get("id", ""),
            r.get("status", ""),
            _ts(r.get("started_at")),
            str(r.get("duration_seconds", "-")),
            str(r.get("rows_read", "-")),
            str(r.get("rows_written", "-")),
            _truncate(r.get("error_message") or "", 30),
        ]
        for r in runs
    ]
    return _render_table(headers, rows) if rows else "(no runs found)"


def products_table(products: list[dict]) -> str:
    headers = ["ID", "Name", "Domain", "Quality", "Freshness (h)", "Status", "Version"]
    rows = [
        [
            p.get("id", ""),
            _truncate(p.get("name", ""), 30),
            p.get("domain", ""),
            f"{p.get('quality_score', 0) * 100:.1f}%",
            f"{p.get('freshness_hours', 0):.1f}",
            p.get("status", ""),
            p.get("version", "-"),
        ]
        for p in products
    ]
    return _render_table(headers, rows) if rows else "(no products found)"


def product_detail(product: dict) -> str:
    fields = [
        ("ID", product.get("id", "")),
        ("Name", product.get("name", "")),
        ("Domain", product.get("domain", "")),
        ("Status", product.get("status", "")),
        ("Version", product.get("version", "")),
        ("Classification", product.get("classification", "")),
        ("Quality Score", f"{product.get('quality_score', 0) * 100:.1f}%"),
        ("Freshness (h)", f"{product.get('freshness_hours', 0):.2f}"),
        ("Completeness", f"{product.get('completeness', 0):.1%}"),
        ("Availability", f"{product.get('availability', 0):.1%}"),
        ("Description", _truncate(product.get("description", ""), 60)),
        ("Updated", _ts(product.get("updated_at"))),
    ]
    owner = product.get("owner") or {}
    if owner:
        fields.append(("Owner", f"{owner.get('name', '')} <{owner.get('email', '')}>"))
    tags = product.get("tags") or {}
    if tags:
        fields.append(("Tags", ", ".join(f"{k}={v}" for k, v in tags.items())))
    lineage = product.get("lineage") or {}
    if lineage:
        upstream = lineage.get("upstream") or []
        downstream = lineage.get("downstream") or []
        if upstream:
            fields.append(("Upstream", ", ".join(upstream)))
        if downstream:
            fields.append(("Downstream", ", ".join(downstream)))
    width = max(len(f[0]) for f in fields)
    return "\n".join(f"{k:<{width}}  {v}" for k, v in fields)


def quality_table(metrics: list[dict]) -> str:
    headers = ["Date", "Quality Score", "Completeness", "Freshness (h)", "Row Count"]
    rows = [
        [
            m.get("date", ""),
            f"{m.get('quality_score', 0) * 100:.1f}%",
            f"{m.get('completeness', 0):.1%}",
            f"{m.get('freshness_hours', 0):.2f}",
            str(m.get("row_count", "-")),
        ]
        for m in metrics
    ]
    return _render_table(headers, rows) if rows else "(no quality data found)"


def stats_table(stats: dict) -> str:
    fields = [
        ("Registered Sources", str(stats.get("registered_sources", 0))),
        ("Active Pipelines", str(stats.get("active_pipelines", 0))),
        ("Data Products", str(stats.get("data_products", 0))),
        ("Pending Access Requests", str(stats.get("pending_access_requests", 0))),
        ("Total Data Volume (GB)", str(stats.get("total_data_volume_gb", 0))),
        ("Pipeline Runs (24h)", str(stats.get("last_24h_pipeline_runs", 0))),
        ("Avg Quality Score", f"{stats.get('avg_quality_score', 0) * 100:.1f}%"),
    ]
    width = max(len(f[0]) for f in fields)
    return "\n".join(f"{k:<{width}}  {v}" for k, v in fields)


def domains_table(domains: list[dict]) -> str:
    # Support both marketplace /domains (name, product_count) and
    # stats /domains (full DomainOverview).
    if domains and "source_count" in domains[0]:
        headers = ["Domain", "Sources", "Pipelines", "Products", "Avg Quality", "Status"]
        rows = [
            [
                d.get("name", ""),
                str(d.get("source_count", 0)),
                str(d.get("pipeline_count", 0)),
                str(d.get("data_product_count", 0)),
                f"{d.get('avg_quality_score', 0) * 100:.1f}%",
                d.get("status", ""),
            ]
            for d in domains
        ]
    else:
        headers = ["Domain", "Products"]
        rows = [
            [d.get("name", ""), str(d.get("product_count", 0))]
            for d in domains
        ]
    return _render_table(headers, rows) if rows else "(no domains found)"


# ── Top-level dispatch ────────────────────────────────────────────────────────


def render(data: Any, output_format: str) -> str:
    """Serialise *data* in the requested format.

    Parameters
    ----------
    data:
        Python dict or list as returned by the API client.
    output_format:
        One of ``"table"``, ``"json"``, ``"yaml"``.  For table output
        callers should use the domain-specific helpers directly.
    """
    if output_format == "json":
        return format_json(data)
    if output_format == "yaml":
        return format_yaml(data)
    # Default: callers handle their own table formatting.
    return format_json(data)
