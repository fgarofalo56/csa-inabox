"""CSA-0113 — Fabric Data Agent reference example.

Read-class Q&A agent grounded on a Fabric Lakehouse (or semantic model).
See ``examples/fabric-data-agent/README.md`` for the full tutorial and
``GOV_NOTE.md`` for the Gov-availability positioning.

The top-level imports are intentionally lightweight so importing the
package alone does not pull in the Fabric SDK (which is pre-GA in
Azure Government).  Heavy SDK imports live inside the retriever.
"""

from __future__ import annotations

from .agent import AgentResponse, FabricDataAgent, TableBinding
from .config import FabricAgentSettings
from .generator import GeneratedAnswer, Generator, LLMClient
from .retriever import (
    Citation,
    FabricClient,
    RetrievalResult,
    Retriever,
    UnsafeSQLError,
    generate_sql,
)

__all__ = [
    "AgentResponse",
    "Citation",
    "FabricAgentSettings",
    "FabricClient",
    "FabricDataAgent",
    "GeneratedAnswer",
    "Generator",
    "LLMClient",
    "RetrievalResult",
    "Retriever",
    "TableBinding",
    "UnsafeSQLError",
    "generate_sql",
]
