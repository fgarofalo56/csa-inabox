"""Tests for csa_platform.common.azure_clients.

Covers:
- _is_government_cloud flag reading (env var true/1/false/absent)
- get_credential caching (same object returned on repeated calls)
- get_async_credential returns a fresh instance each call
- get_blob_client URL construction (commercial + government)
- get_keyvault_client delegation
- get_cosmos_client delegation
- get_search_client delegation
- get_purview_client URL construction (commercial + government)
- get_monitor_ingestion_client delegation
- module re-export from csa_platform.common

Mocking strategy
----------------
All Azure SDK constructors are patched so that no real credentials,
network access, or installed Azure packages beyond azure-identity are
required.  The lru_cache on ``get_credential`` is cleared before each
test to keep tests independent.
"""

from __future__ import annotations

import importlib
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _reload_module() -> Any:
    """Re-import azure_clients so lru_cache state is fresh for each test."""
    import csa_platform.common.azure_clients as mod

    importlib.reload(mod)
    return mod


@pytest.fixture(autouse=True)
def _clear_lru_cache() -> None:  # type: ignore[return]
    """Clear the get_credential lru_cache before every test."""
    import csa_platform.common.azure_clients as mod

    mod.get_credential.cache_clear()
    yield  # type: ignore[misc]
    mod.get_credential.cache_clear()


# ---------------------------------------------------------------------------
# _is_government_cloud
# ---------------------------------------------------------------------------


