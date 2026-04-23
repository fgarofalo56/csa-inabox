"""
CSA Platform Semantic Kernel Integration

This module provides Semantic Kernel integration for the CSA Analytics Platform,
including factories, plugins, orchestration, and memory stores for AI-driven analytics.
"""

from .kernel_factory import CSAKernelFactory
from .memory.ai_search_memory import AISearchMemoryStore
from .orchestration.multi_agent import (
    create_analyst_team,
    create_data_analyst_agent,
    create_governance_agent,
    create_quality_agent,
)
from .plugins.data_query import DataQueryPlugin
from .plugins.governance import GovernancePlugin
from .plugins.purview import PurviewPlugin
from .plugins.storage import StoragePlugin

__all__ = [
    "AISearchMemoryStore",
    "CSAKernelFactory",
    "DataQueryPlugin",
    "GovernancePlugin",
    "PurviewPlugin",
    "StoragePlugin",
    "create_analyst_team",
    "create_data_analyst_agent",
    "create_governance_agent",
    "create_quality_agent"
]

__version__ = "1.0.0"
