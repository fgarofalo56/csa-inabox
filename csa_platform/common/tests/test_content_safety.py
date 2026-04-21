"""Tests for :mod:`csa_platform.common.content_safety`."""

from __future__ import annotations

from typing import Any

import pytest

from csa_platform.common import content_safety
from csa_platform.common.content_safety import (
    ContentSafetyBlockedError,
    ContentSafetyCategory,
    ContentSafetyPolicy,
    ContentSafetyVerdict,
    NoopContentSafetyClient,
    _AzureContentSafetyClient,
    apply_policy,
    build_content_safety_client,
)

# ---------------------------------------------------------------------------
# Noop client
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_noop_client_passes_everything() -> None:
    client = NoopContentSafetyClient()
    verdict = await client.analyze_text("anything goes, including profanity and more")
    assert verdict.allowed is True
    assert verdict.categories_triggered == []
    assert all(score == 0 for score in verdict.severity_scores.values())
    await client.close()


@pytest.mark.asyncio
async def test_noop_client_empty_input() -> None:
    client = NoopContentSafetyClient()
    verdict = await client.analyze_text("")
    assert verdict.allowed is True


# ---------------------------------------------------------------------------
# Policy application
# ---------------------------------------------------------------------------


def test_policy_allows_when_below_threshold() -> None:
    verdict = ContentSafetyVerdict(
        allowed=True,
        categories_triggered=[],
        severity_scores={"Hate": 2, "Sexual": 0, "Violence": 0, "SelfHarm": 0},
    )
    policy = ContentSafetyPolicy(hate=4, sexual=4, violence=4, selfharm=4)
    assert apply_policy(verdict, policy) is True


def test_policy_blocks_when_at_or_above_threshold() -> None:
    verdict = ContentSafetyVerdict(
        allowed=False,
        categories_triggered=["Hate"],
        severity_scores={"Hate": 4, "Sexual": 0, "Violence": 0, "SelfHarm": 0},
    )
    policy = ContentSafetyPolicy(hate=4)
    assert apply_policy(verdict, policy) is False


def test_policy_block_raises_when_requested() -> None:
    verdict = ContentSafetyVerdict(
        allowed=False,
        categories_triggered=["Violence"],
        severity_scores={"Violence": 6},
    )
    policy = ContentSafetyPolicy(violence=4)
    with pytest.raises(ContentSafetyBlockedError) as excinfo:
        apply_policy(verdict, policy, raise_on_block=True)
    assert excinfo.value.verdict is verdict
    assert excinfo.value.policy is policy


def test_policy_disabled_category_ignored() -> None:
    verdict = ContentSafetyVerdict(
        allowed=False,
        categories_triggered=["Sexual"],
        severity_scores={"Sexual": 6},
    )
    # sexual=None means the category is disabled entirely
    policy = ContentSafetyPolicy(hate=4, sexual=None, violence=4, selfharm=4)
    assert apply_policy(verdict, policy) is True


def test_policy_threshold_for_case_insensitive() -> None:
    policy = ContentSafetyPolicy(hate=4)
    assert policy.threshold_for("HATE") == 4
    assert policy.threshold_for("Hate") == 4
    assert policy.threshold_for("unknown") is None


def test_verdict_is_frozen() -> None:
    import dataclasses

    verdict = ContentSafetyVerdict(allowed=True)
    with pytest.raises(dataclasses.FrozenInstanceError):
        verdict.allowed = False  # type: ignore[misc]


def test_policy_is_frozen() -> None:
    import dataclasses

    policy = ContentSafetyPolicy()
    with pytest.raises(dataclasses.FrozenInstanceError):
        policy.hate = 2  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Azure client (mocked)
# ---------------------------------------------------------------------------


class _FakeCategoryResult:
    def __init__(self, category: str, severity: int) -> None:
        self.category = category
        self.severity = severity


class _FakeAnalyzeResponse:
    def __init__(self, items: list[_FakeCategoryResult]) -> None:
        self.categories_analysis = items


class _FakeSdkClient:
    """Stand-in for ``azure.ai.contentsafety.aio.ContentSafetyClient``."""

    def __init__(self, response: _FakeAnalyzeResponse) -> None:
        self._response = response
        self.closed = False

    async def analyze_text(self, options: Any) -> _FakeAnalyzeResponse:
        return self._response

    async def close(self) -> None:
        self.closed = True


