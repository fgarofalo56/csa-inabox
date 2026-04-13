"""Azure Functions for Automatic Secret Rotation Service.

Provides Event Grid-triggered and HTTP-triggered functions for rotating
secrets stored in Azure Key Vault.  Supports storage account keys,
Cosmos DB keys, and SQL/Synapse admin passwords.

Part of the CSA-in-a-Box shared services layer.

Manual Recovery Procedures
--------------------------

If automatic secret rotation fails, follow these manual recovery steps:

1. **Storage Account Key Rotation Failure**:
   - Navigate to Azure Portal → Storage Account → Access Keys
   - Click "Regenerate" for key1 or key2
   - Copy the new key value
   - Update Key Vault secret manually using:
     ``az keyvault secret set --vault-name <vault> --name <secret> --value <key>``

2. **Cosmos DB Key Rotation Failure**:
   - Navigate to Azure Portal → Cosmos DB Account → Keys
   - Click "Regenerate Primary Key"
   - Wait for regeneration to complete (may take several minutes)
   - Copy the new primary key value
   - Update Key Vault secret manually

3. **SQL/Synapse Password Rotation Failure**:
   - If password is stored in Key Vault but not applied to the service:
     - Use deployment pipeline to update Bicep templates with new password reference
     - Or use Azure CLI: ``az synapse sql pool update --admin-password <new-password>``
   - If password generation failed entirely:
     - Generate secure password manually and store in Key Vault
     - Apply via deployment pipeline

4. **Event Grid Subscription Issues**:
   - Verify Event Grid subscription exists: ``az eventgrid event-subscription list``
   - Check Function App endpoint is accessible
   - Review Function App logs for processing errors
   - Manually trigger rotation via HTTP endpoint: ``POST /api/rotate``

5. **Key Vault Access Issues**:
   - Verify Function App managed identity has "Key Vault Secrets Officer" role
   - Check Key Vault firewall settings allow Function App access
   - Validate Key Vault URL environment variable is correctly set

For all recovery procedures, ensure you update any downstream services that
depend on the rotated secrets (application settings, connection strings, etc.).

Async / concurrency model
-------------------------
Every trigger is ``async def`` and all Azure SDK calls use the ``.aio``
credential variant (``azure.identity.aio.DefaultAzureCredential``) so
the Functions host can interleave multiple in-flight invocations without
blocking.  Management-plane clients are instantiated per-invocation inside
``async with`` blocks so the underlying ``aiohttp`` transport is always
closed cleanly.

Logging
-------
All log lines are JSON via :mod:`governance.common.logging` (structlog).
Each invocation binds ``trace_id`` and ``correlation_id`` via
:func:`bind_trace_context` so cross-service correlation works end-to-end.
See ``docs/LOG_SCHEMA.md`` for the shared schema and KQL queries.

Secret naming convention
------------------------
Secrets follow the pattern ``{service}-{purpose}-{environment}`` as
defined in ``governance/keyvault/keyvault-config.json``.  The rotation
handler parses the secret name to determine which service-specific
rotation function to invoke.  Examples:

* ``sql-admin-password-prod``   -> SQL password rotation
* ``storage-access-key-prod``   -> Storage account key regeneration
* ``cosmosdb-primary-key-prod`` -> Cosmos DB key regeneration
"""

import json
import os
import secrets
import string
from datetime import datetime, timezone
from typing import Any

import azure.functions as func
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from azure.core.exceptions import ServiceRequestError, HttpResponseError

from governance.common.logging import (
    bind_trace_context,
    configure_structlog,
    extract_trace_id_from_headers,
    get_logger,
)

configure_structlog(service="csa-secret-rotation")
logger = get_logger(__name__)

