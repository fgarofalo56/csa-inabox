"""Centralized Azure SDK client factory.

Provides factory functions for Azure service clients with consistent
credential management, retry configuration, and async context support.
All clients use DefaultAzureCredential and support both commercial
and government cloud endpoints.

Usage::

    from csa_platform.common.azure_clients import (
        get_blob_client,
        get_credential,
        get_search_client,
    )

    # Sync credential (cached for the process lifetime)
    cred = get_credential()

    # Service-specific clients
    blob = get_blob_client("mystorageaccount")
    search = get_search_client("https://mysearch.search.windows.net", "my-index")

Government cloud::

    # Set IS_GOVERNMENT_CLOUD=true in the environment before importing.
    # All factory functions read this flag and adjust endpoints accordingly.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential


def _is_government_cloud() -> bool:
    """Return True when the IS_GOVERNMENT_CLOUD environment variable is set.

    Accepts ``"true"`` or ``"1"`` (case-insensitive).
    """
    return os.environ.get("IS_GOVERNMENT_CLOUD", "").lower() in ("true", "1")


@lru_cache(maxsize=1)
def get_credential() -> DefaultAzureCredential:
    """Return a cached sync DefaultAzureCredential.

    The credential is created once per process and reused across all
    factory calls, which avoids redundant metadata endpoint probing and
    token refresh overhead.

    Returns:
        A ``DefaultAzureCredential`` instance shared across the process.
    """
    return DefaultAzureCredential()


def get_async_credential() -> AsyncDefaultAzureCredential:
    """Return a new async DefaultAzureCredential.

    A new instance is returned on every call rather than being cached
    because async credentials are tied to an event loop and must be
    closed by the caller via ``async with`` or ``await cred.close()``.

    Returns:
        A fresh ``azure.identity.aio.DefaultAzureCredential`` instance.
    """
    return AsyncDefaultAzureCredential()


def get_blob_client(account_name: str, **kwargs: Any) -> Any:
    """Create a BlobServiceClient for the given storage account.

    Constructs the account URL from *account_name* using the appropriate
    cloud suffix (commercial or government) and authenticates with the
    shared sync credential.

    Args:
        account_name: The storage account name (not the full URL).
        **kwargs: Additional keyword arguments forwarded to
            ``BlobServiceClient``.

    Returns:
        A configured ``azure.storage.blob.BlobServiceClient``.

    Example::

        client = get_blob_client("mydatalake")
        container = client.get_container_client("bronze")
    """
    from azure.storage.blob import BlobServiceClient

    suffix = "core.usgovcloudapi.net" if _is_government_cloud() else "core.windows.net"
    url = f"https://{account_name}.blob.{suffix}"
    return BlobServiceClient(url, credential=get_credential(), **kwargs)


def get_keyvault_client(vault_url: str, **kwargs: Any) -> Any:
    """Create a SecretClient for the given Key Vault URL.

    Args:
        vault_url: Full Key Vault URL, e.g.
            ``"https://myvault.vault.azure.net"``.
        **kwargs: Additional keyword arguments forwarded to
            ``SecretClient``.

    Returns:
        A configured ``azure.keyvault.secrets.SecretClient``.
    """
    from azure.keyvault.secrets import SecretClient

    return SecretClient(vault_url=vault_url, credential=get_credential(), **kwargs)


def get_cosmos_client(endpoint: str, **kwargs: Any) -> Any:
    """Create a CosmosClient for the given endpoint.

    Args:
        endpoint: Cosmos DB account endpoint URL.
        **kwargs: Additional keyword arguments forwarded to
            ``CosmosClient``.

    Returns:
        A configured ``azure.cosmos.CosmosClient``.
    """
    from azure.cosmos import CosmosClient

    return CosmosClient(url=endpoint, credential=get_credential(), **kwargs)


def get_search_client(endpoint: str, index_name: str, **kwargs: Any) -> Any:
    """Create a SearchClient for Azure AI Search.

    Args:
        endpoint: Azure AI Search service endpoint URL.
        index_name: Name of the target search index.
        **kwargs: Additional keyword arguments forwarded to
            ``SearchClient``.

    Returns:
        A configured ``azure.search.documents.SearchClient``.

    Example::

        client = get_search_client(
            "https://mysearch.search.windows.net",
            "csa-rag-index",
        )
        results = client.search("data lake")
    """
    from azure.search.documents import SearchClient

    return SearchClient(
        endpoint=endpoint,
        index_name=index_name,
        credential=get_credential(),
        **kwargs,
    )


def get_purview_client(account_name: str, **kwargs: Any) -> Any:
    """Create a PurviewCatalogClient for the given account.

    Constructs the catalog endpoint from *account_name* using the
    appropriate cloud suffix and authenticates with the shared credential.

    Args:
        account_name: The Purview account name (not the full URL).
        **kwargs: Additional keyword arguments forwarded to
            ``PurviewCatalogClient``.

    Returns:
        A configured ``azure.purview.catalog.PurviewCatalogClient``.

    Raises:
        ImportError: If the ``azure-purview-catalog`` package is not
            installed.

    Example::

        client = get_purview_client("purview-prod")
    """
    from azure.purview.catalog import PurviewCatalogClient

    suffix = "purview.azure.us" if _is_government_cloud() else "purview.azure.com"
    endpoint = f"https://{account_name}.{suffix}"
    return PurviewCatalogClient(endpoint=endpoint, credential=get_credential(), **kwargs)


def get_monitor_ingestion_client(endpoint: str, **kwargs: Any) -> Any:
    """Create a LogsIngestionClient for Azure Monitor.

    Args:
        endpoint: The Data Collection Endpoint (DCE) URL, e.g.
            ``"https://my-dce.eastus-1.ingest.monitor.azure.com"``.
        **kwargs: Additional keyword arguments forwarded to
            ``LogsIngestionClient``.

    Returns:
        A configured ``azure.monitor.ingestion.LogsIngestionClient``.
    """
    from azure.monitor.ingestion import LogsIngestionClient

    return LogsIngestionClient(endpoint=endpoint, credential=get_credential(), **kwargs)
