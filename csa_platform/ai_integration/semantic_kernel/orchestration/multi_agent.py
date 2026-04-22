"""
Multi-Agent Orchestration for Semantic Kernel

This module provides functionality for creating and managing teams of specialized AI agents
for analytics and data governance tasks using Semantic Kernel's agent framework.
"""

import logging
from typing import List, Optional, Dict, Any

from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.agents.group_chat import GroupChat, GroupChatOrchestration
from semantic_kernel.agents.group_chat.round_robin_group_chat_manager import RoundRobinGroupChatManager
from semantic_kernel.contents import ChatHistory

from ..kernel_factory import CSAKernelFactory
from ..plugins.data_query import DataQueryPlugin
from ..plugins.governance import GovernancePlugin
from ..plugins.storage import StoragePlugin
from ..plugins.purview import PurviewPlugin

logger = logging.getLogger(__name__)


def create_data_analyst_agent(
    kernel: Optional[Kernel] = None,
    name: str = "DataAnalyst",
    synapse_endpoint: Optional[str] = None,
    adx_cluster_uri: Optional[str] = None,
    storage_account_url: Optional[str] = None
) -> ChatCompletionAgent:
    """
    Create a data analyst agent with data query and storage plugins.

    Args:
        kernel: Semantic Kernel instance (if None, creates one using factory)
        name: Agent name
        synapse_endpoint: Synapse serverless SQL endpoint
        adx_cluster_uri: Azure Data Explorer cluster URI
        storage_account_url: Azure Storage account URL

    Returns:
        Configured ChatCompletionAgent for data analysis
    """
    try:
        # Create kernel if not provided
        if kernel is None:
            kernel = CSAKernelFactory.create_kernel_from_config()

        # Create and add plugins
        data_query_plugin = DataQueryPlugin(
            synapse_endpoint=synapse_endpoint,
            adx_cluster_uri=adx_cluster_uri
        )
        kernel.add_plugin(data_query_plugin, plugin_name="DataQuery")

        storage_plugin = StoragePlugin(storage_account_url=storage_account_url)
        kernel.add_plugin(storage_plugin, plugin_name="Storage")

        # Define agent instructions
        instructions = """
        You are a Data Analyst AI agent specialized in querying and analyzing data from various sources.

        Your capabilities include:
        - Executing SQL queries against Synapse serverless SQL pools
        - Running KQL queries against Azure Data Explorer clusters
        - Browsing and analyzing files in Azure Data Lake Storage
        - Providing insights and recommendations based on data analysis
        - Helping users understand data patterns and trends

        Use your available functions to:
        - Query databases using query_sql() and query_kql()
        - List and describe tables using list_tables() and describe_table()
        - Browse storage containers and files using list_containers() and list_files()
        - Preview file contents using read_file_preview()
        - Search for specific files using search_files()

        Always provide clear, actionable insights and suggest next steps for data analysis.
        When working with large datasets, offer to sample or summarize the data first.
        Be proactive in suggesting data quality checks and validation steps.
        """

        # Create the agent
        agent = ChatCompletionAgent(
            service_id="chat",
            kernel=kernel,
            name=name,
            instructions=instructions
        )

        logger.info(f"Created Data Analyst agent: {name}")
        return agent

    except Exception as e:
        logger.error(f"Failed to create Data Analyst agent: {str(e)}")
        raise


