"""Tests for ai_functions._config — env-first, Spark-conf fallback resolution."""

from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def config(monkeypatch: pytest.MonkeyPatch):
    """Re-import the config module with a clean environment each test."""
    for var in (
        "LOOM_AOAI_ENDPOINT",
        "LOOM_AOAI_DEPLOYMENT",
        "LOOM_AOAI_AUDIENCE",
        "LOOM_AOAI_KEY",
        "LOOM_UAMI_CLIENT_ID",
        "AZURE_CLIENT_ID",
    ):
        monkeypatch.delenv(var, raising=False)
    import ai_functions._config as cfg

    return importlib.reload(cfg)


def test_endpoint_from_env_is_trimmed(config, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOM_AOAI_ENDPOINT", "https://aoai.openai.azure.com/")
    assert config.get_endpoint() == "https://aoai.openai.azure.com"


def test_endpoint_empty_when_unset_and_no_spark(config) -> None:
    # No env + no active SparkContext -> empty string (drives the honest gate).
    assert config.get_endpoint() == ""


def test_deployment_defaults_to_gpt4o(config) -> None:
    assert config.get_deployment() == "gpt-4o"


def test_deployment_env_override(config, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOM_AOAI_DEPLOYMENT", "gpt-4o-mini")
    assert config.get_deployment() == "gpt-4o-mini"


def test_audience_default_is_commercial(config) -> None:
    assert config.get_audience() == "https://cognitiveservices.azure.com"


def test_audience_sovereign_override(config, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOM_AOAI_AUDIENCE", "https://cognitiveservices.azure.us/")
    assert config.get_audience() == "https://cognitiveservices.azure.us"


def test_api_key_none_when_unset(config) -> None:
    assert config.get_api_key() is None


def test_uami_client_id_prefers_loom_var(config, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOM_UAMI_CLIENT_ID", "uami-123")
    monkeypatch.setenv("AZURE_CLIENT_ID", "azure-456")
    assert config.get_uami_client_id() == "uami-123"


def test_uami_client_id_falls_back_to_azure_client_id(config, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_CLIENT_ID", "azure-456")
    assert config.get_uami_client_id() == "azure-456"


def test_spark_conf_get_returns_none_without_pyspark(config) -> None:
    # pyspark is not installed in CI -> the helper must swallow ImportError.
    assert config._spark_conf_get("spark.loom.aoai.endpoint") is None
