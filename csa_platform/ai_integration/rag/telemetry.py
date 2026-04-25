"""Cost + latency telemetry for the RAG pipeline (CSA-0105).

Single module that exposes three concerns:

1. **Pricing table** — a mapping from Azure OpenAI deployment / model name
   to ``{prompt_usd_per_1k, completion_usd_per_1k}``.  Defaults cover
   ``gpt-4o``, ``gpt-4o-mini``, ``text-embedding-3-large``, and
   ``text-embedding-3-small``.  Callers can override via a YAML file
   pointed at by the ``RAG_TOKEN_PRICING_YAML`` environment variable.
2. **Prometheus metrics** — one histogram + two counters tagged with
   ``operation`` / ``model`` / ``direction``, registered on the default
   registry if ``prometheus_client`` is available.  A no-op fallback
   keeps the rest of the platform importable when it is not.
3. **OTel spans** — :func:`record_openai_call` emits a span that carries
   the full set of ``openai.*`` attributes required for LLMOps
   dashboards.  When ``opentelemetry`` is not installed the context
   manager is still safe to use (it becomes a no-op).

The module is deliberately tolerant of missing optional dependencies so
that the rest of ``csa_platform.ai_integration.rag`` can be imported in
lean environments (governance, dev shells) without a hard pin.
"""

from __future__ import annotations

import contextlib
import os
import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Optional dependency probes
# ---------------------------------------------------------------------------

_otel_trace: Any | None
try:  # pragma: no cover — trivial import guard
    from opentelemetry import trace as _otel_trace_import

    _otel_trace = _otel_trace_import
    _OTEL_TRACER: Any | None = _otel_trace_import.get_tracer("csa_platform.ai_integration.rag")
except ImportError:  # pragma: no cover — exercised by test_telemetry
    _otel_trace = None
    _OTEL_TRACER = None


try:  # pragma: no cover — trivial import guard
    from prometheus_client import REGISTRY, Counter, Histogram

    _PROM_AVAILABLE = True
except ImportError:  # pragma: no cover
    REGISTRY = None  # type: ignore[assignment, unused-ignore]
    Counter = None  # type: ignore[assignment, misc, unused-ignore]
    Histogram = None  # type: ignore[assignment, misc, unused-ignore]
    _PROM_AVAILABLE = False


_yaml: Any | None
try:  # pragma: no cover — pyyaml is already on the platform extra.
    import yaml as _yaml_import

    _yaml = _yaml_import
    _YAML_AVAILABLE = True
except ImportError:  # pragma: no cover
    _yaml = None
    _YAML_AVAILABLE = False


# ---------------------------------------------------------------------------
# Pricing table
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ModelPricing:
    """Per-1k-token pricing for a single model/deployment (frozen DTO)."""

    prompt_usd_per_1k: float
    completion_usd_per_1k: float


DEFAULT_PRICING: Mapping[str, ModelPricing] = {
    # Chat models (values valid as of 2026-Q1 Azure commercial; update
    # via RAG_TOKEN_PRICING_YAML for gov / custom-rate tenants).
    "gpt-4o": ModelPricing(prompt_usd_per_1k=0.0025, completion_usd_per_1k=0.010),
    "gpt-4o-mini": ModelPricing(prompt_usd_per_1k=0.00015, completion_usd_per_1k=0.00060),
    # Embedding models (completion leg is 0 — embeddings only bill prompt tokens).
    "text-embedding-3-large": ModelPricing(prompt_usd_per_1k=0.00013, completion_usd_per_1k=0.0),
    "text-embedding-3-small": ModelPricing(prompt_usd_per_1k=0.00002, completion_usd_per_1k=0.0),
}


