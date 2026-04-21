"""Unit tests for :mod:`csa_platform.streaming.silver`."""

from __future__ import annotations

from csa_platform.streaming.models import SilverMaterializedView
from csa_platform.streaming.silver import MaterializedViewBuilder


def _view(dedup: tuple[str, ...] = ("sensor_id", "event_time")) -> SilverMaterializedView:
    return SilverMaterializedView(
        name="iot_clean",
        upstream_bronze="iot_telemetry",
        dbt_model_ref="silver.iot_clean",
        watermark_field="event_time",
        deduplication_keys=dedup,
    )


def test_build_dbt_model_yaml_includes_key_fields() -> None:
    yaml_text = MaterializedViewBuilder(_view()).build_dbt_model_yaml()
    assert "- name: iot_clean" in yaml_text
    assert "materialized: incremental" in yaml_text
    assert "event_time" in yaml_text
    assert "sensor_id" in yaml_text
    # Dedup test emitted when keys are present.
    assert "unique_combination_of_columns" in yaml_text


def test_build_dbt_model_yaml_without_dedup_skips_tests() -> None:
    view = SilverMaterializedView(
        name="iot_raw",
        upstream_bronze="iot_telemetry",
        dbt_model_ref="silver.iot_raw",
        watermark_field="event_time",
        deduplication_keys=(),
    )
    yaml_text = MaterializedViewBuilder(view).build_dbt_model_yaml()
    assert "unique_combination_of_columns" not in yaml_text
    assert "- name: iot_raw" in yaml_text


def test_build_incremental_sql_contains_merge_blocks() -> None:
    sql = MaterializedViewBuilder(_view()).build_incremental_sql(bronze_source="iot_telemetry")
    assert "materialized='incremental'" in sql
    assert "incremental_strategy='merge'" in sql
    assert "is_incremental()" in sql
    assert "sensor_id" in sql
    assert "event_time" in sql
    assert "row_number()" in sql
    assert "iot_telemetry" in sql


def test_build_incremental_sql_without_dedup_falls_back_to_watermark() -> None:
    view = SilverMaterializedView(
        name="iot_raw",
        upstream_bronze="iot_telemetry",
        dbt_model_ref="silver.iot_raw",
        watermark_field="event_time",
    )
    sql = MaterializedViewBuilder(view).build_incremental_sql(bronze_source="iot_telemetry")
    # partition by falls back to the watermark field when no dedup keys.
    assert "partition by event_time" in sql
