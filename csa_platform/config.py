"""Platform-wide configuration using Pydantic Settings.

Reads from environment variables with sensible defaults for local
development.  Modules should import ``platform_settings`` rather than
calling ``os.environ.get()`` directly.

Environment variables are read **once** at import time into the
``platform_settings`` singleton.  Consumers that need late-binding
(e.g. test suites that override env vars after import) should call
``PlatformSettings()`` directly instead of using the singleton.

Usage::

    from csa_platform.config import platform_settings

    tenant_id = platform_settings.AZURE_TENANT_ID
    is_gov    = platform_settings.IS_GOVERNMENT_CLOUD

Variable naming follows the existing environment-variable contracts
already present across csa_platform modules (auth.py, marketplace_api.py,
etc.) so no deployed configuration needs to change.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings


class PlatformSettings(BaseSettings):
    """Central configuration for CSA Platform services.

    All fields default to empty strings / sensible development defaults.
    Unset fields are harmless at import time; individual service modules
    raise explicit errors if a required field is empty when they actually
    try to connect.

    Field names intentionally mirror existing ``os.environ.get()`` call
    sites so that no deployed environment configuration needs to change.
    """

    # ── Azure identity ────────────────────────────────────────────────────
    # Used by: common/auth.py, azure_clients.py
    AZURE_TENANT_ID: str = ""
    AZURE_CLIENT_ID: str = ""
    AZURE_SUBSCRIPTION_ID: str = ""

    # ── Deployment context ────────────────────────────────────────────────
    # Used by: common/auth.py, marketplace_api.py
    IS_GOVERNMENT_CLOUD: bool = False
    ENVIRONMENT: str = "local"
    DEMO_MODE: bool = False
    AUTH_DISABLED: bool = False

    # ── Azure Storage / ADLS ─────────────────────────────────────────────
    # Used by: various shortcut / provisioner modules
    ADLS_ACCOUNT_NAME: str = ""
    STORAGE_ACCOUNT_NAME: str = ""

    # ── Azure AI Services ────────────────────────────────────────────────
    # Flat names used by non-RAG modules; the RAG pipeline has its own
    # prefixed settings in csa_platform/ai_integration/rag/config.py.
    AZURE_AI_ENDPOINT: str = ""
    AZURE_SEARCH_ENDPOINT: str = ""
    AZURE_SEARCH_KEY: str = ""

    # ── Databricks ───────────────────────────────────────────────────────
    # Used by: semantic_model/scripts/configure_sql_endpoint.py (via CLI args
    # today; will consume from settings after incremental migration).
    DATABRICKS_HOST: str = ""
    DATABRICKS_TOKEN: str = ""

    # ── Cosmos DB ────────────────────────────────────────────────────────
    # Used by: data_marketplace/api/marketplace_api.py
    # NOTE: marketplace_api.py currently reads COSMOS_DATABASE (no "_DB_")
    # as its env var.  COSMOS_DB_DATABASE here follows the wider platform
    # convention; the marketplace will be migrated in the next pass.
    COSMOS_ENDPOINT: str = ""
    COSMOS_DB_DATABASE: str = ""

    # ── Microsoft Purview ────────────────────────────────────────────────
    # Used by: purview_governance/purview_automation.py
    PURVIEW_ACCOUNT_NAME: str = ""

    # ── Azure Synapse Analytics ──────────────────────────────────────────
    # Used by: multi_synapse/scripts/
    SYNAPSE_SQL_ENDPOINT: str = ""

    # ── Azure Key Vault ──────────────────────────────────────────────────
    KEY_VAULT_URL: str = ""

    # ── Azure Event Hubs ─────────────────────────────────────────────────
    # Used by: data_activator/functions/alert_processor.py
    EVENTHUB_CONNECTION_STRING: str = ""
    EVENTHUB_NAME: str = ""

    # ── Observability ────────────────────────────────────────────────────
    # Used by: common/logging.py (via structlog configure calls)
    LOG_ANALYTICS_WORKSPACE_ID: str = ""
    MONITOR_DCR_ENDPOINT: str = ""

    # ── Notifications ────────────────────────────────────────────────────
    # Used by: data_activator/actions/notifier.py
    TEAMS_WEBHOOK_URL: str = ""

    # ── Logging ──────────────────────────────────────────────────────────
    LOG_LEVEL: str = "INFO"

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        # Case-sensitive to preserve the ALL_CAPS naming convention used
        # across existing csa_platform env var call sites.
        "case_sensitive": True,
    }


# Module-level singleton — import this wherever settings are needed.
# Individual modules that override env vars in tests should construct a
# fresh PlatformSettings() instance rather than mutating this object.
platform_settings = PlatformSettings()
