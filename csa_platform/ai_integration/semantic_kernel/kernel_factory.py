"""
Kernel Factory for CSA Platform Semantic Kernel Integration

This module provides factory methods for creating properly configured Semantic Kernel
instances with Azure OpenAI services for the CSA Analytics Platform.
"""

import os
import logging
from typing import Optional

from semantic_kernel import Kernel
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion, AzureTextEmbedding
from azure.identity import DefaultAzureCredential

logger = logging.getLogger(__name__)


class CSAKernelFactory:
    """Factory for creating Semantic Kernel instances configured for CSA platform."""

    @staticmethod
    def create_kernel(
        deployment_name: str = "gpt-5-4",
        endpoint: Optional[str] = None,
        embedding_deployment: str = "text-embedding-3-large",
        api_version: str = "2024-02-01",
    ) -> Kernel:
        """
        Create a configured Semantic Kernel instance with Azure OpenAI services.

        Args:
            deployment_name: The Azure OpenAI chat completion deployment name
            endpoint: Azure OpenAI endpoint URL (if None, loads from AZURE_OPENAI_ENDPOINT env var)
            embedding_deployment: The Azure OpenAI text embedding deployment name
            api_version: The Azure OpenAI API version

        Returns:
            Configured Semantic Kernel instance

        Raises:
            ValueError: If required configuration is missing
            Exception: If kernel creation fails
        """
        try:
            # Get endpoint from parameter or environment
            if endpoint is None:
                endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")

            if not endpoint:
                raise ValueError(
                    "Azure OpenAI endpoint must be provided either as parameter or "
                    "AZURE_OPENAI_ENDPOINT environment variable"
                )

            logger.info(f"Creating kernel with endpoint: {endpoint}")
            logger.info(f"Chat deployment: {deployment_name}")
            logger.info(f"Embedding deployment: {embedding_deployment}")

            # Create credential
            credential = DefaultAzureCredential()

            # Create the kernel
            kernel = Kernel()

            # Add chat completion service
            chat_service = AzureChatCompletion(
                deployment_name=deployment_name,
                endpoint=endpoint,
                ad_token_provider=credential.get_token,
                api_version=api_version,
                service_id="chat"
            )
            kernel.add_service(chat_service)

            # Add text embedding service
            embedding_service = AzureTextEmbedding(
                deployment_name=embedding_deployment,
                endpoint=endpoint,
                ad_token_provider=credential.get_token,
                api_version=api_version,
                service_id="embedding"
            )
            kernel.add_service(embedding_service)

            logger.info("Kernel created successfully")
            return kernel

        except Exception as e:
            logger.error(f"Failed to create kernel: {str(e)}")
            raise

    @staticmethod
    def create_kernel_from_config() -> Kernel:
        """
        Create a kernel using configuration from environment variables.

        Environment variables:
            AZURE_OPENAI_ENDPOINT: Azure OpenAI endpoint URL
            AZURE_OPENAI_CHAT_DEPLOYMENT: Chat completion deployment name (default: gpt-5-4)
            AZURE_OPENAI_EMBEDDING_DEPLOYMENT: Text embedding deployment name (default: text-embedding-3-large)
            AZURE_OPENAI_API_VERSION: API version (default: 2024-02-01)

        Returns:
            Configured Semantic Kernel instance
        """
        return CSAKernelFactory.create_kernel(
            deployment_name=os.getenv("AZURE_OPENAI_CHAT_DEPLOYMENT", "gpt-5-4"),
            endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
            embedding_deployment=os.getenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-3-large"),
            api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2024-02-01"),
        )

    @staticmethod
    def validate_configuration() -> dict:
        """
        Validate the current environment configuration for kernel creation.

        Returns:
            Dictionary with validation results
        """
        validation = {
            "valid": True,
            "errors": [],
            "warnings": [],
            "config": {}
        }

        # Check required environment variables
        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
        if not endpoint:
            validation["valid"] = False
            validation["errors"].append("AZURE_OPENAI_ENDPOINT environment variable is required")
        else:
            validation["config"]["endpoint"] = endpoint

        # Check optional configurations
        chat_deployment = os.getenv("AZURE_OPENAI_CHAT_DEPLOYMENT", "gpt-5-4")
        embedding_deployment = os.getenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-3-large")
        api_version = os.getenv("AZURE_OPENAI_API_VERSION", "2024-02-01")

        validation["config"].update({
            "chat_deployment": chat_deployment,
            "embedding_deployment": embedding_deployment,
            "api_version": api_version
        })

        # Check for Azure credentials
        try:
            credential = DefaultAzureCredential()
            # Test credential by getting a token (this doesn't actually use the token)
            token = credential.get_token("https://management.azure.com/.default")
            if token:
                validation["config"]["azure_auth"] = "Available"
            else:
                validation["warnings"].append("Azure credentials may not be properly configured")
        except Exception as e:
            validation["warnings"].append(f"Azure credential check failed: {str(e)}")

        return validation