class PricingTable:
    """Mutable lookup wrapper around :data:`DEFAULT_PRICING`.

    Loads an optional YAML overlay from ``RAG_TOKEN_PRICING_YAML`` at
    construction time.  Missing models fall back to a zero-priced entry
    so the cost counter still fires (and operators can spot the gap in
    dashboards).
    """

    def __init__(
        self,
        *,
        overrides: Mapping[str, ModelPricing] | None = None,
        yaml_path: str | os.PathLike[str] | None = None,
    ) -> None:
        base: dict[str, ModelPricing] = dict(DEFAULT_PRICING)
        if yaml_path:
            base.update(load_pricing_yaml(yaml_path))
        if overrides:
            base.update(overrides)
        self._table: dict[str, ModelPricing] = base

    def get(self, model: str) -> ModelPricing:
        """Return pricing for *model*; zero-priced fallback on miss."""
        return self._table.get(model, ModelPricing(0.0, 0.0))

    def __contains__(self, model: str) -> bool:
        return model in self._table

    def as_mapping(self) -> Mapping[str, ModelPricing]:
        return dict(self._table)


def load_pricing_yaml(path: str | os.PathLike[str]) -> dict[str, ModelPricing]:
    """Parse a YAML overlay file into :class:`ModelPricing` entries.

    Expected shape::

        gpt-4o:
          prompt_usd_per_1k: 0.0025
          completion_usd_per_1k: 0.010
        text-embedding-3-large:
          prompt_usd_per_1k: 0.00013
          completion_usd_per_1k: 0.0

    Missing keys default to ``0.0``.  Raises :class:`PricingLoadError`
    on parse / structural errors so misconfigurations surface early.
    """
    if not _YAML_AVAILABLE or _yaml is None:  # pragma: no cover
        raise PricingLoadError("PyYAML is not installed; cannot load pricing YAML.")
    yaml_module = _yaml
    p = Path(path)
    if not p.is_file():
        raise PricingLoadError(f"Pricing YAML not found: {p}")
    try:
        raw = yaml_module.safe_load(p.read_text(encoding="utf-8")) or {}
    except Exception as exc:  # pragma: no cover — yaml parse errors
        raise PricingLoadError(f"Failed to parse pricing YAML {p}: {exc}") from exc
    if not isinstance(raw, Mapping):
        raise PricingLoadError(f"Pricing YAML root must be a mapping: {p}")
    parsed: dict[str, ModelPricing] = {}
    for model, entry in raw.items():
        if not isinstance(entry, Mapping):
            raise PricingLoadError(f"Pricing entry for '{model}' must be a mapping.")
        try:
            parsed[str(model)] = ModelPricing(
                prompt_usd_per_1k=float(entry.get("prompt_usd_per_1k", 0.0)),
                completion_usd_per_1k=float(entry.get("completion_usd_per_1k", 0.0)),
            )
        except (TypeError, ValueError) as exc:
            raise PricingLoadError(
                f"Invalid pricing numbers for '{model}': {exc}"
            ) from exc
    return parsed


class PricingLoadError(RuntimeError):
    """Raised when the pricing YAML cannot be loaded."""


def estimate_cost_usd(
    *,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    pricing: PricingTable | None = None,
) -> float:
    """Return estimated USD for *prompt_tokens* + *completion_tokens*."""
    table = pricing or _default_pricing()
    entry = table.get(model)
    prompt_cost = (prompt_tokens / 1000.0) * entry.prompt_usd_per_1k
    completion_cost = (completion_tokens / 1000.0) * entry.completion_usd_per_1k
    return round(prompt_cost + completion_cost, 8)


_DEFAULT_PRICING_SINGLETON: PricingTable | None = None


def _default_pricing() -> PricingTable:
    """Module-level singleton, lazily honouring the YAML env var."""
    global _DEFAULT_PRICING_SINGLETON
    if _DEFAULT_PRICING_SINGLETON is None:
        yaml_env = os.environ.get("RAG_TOKEN_PRICING_YAML")
        _DEFAULT_PRICING_SINGLETON = PricingTable(yaml_path=yaml_env if yaml_env else None)
    return _DEFAULT_PRICING_SINGLETON


def reset_default_pricing() -> None:
    """Drop the cached :class:`PricingTable` (test hook)."""
    global _DEFAULT_PRICING_SINGLETON
    _DEFAULT_PRICING_SINGLETON = None


