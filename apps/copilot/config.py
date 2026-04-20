"""Configuration for the CSA Copilot (CSA-0008, Phases 0-1).

All settings are driven by environment variables (``COPILOT_*``) so the
same code path works across local dev, CI, and Azure-hosted runs.  No
secrets are baked into the model — the :class:`CopilotSettings` instance
only ever holds values injected at process start.

Usage::

    from apps.copilot.config import CopilotSettings

    settings = CopilotSettings()  # reads env
    print(settings.azure_search_index_name)

The class is **frozen** so that callers cannot mutate configuration after
construction — the implicit contract is that a Copilot agent is created
with a snapshot of settings and keeps that snapshot for its lifetime.
"""

from __future__ import annotations

from pydantic import ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# The default corpus roots are relative to the repository root.  The CLI
# and the indexer both resolve them to absolute paths at runtime.
DEFAULT_CORPUS_ROOTS: tuple[str, ...] = (
    "docs",
    "docs/adr",
    "docs/decisions",
    "docs/migrations",
    "docs/compliance",
    "docs/runbooks",
    "examples",
    "README.md",
    "ARCHITECTURE.md",
)


class CopilotSettings(BaseSettings):
    """Environment-driven configuration for the Copilot service.

    All fields have sensible defaults so the class can be instantiated
    in tests (or dry-run CLI invocations) without any environment
    variables set.  Production deployments must provide at minimum:

    * ``COPILOT_AZURE_OPENAI_ENDPOINT`` and credentials (key or AAD).
    * ``COPILOT_AZURE_SEARCH_ENDPOINT`` and credentials (key or AAD).

    Instances are immutable (``frozen=True``) — to re-read environment
    variables at runtime, construct a new instance.
    """

    # ---- Azure OpenAI ------------------------------------------------------
    azure_openai_endpoint: str = Field(
        default="",
        description="Azure OpenAI resource endpoint URL.",
    )
    azure_openai_api_key: str = Field(
        default="",
        description="Azure OpenAI API key. Leave empty to use AAD (DefaultAzureCredential).",
    )
    azure_openai_use_aad: bool = Field(
        default=False,
        description="If true, force AAD auth even when an API key is present.",
    )
    azure_openai_api_version: str = Field(
        default="2024-06-01",
        description="Azure OpenAI REST API version.",
    )
    azure_openai_chat_deployment: str = Field(
        default="gpt-4o",
        description="Deployment name for the chat/completion model.",
    )
    azure_openai_embed_deployment: str = Field(
        default="text-embedding-3-large",
        description="Deployment name for the embedding model.",
    )
    azure_openai_embed_dimensions: int = Field(
        default=3072,
        description=(
            "Embedding vector dimensionality. Default matches "
            "text-embedding-3-large; use 1536 for text-embedding-3-small."
        ),
    )

    # ---- Azure AI Search ---------------------------------------------------
    azure_search_endpoint: str = Field(
        default="",
        description="Azure AI Search service endpoint URL.",
    )
    azure_search_api_key: str = Field(
        default="",
        description="Azure AI Search admin API key. Leave empty for AAD.",
    )
    azure_search_use_aad: bool = Field(
        default=False,
        description="If true, force AAD auth even when an API key is present.",
    )
    azure_search_index_name: str = Field(
        default="csa-copilot-corpus",
        description="Name of the Azure AI Search index that stores Copilot chunks.",
    )

    # ---- Retrieval / grounding policy -------------------------------------
    top_k: int = Field(
        default=6,
        ge=1,
        le=50,
        description="Number of top chunks to retrieve for each query.",
    )
    min_grounding_similarity: float = Field(
        default=0.45,
        ge=0.0,
        le=1.0,
        description="Minimum score for a retrieved chunk to count as grounded evidence.",
    )
    min_grounded_chunks: int = Field(
        default=1,
        ge=1,
        description="Minimum chunks above threshold required before generating an answer.",
    )
    max_citation_verification_retries: int = Field(
        default=1,
        ge=0,
        le=5,
        description="Regenerations allowed when the first answer fails citation verification.",
    )
    refusal_message: str = Field(
        default=(
            "I don't have enough grounded context from the CSA-in-a-Box documentation "
            "to answer that reliably. Try rephrasing, or add the missing doc and re-run "
            "the indexer."
        ),
        description="User-facing message returned when coverage is insufficient.",
    )

    # ---- Chunking ----------------------------------------------------------
    chunk_size: int = Field(
        default=600,
        ge=100,
        description="Target chunk size (characters) for the DocumentChunker.",
    )
    chunk_overlap: int = Field(
        default=80,
        ge=0,
        description="Overlap between consecutive chunks (characters).",
    )
    min_chunk_length: int = Field(
        default=50,
        ge=0,
        description="Minimum chunk length (characters) kept after splitting.",
    )

    # ---- Corpus selection --------------------------------------------------
    corpus_roots: list[str] = Field(
        default_factory=lambda: list(DEFAULT_CORPUS_ROOTS),
        description=(
            "Repo-relative paths scanned by the indexer. Entries may point "
            "to directories (recursively walked) or individual files."
        ),
    )
    corpus_file_extensions: list[str] = Field(
        default_factory=lambda: [".md"],
        description="File extensions considered documentation (case-insensitive).",
    )

    # ---- Confirmation broker (CSA-0102) ------------------------------------
    broker_signing_key: str = Field(
        default="",
        description=(
            "HMAC signing key for confirmation tokens. REQUIRED when execute-"
            "class tools are enabled; tests may set a fixed value. An empty "
            "value is treated as 'broker disabled' by CopilotAgentLoop."
        ),
    )
    broker_token_ttl_seconds: int = Field(
        default=600,
        ge=1,
        le=86_400,
        description="Validity window for issued confirmation tokens (seconds).",
    )
    broker_require_four_eyes: bool = Field(
        default=False,
        description=(
            "If true, the approver_principal must differ from the "
            "caller_principal when approving a ConfirmationRequest."
        ),
    )
    broker_token_salt: str = Field(
        default="csa.copilot.broker.v1",
        description=(
            "itsdangerous salt bound to the broker signing key. Change the "
            "salt to invalidate every outstanding token without rotating the key."
        ),
    )

    # pydantic-settings configuration: env var prefix + immutability.  The
    # frozen config enforces the "configuration is a snapshot" contract
    # required by the Copilot agent.
    model_config = SettingsConfigDict(
        env_prefix="COPILOT_",
        frozen=True,
        extra="ignore",
    )


# Re-export ConfigDict so downstream modules that need a frozen Pydantic
# model can import it from one place without pulling pydantic in directly.
FROZEN_MODEL_CONFIG = ConfigDict(frozen=True)
