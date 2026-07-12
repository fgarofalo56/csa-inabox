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


@pytest.fixture
def fake_embed(monkeypatch: pytest.MonkeyPatch):
    """Deterministic embeddings: 'a'->[1,0], anything-else->[0,1]. cosine stays real."""

    def _vec(text: str) -> list[float]:
        return [1.0, 0.0] if text.strip() == "a" else [0.0, 1.0]

    def fake_call_embed(texts: list[str]) -> list[list[float]]:
        return [_vec(t) for t in texts]

    monkeypatch.setattr("ai_functions._embed.call_embed", fake_call_embed)
    monkeypatch.setattr("ai_functions.functions.call_embed", fake_call_embed)
    return fake_call_embed


def test_build_system_prompt_keywords() -> None:
    assert "summary" in fns.build_system_prompt("summarize")
    assert "urgent, low" in fns.build_system_prompt("classify", labels=["urgent", "low"])
    assert "positive, negative, or neutral" in fns.build_system_prompt("sentiment")
    assert "name, date" in fns.build_system_prompt("extract", fields=["name", "date"])
    assert "French" in fns.build_system_prompt("translate", target_lang="French")
    assert "grammar" in fns.build_system_prompt("fix_grammar")
    assert "response" in fns.build_system_prompt("generate_response")


def test_scalar_fix_grammar_and_generate_response(echo) -> None:
    assert ai.fix_grammar("teh cat") == "<teh cat>"
    assert ai.generate_response("ping") == "<ping>"
    assert "grammar" in echo[0]["system"]
    assert "response" in echo[1]["system"]


def test_embed_scalar_and_series(fake_embed) -> None:
    assert ai.embed("a") == [1.0, 0.0]
    series = pd.Series(["a", "", "b"], index=[1, 2, 3])
    out = ai.embed(series)
    assert isinstance(out, pd.Series)
    assert list(out.index) == [1, 2, 3]
    assert list(out) == [[1.0, 0.0], [], [0.0, 1.0]]  # empty row skipped, no call


def test_similarity_scalar_and_series(fake_embed) -> None:
    assert ai.similarity("a", compare_to="a") == pytest.approx(1.0)
    assert ai.similarity("b", compare_to="a") == pytest.approx(0.0)
    out = ai.similarity(pd.Series(["a", "b"]), compare_to="a")
    assert list(out) == pytest.approx([1.0, 0.0])


def test_similarity_requires_compare_to() -> None:
    with pytest.raises(ValueError, match="compare_to"):
        ai.similarity("a", compare_to="")


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