# ---------------------------------------------------------------------------
# Prometheus metrics (no-op when prometheus_client is absent)
# ---------------------------------------------------------------------------


class _NoopMetric:
    """Shared no-op stand-in for Counter / Histogram in lean installs."""

    def labels(self, **_: Any) -> _NoopMetric:
        return self

    def inc(self, _amount: float = 1.0) -> None:  # pragma: no cover - trivial
        return None

    def observe(self, _amount: float) -> None:  # pragma: no cover - trivial
        return None


_METRIC_PREFIX = "rag_"


def _build_metrics() -> dict[str, Any]:
    """Register the Prometheus metrics once (idempotent across reloads)."""
    if not _PROM_AVAILABLE:
        return {
            "latency": _NoopMetric(),
            "tokens": _NoopMetric(),
            "dollars": _NoopMetric(),
            "chunks": _NoopMetric(),
        }

    names = {
        "latency": f"{_METRIC_PREFIX}request_latency_seconds",
        "tokens": f"{_METRIC_PREFIX}tokens_total",
        "dollars": f"{_METRIC_PREFIX}dollars_estimated_total",
        "chunks": f"{_METRIC_PREFIX}chunk_count",
    }

    # Guard against re-registration when the module is re-imported during
    # tests — look each metric up on the default registry first.
    existing = {}
    for key, name in names.items():
        existing[key] = _find_collector(name)

    if all(existing.values()):
        return existing

    try:
        latency = existing["latency"] or Histogram(
            names["latency"],
            "RAG request latency in seconds, partitioned by operation + model.",
            labelnames=("operation", "model"),
        )
        tokens = existing["tokens"] or Counter(
            names["tokens"],
            "Tokens billed by Azure OpenAI, partitioned by model + direction.",
            labelnames=("model", "direction"),
        )
        dollars = existing["dollars"] or Counter(
            names["dollars"],
            "Estimated USD spend per model (see RAG_TOKEN_PRICING_YAML).",
            labelnames=("model",),
        )
        chunks = existing["chunks"] or Histogram(
            names["chunks"],
            "Chunk counts observed per RAG operation.",
            labelnames=("operation",),
            buckets=(0, 1, 2, 5, 10, 20, 50, 100, 500, 1000),
        )
    except ValueError:  # pragma: no cover — duplicate registration edge case
        return {
            "latency": _find_collector(names["latency"]) or _NoopMetric(),
            "tokens": _find_collector(names["tokens"]) or _NoopMetric(),
            "dollars": _find_collector(names["dollars"]) or _NoopMetric(),
            "chunks": _find_collector(names["chunks"]) or _NoopMetric(),
        }

    return {
        "latency": latency,
        "tokens": tokens,
        "dollars": dollars,
        "chunks": chunks,
    }


def _find_collector(name: str) -> Any:
    """Return a metric already registered under *name*, or ``None``."""
    if not _PROM_AVAILABLE or REGISTRY is None:  # pragma: no cover
        return None
    collectors = getattr(REGISTRY, "_names_to_collectors", None)
    if not isinstance(collectors, Mapping):  # pragma: no cover
        return None
    return collectors.get(name)


_METRICS = _build_metrics()


def observe_chunk_count(operation: str, count: int) -> None:
    """Record chunk counts produced by a RAG operation."""
    try:
        _METRICS["chunks"].labels(operation=operation).observe(max(0, count))
    except Exception:  # pragma: no cover — never fail the caller on metrics
        logger.debug("rag_telemetry.chunk_observe_failed", operation=operation)


def observe_request_latency(operation: str, model: str, seconds: float) -> None:
    """Record a request latency sample."""
    try:
        _METRICS["latency"].labels(operation=operation, model=model).observe(max(0.0, seconds))
    except Exception:  # pragma: no cover
        logger.debug("rag_telemetry.latency_observe_failed", operation=operation)


# ---------------------------------------------------------------------------
# OpenAI call instrumentation helper
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class OpenAICallRecord:
    """Snapshot of a single OpenAI call for post-hoc introspection."""

    model: str
    operation: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    estimated_usd: float
    latency_ms: int


