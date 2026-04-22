"""
CSA Platform Semantic Kernel Integration

This module provides Semantic Kernel integration for the CSA Analytics Platform,
including factories, plugins, orchestration, and memory stores for AI-driven analytics.
"""

from .kernel_factory import CSAKernelFactory
from .plugins.data_query import DataQueryPlugin
from .plugins.governance import GovernancePlugin
from .plugins.storage import StoragePlugin
from .plugins.purview import PurviewPlugin
from .orchestration.multi_agent import (
    create_data_analyst_agent,
    create_governance_agent,
    create_quality_agent,
    create_analyst_team
)
from .memory.ai_search_memory import AISearchMemoryStore

__all__ = [
    "CSAKernelFactory",
    "DataQueryPlugin",
    "GovernancePlugin",
    "StoragePlugin",
    "PurviewPlugin",
    "create_data_analyst_agent",
    "create_governance_agent",
    "create_quality_agent",
    "create_analyst_team",
    "AISearchMemoryStore"
]

__version__ = "1.0.0"