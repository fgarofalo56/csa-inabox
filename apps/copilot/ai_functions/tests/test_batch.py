"""Tests for ai_functions._batch — order, empty-row skip, index, fail-loud."""

from __future__ import annotations

import pandas as pd
import pytest
from ai_functions import _batch
from ai_functions._errors import AoaiBridgeError


def test_preserves_order_and_index(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ai_functions._batch.call_chat", lambda _s, u, max_tokens=800: u.upper())
    series = pd.Series(["a", "b", "c"], index=["r1", "r2", "r3"])
    out = _batch.batch_call(series, "summarize", {"max_tokens": 10})
    assert list(out) == ["A", "B", "C"]
    assert list(out.index) == ["r1", "r2", "r3"]


def test_empty_and_non_string_rows_skip_call(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}

    def fake(_s, u, max_tokens=800):
        calls["n"] += 1
        return u.upper()

    monkeypatch.setattr("ai_functions._batch.call_chat", fake)
    series = pd.Series(["hello", "", None, "  ", "world"])
    out = _batch.batch_call(series, "summarize", {})
    assert list(out) == ["HELLO", "", "", "", "WORLD"]
    assert calls["n"] == 2  # only the two non-blank strings hit AOAI


def test_failure_propagates_not_silent(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_s, _u, max_tokens=800):
        raise AoaiBridgeError("backend down")

    monkeypatch.setattr("ai_functions._batch.call_chat", boom)
    series = pd.Series(["x", "y"])
    with pytest.raises(AoaiBridgeError, match="backend down"):
        _batch.batch_call(series, "classify", {})


def test_empty_series_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ai_functions._batch.call_chat", lambda _s, _u, max_tokens=800: "x")
    out = _batch.batch_call(pd.Series([], dtype=object), "summarize", {})
    assert len(out) == 0


def test_worker_count_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOM_AI_FN_WORKERS", "4")
    assert _batch._worker_count() == 4
    monkeypatch.setenv("LOOM_AI_FN_WORKERS", "0")
    assert _batch._worker_count() == 8  # invalid -> default
    monkeypatch.delenv("LOOM_AI_FN_WORKERS", raising=False)
    assert _batch._worker_count() == 8
