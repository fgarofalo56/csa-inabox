"""Tests for the Secret Rotation Azure Function (secretRotation/functions/function_app.py).

Covers all three triggers (EventGrid rotation, HTTP rotate, HTTP health) plus
the four async rotation handlers (_rotate_storage_key, _rotate_cosmos_key,
_rotate_sql_password) and synchronous utility functions (_generate_password,
_parse_secret_name).

Mocking strategy
----------------
Azure SDK clients are mocked at the module level using ``unittest.mock.patch``
targeting the import path inside function_app. Every async client is replaced
with an ``AsyncMock`` so ``async with`` and ``await`` both work transparently.
The function_app module is imported dynamically in a fixture so the
module-level ``configure_structlog()`` call runs after the logging state is
reset — this avoids polluting other test modules.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
from collections.abc import Iterator
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from governance.common.logging import reset_logging_state


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _reset_logging() -> Iterator[None]:
    """Reset structlog state between tests so module-level configure_structlog works."""
    reset_logging_state()
    yield
    reset_logging_state()


@pytest.fixture
def function_app() -> types.ModuleType:
    """Import (or reimport) the secret rotation function_app module.

    We add the function directory to sys.path so ``function_app`` resolves.
    The reimport ensures module-level side effects (configure_structlog, env
    reads) happen after the autouse logging reset fixture runs.
    """
    func_dir = "domains/sharedServices/secretRotation/functions"
    if func_dir not in sys.path:
        sys.path.insert(0, func_dir)
    # Force a fresh import each time
    if "function_app" in sys.modules:
        del sys.modules["function_app"]
    return importlib.import_module("function_app")


def _make_http_request(
    *,
    method: str = "POST",
    url: str = "/api/rotate",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> MagicMock:
    """Build a mock ``azure.functions.HttpRequest``."""
    import azure.functions as func

    req = MagicMock(spec=func.HttpRequest)
    req.method = method
    req.url = url
    req.headers = headers or {}

    if body is not None:
        req.get_json.return_value = json.loads(body)
    else:
        from json import JSONDecodeError

        req.get_json.side_effect = JSONDecodeError("", "", 0)

    return req


def _make_event_grid_event(
    *,
    event_type: str = "Microsoft.KeyVault.SecretNearExpiry",
    event_id: str = "test-event-123",
    subject: str = "test-subject",
    data: dict[str, Any] | None = None,
) -> MagicMock:
    """Build a mock ``azure.functions.EventGridEvent``."""
    import azure.functions as func

    event = MagicMock(spec=func.EventGridEvent)
    event.event_type = event_type
    event.id = event_id
    event.subject = subject
    event.get_json.return_value = data or {}
    return event


# ---------------------------------------------------------------------------
# Password generation tests
# ---------------------------------------------------------------------------
class TestGeneratePassword:
    def test_default_length_32(self, function_app: types.ModuleType) -> None:
        """Default password length should be 32 characters."""
        password = function_app._generate_password()
        assert len(password) == 32

    def test_custom_length(self, function_app: types.ModuleType) -> None:
        """Should respect custom length parameter."""
        password = function_app._generate_password(length=16)
        assert len(password) == 16

    def test_includes_special_chars_by_default(self, function_app: types.ModuleType) -> None:
        """Default behavior should include special characters."""
        password = function_app._generate_password(length=50)
        special_chars = "!@#$%^&*()-_=+"
        has_special = any(c in special_chars for c in password)
        assert has_special

    def test_no_special_chars_when_disabled(self, function_app: types.ModuleType) -> None:
        """Should exclude special chars when include_special=False."""
        password = function_app._generate_password(length=50, include_special=False)
        special_chars = "!@#$%^&*()-_=+"
        has_special = any(c in special_chars for c in password)
        assert not has_special

    def test_always_has_upper_lower_digit(self, function_app: types.ModuleType) -> None:
        """Password should always contain uppercase, lowercase, and digit."""
        # Run multiple times to ensure it's not random luck
        for _ in range(100):
            password = function_app._generate_password(length=20)
            has_upper = any(c.isupper() for c in password)
            has_lower = any(c.islower() for c in password)
            has_digit = any(c.isdigit() for c in password)
            assert has_upper
            assert has_lower
            assert has_digit


# ---------------------------------------------------------------------------
# Secret name parsing tests
# ---------------------------------------------------------------------------
class TestParseSecretName:
    def test_storage_access_key_prod(self, function_app: types.ModuleType) -> None:
        """Parse standard storage account secret name."""
        result = function_app._parse_secret_name("storage-access-key-prod")
        assert result["service"] == "storage"
        assert result["purpose"] == "access-key"
        assert result["environment"] == "prod"

    def test_cosmosdb_primary_key_prod(self, function_app: types.ModuleType) -> None:
        """Parse Cosmos DB secret with multi-hyphen service name."""
        result = function_app._parse_secret_name("cosmosdb-primary-key-prod")
        assert result["service"] == "cosmosdb"
        assert result["purpose"] == "primary-key"
        assert result["environment"] == "prod"

    def test_sql_admin_password_dev(self, function_app: types.ModuleType) -> None:
        """Parse SQL password secret name."""
        result = function_app._parse_secret_name("sql-admin-password-dev")
        assert result["service"] == "sql"
        assert result["purpose"] == "admin-password"
        assert result["environment"] == "dev"

    def test_no_hyphen_returns_defaults(self, function_app: types.ModuleType) -> None:
        """Secret name with no hyphens should return defaults."""
        result = function_app._parse_secret_name("mysecret")
        assert result["service"] == "mysecret"
        assert result["purpose"] == "unknown"
        assert result["environment"] == "unknown"

    def test_single_hyphen(self, function_app: types.ModuleType) -> None:
        """Secret name with single hyphen should parse correctly."""
        result = function_app._parse_secret_name("service-prod")
        assert result["service"] == "service"
        assert result["purpose"] == "unknown"
        assert result["environment"] == "prod"

    def test_unknown_service_fallback(self, function_app: types.ModuleType) -> None:
        """Unknown service should fall back to first-hyphen split."""
        result = function_app._parse_secret_name("unknown-service-connection-prod")
        assert result["service"] == "unknown"
        assert result["purpose"] == "service-connection"
        assert result["environment"] == "prod"


# ---------------------------------------------------------------------------
# Storage key rotation tests
# ---------------------------------------------------------------------------
class TestRotateStorageKey:
    @pytest.mark.asyncio
    async def test_returns_error_when_missing_params(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Should return error when required parameters are missing."""
        monkeypatch.setenv("AZURE_SUBSCRIPTION_ID", "")

        # Mock the Azure SDK modules that are imported inside the function
        with patch.dict("sys.modules", {
            "azure.identity.aio": MagicMock(),
            "azure.keyvault.secrets.aio": MagicMock(),
            "azure.mgmt.storage.aio": MagicMock(),
            "azure.mgmt.storage.models": MagicMock(),
        }):
            result = await function_app._rotate_storage_key(
                "storage-access-key-prod",
                {"service": "storage", "purpose": "access-key", "environment": "prod"},
                {"resource_group": "rg", "account_name": "account"}
            )

        assert not result["success"]
        assert "Missing storage account parameters" in result["error"]

    @pytest.mark.asyncio
    async def test_successful_rotation(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Full happy-path: mock the storage management and Key Vault clients."""
        monkeypatch.setenv("AZURE_SUBSCRIPTION_ID", "test-sub-id")
        monkeypatch.setattr(function_app, "KEY_VAULT_URL", "https://test-kv.vault.azure.net/")

        # Mock storage regenerate result
        mock_key = MagicMock()
        mock_key.value = "new-storage-key-value"
        mock_result = MagicMock()
        mock_result.keys = [mock_key]

        # Mock storage management client
        mock_storage_client = AsyncMock()
        mock_storage_client.storage_accounts.regenerate_key.return_value = mock_result
        mock_storage_client.__aenter__ = AsyncMock(return_value=mock_storage_client)
        mock_storage_client.__aexit__ = AsyncMock(return_value=False)

        # Mock Key Vault secret client
        mock_secret = MagicMock()
        mock_secret.value = "new-storage-key-value"
        mock_kv_client = AsyncMock()
        mock_kv_client.set_secret.return_value = None
        mock_kv_client.get_secret.return_value = mock_secret
        mock_kv_client.__aenter__ = AsyncMock(return_value=mock_kv_client)
        mock_kv_client.__aexit__ = AsyncMock(return_value=False)

        # Mock credential
        mock_credential = AsyncMock()
        mock_credential.__aenter__ = AsyncMock(return_value=mock_credential)
        mock_credential.__aexit__ = AsyncMock(return_value=False)

        with patch.dict("sys.modules", {
            "azure.identity.aio": MagicMock(DefaultAzureCredential=MagicMock(return_value=mock_credential)),
            "azure.keyvault.secrets.aio": MagicMock(SecretClient=MagicMock(return_value=mock_kv_client)),
            "azure.mgmt.storage.aio": MagicMock(StorageManagementClient=MagicMock(return_value=mock_storage_client)),
            "azure.mgmt.storage.models": MagicMock(StorageAccountRegenerateKeyParameters=MagicMock()),
        }):
            result = await function_app._rotate_storage_key(
                "storage-access-key-prod",
                {"service": "storage", "purpose": "access-key", "environment": "prod"},
                {"resource_group": "test-rg", "account_name": "testaccount"}
            )

        assert result["success"] is True
        assert result["service"] == "storage"
        assert result["account"] == "testaccount"
        assert "expires_on" in result

    @pytest.mark.asyncio
    async def test_handles_sdk_exception(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Should handle SDK exceptions gracefully."""
        monkeypatch.setenv("AZURE_SUBSCRIPTION_ID", "test-sub-id")

        mock_storage_client = AsyncMock()
        mock_storage_client.storage_accounts.regenerate_key.side_effect = RuntimeError("Storage SDK boom")
        mock_storage_client.__aenter__ = AsyncMock(return_value=mock_storage_client)
        mock_storage_client.__aexit__ = AsyncMock(return_value=False)

        mock_credential = AsyncMock()
        mock_credential.__aenter__ = AsyncMock(return_value=mock_credential)
        mock_credential.__aexit__ = AsyncMock(return_value=False)

        with patch.dict("sys.modules", {
            "azure.identity.aio": MagicMock(DefaultAzureCredential=MagicMock(return_value=mock_credential)),
            "azure.mgmt.storage.aio": MagicMock(StorageManagementClient=MagicMock(return_value=mock_storage_client)),
            "azure.mgmt.storage.models": MagicMock(StorageAccountRegenerateKeyParameters=MagicMock()),
        }), pytest.raises(RuntimeError):
            await function_app._rotate_storage_key(
                "storage-access-key-prod",
                {"service": "storage", "purpose": "access-key", "environment": "prod"},
                {"resource_group": "test-rg", "account_name": "testaccount"}
            )


# ---------------------------------------------------------------------------
# Cosmos DB key rotation tests
# ---------------------------------------------------------------------------
class TestRotateCosmosKey:
    @pytest.mark.asyncio
    async def test_returns_error_when_missing_params(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Should return error when required parameters are missing."""
        monkeypatch.setenv("AZURE_SUBSCRIPTION_ID", "")

        # Mock the Azure SDK modules that are imported inside the function
        with patch.dict("sys.modules", {
            "azure.identity.aio": MagicMock(),
            "azure.keyvault.secrets.aio": MagicMock(),
            "azure.mgmt.cosmosdb.aio": MagicMock(),
            "azure.mgmt.cosmosdb.models": MagicMock(),
        }):
            result = await function_app._rotate_cosmos_key(
                "cosmosdb-primary-key-prod",
                {"service": "cosmosdb", "purpose": "primary-key", "environment": "prod"},
                {"resource_group": "rg", "account_name": "account"}
            )

        assert not result["success"]
        assert "Missing Cosmos DB parameters" in result["error"]

    @pytest.mark.asyncio
    async def test_successful_rotation(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Full happy-path: mock the Cosmos DB management and Key Vault clients."""
        monkeypatch.setenv("AZURE_SUBSCRIPTION_ID", "test-sub-id")
        monkeypatch.setattr(function_app, "KEY_VAULT_URL", "https://test-kv.vault.azure.net/")

        # Mock Cosmos DB poller and keys result
        mock_poller = AsyncMock()
        mock_poller.result.return_value = None

        mock_keys = MagicMock()
        mock_keys.primary_master_key = "new-cosmos-primary-key"

        # Mock Cosmos DB management client
        mock_cosmos_client = AsyncMock()
        mock_cosmos_client.database_accounts.begin_regenerate_key.return_value = mock_poller
        mock_cosmos_client.database_accounts.list_keys.return_value = mock_keys
        mock_cosmos_client.__aenter__ = AsyncMock(return_value=mock_cosmos_client)
        mock_cosmos_client.__aexit__ = AsyncMock(return_value=False)

        # Mock Key Vault secret client
        mock_secret = MagicMock()
        mock_secret.value = "new-cosmos-primary-key"
        mock_kv_client = AsyncMock()
        mock_kv_client.set_secret.return_value = None
        mock_kv_client.get_secret.return_value = mock_secret
        mock_kv_client.__aenter__ = AsyncMock(return_value=mock_kv_client)
        mock_kv_client.__aexit__ = AsyncMock(return_value=False)

        # Mock credential
        mock_credential = AsyncMock()
        mock_credential.__aenter__ = AsyncMock(return_value=mock_credential)
        mock_credential.__aexit__ = AsyncMock(return_value=False)

        with patch.dict("sys.modules", {
            "azure.identity.aio": MagicMock(DefaultAzureCredential=MagicMock(return_value=mock_credential)),
            "azure.keyvault.secrets.aio": MagicMock(SecretClient=MagicMock(return_value=mock_kv_client)),
            "azure.mgmt.cosmosdb.aio": MagicMock(CosmosDBManagementClient=MagicMock(return_value=mock_cosmos_client)),
            "azure.mgmt.cosmosdb.models": MagicMock(DatabaseAccountRegenerateKeyParameters=MagicMock()),
        }):
            result = await function_app._rotate_cosmos_key(
                "cosmosdb-primary-key-prod",
                {"service": "cosmosdb", "purpose": "primary-key", "environment": "prod"},
                {"resource_group": "test-rg", "account_name": "testaccount"}
            )

        assert result["success"] is True
        assert result["service"] == "cosmosdb"
        assert result["account"] == "testaccount"
        assert "expires_on" in result

    @pytest.mark.asyncio
    async def test_handles_sdk_exception(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Should handle SDK exceptions gracefully."""
        monkeypatch.setenv("AZURE_SUBSCRIPTION_ID", "test-sub-id")

        mock_cosmos_client = AsyncMock()
        mock_cosmos_client.database_accounts.begin_regenerate_key.side_effect = RuntimeError("Cosmos SDK boom")
        mock_cosmos_client.__aenter__ = AsyncMock(return_value=mock_cosmos_client)
        mock_cosmos_client.__aexit__ = AsyncMock(return_value=False)

        mock_credential = AsyncMock()
        mock_credential.__aenter__ = AsyncMock(return_value=mock_credential)
        mock_credential.__aexit__ = AsyncMock(return_value=False)

        with patch.dict("sys.modules", {
            "azure.identity.aio": MagicMock(DefaultAzureCredential=MagicMock(return_value=mock_credential)),
            "azure.mgmt.cosmosdb.aio": MagicMock(CosmosDBManagementClient=MagicMock(return_value=mock_cosmos_client)),
            "azure.mgmt.cosmosdb.models": MagicMock(DatabaseAccountRegenerateKeyParameters=MagicMock()),
        }), pytest.raises(RuntimeError):
            await function_app._rotate_cosmos_key(
                "cosmosdb-primary-key-prod",
                {"service": "cosmosdb", "purpose": "primary-key", "environment": "prod"},
                {"resource_group": "test-rg", "account_name": "testaccount"}
            )


# ---------------------------------------------------------------------------
# SQL password rotation tests
# ---------------------------------------------------------------------------
class TestRotateSqlPassword:
    @pytest.mark.asyncio
    async def test_successful_rotation(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Full happy-path: generate password and store in Key Vault."""
        monkeypatch.setattr(function_app, "KEY_VAULT_URL", "https://test-kv.vault.azure.net/")

        # Mock Key Vault secret client
        stored_password = None

        async def mock_set_secret(secret_name, value, **kwargs):
            nonlocal stored_password
            stored_password = value
            return

        mock_secret = MagicMock()
        async def mock_get_secret(secret_name):
            mock_secret.value = stored_password
            return mock_secret

        mock_kv_client = AsyncMock()
        mock_kv_client.set_secret.side_effect = mock_set_secret
        mock_kv_client.get_secret.side_effect = mock_get_secret
        mock_kv_client.__aenter__ = AsyncMock(return_value=mock_kv_client)
        mock_kv_client.__aexit__ = AsyncMock(return_value=False)

        # Mock credential
        mock_credential = AsyncMock()
        mock_credential.__aenter__ = AsyncMock(return_value=mock_credential)
        mock_credential.__aexit__ = AsyncMock(return_value=False)

        with patch.dict("sys.modules", {
            "azure.identity.aio": MagicMock(DefaultAzureCredential=MagicMock(return_value=mock_credential)),
            "azure.keyvault.secrets.aio": MagicMock(SecretClient=MagicMock(return_value=mock_kv_client)),
        }):
            result = await function_app._rotate_sql_password(
                "sql-admin-password-prod",
                {"service": "sql", "purpose": "admin-password", "environment": "prod"},
                {}
            )

        assert result["success"] is True
        assert result["service"] == "sql"
        assert result["purpose"] == "admin-password"
        assert "expires_on" in result
        assert "Password stored in Key Vault" in result["note"]

    @pytest.mark.asyncio
    async def test_custom_password_length(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Should use custom password length from params."""
        monkeypatch.setattr(function_app, "KEY_VAULT_URL", "https://test-kv.vault.azure.net/")

        # Mock Key Vault secret client
        stored_password = None

        async def mock_set_secret(secret_name, value, **kwargs):
            nonlocal stored_password
            stored_password = value
            return

        mock_secret = MagicMock()
        async def mock_get_secret(secret_name):
            mock_secret.value = stored_password
            return mock_secret

        mock_kv_client = AsyncMock()
        mock_kv_client.set_secret.side_effect = mock_set_secret
        mock_kv_client.get_secret.side_effect = mock_get_secret
        mock_kv_client.__aenter__ = AsyncMock(return_value=mock_kv_client)
        mock_kv_client.__aexit__ = AsyncMock(return_value=False)

        # Mock credential
        mock_credential = AsyncMock()
        mock_credential.__aenter__ = AsyncMock(return_value=mock_credential)
        mock_credential.__aexit__ = AsyncMock(return_value=False)

        with patch.dict("sys.modules", {
            "azure.identity.aio": MagicMock(DefaultAzureCredential=MagicMock(return_value=mock_credential)),
            "azure.keyvault.secrets.aio": MagicMock(SecretClient=MagicMock(return_value=mock_kv_client)),
        }):
            result = await function_app._rotate_sql_password(
                "sql-admin-password-prod",
                {"service": "sql", "purpose": "admin-password", "environment": "prod"},
                {"secret_length": 64}
            )

        assert result["success"] is True
        assert len(stored_password) == 64


# ---------------------------------------------------------------------------
# EventGrid trigger tests
# ---------------------------------------------------------------------------
class TestSecretRotationHandler:
    @pytest.mark.asyncio
    async def test_handles_storage_event(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Should successfully handle storage secret rotation event."""
        # Mock the storage rotation handler
        async def mock_storage_handler(secret_name, parsed, params):
            return {"success": True, "service": "storage"}

        # Patch the handler in the module's _ROTATION_HANDLERS dict
        monkeypatch.setitem(function_app._ROTATION_HANDLERS, "storage", mock_storage_handler)

        event = _make_event_grid_event(
            data={
                "ObjectName": "storage-access-key-prod",
                "VaultName": "test-kv"
            }
        )

        # Should not raise any exceptions
        await function_app.secret_rotation_handler(event)

    @pytest.mark.asyncio
    async def test_handles_unknown_service(self, function_app: types.ModuleType) -> None:
        """Should gracefully handle unknown service types."""
        event = _make_event_grid_event(
            data={
                "ObjectName": "unknown-service-key-prod",
                "VaultName": "test-kv"
            }
        )

        # Should not raise any exceptions
        await function_app.secret_rotation_handler(event)

    @pytest.mark.asyncio
    async def test_handles_missing_secret_name(self, function_app: types.ModuleType) -> None:
        """Should handle event with missing ObjectName gracefully."""
        event = _make_event_grid_event(
            data={
                "VaultName": "test-kv"
                # Missing ObjectName
            }
        )

        # Should not raise any exceptions
        await function_app.secret_rotation_handler(event)

    @pytest.mark.asyncio
    async def test_handles_handler_exception(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Should handle exceptions from rotation handlers gracefully."""
        # Mock the storage rotation handler to raise an exception
        async def mock_failing_handler(secret_name, parsed, params):
            raise RuntimeError("Handler failed")

        # Patch the handler in the module's _ROTATION_HANDLERS dict
        monkeypatch.setitem(function_app._ROTATION_HANDLERS, "storage", mock_failing_handler)

        event = _make_event_grid_event(
            data={
                "ObjectName": "storage-access-key-prod",
                "VaultName": "test-kv"
            }
        )

        # Should not raise any exceptions, just log the error
        await function_app.secret_rotation_handler(event)


# ---------------------------------------------------------------------------
# HTTP rotate endpoint tests
# ---------------------------------------------------------------------------
class TestRotateEndpoint:
    @pytest.mark.asyncio
    async def test_200_success(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Happy path: valid JSON with secret_name."""
        # Mock the storage rotation handler
        async def mock_storage_handler(secret_name, parsed, params):
            return {"success": True, "service": "storage", "account": "testaccount"}

        # Patch the handler in the module's _ROTATION_HANDLERS dict
        monkeypatch.setitem(function_app._ROTATION_HANDLERS, "storage", mock_storage_handler)

        req = _make_http_request(
            body=json.dumps({
                "secret_name": "storage-access-key-prod",
                "params": {"resource_group": "rg", "account_name": "testaccount"}
            }).encode()
        )

        resp = await function_app.rotate(req)
        assert resp.status_code == 200

        body = json.loads(resp.get_body())
        assert body["secret_name"] == "storage-access-key-prod"
        assert body["service"] == "storage"
        assert body["result"]["success"] is True

    @pytest.mark.asyncio
    async def test_400_invalid_json(self, function_app: types.ModuleType) -> None:
        """Should return 400 for invalid JSON."""
        req = _make_http_request(body=None)  # triggers JSONDecodeError
        resp = await function_app.rotate(req)
        assert resp.status_code == 400

        body = json.loads(resp.get_body())
        assert "Invalid JSON" in body["error"]

    @pytest.mark.asyncio
    async def test_400_missing_secret_name(self, function_app: types.ModuleType) -> None:
        """Should return 400 when secret_name is missing."""
        req = _make_http_request(
            body=json.dumps({"other": "field"}).encode()
        )
        resp = await function_app.rotate(req)
        assert resp.status_code == 400

        body = json.loads(resp.get_body())
        assert "secret_name" in body["error"]

    @pytest.mark.asyncio
    async def test_400_unsupported_service(self, function_app: types.ModuleType) -> None:
        """Should return 400 for unsupported service types."""
        req = _make_http_request(
            body=json.dumps({"secret_name": "unknown-service-key-prod"}).encode()
        )
        resp = await function_app.rotate(req)
        assert resp.status_code == 400

        body = json.loads(resp.get_body())
        assert "Unsupported service type" in body["error"]
        assert "supported" in body

    @pytest.mark.asyncio
    async def test_500_handler_exception(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Should return 500 when handler raises an exception."""
        # Mock the storage rotation handler to raise an exception
        async def mock_failing_handler(secret_name, parsed, params):
            raise RuntimeError("Handler boom")

        # Patch the handler in the module's _ROTATION_HANDLERS dict
        monkeypatch.setitem(function_app._ROTATION_HANDLERS, "storage", mock_failing_handler)

        req = _make_http_request(
            body=json.dumps({"secret_name": "storage-access-key-prod"}).encode()
        )

        resp = await function_app.rotate(req)
        assert resp.status_code == 500

        body = json.loads(resp.get_body())
        assert "Rotation failed" in body["error"]
        assert body["secret_name"] == "storage-access-key-prod"


# ---------------------------------------------------------------------------
# HTTP health endpoint tests
# ---------------------------------------------------------------------------
class TestHealthEndpoint:
    @pytest.mark.asyncio
    async def test_healthy_when_kv_configured(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Should return healthy status when Key Vault URL is configured."""
        monkeypatch.setattr(function_app, "KEY_VAULT_URL", "https://test-kv.vault.azure.net/")

        req = _make_http_request(method="GET", url="/api/health")
        resp = await function_app.health(req)
        assert resp.status_code == 200

        body = json.loads(resp.get_body())
        assert body["status"] == "healthy"
        assert body["service"] == "secret-rotation"
        assert "timestamp" in body

    @pytest.mark.asyncio
    async def test_degraded_when_kv_not_configured(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Should return degraded status when Key Vault URL is not configured."""
        monkeypatch.setattr(function_app, "KEY_VAULT_URL", "")

        req = _make_http_request(method="GET", url="/api/health")
        resp = await function_app.health(req)
        assert resp.status_code == 200

        body = json.loads(resp.get_body())
        assert body["status"] == "degraded"
        assert body["service"] == "secret-rotation"
        assert "timestamp" in body