app = func.FunctionApp()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
KEY_VAULT_URL = os.environ.get("KEY_VAULT_URL", "")
DEFAULT_SECRET_LENGTH = int(os.environ.get("SECRET_LENGTH", "32"))
DEFAULT_VALIDITY_DAYS = int(os.environ.get("SECRET_VALIDITY_DAYS", "90"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _generate_password(length: int = 32, *, include_special: bool = True) -> str:
    """Generate a cryptographically secure random password.

    The password always contains at least one uppercase letter, one lowercase
    letter, and one digit.  Special characters are included unless
    *include_special* is ``False`` (some services disallow certain chars).
    """
    alphabet = string.ascii_letters + string.digits
    if include_special:
        alphabet += "!@#$%^&*()-_=+"

    while True:
        password = "".join(secrets.choice(alphabet) for _ in range(length))
        # Guarantee complexity requirements
        has_upper = any(c.isupper() for c in password)
        has_lower = any(c.islower() for c in password)
        has_digit = any(c.isdigit() for c in password)
        has_special = not include_special or any(
            c in "!@#$%^&*()-_=+" for c in password
        )
        if has_upper and has_lower and has_digit and has_special:
            return password


def _parse_secret_name(secret_name: str) -> dict[str, str]:
    """Parse a secret name following ``{service}-{purpose}-{env}`` convention.

    The environment is always the last segment (after the final ``-``).
    The service is matched against known handler prefixes so multi-hyphen
    service names like ``cosmosdb-primary-key-prod`` correctly resolve to
    ``service="cosmosdb"``.  Falls back gracefully when the name doesn't
    match the expected pattern.

    Examples::

        "storage-access-key-prod"   -> service="storage", purpose="access-key", env="prod"
        "cosmosdb-primary-key-prod" -> service="cosmosdb", purpose="primary-key", env="prod"
        "sql-admin-password-dev"    -> service="sql", purpose="admin-password", env="dev"
    """
    if "-" not in secret_name:
        return {"service": secret_name, "purpose": "unknown", "environment": "unknown"}

    # Environment is always the last segment
    rest, environment = secret_name.rsplit("-", 1)

    if "-" not in rest:
        return {"service": rest, "purpose": "unknown", "environment": environment}

    # Match the service prefix against known handler keys.  Try longest
    # prefixes first so "cosmosdb" beats "cosmos" when both are registered.
    known_services = sorted(_ROTATION_HANDLERS.keys(), key=len, reverse=True)
    for svc in known_services:
        if rest == svc:
            return {"service": svc, "purpose": "default", "environment": environment}
        if rest.startswith(svc + "-"):
            purpose = rest[len(svc) + 1 :]
            return {"service": svc, "purpose": purpose, "environment": environment}

    # No known service prefix matched — split on first hyphen as best-effort
    first_hyphen = rest.index("-")
    return {
        "service": rest[:first_hyphen],
        "purpose": rest[first_hyphen + 1 :],
        "environment": environment,
    }


# ---------------------------------------------------------------------------
# Rotation handlers (per service type)
# ---------------------------------------------------------------------------
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    retry=retry_if_exception_type((ServiceRequestError, HttpResponseError))
)
async def _rotate_storage_key(
    secret_name: str,
    parsed: dict[str, str],
    params: dict[str, Any],
) -> dict[str, Any]:
    """Rotate a storage account access key and store the new value in Key Vault.

    Flow:
    1. Regenerate key1 on the storage account via the management SDK.
    2. Store the new key in Key Vault.
    3. Verify the secret can be read back.
    """
    from azure.identity.aio import DefaultAzureCredential
    from azure.keyvault.secrets.aio import SecretClient
    from azure.mgmt.storage.aio import StorageManagementClient

    subscription_id = os.environ.get("AZURE_SUBSCRIPTION_ID", "")
    resource_group = params.get("resource_group", "")
    account_name = params.get("account_name", "")

    if not all([subscription_id, resource_group, account_name]):
        return {"success": False, "error": "Missing storage account parameters (subscription_id, resource_group, account_name)"}

    result: dict[str, Any] = {"service": "storage", "account": account_name}

    async with DefaultAzureCredential() as credential:
        # Step 1: Regenerate key
        async with StorageManagementClient(credential, subscription_id) as storage_client:
            from azure.mgmt.storage.models import StorageAccountRegenerateKeyParameters
            key_result = await storage_client.storage_accounts.regenerate_key(
                resource_group,
                account_name,
                StorageAccountRegenerateKeyParameters(key_name="key1"),
            )
            new_key = key_result.keys[0].value
            logger.info("rotation.key_regenerated", service="storage", account=account_name)

        # Step 2: Store in Key Vault
        async with SecretClient(vault_url=KEY_VAULT_URL, credential=credential) as kv_client:
            from datetime import timedelta
            expires_on = datetime.now(timezone.utc) + timedelta(days=DEFAULT_VALIDITY_DAYS)
            await kv_client.set_secret(
                secret_name,
                new_key,
                expires_on=expires_on,
                content_type="application/x-azure-storage-key",
            )
            logger.info("rotation.secret_stored", secret_name=secret_name)

            # Step 3: Verify
            verified = await kv_client.get_secret(secret_name)
            result["success"] = verified.value == new_key
            result["expires_on"] = expires_on.isoformat()

    return result


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    retry=retry_if_exception_type((ServiceRequestError, HttpResponseError))
)
async def _rotate_cosmos_key(
    secret_name: str,
    parsed: dict[str, str],
    params: dict[str, Any],
) -> dict[str, Any]:
    """Rotate a Cosmos DB account key and store the new value in Key Vault.

    Flow:
    1. Regenerate the primary key on the Cosmos DB account.
    2. Read back the new keys to get the regenerated value.
    3. Store in Key Vault and verify.
    """
    from azure.identity.aio import DefaultAzureCredential
    from azure.keyvault.secrets.aio import SecretClient
    from azure.mgmt.cosmosdb.aio import CosmosDBManagementClient

    subscription_id = os.environ.get("AZURE_SUBSCRIPTION_ID", "")
    resource_group = params.get("resource_group", "")
    account_name = params.get("account_name", "")

    if not all([subscription_id, resource_group, account_name]):
        return {"success": False, "error": "Missing Cosmos DB parameters (subscription_id, resource_group, account_name)"}

    result: dict[str, Any] = {"service": "cosmosdb", "account": account_name}

    async with DefaultAzureCredential() as credential:
        # Step 1: Regenerate primary key (long-running operation)
        async with CosmosDBManagementClient(credential, subscription_id) as cosmos_client:
            from azure.mgmt.cosmosdb.models import DatabaseAccountRegenerateKeyParameters
            poller = await cosmos_client.database_accounts.begin_regenerate_key(
                resource_group,
                account_name,
                DatabaseAccountRegenerateKeyParameters(key_kind="Primary"),
            )
            # CRITICAL: await the poller — without this, list_keys returns the OLD key
            await poller.result()
            logger.info("rotation.key_regenerated", service="cosmosdb", account=account_name)

            # Step 2: Read back the new key (safe now that regeneration is complete)
            keys = await cosmos_client.database_accounts.list_keys(
                resource_group, account_name,
            )
            new_key = keys.primary_master_key

        # Step 3: Store in Key Vault
        async with SecretClient(vault_url=KEY_VAULT_URL, credential=credential) as kv_client:
            from datetime import timedelta
            expires_on = datetime.now(timezone.utc) + timedelta(days=DEFAULT_VALIDITY_DAYS)
            await kv_client.set_secret(
                secret_name,
                new_key,
                expires_on=expires_on,
                content_type="application/x-azure-cosmosdb-key",
            )
            logger.info("rotation.secret_stored", secret_name=secret_name)

            # Verify
            verified = await kv_client.get_secret(secret_name)
            result["success"] = verified.value == new_key
            result["expires_on"] = expires_on.isoformat()

    return result


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    retry=retry_if_exception_type((ServiceRequestError, HttpResponseError))
)
async def _rotate_sql_password(
    secret_name: str,
    parsed: dict[str, str],
    params: dict[str, Any],
) -> dict[str, Any]:
    """Rotate a SQL/Synapse admin password.

    Flow:
    1. Generate a new cryptographically secure password.
    2. Store the new password in Key Vault.
    3. Log that the service-side password update must be applied by the
       deployment pipeline (Synapse/SQL Server admin passwords require a
       Bicep redeployment or direct REST call with elevated privileges).
    """
    from azure.identity.aio import DefaultAzureCredential
    from azure.keyvault.secrets.aio import SecretClient

    length = params.get("secret_length", DEFAULT_SECRET_LENGTH)
    include_special = params.get("include_special_chars", True)

    result: dict[str, Any] = {"service": "sql", "purpose": parsed.get("purpose", "admin-password")}

    new_password = _generate_password(length, include_special=include_special)

    async with DefaultAzureCredential() as credential:
        async with SecretClient(vault_url=KEY_VAULT_URL, credential=credential) as kv_client:
            from datetime import timedelta
            expires_on = datetime.now(timezone.utc) + timedelta(days=DEFAULT_VALIDITY_DAYS)
            await kv_client.set_secret(
                secret_name,
                new_password,
                expires_on=expires_on,
                content_type="application/x-azure-sql-password",
            )
            logger.info("rotation.secret_stored", secret_name=secret_name)

            # Verify
            verified = await kv_client.get_secret(secret_name)
            result["success"] = verified.value == new_password
            result["expires_on"] = expires_on.isoformat()
            result["note"] = (
                "Password stored in Key Vault. Apply to the SQL/Synapse service via "
                "the deployment pipeline or az synapse sql pool update."
            )

    return result