def create_governance_agent(
    kernel: Optional[Kernel] = None,
    name: str = "GovernanceAgent",
    purview_endpoint: Optional[str] = None
) -> ChatCompletionAgent:
    """
    Create a governance agent with governance and Purview plugins.

    Args:
        kernel: Semantic Kernel instance (if None, creates one using factory)
        name: Agent name
        purview_endpoint: Purview catalog endpoint URL

    Returns:
        Configured ChatCompletionAgent for data governance
    """
    try:
        # Create kernel if not provided
        if kernel is None:
            kernel = CSAKernelFactory.create_kernel_from_config()

        # Create and add plugins
        governance_plugin = GovernancePlugin(purview_endpoint=purview_endpoint)
        kernel.add_plugin(governance_plugin, plugin_name="Governance")

        purview_plugin = PurviewPlugin(purview_endpoint=purview_endpoint)
        kernel.add_plugin(purview_plugin, plugin_name="Purview")

        # Define agent instructions
        instructions = """
        You are a Data Governance AI agent specialized in ensuring data compliance, quality, and proper management.

        Your capabilities include:
        - Searching and managing the Purview data catalog
        - Looking up glossary terms and their definitions
        - Checking data classifications and compliance status
        - Validating data contracts and governance policies
        - Tracking data lineage and dependencies
        - Assessing data quality and providing recommendations

        Use your available functions to:
        - Search catalog assets using search_catalog() and search_assets()
        - Look up definitions using get_glossary_term() and list_glossary_terms()
        - Check compliance using check_classification()
        - Validate contracts using validate_contract()
        - Trace lineage using get_lineage()
        - Assess quality using get_quality_score()

        Always prioritize data security, privacy, and compliance requirements.
        Provide clear guidance on governance best practices and policy adherence.
        Help users understand the business context and impact of data governance decisions.
        """

        # Create the agent
        agent = ChatCompletionAgent(
            service_id="chat",
            kernel=kernel,
            name=name,
            instructions=instructions
        )

        logger.info(f"Created Governance agent: {name}")
        return agent

    except Exception as e:
        logger.error(f"Failed to create Governance agent: {str(e)}")
        raise


def create_quality_agent(
    kernel: Optional[Kernel] = None,
    name: str = "QualityAgent",
    purview_endpoint: Optional[str] = None,
    storage_account_url: Optional[str] = None
) -> ChatCompletionAgent:
    """
    Create a quality assessment agent focused on data quality evaluation.

    Args:
        kernel: Semantic Kernel instance (if None, creates one using factory)
        name: Agent name
        purview_endpoint: Purview catalog endpoint URL
        storage_account_url: Azure Storage account URL

    Returns:
        Configured ChatCompletionAgent for data quality assessment
    """
    try:
        # Create kernel if not provided
        if kernel is None:
            kernel = CSAKernelFactory.create_kernel_from_config()

        # Create and add plugins
        purview_plugin = PurviewPlugin(purview_endpoint=purview_endpoint)
        kernel.add_plugin(purview_plugin, plugin_name="Purview")

        storage_plugin = StoragePlugin(storage_account_url=storage_account_url)
        kernel.add_plugin(storage_plugin, plugin_name="Storage")

        # Define agent instructions
        instructions = """
        You are a Data Quality AI agent specialized in assessing and improving data quality across the platform.

        Your capabilities include:
        - Evaluating data quality metrics and scores
        - Analyzing data completeness, accuracy, and consistency
        - Identifying data quality issues and patterns
        - Providing recommendations for quality improvements
        - Assessing metadata completeness and governance maturity

        Use your available functions to:
        - Assess quality using get_quality_score() and get_asset_details()
        - Analyze file structure and content using list_files() and read_file_preview()
        - Check metadata completeness in Purview catalog
        - Evaluate naming conventions and data organization

        Focus on these quality dimensions:
        - Completeness: Are required fields populated?
        - Accuracy: Are values correct and valid?
        - Consistency: Do values follow expected patterns?
        - Timeliness: Is data fresh and up-to-date?
        - Validity: Do values meet business rules?

        Always provide actionable recommendations to improve data quality.
        Suggest specific steps for remediation and prevention of quality issues.
        Help establish data quality monitoring and alerting strategies.
        """

        # Create the agent
        agent = ChatCompletionAgent(
            service_id="chat",
            kernel=kernel,
            name=name,
            instructions=instructions
        )

        logger.info(f"Created Quality agent: {name}")
        return agent

    except Exception as e:
        logger.error(f"Failed to create Quality agent: {str(e)}")
        raise


