"""Configuration model for the Fabric Data Agent reference example.

Fabric SDK imports are intentionally deferred (inside the retriever /
agent modules) so this module stays importable without installing the
Fabric packages — important for the test matrix on Gov-leaning CI
where Fabric SDKs may not be available.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


@dataclass
class FabricAgentSettings:
    """Settings for the Fabric Data Agent.

    Attributes:
        workspace_id: Fabric workspace GUID (from ``FABRIC_WORKSPACE_ID``).
        lakehouse_id: Lakehouse GUID for SQL retrieval.
        semantic_model_id: Optional semantic-model GUID for dimensional
            retrieval.  When unset, only the lakehouse path is used.
        endpoint: Fabric API endpoint (default
            ``https://api.fabric.microsoft.com``).
        tenant_id: AAD tenant ID (optional — ``DefaultAzureCredential``
            uses whichever context is cached).
        max_rows: Hard cap on rows returned from a single SQL query.
        query_timeout_seconds: Timeout for SQL execution.
        llm_model: Deployment name of the Azure OpenAI chat model.
        llm_temperature: Temperature for the generator.
        enforce_read_only: Block any SQL that is not a bare ``SELECT``.
    """

    workspace_id: str = ""
    lakehouse_id: str = ""
    semantic_model_id: str = ""
    endpoint: str = "https://api.fabric.microsoft.com"
    tenant_id: str = ""
    max_rows: int = 500
    query_timeout_seconds: int = 30
    llm_model: str = "gpt-4o-mini"
    llm_temperature: float = 0.1
    enforce_read_only: bool = True

    @classmethod
    def from_env(cls, **overrides: Any) -> FabricAgentSettings:
        """Build settings from environment variables, with optional overrides."""
        return cls(
            workspace_id=overrides.get(
                "workspace_id",
                os.environ.get("FABRIC_WORKSPACE_ID", ""),
            ),
            lakehouse_id=overrides.get(
                "lakehouse_id",
                os.environ.get("FABRIC_LAKEHOUSE_ID", ""),
            ),
            semantic_model_id=overrides.get(
                "semantic_model_id",
                os.environ.get("FABRIC_SEMANTIC_MODEL_ID", ""),
            ),
            endpoint=overrides.get(
                "endpoint",
                os.environ.get("FABRIC_ENDPOINT", "https://api.fabric.microsoft.com"),
            ),
            tenant_id=overrides.get(
                "tenant_id",
                os.environ.get("AZURE_TENANT_ID", ""),
            ),
            max_rows=int(
                overrides.get(
                    "max_rows",
                    os.environ.get("FABRIC_AGENT_MAX_ROWS", 500),
                ),
            ),
            query_timeout_seconds=int(
                overrides.get(
                    "query_timeout_seconds",
                    os.environ.get("FABRIC_AGENT_QUERY_TIMEOUT", 30),
                ),
            ),
            llm_model=overrides.get(
                "llm_model",
                os.environ.get("FABRIC_AGENT_LLM_MODEL", "gpt-4o-mini"),
            ),
            llm_temperature=float(
                overrides.get(
                    "llm_temperature",
                    os.environ.get("FABRIC_AGENT_LLM_TEMPERATURE", 0.1),
                ),
            ),
            enforce_read_only=overrides.get(
                "enforce_read_only",
                os.environ.get("FABRIC_AGENT_READ_ONLY", "1") not in ("0", "false", "False"),
            ),
        )

    def is_configured_for_fabric(self) -> bool:
        """Return True if the workspace + lakehouse IDs are both set.

        The agent uses a mocked client in tests (no Fabric setup); this
        guard is the gate for the real SDK code paths.
        """
        return bool(self.workspace_id) and bool(self.lakehouse_id)


__all__ = [
    "FabricAgentSettings",
]