# Map service prefixes to rotation handlers
_ROTATION_HANDLERS: dict[str, Any] = {
    "storage": _rotate_storage_key,
    "cosmosdb": _rotate_cosmos_key,
    "cosmos": _rotate_cosmos_key,
    "sql": _rotate_sql_password,
    "synapse": _rotate_sql_password,
}


# ---------------------------------------------------------------------------
# Event Grid Trigger: SecretNearExpiry auto-rotation
# ---------------------------------------------------------------------------
@app.function_name("secret_rotation_handler")
@app.event_grid_trigger(arg_name="event")
async def secret_rotation_handler(event: func.EventGridEvent) -> None:
    """Handle Key Vault SecretNearExpiry events.

    Automatically rotates secrets when Azure Key Vault fires a
    ``Microsoft.KeyVault.SecretNearExpiry`` event.  The handler parses
    the secret name to determine the service type and delegates to the
    appropriate rotation function.
    """
    with bind_trace_context(
        trigger="eventgrid",
        event_type=event.event_type,
        event_id=event.id,
    ):
        logger.info(
            "rotation.event_received",
            event_type=event.event_type,
            subject=event.subject,
        )

        event_data = event.get_json()
        secret_name = event_data.get("ObjectName", "")
        vault_name = event_data.get("VaultName", "")

        if not secret_name:
            logger.error("rotation.missing_secret_name", event_data=event_data)
            return

        parsed = _parse_secret_name(secret_name)
        service = parsed["service"]

        logger.info(
            "rotation.parsed_secret",
            secret_name=secret_name,
            vault_name=vault_name,
            service=service,
            purpose=parsed["purpose"],
            environment=parsed["environment"],
        )

        handler = _ROTATION_HANDLERS.get(service)
        if not handler:
            logger.warning(
                "rotation.no_handler",
                service=service,
                secret_name=secret_name,
                supported=list(_ROTATION_HANDLERS.keys()),
            )
            return

        try:
            result = await handler(secret_name, parsed, {})
            logger.info(
                "rotation.completed",
                secret_name=secret_name,
                service=service,
                success=result.get("success", False),
            )
        except (ServiceRequestError, HttpResponseError) as e:
            logger.error(
                "rotation.azure_sdk_failed",
                secret_name=secret_name,
                service=service,
                error_type=type(e).__name__,
                error_message=str(e),
            )
        except ValueError as e:
            logger.error(
                "rotation.invalid_parameters",
                secret_name=secret_name,
                service=service,
                error=str(e),
            )
        except Exception as e:
            logger.exception(
                "rotation.unexpected_error",
                secret_name=secret_name,
                service=service,
                error_type=type(e).__name__,
            )