def create_analyst_team(
    kernel: Optional[Kernel] = None,
    synapse_endpoint: Optional[str] = None,
    adx_cluster_uri: Optional[str] = None,
    storage_account_url: Optional[str] = None,
    purview_endpoint: Optional[str] = None,
    custom_agents: Optional[List[ChatCompletionAgent]] = None
) -> GroupChatOrchestration:
    """
    Create a team of analyst agents with group chat orchestration.

    Args:
        kernel: Semantic Kernel instance (if None, creates one using factory)
        synapse_endpoint: Synapse serverless SQL endpoint
        adx_cluster_uri: Azure Data Explorer cluster URI
        storage_account_url: Azure Storage account URL
        purview_endpoint: Purview catalog endpoint URL
        custom_agents: Additional custom agents to include in the team

    Returns:
        Configured GroupChatOrchestration with analyst team
    """
    try:
        # Create kernel if not provided
        if kernel is None:
            kernel = CSAKernelFactory.create_kernel_from_config()

        # Create the core analyst agents
        agents = []

        # Data Analyst
        data_analyst = create_data_analyst_agent(
            kernel=kernel,
            name="DataAnalyst",
            synapse_endpoint=synapse_endpoint,
            adx_cluster_uri=adx_cluster_uri,
            storage_account_url=storage_account_url
        )
        agents.append(data_analyst)

        # Governance Agent
        governance_agent = create_governance_agent(
            kernel=kernel,
            name="GovernanceAgent",
            purview_endpoint=purview_endpoint
        )
        agents.append(governance_agent)

        # Quality Agent
        quality_agent = create_quality_agent(
            kernel=kernel,
            name="QualityAgent",
            purview_endpoint=purview_endpoint,
            storage_account_url=storage_account_url
        )
        agents.append(quality_agent)

        # Add custom agents if provided
        if custom_agents:
            agents.extend(custom_agents)

        # Create group chat manager with round-robin strategy
        chat_manager = RoundRobinGroupChatManager()

        # Create group chat
        group_chat = GroupChat(
            agents=agents,
            selection_strategy=chat_manager
        )

        # Create orchestration
        orchestration = GroupChatOrchestration(group_chat=group_chat)

        logger.info(f"Created analyst team with {len(agents)} agents")
        return orchestration

    except Exception as e:
        logger.error(f"Failed to create analyst team: {str(e)}")
        raise


async def run_analyst_consultation(
    orchestration: GroupChatOrchestration,
    question: str,
    max_rounds: int = 10
) -> List[Dict[str, Any]]:
    """
    Run a consultation session with the analyst team.

    Args:
        orchestration: GroupChatOrchestration instance
        question: Question to ask the analyst team
        max_rounds: Maximum number of conversation rounds

    Returns:
        List of conversation messages with agent responses
    """
    try:
        logger.info(f"Starting analyst consultation: {question[:100]}...")

        # Create chat history
        chat_history = ChatHistory()
        chat_history.add_user_message(question)

        # Run the consultation
        conversation = []
        async for message in orchestration.get_chat_messages(chat_history):
            conversation.append({
                "agent": message.source if hasattr(message, 'source') else 'Unknown',
                "role": message.role,
                "content": message.content,
                "timestamp": message.metadata.get('timestamp') if hasattr(message, 'metadata') else None
            })

            # Limit rounds to prevent infinite loops
            if len(conversation) >= max_rounds:
                break

        logger.info(f"Consultation completed with {len(conversation)} messages")
        return conversation

    except Exception as e:
        logger.error(f"Analyst consultation failed: {str(e)}")
        raise


def get_agent_capabilities(agent: ChatCompletionAgent) -> Dict[str, Any]:
    """
    Get information about an agent's capabilities and available functions.

    Args:
        agent: ChatCompletionAgent instance

    Returns:
        Dictionary with agent capabilities information
    """
    try:
        capabilities = {
            "name": agent.name,
            "instructions_summary": agent.instructions[:200] + "..." if len(agent.instructions) > 200 else agent.instructions,
            "plugins": [],
            "functions": []
        }

        # Get kernel plugins and functions
        if agent.kernel:
            for plugin_name, plugin in agent.kernel.plugins.items():
                plugin_info = {
                    "name": plugin_name,
                    "functions": []
                }

                for function_name, function in plugin.functions.items():
                    func_info = {
                        "name": function_name,
                        "description": getattr(function, 'description', 'No description'),
                        "parameters": []
                    }

                    # Try to get parameter information
                    if hasattr(function, 'metadata') and hasattr(function.metadata, 'parameters'):
                        for param in function.metadata.parameters:
                            func_info["parameters"].append({
                                "name": param.name,
                                "description": param.description,
                                "type": param.type_,
                                "required": param.is_required
                            })

                    plugin_info["functions"].append(func_info)

                capabilities["plugins"].append(plugin_info)

        return capabilities

    except Exception as e:
        logger.error(f"Failed to get agent capabilities: {str(e)}")
        return {"error": str(e)}