"""Tests for the CLI output formatters."""

from __future__ import annotations

import json

import pytest

from portal.cli.formatters import (
    domains_table,
    format_json,
    format_yaml,
    pipeline_runs_table,
    pipelines_table,
    product_detail,
    products_table,
    quality_table,
    render,
    source_detail,
    sources_table,
    stats_table,
)

from .conftest import (
    SAMPLE_DOMAINS,
    SAMPLE_PIPELINE,
    SAMPLE_PRODUCT,
    SAMPLE_QUALITY,
    SAMPLE_RUN,
    SAMPLE_SOURCE,
    SAMPLE_STATS,
)


# ── JSON formatter ─────────────────────────────────────────────────────────────


class TestFormatJSON:
    def test_dict_round_trips(self):
        data = {"id": "src-001", "name": "Test"}
        output = format_json(data)
        assert json.loads(output) == data

    def test_list_round_trips(self):
        data = [{"id": "src-001"}, {"id": "src-002"}]
        output = format_json(data)
        assert json.loads(output) == data

    def test_uses_indent_2(self):
        output = format_json({"k": "v"})
        assert "\n" in output  # multi-line = indented

    def test_none_value(self):
        output = format_json(None)
        assert output == "null"

    def test_non_serialisable_uses_str(self):
        from datetime import datetime
        dt = datetime(2026, 4, 17, 12, 0, 0)
        output = format_json({"ts": dt})
        assert "2026-04-17" in output


# ── YAML formatter ─────────────────────────────────────────────────────────────


class TestFormatYAML:
    def test_simple_dict(self):
        output = format_yaml({"name": "test", "value": 42})
        assert "name: test" in output
        assert "value: 42" in output

    def test_list_of_dicts(self):
        data = [{"id": "a", "v": 1}, {"id": "b", "v": 2}]
        output = format_yaml(data)
        assert "id: a" in output
        assert "id: b" in output

    def test_nested_dict(self):
        data = {"owner": {"name": "Alice", "email": "alice@example.com"}}
        output = format_yaml(data)
        assert "name:" in output
        assert "Alice" in output

    def test_none_scalar(self):
        output = format_yaml({"key": None})
        assert "null" in output

    def test_bool_true(self):
        output = format_yaml({"enabled": True})
        assert "true" in output

    def test_bool_false(self):
        output = format_yaml({"enabled": False})
        assert "false" in output

    def test_empty_dict(self):
        output = format_yaml({})
        assert output == ""

    def test_empty_list(self):
        output = format_yaml([])
        assert output == ""


# ── Table formatters ───────────────────────────────────────────────────────────


class TestSourcesTable:
    def test_contains_headers(self):
        output = sources_table([SAMPLE_SOURCE])
        assert "ID" in output
        assert "Name" in output
        assert "Status" in output

    def test_contains_data(self):
        output = sources_table([SAMPLE_SOURCE])
        assert "src-001" in output
        assert "azure_sql" in output
        assert "active" in output

    def test_empty_list_returns_message(self):
        output = sources_table([])
        assert "no sources" in output.lower()

    def test_long_name_truncated(self):
        long_source = {**SAMPLE_SOURCE, "name": "A" * 50}
        output = sources_table([long_source])
        assert "..." in output


class TestSourceDetail:
    def test_contains_all_fields(self):
        output = source_detail(SAMPLE_SOURCE)
        assert "src-001" in output
        assert "HR Employee Records" in output
        assert "human-resources" in output
        assert "azure_sql" in output
        assert "Jane Smith" in output
        assert "pii=true" in output

    def test_handles_missing_owner(self):
        source = {**SAMPLE_SOURCE, "owner": None}
        output = source_detail(source)
        assert "src-001" in output  # still renders

    def test_handles_missing_tags(self):
        source = {**SAMPLE_SOURCE, "tags": {}}
        output = source_detail(source)
        assert "src-001" in output


class TestPipelinesTable:
    def test_contains_headers(self):
        output = pipelines_table([SAMPLE_PIPELINE])
        assert "ID" in output
        assert "Name" in output
        assert "Status" in output

    def test_contains_data(self):
        output = pipelines_table([SAMPLE_PIPELINE])
        assert "pl-001" in output
        assert "succeeded" in output
        assert "src-001" in output

    def test_empty_returns_message(self):
        output = pipelines_table([])
        assert "no pipelines" in output.lower()


class TestPipelineRunsTable:
    def test_contains_headers(self):
        output = pipeline_runs_table([SAMPLE_RUN])
        assert "Run ID" in output
        assert "Status" in output
        assert "Duration" in output

    def test_contains_data(self):
        output = pipeline_runs_table([SAMPLE_RUN])
        assert "run-abc12345" in output
        assert "succeeded" in output
        assert "600" in output
        assert "150000" in output

    def test_empty_returns_message(self):
        output = pipeline_runs_table([])
        assert "no runs" in output.lower()

    def test_error_message_truncated(self):
        run = {**SAMPLE_RUN, "error_message": "E" * 60}
        output = pipeline_runs_table([run])
        assert "..." in output


class TestProductsTable:
    def test_contains_headers(self):
        output = products_table([SAMPLE_PRODUCT])
        assert "ID" in output
        assert "Quality" in output
        assert "Domain" in output

    def test_contains_data(self):
        output = products_table([SAMPLE_PRODUCT])
        assert "dp-001" in output
        assert "94.5" in output
        assert "human-resources" in output

    def test_empty_returns_message(self):
        output = products_table([])
        assert "no products" in output.lower()


class TestProductDetail:
    def test_contains_all_fields(self):
        output = product_detail(SAMPLE_PRODUCT)
        assert "Employee Master Data" in output
        assert "94.5" in output
        assert "human-resources" in output
        assert "workday-hris-raw" in output
        assert "workforce-analytics" in output

    def test_handles_no_lineage(self):
        p = {**SAMPLE_PRODUCT, "lineage": None}
        output = product_detail(p)
        assert "Employee Master Data" in output


class TestQualityTable:
    def test_contains_headers(self):
        output = quality_table(SAMPLE_QUALITY)
        assert "Date" in output
        assert "Quality Score" in output
        assert "Completeness" in output

    def test_contains_data(self):
        output = quality_table(SAMPLE_QUALITY)
        assert "2026-04-17" in output
        assert "500000" in output

    def test_empty_returns_message(self):
        output = quality_table([])
        assert "no quality" in output.lower()


class TestStatsTable:
    def test_contains_all_fields(self):
        output = stats_table(SAMPLE_STATS)
        assert "Registered Sources" in output
        assert "Active Pipelines" in output
        assert "Data Products" in output
        assert "92.8" in output

    def test_zero_values(self):
        output = stats_table({})
        assert "0" in output


class TestDomainsTable:
    def test_full_domain_overview(self):
        output = domains_table(SAMPLE_DOMAINS)
        assert "finance" in output
        assert "human-resources" in output
        assert "98.1" in output
        assert "healthy" in output

    def test_simple_domain_list(self):
        simple = [{"name": "finance", "product_count": 3}]
        output = domains_table(simple)
        assert "finance" in output
        assert "3" in output


# ── render() dispatch ──────────────────────────────────────────────────────────


class TestRender:
    def test_json_format(self):
        output = render({"key": "value"}, "json")
        assert json.loads(output) == {"key": "value"}

    def test_yaml_format(self):
        output = render({"key": "value"}, "yaml")
        assert "key: value" in output

    def test_table_format_falls_back_to_json(self):
        # render() itself falls back to JSON for table — callers use specific helpers.
        output = render({"key": "value"}, "table")
        assert json.loads(output) == {"key": "value"}