# ---------------------------------------------------------------------------
# HTTP Trigger: Manual secret rotation
# ---------------------------------------------------------------------------
@app.route(route="rotate", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
async def rotate(req: func.HttpRequest) -> func.HttpResponse:
    """Manually trigger rotation of a specific secret.

    POST /api/rotate
    Body: {
        "secret_name": "storage-access-key-prod",
        "params": {                          // optional, service-specific
            "subscription_id": "...",
            "resource_group": "...",
            "account_name": "..."
        }
    }
    """
    trace_id = extract_trace_id_from_headers(dict(req.headers))
    with bind_trace_context(
        trace_id=trace_id,
        request_method="POST",
        request_route="/api/rotate",
    ):
        logger.info("rotation.manual_request")

        try:
            body = req.get_json()
        except ValueError:
            logger.warning("rotation.invalid_json")
            return func.HttpResponse(
                json.dumps({"error": "Invalid JSON body"}),
                status_code=400,
                mimetype="application/json",
            )

        secret_name = body.get("secret_name", "")
        if not secret_name:
            logger.warning("rotation.missing_secret_name")
            return func.HttpResponse(
                json.dumps({"error": "Missing 'secret_name' field"}),
                status_code=400,
                mimetype="application/json",
            )

        parsed = _parse_secret_name(secret_name)
        service = parsed["service"]
        params = body.get("params", {})

        handler = _ROTATION_HANDLERS.get(service)
        if not handler:
            logger.warning("rotation.unsupported_service", service=service)
            return func.HttpResponse(
                json.dumps({
                    "error": f"Unsupported service type: {service}",
                    "supported": list(_ROTATION_HANDLERS.keys()),
                }),
                status_code=400,
                mimetype="application/json",
            )

        try:
            result = await handler(secret_name, parsed, params)
            logger.info(
                "rotation.manual_completed",
                secret_name=secret_name,
                success=result.get("success", False),
            )
            return func.HttpResponse(
                json.dumps({
                    "secret_name": secret_name,
                    "service": service,
                    "result": result,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }, default=str),
                status_code=200,
                mimetype="application/json",
            )
        except (ServiceRequestError, HttpResponseError) as e:
            logger.error(
                "rotation.azure_sdk_failed",
                secret_name=secret_name,
                error_type=type(e).__name__,
                error_message=str(e),
            )
            return func.HttpResponse(
                json.dumps({
                    "error": f"Azure SDK error: {str(e)}",
                    "secret_name": secret_name,
                    "service": service,
                }),
                status_code=503,  # Service Unavailable for retriable errors
                mimetype="application/json",
            )
        except ValueError as e:
            logger.error("rotation.validation_failed", secret_name=secret_name, error=str(e))
            return func.HttpResponse(
                json.dumps({
                    "error": f"Invalid parameters: {str(e)}",
                    "secret_name": secret_name,
                    "service": service,
                }),
                status_code=400,
                mimetype="application/json",
            )
        except Exception as e:
            logger.exception("rotation.manual_failed", secret_name=secret_name)
            return func.HttpResponse(
                json.dumps({
                    "error": "Rotation failed. Check service logs for details.",
                    "secret_name": secret_name,
                    "service": service,
                    "error_type": type(e).__name__,
                }),
                status_code=500,
                mimetype="application/json",
            )


# ---------------------------------------------------------------------------
# HTTP Trigger: Health check
# ---------------------------------------------------------------------------
@app.route(route="health", methods=["GET"], auth_level=func.AuthLevel.FUNCTION)
async def health(req: func.HttpRequest) -> func.HttpResponse:
    """Health check for secret rotation service.

    GET /api/health
    Returns: JSON with service status and configuration checks
    """
    kv_configured = bool(KEY_VAULT_URL)
    return func.HttpResponse(
        json.dumps({
            "status": "healthy" if kv_configured else "degraded",
            "service": "secret-rotation",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }),
        status_code=200,
        mimetype="application/json",
    )
