"""Tests for ``csa_platform.ai_integration.semantic_kernel``.

Smoke-level coverage so that:

* The package's public exports stay importable (the prior version
  shipped with no tests; broken imports would never fail CI).
* :meth:`CSAKernelFactory.validate_configuration` returns a sane
  shape and correctly flags missing ``AZURE_OPENAI_ENDPOINT``.
* :meth:`CSAKernelFactory.create_kernel` raises a clean
  :class:`ValueError` (not an obscure attribute error) when no
  endpoint is configured.

We do not exercise live Azure OpenAI here.
"""

from __future__ import annotations

import importlib

import pytest

# Skip the entire suite if the optional `semantic_kernel` extra is not
# installed in the current environment. Must run *before* we touch the
# csa_platform.ai_integration.semantic_kernel package, whose __init__
# imports semantic_kernel at module load time.
pytest.importorskip("semantic_kernel")


def test_public_exports_are_importable() -> None:
    """All names listed in ``__all__`` must resolve."""
    mod = importlib.import_module("csa_platform.ai_integration.semantic_kernel")
    for name in mod.__all__:
        assert hasattr(mod, name), f"{name} listed in __all__ but not exported"


class TestValidateConfiguration:
    def test_flags_missing_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from csa_platform.ai_integration.semantic_kernel.kernel_factory import (
            CSAKernelFactory,
        )

        monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
        result = CSAKernelFactory.validate_configuration()
        assert result["valid"] is False
        assert any("AZURE_OPENAI_ENDPOINT" in e for e in result["errors"])

    def test_returns_config_when_endpoint_present(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from csa_platform.ai_integration.semantic_kernel.kernel_factory import (
            CSAKernelFactory,
        )

        monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com/")
        result = CSAKernelFactory.validate_configuration()
        assert result["config"]["endpoint"] == "https://example.openai.azure.com/"
        assert "chat_deployment" in result["config"]
        assert "embedding_deployment" in result["config"]


class TestCreateKernel:
    def test_raises_value_error_when_no_endpoint(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from csa_platform.ai_integration.semantic_kernel.kernel_factory import (
            CSAKernelFactory,
        )

        monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
        with pytest.raises(ValueError, match="endpoint"):
            CSAKernelFactory.create_kernel(endpoint=None)


class TestStoragePlugin:
    def test_clients_are_lazy_when_no_account_url(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from csa_platform.ai_integration.semantic_kernel.plugins.storage import (
            StoragePlugin,
        )

        monkeypatch.setattr(
            "csa_platform.ai_integration.semantic_kernel.plugins.storage.DefaultAzureCredential",
            lambda: object(),
        )
        plugin = StoragePlugin(storage_account_url=None)
        # Lazy properties should yield None when no URL is configured
        # rather than crashing at construction time.
        assert plugin.blob_service_client is None
