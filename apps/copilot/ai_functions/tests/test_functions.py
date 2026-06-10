"""Tests for ai_functions.functions — prompts + scalar/Series dispatch.

call_chat is monkeypatched so dispatch is verified without a live AOAI call.
"""

from __future__ import annotations

import ai_functions as ai
import pandas as pd
import pytest
from ai_functions import functions as fns


@pytest.fixture
def echo(monkeypatch: pytest.MonkeyPatch):
    """Replace call_chat everywhere it is used with an echoing fake."""
    seen = []

    def fake_call_chat(system_prompt: str, user_text: str, max_tokens: int = 800) -> str:
        seen.append({"system": system_prompt, "user": user_text, "max_tokens": max_tokens})
        return f"<{user_text}>"

    monkeypatch.setattr("ai_functions._client.call_chat", fake_call_chat)
    monkeypatch.setattr("ai_functions.functions.call_chat", fake_call_chat)
    monkeypatch.setattr("ai_functions._batch.call_chat", fake_call_chat)
    return seen


def test_build_system_prompt_keywords() -> None:
    assert "summary" in fns.build_system_prompt("summarize")
    assert "urgent, low" in fns.build_system_prompt("classify", labels=["urgent", "low"])
    assert "positive, negative, or neutral" in fns.build_system_prompt("sentiment")
    assert "name, date" in fns.build_system_prompt("extract", fields=["name", "date"])
    assert "French" in fns.build_system_prompt("translate", target_lang="French")


def test_unknown_function_raises() -> None:
    with pytest.raises(ValueError, match="Unknown AI function"):
        fns.build_system_prompt("nope")


def test_scalar_classify(echo) -> None:
    out = ai.classify("server on fire", labels=["urgent", "low"])
    assert out == "<server on fire>"
    assert "urgent, low" in echo[0]["system"]
    assert echo[0]["max_tokens"] == 50


def test_scalar_summarize_passes_max_tokens(echo) -> None:
    ai.summarize("long text", max_tokens=120)
    assert echo[0]["max_tokens"] == 120


def test_series_classify_returns_aligned_series(echo) -> None:
    series = pd.Series(["a", "b", "c"], index=[10, 20, 30])
    out = ai.classify(series, labels=["x", "y"])
    assert isinstance(out, pd.Series)
    assert list(out.index) == [10, 20, 30]
    assert list(out) == ["<a>", "<b>", "<c>"]


def test_series_extract_each_row(echo) -> None:
    series = pd.Series(["row1", "row2"])
    out = ai.extract(series, fields=["k"])
    assert list(out) == ["<row1>", "<row2>"]
    assert all("k" in c["system"] for c in echo)
