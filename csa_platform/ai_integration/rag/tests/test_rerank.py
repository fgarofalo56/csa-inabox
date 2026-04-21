"""Tests for :mod:`csa_platform.ai_integration.rag.rerank`."""

from __future__ import annotations

from csa_platform.ai_integration.rag.rerank import RerankPolicy, apply_policy
from csa_platform.ai_integration.rag.retriever import SearchResult


def _mk(id_: str, score: float) -> SearchResult:
    return SearchResult(id=id_, text="", score=score, source="")


class TestRerankPolicy:
    def test_default_is_enabled(self) -> None:
        policy = RerankPolicy()
        assert policy.enabled is True
        assert policy.configuration_name == "csa-semantic-config"

    def test_disabled_factory(self) -> None:
        policy = RerankPolicy.disabled()
        assert policy.enabled is False

    def test_frozen(self) -> None:
        """Dataclass is frozen so the policy can't mutate mid-request."""
        policy = RerankPolicy()
        try:
            policy.enabled = False  # type: ignore[misc]
        except Exception:  # FrozenInstanceError from dataclasses
            return
        raise AssertionError("RerankPolicy should be frozen")


class TestApplyPolicy:
    def test_disabled_returns_input_order(self) -> None:
        results = [_mk("a", 0.5), _mk("b", 0.9), _mk("c", 0.3)]
        out = apply_policy(results, RerankPolicy.disabled())
        assert [r.id for r in out] == ["a", "b", "c"]
        assert out is not results  # always a fresh list

    def test_enabled_sorts_by_score_desc(self) -> None:
        results = [_mk("a", 0.5), _mk("b", 0.9), _mk("c", 0.3)]
        out = apply_policy(results, RerankPolicy(enabled=True))
        assert [r.id for r in out] == ["b", "a", "c"]

    def test_empty_input(self) -> None:
        assert apply_policy([], RerankPolicy()) == []
