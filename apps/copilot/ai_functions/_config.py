"""Configuration resolution for the Loom notebook AI-functions bridge.

Settings are read from ``os.environ`` FIRST (the Spark pool delivers them as
environment variables when the pool is bootstrapped with
``ai-functions-pool-setup.sh``), then fall back to an active Spark session's
conf (for pools where the analyst injects them per-session via
``spark.conf.set('spark.loom.aoai.endpoint', ...)`` or ``%%configure``).

The sovereign endpoint / audience are NOT hard-coded here — they are wired
per-boundary in ``platform/fiab/bicep/modules/admin-plane/main.bicep`` (the
``LOOM_AOAI_ENDPOINT`` / ``LOOM_AOAI_AUDIENCE`` env values flip to the
``.openai.azure.us`` host and ``cognitiveservices.azure.us`` audience on
GCC-High / IL5). This module just reads whatever the pool was given, so the
same wheel runs unmodified in every cloud.
"""

from __future__ import annotations

import os

# Default chat deployment when the pool does not pin one. gpt-4o is the model
# the AI Foundry hub deploys by default (see ai-foundry.bicep). gpt-4o-mini is
# an equally valid override via LOOM_AOAI_DEPLOYMENT.
_DEFAULT_DEPLOYMENT = "gpt-4o"

# Commercial / GCC token audience. GCC-High / IL5 set the .us audience via the
# LOOM_AOAI_AUDIENCE env (wired in main.bicep) — this is only the fallback.
_DEFAULT_AUDIENCE = "https://cognitiveservices.azure.com"


def _spark_conf_get(key: str) -> str | None:
    """Read a Spark conf key from the active SparkContext, if one exists.

    Returns ``None`` when PySpark is absent (pure-pandas notebook), when no
    SparkContext is active, or when the key is unset — never raises.
    """
    try:
        from pyspark import SparkContext

        sc = SparkContext._active_spark_context
        if sc is None:
            return None
        opt = sc._jvm.org.apache.spark.SparkContext.getOrCreate().conf().getOption(key)
        return opt.get() if opt.isDefined() else None
    except Exception:
        # Any PySpark/JVM error (no Spark, key absent) → fall back to env.
        return None


def get_endpoint() -> str:
    """AOAI inference endpoint, e.g. ``https://aoai-csa-loom-eastus2.openai.azure.com``."""
    value = os.environ.get("LOOM_AOAI_ENDPOINT") or _spark_conf_get("spark.loom.aoai.endpoint") or ""
    return value.rstrip("/")


def get_deployment() -> str:
    """Chat-completions deployment name (default ``gpt-4o``)."""
    return (
        os.environ.get("LOOM_AOAI_DEPLOYMENT")
        or _spark_conf_get("spark.loom.aoai.deployment")
        or _DEFAULT_DEPLOYMENT
    )


def get_audience() -> str:
    """AOAI token audience (sovereign-aware via the ``LOOM_AOAI_AUDIENCE`` env)."""
    value = (
        os.environ.get("LOOM_AOAI_AUDIENCE")
        or _spark_conf_get("spark.loom.aoai.audience")
        or _DEFAULT_AUDIENCE
    )
    return value.rstrip("/")


def get_api_key() -> str | None:
    """Optional AOAI key. When set, the bridge uses ``api-key`` auth instead of MSI."""
    return os.environ.get("LOOM_AOAI_KEY") or None


def get_uami_client_id() -> str | None:
    """Client id of a user-assigned managed identity to prefer for token acquisition."""
    return os.environ.get("LOOM_UAMI_CLIENT_ID") or os.environ.get("AZURE_CLIENT_ID") or None
