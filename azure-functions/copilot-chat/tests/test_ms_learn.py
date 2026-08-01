"""Tests for the MS Learn fallback retrieval (CSA-0162 Phase 2).

These tests exercise the response parser end-to-end against the same
JSON shapes Microsoft's MCP server is observed to return
(``{"results": [...]}``, plain list, bare hit). The actual network
call is never made — ``ms_learn.search`` is the integration point and
is left to runtime smoke-tests; ``_extract_grounding`` is the unit we
verify here.
"""

from __future__ import annotations

import json
import os
from unittest.mock import patch

import ms_learn  # type: ignore[import-not-found]
import pytest


class _FakePart:
    def __init__(self, text: str) -> None:
        self.text = text


class _FakeResult:
    def __init__(self, parts: list[_FakePart]) -> None:
        self.content = parts


def _wrap(text: str) -> _FakeResult:
    return _FakeResult([_FakePart(text=text)])


# ---------------------------------------------------------------------------
# is_enabled
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("true", True),
        ("True", True),
        ("1", True),
        ("yes", True),
        ("ON", True),
        ("false", False),
        ("0", False),
        ("", False),
        ("anything", False),
    ],
)
def test_is_enabled_truthiness(value: str, expected: bool) -> None:
    with patch.dict(os.environ, {"COPILOT_MS_LEARN_ENABLED": value}):
        assert ms_learn.is_enabled() is expected


def test_is_enabled_unset_defaults_to_false() -> None:
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("COPILOT_MS_LEARN_ENABLED", None)
        assert ms_learn.is_enabled() is False


# ---------------------------------------------------------------------------
# _extract_grounding — shape variants
# ---------------------------------------------------------------------------


def test_extract_results_envelope() -> None:
    payload = (
        '{"results": ['
        '{"title": "ADLS Gen2 lifecycle management", '
        '"content": "Use lifecycle management...", '
        '"contentUrl": "https://learn.microsoft.com/azure/storage/blobs/lifecycle-management"},'
        '{"title": "Hierarchical namespace", '
        '"content": "ADLS Gen2 adds a hierarchical namespace...", '
        '"contentUrl": "https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-namespace"}'
        ']}'
    )
    hits = ms_learn._extract_grounding(_wrap(payload), top_k=5)
    assert len(hits) == 2
    assert hits[0]["title"] == "ADLS Gen2 lifecycle management"
    assert hits[0]["url"].startswith("https://learn.microsoft.com/")
    assert hits[0]["external"] == "true"


def test_extract_plain_list() -> None:
    payload = (
        '['
        '{"title": "A", "url": "https://learn.microsoft.com/a"},'
        '{"title": "B", "url": "https://learn.microsoft.com/b"}'
        ']'
    )
    hits = ms_learn._extract_grounding(_wrap(payload), top_k=5)
    assert [h["title"] for h in hits] == ["A", "B"]


def test_extract_bare_single_hit() -> None:
    payload = '{"title": "Solo", "url": "https://learn.microsoft.com/solo"}'
    hits = ms_learn._extract_grounding(_wrap(payload), top_k=5)
    assert len(hits) == 1
    assert hits[0]["title"] == "Solo"


def test_extract_empty_dict_returns_empty() -> None:
    hits = ms_learn._extract_grounding(_wrap("{}"), top_k=5)
    assert hits == []


def test_extract_top_k_caps_results() -> None:
    items = ",".join(
        f'{{"title": "T{i}", "url": "https://learn.microsoft.com/{i}"}}' for i in range(8)
    )
    payload = f'{{"results": [{items}]}}'
    hits = ms_learn._extract_grounding(_wrap(payload), top_k=3)
    assert len(hits) == 3


# ---------------------------------------------------------------------------
# Safety: URL allowlist + dedupe + cruft stripping
# ---------------------------------------------------------------------------


def test_extract_rejects_non_learn_urls() -> None:
    payload = (
        '{"results": ['
        '{"title": "Bad", "url": "https://attacker.example.com/x"},'
        '{"title": "Good", "url": "https://learn.microsoft.com/good"}'
        ']}'
    )
    hits = ms_learn._extract_grounding(_wrap(payload), top_k=5)
    assert [h["title"] for h in hits] == ["Good"]


