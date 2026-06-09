"""Tests for ai_functions._gate — honest reachability probe."""

from __future__ import annotations

import pytest
from ai_functions import _gate
from ai_functions._errors import AoaiBridgeConfigError, AoaiBridgeError


def test_missing_endpoint_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOOM_AOAI_ENDPOINT", raising=False)
    monkeypatch.setattr("ai_functions._gate.get_endpoint", lambda: "")
    with pytest.raises(AoaiBridgeConfigError, match="LOOM_AOAI_ENDPOINT"):
        _gate.check_reachable()


def test_missing_endpoint_soft_returns_false(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    monkeypatch.setattr("ai_functions._gate.get_endpoint", lambda: "")
    assert _gate.check_reachable(raise_on_fail=False) is False
    assert "LOOM_AOAI_ENDPOINT" in capsys.readouterr().out


def test_happy_probe_returns_true(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    monkeypatch.setattr("ai_functions._gate.get_endpoint", lambda: "https://aoai.openai.azure.com")
    monkeypatch.setattr("ai_functions._gate.get_deployment", lambda: "gpt-4o")
    monkeypatch.setattr("ai_functions._gate.call_chat", lambda _s, _u, max_tokens=5: "PONG")
    assert _gate.check_reachable() is True
    assert "reachable" in capsys.readouterr().out


def test_probe_failure_raises_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ai_functions._gate.get_endpoint", lambda: "https://aoai.openai.azure.com")
    monkeypatch.setattr("ai_functions._gate.get_deployment", lambda: "gpt-4o")

    def boom(_s, _u, max_tokens=5):
        raise AoaiBridgeError("401 unauthorized")

    monkeypatch.setattr("ai_functions._gate.call_chat", boom)
    with pytest.raises(AoaiBridgeError, match="401"):
        _gate.check_reachable()


def test_probe_failure_soft_returns_false(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    monkeypatch.setattr("ai_functions._gate.get_endpoint", lambda: "https://aoai.openai.azure.com")
    monkeypatch.setattr("ai_functions._gate.get_deployment", lambda: "gpt-4o")

    def boom(_s, _u, max_tokens=5):
        raise AoaiBridgeError("timeout")

    monkeypatch.setattr("ai_functions._gate.call_chat", boom)
    assert _gate.check_reachable(raise_on_fail=False) is False
    assert "probe failed" in capsys.readouterr().out