def _install_fake_sdk(
    monkeypatch: pytest.MonkeyPatch,
    response: _FakeAnalyzeResponse,
) -> dict[str, Any]:
    """Inject a fake azure.ai.contentsafety module tree into sys.modules."""
    import sys
    from types import ModuleType

    captured: dict[str, Any] = {"client_instances": []}

    class _FakeSdkClientFactory(_FakeSdkClient):
        def __init__(self, *, endpoint: str, credential: Any) -> None:
            super().__init__(response=response)
            self.endpoint = endpoint
            self.credential = credential
            captured["client_instances"].append(self)

    class _FakeAzureKeyCredential:
        def __init__(self, key: str) -> None:
            self.key = key

    class _FakeAnalyzeTextOptions:
        def __init__(self, text: str) -> None:
            self.text = text

    # ``azure.ai.contentsafety.aio``
    contentsafety_mod = ModuleType("azure.ai.contentsafety")
    contentsafety_aio_mod = ModuleType("azure.ai.contentsafety.aio")
    contentsafety_aio_mod.ContentSafetyClient = _FakeSdkClientFactory  # type: ignore[attr-defined]
    # ``azure.ai.contentsafety.models``
    contentsafety_models_mod = ModuleType("azure.ai.contentsafety.models")
    contentsafety_models_mod.AnalyzeTextOptions = _FakeAnalyzeTextOptions  # type: ignore[attr-defined]
    # ``azure.core.credentials``
    core_credentials_mod = ModuleType("azure.core.credentials")
    core_credentials_mod.AzureKeyCredential = _FakeAzureKeyCredential  # type: ignore[attr-defined]

    # Parent packages — only register if missing
    for parent in ("azure", "azure.ai", "azure.core"):
        if parent not in sys.modules:
            sys.modules[parent] = ModuleType(parent)

    monkeypatch.setitem(sys.modules, "azure.ai.contentsafety", contentsafety_mod)
    monkeypatch.setitem(sys.modules, "azure.ai.contentsafety.aio", contentsafety_aio_mod)
    monkeypatch.setitem(sys.modules, "azure.ai.contentsafety.models", contentsafety_models_mod)
    monkeypatch.setitem(sys.modules, "azure.core.credentials", core_credentials_mod)
    return captured


@pytest.mark.asyncio
async def test_azure_client_parses_clean_response(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _FakeAnalyzeResponse(
        [
            _FakeCategoryResult(ContentSafetyCategory.HATE, 0),
            _FakeCategoryResult(ContentSafetyCategory.SEXUAL, 0),
            _FakeCategoryResult(ContentSafetyCategory.VIOLENCE, 0),
            _FakeCategoryResult(ContentSafetyCategory.SELFHARM, 0),
        ],
    )
    _install_fake_sdk(monkeypatch, response)
    client = _AzureContentSafetyClient(endpoint="https://cs.cognitiveservices.azure.com", key="test-key")
    verdict = await client.analyze_text("hello world")
    assert verdict.allowed is True
    assert verdict.categories_triggered == []
    assert verdict.severity_scores[ContentSafetyCategory.HATE] == 0
    await client.close()


@pytest.mark.asyncio
async def test_azure_client_parses_flagged_response(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _FakeAnalyzeResponse(
        [
            _FakeCategoryResult(ContentSafetyCategory.HATE, 4),
            _FakeCategoryResult(ContentSafetyCategory.VIOLENCE, 2),
        ],
    )
    _install_fake_sdk(monkeypatch, response)
    client = _AzureContentSafetyClient(endpoint="https://cs.cognitiveservices.azure.com", key="k")
    verdict = await client.analyze_text("nasty input")
    assert verdict.allowed is False
    assert ContentSafetyCategory.HATE in verdict.categories_triggered
    assert ContentSafetyCategory.VIOLENCE in verdict.categories_triggered
    assert verdict.severity_scores[ContentSafetyCategory.HATE] == 4


@pytest.mark.asyncio
async def test_azure_client_translates_sdk_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    # Patch _get_client to return a client that raises on analyze_text
    class _RaisingClient:
        async def analyze_text(self, options: Any) -> Any:
            raise RuntimeError("boom")

        async def close(self) -> None:
            return None

    _install_fake_sdk(monkeypatch, _FakeAnalyzeResponse([]))

    client = _AzureContentSafetyClient(endpoint="https://cs.cognitiveservices.azure.com", key="k")

    async def _raise_client() -> Any:
        return _RaisingClient()

    monkeypatch.setattr(client, "_get_client", _raise_client)
    with pytest.raises(content_safety.ContentSafetyError):
        await client.analyze_text("anything")


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def test_factory_returns_noop_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CONTENT_SAFETY_ENABLED", raising=False)
    client = build_content_safety_client()
    assert isinstance(client, NoopContentSafetyClient)


def test_factory_returns_noop_when_flag_false(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTENT_SAFETY_ENABLED", "false")
    client = build_content_safety_client()
    assert isinstance(client, NoopContentSafetyClient)


def test_factory_returns_noop_when_endpoint_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTENT_SAFETY_ENABLED", "true")
    monkeypatch.delenv("CONTENT_SAFETY_ENDPOINT", raising=False)
    client = build_content_safety_client()
    assert isinstance(client, NoopContentSafetyClient)


def test_factory_returns_azure_client_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTENT_SAFETY_ENABLED", "true")
    monkeypatch.setenv("CONTENT_SAFETY_ENDPOINT", "https://cs.cognitiveservices.azure.com")
    monkeypatch.setenv("CONTENT_SAFETY_KEY", "test-key")
    client = build_content_safety_client()
    assert isinstance(client, _AzureContentSafetyClient)


def test_factory_prefers_managed_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTENT_SAFETY_ENABLED", "true")
    monkeypatch.setenv("CONTENT_SAFETY_ENDPOINT", "https://cs.cognitiveservices.azure.com")
    monkeypatch.delenv("CONTENT_SAFETY_KEY", raising=False)
    client = build_content_safety_client()
    assert isinstance(client, _AzureContentSafetyClient)
    assert client._key is None
