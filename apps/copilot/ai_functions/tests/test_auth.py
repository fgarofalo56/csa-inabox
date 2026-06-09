"""Tests for ai_functions._auth — api-key bypass, token cache, UAMI chain."""

from __future__ import annotations

import pytest


@pytest.fixture
def auth(monkeypatch: pytest.MonkeyPatch):
    import ai_functions._auth as mod

    mod.reset_token_cache()
    for var in ("LOOM_AOAI_KEY", "LOOM_AOAI_AUDIENCE", "LOOM_UAMI_CLIENT_ID", "AZURE_CLIENT_ID"):
        monkeypatch.delenv(var, raising=False)
    return mod


def test_api_key_set_returns_none(auth, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOM_AOAI_KEY", "k")
    assert auth.get_bearer_token() is None


def test_token_acquired_and_cached(auth, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}

    class _Tok:
        token = "abc.def"
        expires_on = 9_999_999_999

    class _Cred:
        def __init__(self, *a, **k) -> None: ...
        def get_token(self, *scopes):
            calls["n"] += 1
            return _Tok()

    import azure.identity as ident

    monkeypatch.setattr(ident, "DefaultAzureCredential", _Cred)

    first = auth.get_bearer_token()
    second = auth.get_bearer_token()
    assert first == "abc.def"
    assert second == "abc.def"
    assert calls["n"] == 1  # second call served from cache


def test_uami_uses_chained_credential(auth, monkeypatch: pytest.MonkeyPatch) -> None:
    used = {"chained": False, "scope": None}

    class _Tok:
        token = "uami-token"
        expires_on = 9_999_999_999

    class _MI:
        def __init__(self, *a, **k) -> None: ...

    class _Default:
        def __init__(self, *a, **k) -> None: ...

    class _Chained:
        def __init__(self, *creds) -> None:
            used["chained"] = True

        def get_token(self, scope):
            used["scope"] = scope
            return _Tok()

    import azure.identity as ident

    monkeypatch.setattr(ident, "ManagedIdentityCredential", _MI)
    monkeypatch.setattr(ident, "DefaultAzureCredential", _Default)
    monkeypatch.setattr(ident, "ChainedTokenCredential", _Chained)
    monkeypatch.setenv("LOOM_UAMI_CLIENT_ID", "uami-123")

    token = auth.get_bearer_token()
    assert token == "uami-token"
    assert used["chained"] is True
    assert used["scope"] == "https://cognitiveservices.azure.com/.default"


def test_token_failure_raises_actionable_error(auth, monkeypatch: pytest.MonkeyPatch) -> None:
    class _Cred:
        def __init__(self, *a, **k) -> None: ...
        def get_token(self, *scopes):
            raise RuntimeError("no identity")

    import azure.identity as ident

    monkeypatch.setattr(ident, "DefaultAzureCredential", _Cred)

    with pytest.raises(auth.AoaiBridgeAuthError, match="Cognitive Services OpenAI User"):
        auth.get_bearer_token()


def test_sovereign_audience_in_scope(auth, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = {"scope": None}

    class _Tok:
        token = "t"
        expires_on = 9_999_999_999

    class _Cred:
        def __init__(self, *a, **k) -> None: ...
        def get_token(self, scope):
            seen["scope"] = scope
            return _Tok()

    import azure.identity as ident

    monkeypatch.setattr(ident, "DefaultAzureCredential", _Cred)
    monkeypatch.setenv("LOOM_AOAI_AUDIENCE", "https://cognitiveservices.azure.us")

    auth.get_bearer_token()
    assert seen["scope"] == "https://cognitiveservices.azure.us/.default"