def test_extract_dedupes_by_canonical_url() -> None:
    payload = (
        '{"results": ['
        '{"title": "First", "url": "https://learn.microsoft.com/x?source=learn"},'
        '{"title": "Dup", "url": "https://learn.microsoft.com/x#section"},'
        '{"title": "Other", "url": "https://learn.microsoft.com/y"}'
        ']}'
    )
    hits = ms_learn._extract_grounding(_wrap(payload), top_k=5)
    assert [h["title"] for h in hits] == ["First", "Other"]
    # Cruft (query + fragment) stripped from canonical url.
    assert hits[0]["url"] == "https://learn.microsoft.com/x"


def test_extract_skips_hits_without_title_or_url() -> None:
    payload = (
        '{"results": ['
        '{"url": "https://learn.microsoft.com/no-title"},'
        '{"title": "no-url"},'
        '{"title": "ok", "url": "https://learn.microsoft.com/ok"}'
        ']}'
    )
    hits = ms_learn._extract_grounding(_wrap(payload), top_k=5)
    assert [h["title"] for h in hits] == ["ok"]


# ---------------------------------------------------------------------------
# search() entrypoint short-circuits empty / blank queries
# ---------------------------------------------------------------------------


def test_search_empty_query_returns_empty_list() -> None:
    assert ms_learn.search("") == []
    assert ms_learn.search("   ") == []


class TestLearnUrlBoundary:
    """The grounding allowlist must match the HOST, not a string prefix.

    ``url.startswith("https://learn.microsoft.com")`` accepts
    ``https://learn.microsoft.com.evil.test/x`` — the boundary is missing at the
    right-hand end of the host, so any attacker-registered domain whose leftmost
    labels are ``learn.microsoft.com`` passes. These URLs come from a search-API
    response, are fed to the model as grounding, and are surfaced to the user as
    official Microsoft Learn citations, so a poisoned result could launder an
    attacker page through Loom's own citation UI.
    """

    @pytest.mark.parametrize(
        "url",
        [
            "https://learn.microsoft.com/en-us/azure/",
            "https://learn.microsoft.com",
            "https://docs.learn.microsoft.com/x",
            "https://learn.microsoft.com./x",      # root-label trailing dot
            "https://LEARN.MICROSOFT.COM/x",       # host is case-insensitive
        ],
    )
    def test_accepts_real_learn_urls(self, url: str) -> None:
        assert ms_learn._is_learn_url(url) is True

    @pytest.mark.parametrize(
        ("url", "why"),
        [
            ("https://learn.microsoft.com.evil.test/x", "suffix appended on the right"),
            ("https://xlearn.microsoft.com/x", "no label boundary on the left"),
            ("https://notlearn.microsoft.com/x", "different registrable domain"),
            ("https://evil.test/?u=https://learn.microsoft.com", "in the query string"),
            ("https://evil.test/learn.microsoft.com", "in the path"),
            ("https://learn.microsoft.com@evil.test/", "userinfo confusion"),
            ("http://learn.microsoft.com/x", "http downgrade"),
            ("not a url", "unparseable"),
            ("", "empty"),
        ],
    )
    def test_rejects_impostors(self, url: str, why: str) -> None:
        assert ms_learn._is_learn_url(url) is False, why

    def test_extract_grounding_drops_the_impostor(self) -> None:
        """End-to-end through the real extractor, not just the predicate."""
        hits = {
            "results": [
                {"title": "Real", "contentUrl": "https://learn.microsoft.com/a"},
                {"title": "Fake", "contentUrl": "https://learn.microsoft.com.evil.test/b"},
            ]
        }
        out = ms_learn._extract_grounding(_wrap(json.dumps(hits)), top_k=5)
        urls = [g["url"] for g in out]
        assert "https://learn.microsoft.com/a" in urls
        assert not any("evil.test" in u for u in urls)