@contextlib.contextmanager
def record_openai_call(
    *,
    operation: str,
    model: str,
    pricing: PricingTable | None = None,
) -> Iterator[dict[str, Any]]:
    """Instrument a single ``AsyncAzureOpenAI`` call.

    Yields a mutable dict the caller is expected to populate with
    ``prompt_tokens`` / ``completion_tokens`` (the ``usage`` block of
    the API response).  On exit the context manager:

    * computes the estimated USD cost,
    * attaches ``openai.*`` attributes to the active OTel span (when
      ``opentelemetry`` is installed),
    * increments the Prometheus token + dollar counters,
    * records latency + chunk-count (if set) histograms,
    * emits a structured log line with ``rag.*`` keys.

    The context manager is safe to use even when OTel / Prometheus are
    absent — both paths degrade to no-ops.
    """
    start = time.perf_counter()
    payload: dict[str, Any] = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "chunk_count": None,
    }

    span_cm: Any
    if _OTEL_TRACER is not None:
        span_cm = _OTEL_TRACER.start_as_current_span(f"rag.openai.{operation}")
    else:
        span_cm = contextlib.nullcontext()

    with span_cm as span:
        try:
            yield payload
        finally:
            elapsed = time.perf_counter() - start
            latency_ms = int(elapsed * 1000)
            prompt_tokens = int(payload.get("prompt_tokens") or 0)
            completion_tokens = int(payload.get("completion_tokens") or 0)
            total_tokens = prompt_tokens + completion_tokens
            usd = estimate_cost_usd(
                model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                pricing=pricing,
            )

            # --- OTel attrs -----------------------------------------------
            if span is not None and hasattr(span, "set_attribute"):
                with contextlib.suppress(Exception):  # pragma: no cover - defensive
                    span.set_attribute("openai.model", model)
                    span.set_attribute("openai.operation", operation)
                    span.set_attribute("openai.prompt_tokens", prompt_tokens)
                    span.set_attribute("openai.completion_tokens", completion_tokens)
                    span.set_attribute("openai.total_tokens", total_tokens)
                    span.set_attribute("openai.estimated_usd", usd)
                    span.set_attribute("openai.latency_ms", latency_ms)

            # --- Prometheus metrics ---------------------------------------
            try:
                _METRICS["latency"].labels(operation=operation, model=model).observe(elapsed)
                if prompt_tokens:
                    _METRICS["tokens"].labels(model=model, direction="prompt").inc(prompt_tokens)
                if completion_tokens:
                    _METRICS["tokens"].labels(model=model, direction="completion").inc(
                        completion_tokens
                    )
                if usd:
                    _METRICS["dollars"].labels(model=model).inc(usd)
                chunk_count = payload.get("chunk_count")
                if isinstance(chunk_count, int) and chunk_count >= 0:
                    _METRICS["chunks"].labels(operation=operation).observe(chunk_count)
            except Exception:  # pragma: no cover
                logger.debug("rag_telemetry.metric_emit_failed", operation=operation)

            # --- Structured log ------------------------------------------
            logger.info(
                "rag.openai_call",
                **{
                    "rag.operation": operation,
                    "rag.model": model,
                    "rag.tokens_prompt": prompt_tokens,
                    "rag.tokens_completion": completion_tokens,
                    "rag.tokens_total": total_tokens,
                    "rag.estimated_usd": usd,
                    "rag.latency_ms": latency_ms,
                },
            )

            # Expose the final record on the payload so callers (tests,
            # downstream tracers) can introspect without re-reading env.
            payload["record"] = OpenAICallRecord(
                model=model,
                operation=operation,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                estimated_usd=usd,
                latency_ms=latency_ms,
            )


__all__ = [
    "DEFAULT_PRICING",
    "ModelPricing",
    "OpenAICallRecord",
    "PricingLoadError",
    "PricingTable",
    "estimate_cost_usd",
    "load_pricing_yaml",
    "observe_chunk_count",
    "observe_request_latency",
    "record_openai_call",
    "reset_default_pricing",
]
