"""Tests for :mod:`csa_platform.ai_integration.rag.telemetry` (CSA-0105)."""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from csa_platform.ai_integration.rag import telemetry as tel
from csa_platform.ai_integration.rag.telemetry import (
    DEFAULT_PRICING,
    ModelPricing,
    PricingLoadError,
    PricingTable,
    estimate_cost_usd,
    load_pricing_yaml,
    record_openai_call,
    reset_default_pricing,
)


@pytest.fixture(autouse=True)
def _reset_pricing() -> Any:
    reset_default_pricing()
    yield
    reset_default_pricing()


class TestPricingTable:
    def test_default_pricing_has_expected_models(self) -> None:
        for model in ("gpt-4o", "gpt-4o-mini", "text-embedding-3-large", "text-embedding-3-small"):
            assert model in DEFAULT_PRICING

    def test_table_fallback_on_missing_model(self) -> None:
        table = PricingTable()
        price = table.get("no-such-model")
        assert price.prompt_usd_per_1k == 0.0
        assert price.completion_usd_per_1k == 0.0

    def test_overrides_replace_defaults(self) -> None:
        table = PricingTable(
            overrides={"gpt-4o": ModelPricing(1.0, 2.0)},
        )
        price = table.get("gpt-4o")
        assert price.prompt_usd_per_1k == 1.0
        assert price.completion_usd_per_1k == 2.0


class TestCostMath:
    def test_zero_tokens_returns_zero(self) -> None:
        assert estimate_cost_usd(model="gpt-4o", prompt_tokens=0, completion_tokens=0) == 0.0

    def test_cost_for_known_model(self) -> None:
        # gpt-4o-mini: 0.00015/1k prompt, 0.00060/1k completion
        # 1000 prompt + 500 completion = 0.00015 + 0.00030 = 0.00045
        cost = estimate_cost_usd(
            model="gpt-4o-mini",
            prompt_tokens=1000,
            completion_tokens=500,
        )
        assert abs(cost - 0.00045) < 1e-9

    def test_cost_for_embeddings(self) -> None:
        # text-embedding-3-small: 0.00002/1k prompt, 0.0 completion
        # 5000 prompt = 5000/1000 * 0.00002 = 0.0001
        cost = estimate_cost_usd(
            model="text-embedding-3-small",
            prompt_tokens=5000,
            completion_tokens=0,
        )
        assert abs(cost - 0.0001) < 1e-9

    def test_unknown_model_is_zero(self) -> None:
        cost = estimate_cost_usd(
            model="made-up-model",
            prompt_tokens=999_999,
            completion_tokens=999_999,
        )
        assert cost == 0.0