class TestIsGovernmentCloud:
    """Unit tests for the _is_government_cloud() helper."""

    def test_returns_false_when_env_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("IS_GOVERNMENT_CLOUD", raising=False)
        from csa_platform.common.azure_clients import _is_government_cloud

        assert _is_government_cloud() is False

    def test_returns_true_for_lowercase_true(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IS_GOVERNMENT_CLOUD", "true")
        from csa_platform.common.azure_clients import _is_government_cloud

        assert _is_government_cloud() is True

    def test_returns_true_for_uppercase_true(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IS_GOVERNMENT_CLOUD", "TRUE")
        from csa_platform.common.azure_clients import _is_government_cloud

        assert _is_government_cloud() is True

    def test_returns_true_for_digit_1(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IS_GOVERNMENT_CLOUD", "1")
        from csa_platform.common.azure_clients import _is_government_cloud

        assert _is_government_cloud() is True

    def test_returns_false_for_false_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IS_GOVERNMENT_CLOUD", "false")
        from csa_platform.common.azure_clients import _is_government_cloud

        assert _is_government_cloud() is False

    def test_returns_false_for_zero_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IS_GOVERNMENT_CLOUD", "0")
        from csa_platform.common.azure_clients import _is_government_cloud

        assert _is_government_cloud() is False

    def test_returns_false_for_empty_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IS_GOVERNMENT_CLOUD", "")
        from csa_platform.common.azure_clients import _is_government_cloud

        assert _is_government_cloud() is False


# ---------------------------------------------------------------------------
# get_credential
# ---------------------------------------------------------------------------


class TestGetCredential:
    """Tests for get_credential (sync, lru_cache behaviour)."""

    def test_returns_default_azure_credential_instance(self) -> None:
        mock_cred = MagicMock()
        with patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=mock_cred):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            result = azure_clients.get_credential()
            assert result is mock_cred

    def test_same_instance_returned_on_repeated_calls(self) -> None:
        """lru_cache ensures the credential is created exactly once."""
        call_count = 0
        instances: list[MagicMock] = []

        def _factory() -> MagicMock:
            nonlocal call_count
            call_count += 1
            obj = MagicMock()
            instances.append(obj)
            return obj

        with patch("csa_platform.common.azure_clients.DefaultAzureCredential", side_effect=_factory):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            first = azure_clients.get_credential()
            second = azure_clients.get_credential()
            third = azure_clients.get_credential()

        assert call_count == 1
        assert first is second is third


# ---------------------------------------------------------------------------
# get_async_credential
# ---------------------------------------------------------------------------


class TestGetAsyncCredential:
    """Tests for get_async_credential (not cached)."""

    def test_returns_async_credential_instance(self) -> None:
        mock_cred = MagicMock()
        with patch("csa_platform.common.azure_clients.AsyncDefaultAzureCredential", return_value=mock_cred):
            from csa_platform.common.azure_clients import get_async_credential

            result = get_async_credential()
            assert result is mock_cred

    def test_new_instance_each_call(self) -> None:
        """Async credential must not be cached — event-loop lifetime concerns."""
        instances: list[MagicMock] = []

        def _factory() -> MagicMock:
            obj = MagicMock()
            instances.append(obj)
            return obj

        with patch("csa_platform.common.azure_clients.AsyncDefaultAzureCredential", side_effect=_factory):
            from csa_platform.common.azure_clients import get_async_credential

            first = get_async_credential()
            second = get_async_credential()

        assert len(instances) == 2
        assert first is not second


# ---------------------------------------------------------------------------
# get_blob_client
# ---------------------------------------------------------------------------


class TestGetBlobClient:
    """Tests for get_blob_client URL construction."""

    def test_commercial_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("IS_GOVERNMENT_CLOUD", raising=False)
        mock_client_cls = MagicMock()
        mock_cred = MagicMock()

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=mock_cred),
            patch("azure.storage.blob.BlobServiceClient", mock_client_cls),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_blob_client("myaccount")

        # The URL is the first positional argument
        assert "myaccount.blob.core.windows.net" in mock_client_cls.call_args[0][0]

    def test_government_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IS_GOVERNMENT_CLOUD", "true")
        mock_client_cls = MagicMock()
        mock_cred = MagicMock()

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=mock_cred),
            patch("azure.storage.blob.BlobServiceClient", mock_client_cls),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_blob_client("govaccount")

        assert "govaccount.blob.core.usgovcloudapi.net" in mock_client_cls.call_args[0][0]

    def test_passes_kwargs(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("IS_GOVERNMENT_CLOUD", raising=False)
        mock_client_cls = MagicMock()

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch("azure.storage.blob.BlobServiceClient", mock_client_cls),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_blob_client("myaccount", max_block_size=4 * 1024 * 1024)

        _, kwargs = mock_client_cls.call_args
        assert kwargs["max_block_size"] == 4 * 1024 * 1024

    def test_returns_client_instance(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("IS_GOVERNMENT_CLOUD", raising=False)
        sentinel = MagicMock()
        mock_client_cls = MagicMock(return_value=sentinel)

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch("azure.storage.blob.BlobServiceClient", mock_client_cls),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            result = azure_clients.get_blob_client("acc")

        assert result is sentinel


# ---------------------------------------------------------------------------
# get_keyvault_client
# ---------------------------------------------------------------------------


class TestGetKeyvaultClient:
    """Tests for get_keyvault_client."""

    def test_passes_vault_url(self) -> None:
        mock_cls = MagicMock()
        vault_url = "https://myvault.vault.azure.net"

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch("azure.keyvault.secrets.SecretClient", mock_cls),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_keyvault_client(vault_url)

        _, kwargs = mock_cls.call_args
        assert kwargs["vault_url"] == vault_url

    def test_passes_kwargs(self) -> None:
        mock_cls = MagicMock()

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch("azure.keyvault.secrets.SecretClient", mock_cls),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_keyvault_client("https://vault.vault.azure.net", api_version="7.4")

        _, kwargs = mock_cls.call_args
        assert kwargs["api_version"] == "7.4"


# ---------------------------------------------------------------------------
# get_cosmos_client
# ---------------------------------------------------------------------------


class TestGetCosmosClient:
    """Tests for get_cosmos_client."""

    def test_passes_endpoint_as_url(self) -> None:
        mock_cls = MagicMock()
        endpoint = "https://myaccount.documents.azure.com:443"

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch("azure.cosmos.CosmosClient", mock_cls),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_cosmos_client(endpoint)

        _, kwargs = mock_cls.call_args
        assert kwargs["url"] == endpoint

    def test_credential_forwarded(self) -> None:
        mock_cls = MagicMock()
        mock_cred = MagicMock()

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=mock_cred),
            patch("azure.cosmos.CosmosClient", mock_cls),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_cosmos_client("https://acc.documents.azure.com:443")

        _, kwargs = mock_cls.call_args
        assert kwargs["credential"] is mock_cred


# ---------------------------------------------------------------------------
# get_search_client
# ---------------------------------------------------------------------------


class TestGetSearchClient:
    """Tests for get_search_client."""

    def test_passes_endpoint_and_index(self) -> None:
        mock_cls = MagicMock()
        endpoint = "https://mysearch.search.windows.net"
        index = "csa-rag-index"

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch("azure.search.documents.SearchClient", mock_cls),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_search_client(endpoint, index)

        _, kwargs = mock_cls.call_args
        assert kwargs["endpoint"] == endpoint
        assert kwargs["index_name"] == index

    def test_passes_extra_kwargs(self) -> None:
        mock_cls = MagicMock()

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch("azure.search.documents.SearchClient", mock_cls),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_search_client(
                "https://s.search.windows.net",
                "idx",
                retry_total=3,
            )

        _, kwargs = mock_cls.call_args
        assert kwargs["retry_total"] == 3


# ---------------------------------------------------------------------------
# get_purview_client
# ---------------------------------------------------------------------------


def _make_purview_modules(mock_cls: MagicMock) -> dict[str, Any]:
    """Build a minimal sys.modules shim for azure.purview.catalog."""
    import sys
    import types

    # Only add shims for modules not already present (package not installed here).
    shims: dict[str, Any] = {}
    if "azure.purview" not in sys.modules:
        purview_mod = types.ModuleType("azure.purview")
        shims["azure.purview"] = purview_mod
    if "azure.purview.catalog" not in sys.modules:
        catalog_mod = types.ModuleType("azure.purview.catalog")
        catalog_mod.PurviewCatalogClient = mock_cls  # type: ignore[attr-defined]
        shims["azure.purview.catalog"] = catalog_mod
    return shims


def _make_monitor_modules(mock_cls: MagicMock) -> dict[str, Any]:
    """Build a minimal sys.modules shim for azure.monitor.ingestion."""
    import sys
    import types

    shims: dict[str, Any] = {}
    if "azure.monitor" not in sys.modules:
        monitor_mod = types.ModuleType("azure.monitor")
        shims["azure.monitor"] = monitor_mod
    if "azure.monitor.ingestion" not in sys.modules:
        ingestion_mod = types.ModuleType("azure.monitor.ingestion")
        ingestion_mod.LogsIngestionClient = mock_cls  # type: ignore[attr-defined]
        shims["azure.monitor.ingestion"] = ingestion_mod
    return shims


class TestGetPurviewClient:
    """Tests for get_purview_client URL construction."""

    def test_commercial_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("IS_GOVERNMENT_CLOUD", raising=False)
        mock_cls = MagicMock()
        shims = _make_purview_modules(mock_cls)

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch.dict("sys.modules", shims),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_purview_client("purview-prod")

        _, kwargs = mock_cls.call_args
        assert kwargs["endpoint"] == "https://purview-prod.purview.azure.com"

    def test_government_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IS_GOVERNMENT_CLOUD", "true")
        mock_cls = MagicMock()
        shims = _make_purview_modules(mock_cls)

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch.dict("sys.modules", shims),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_purview_client("purview-gov")

        _, kwargs = mock_cls.call_args
        assert kwargs["endpoint"] == "https://purview-gov.purview.azure.us"

    def test_passes_kwargs(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("IS_GOVERNMENT_CLOUD", raising=False)
        mock_cls = MagicMock()
        shims = _make_purview_modules(mock_cls)

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch.dict("sys.modules", shims),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_purview_client("acct", api_version="2022-08-01")

        _, kwargs = mock_cls.call_args
        assert kwargs["api_version"] == "2022-08-01"

    def test_raises_import_error_when_package_missing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When azure-purview-catalog is absent the factory propagates ImportError."""
        monkeypatch.delenv("IS_GOVERNMENT_CLOUD", raising=False)
        import sys

        # Ensure azure.purview.catalog is NOT in sys.modules so the import inside
        # get_purview_client will trigger the real ImportError path.
        saved = {k: sys.modules.pop(k) for k in list(sys.modules) if "azure.purview" in k}
        try:
            import builtins
            real_import = builtins.__import__

            def _block_purview(name: str, *args: Any, **kw: Any) -> Any:
                if "azure.purview.catalog" in name:
                    raise ImportError("azure-purview-catalog not installed")
                return real_import(name, *args, **kw)

            with patch("builtins.__import__", side_effect=_block_purview):
                from csa_platform.common import azure_clients

                azure_clients.get_credential.cache_clear()
                with pytest.raises(ImportError):
                    azure_clients.get_purview_client("purview-prod")
        finally:
            sys.modules.update(saved)


# ---------------------------------------------------------------------------
# get_monitor_ingestion_client
# ---------------------------------------------------------------------------


class TestGetMonitorIngestionClient:
    """Tests for get_monitor_ingestion_client."""

    def test_passes_endpoint(self) -> None:
        mock_cls = MagicMock()
        endpoint = "https://my-dce.eastus-1.ingest.monitor.azure.com"
        shims = _make_monitor_modules(mock_cls)

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch.dict("sys.modules", shims),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_monitor_ingestion_client(endpoint)

        _args, kwargs = mock_cls.call_args
        assert kwargs["endpoint"] == endpoint

    def test_passes_kwargs(self) -> None:
        mock_cls = MagicMock()
        shims = _make_monitor_modules(mock_cls)

        with (
            patch("csa_platform.common.azure_clients.DefaultAzureCredential", return_value=MagicMock()),
            patch.dict("sys.modules", shims),
        ):
            from csa_platform.common import azure_clients

            azure_clients.get_credential.cache_clear()
            azure_clients.get_monitor_ingestion_client(
                "https://dce.ingest.monitor.azure.com",
                retry_total=5,
            )

        _, kwargs = mock_cls.call_args
        assert kwargs["retry_total"] == 5


# ---------------------------------------------------------------------------
# Module re-export from csa_platform.common
# ---------------------------------------------------------------------------


class TestModuleExport:
    """Verify azure_clients is accessible via csa_platform.common."""

    def test_azure_clients_in_all(self) -> None:
        import csa_platform.common as common

        assert "azure_clients" in common.__all__

    def test_azure_clients_attribute_accessible(self) -> None:
        import csa_platform.common as common

        assert hasattr(common, "azure_clients")

    def test_factory_functions_importable(self) -> None:
        from csa_platform.common.azure_clients import (
            get_async_credential,
            get_blob_client,
            get_cosmos_client,
            get_credential,
            get_keyvault_client,
            get_monitor_ingestion_client,
            get_purview_client,
            get_search_client,
        )

        for fn in (
            get_credential,
            get_async_credential,
            get_blob_client,
            get_keyvault_client,
            get_cosmos_client,
            get_search_client,
            get_purview_client,
            get_monitor_ingestion_client,
        ):
            assert callable(fn)