class TestYAMLLoading:
    def test_load_missing_file_raises(self, tmp_path: Path) -> None:
        with pytest.raises(PricingLoadError):
            load_pricing_yaml(tmp_path / "nope.yaml")

    def test_load_valid_yaml(self, tmp_path: Path) -> None:
        y = tmp_path / "pricing.yaml"
        y.write_text(
            "gpt-custom:\n"
            "  prompt_usd_per_1k: 0.005\n"
            "  completion_usd_per_1k: 0.015\n",
            encoding="utf-8",
        )
        table = load_pricing_yaml(y)
        assert "gpt-custom" in table
        assert table["gpt-custom"].prompt_usd_per_1k == 0.005
        assert table["gpt-custom"].completion_usd_per_1k == 0.015

    def test_load_missing_fields_default_to_zero(self, tmp_path: Path) -> None:
        y = tmp_path / "pricing.yaml"
        y.write_text("gpt-partial: {}\n", encoding="utf-8")
        table = load_pricing_yaml(y)
        assert table["gpt-partial"].prompt_usd_per_1k == 0.0
        assert table["gpt-partial"].completion_usd_per_1k == 0.0

    def test_load_invalid_root_raises(self, tmp_path: Path) -> None:
        y = tmp_path / "pricing.yaml"
        y.write_text("- not\n- a\n- map\n", encoding="utf-8")
        with pytest.raises(PricingLoadError):
            load_pricing_yaml(y)

    def test_env_driven_yaml_is_picked_up(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        y = tmp_path / "pricing.yaml"
        y.write_text(
            "gpt-4o:\n"
            "  prompt_usd_per_1k: 99.0\n"
            "  completion_usd_per_1k: 99.0\n",
            encoding="utf-8",
        )
        monkeypatch.setenv("RAG_TOKEN_PRICING_YAML", str(y))
        reset_default_pricing()
        cost = estimate_cost_usd(model="gpt-4o", prompt_tokens=1000, completion_tokens=0)
        assert cost == 99.0


class TestRecordOpenAICall:
    def test_usage_dict_populates_telemetry(self) -> None:
        with record_openai_call(operation="chat.completions", model="gpt-4o") as rec:
            rec["prompt_tokens"] = 100
            rec["completion_tokens"] = 200
        # After the context exits, the record attribute is attached.
        final = rec.get("record")
        assert final is not None
        assert final.model == "gpt-4o"
        assert final.prompt_tokens == 100
        assert final.completion_tokens == 200
        assert final.total_tokens == 300
        # gpt-4o: 0.0025 prompt + 0.010 completion per 1k
        # 100/1000 * 0.0025 + 200/1000 * 0.010 = 0.00025 + 0.002 = 0.00225
        assert abs(final.estimated_usd - 0.00225) < 1e-9

    def test_missing_usage_still_produces_record(self) -> None:
        with record_openai_call(operation="embeddings.create", model="x") as rec:
            pass
        final = rec["record"]
        assert final.prompt_tokens == 0
        assert final.completion_tokens == 0
        assert final.estimated_usd == 0.0

    def test_latency_is_recorded_in_ms(self) -> None:
        import time as _t

        with record_openai_call(operation="chat.completions", model="gpt-4o") as rec:
            _t.sleep(0.01)
        final = rec["record"]
        assert final.latency_ms >= 5  # noisy timer, but should be nonzero

    def test_otel_noop_fallback(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When OTel is not installed the helper degrades to a no-op.

        We patch ``_OTEL_TRACER`` to ``None`` on the module to simulate
        a lean install; the context manager must still complete without
        raising.
        """
        monkeypatch.setattr(tel, "_OTEL_TRACER", None)
        with record_openai_call(operation="chat.completions", model="gpt-4o") as rec:
            rec["prompt_tokens"] = 1
            rec["completion_tokens"] = 2
        assert rec["record"].prompt_tokens == 1

    def test_otel_span_attributes_captured(self) -> None:
        """When OTel is installed the span gets ``openai.*`` attrs.

        We install an in-memory span exporter for the duration of the
        test and verify the span carries every attribute the audit
        spec calls for.
        """
        pytest.importorskip("opentelemetry.sdk.trace")
        from opentelemetry import trace as otel_trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import (
            SimpleSpanProcessor,
        )
        from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
            InMemorySpanExporter,
        )

        provider = TracerProvider()
        exporter = InMemorySpanExporter()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        # Force the telemetry module to use our provider's tracer.
        importlib.reload(tel)
        prev = tel._OTEL_TRACER
        try:
            otel_trace.set_tracer_provider(provider)
            tel._OTEL_TRACER = provider.get_tracer("test")
            with tel.record_openai_call(operation="chat.completions", model="gpt-4o") as rec:
                rec["prompt_tokens"] = 10
                rec["completion_tokens"] = 5
        finally:
            tel._OTEL_TRACER = prev

        spans = exporter.get_finished_spans()
        assert spans, "no span was exported"
        attrs = dict(spans[0].attributes or {})
        assert attrs["openai.model"] == "gpt-4o"
        assert attrs["openai.operation"] == "chat.completions"
        assert attrs["openai.prompt_tokens"] == 10
        assert attrs["openai.completion_tokens"] == 5
        assert attrs["openai.total_tokens"] == 15
        assert "openai.estimated_usd" in attrs
        assert "openai.latency_ms" in attrs


class TestPrometheusMetrics:
    def test_metrics_registered(self) -> None:
        pytest.importorskip("prometheus_client")
        from prometheus_client import REGISTRY

        # Counters register both the base name and a ``_created`` sibling;
        # histograms register ``_sum`` / ``_count`` / ``_bucket`` series.
        # We only care that the base metric name appears somewhere.
        registered = set(getattr(REGISTRY, "_names_to_collectors", {}).keys())
        for base in (
            "rag_request_latency_seconds",
            "rag_tokens_total",
            "rag_dollars_estimated_total",
            "rag_chunk_count",
        ):
            assert any(
                name == base or name.startswith(base + "_") for name in registered
            ), f"metric {base!r} not registered"

    def test_metrics_increment_on_call(self) -> None:
        pytest.importorskip("prometheus_client")
        from prometheus_client import REGISTRY

        before_tokens = (
            REGISTRY.get_sample_value(
                "rag_tokens_total", {"model": "gpt-4o", "direction": "prompt"}
            )
            or 0.0
        )
        with record_openai_call(operation="chat.completions", model="gpt-4o") as rec:
            rec["prompt_tokens"] = 10
            rec["completion_tokens"] = 5
        after_tokens = (
            REGISTRY.get_sample_value(
                "rag_tokens_total", {"model": "gpt-4o", "direction": "prompt"}
            )
            or 0.0
        )
        assert after_tokens - before_tokens == 10.0

        dollars = REGISTRY.get_sample_value(
            "rag_dollars_estimated_total", {"model": "gpt-4o"}
        )
        assert dollars is not None
        assert dollars > 0.0


class TestNoopFallbacks:
    def test_no_prom_available_is_noop(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Re-importing with the prom flag off returns no-op metrics."""
        with patch.dict("sys.modules", {"prometheus_client": None}):
            importlib.reload(tel)
            try:
                with tel.record_openai_call(operation="chat.completions", model="gpt-4o") as rec:
                    rec["prompt_tokens"] = 1
                assert rec["record"].prompt_tokens == 1
            finally:
                importlib.reload(tel)
