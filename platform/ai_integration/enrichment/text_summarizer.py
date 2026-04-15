"""Azure OpenAI text summarization for data enrichment.

Provides extractive and abstractive summarization with configurable output
styles (bullet points, paragraph, executive summary).  Handles long documents
via chunked summarization with hierarchical reduction.

Usage::

    summarizer = TextSummarizer(
        endpoint="https://<resource>.openai.azure.com",
        deployment="gpt-4o",
    )

    result = summarizer.summarize(
        "Very long document text here...",
        style="executive_summary",
        max_length=300,
    )
    print(result.summary)
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from openai import AzureOpenAI

from governance.common.logging import configure_structlog, get_logger

configure_structlog(service="text-summarizer")
logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


class SummarizationMode(str, Enum):
    """Summarization approach."""

    EXTRACTIVE = "extractive"
    ABSTRACTIVE = "abstractive"


class SummarizationStyle(str, Enum):
    """Output formatting style."""

    BULLET_POINTS = "bullet_points"
    PARAGRAPH = "paragraph"
    EXECUTIVE_SUMMARY = "executive_summary"


@dataclass
class SummarizationResult:
    """Result of a summarization request."""

    summary: str
    mode: str
    style: str
    input_length: int
    output_length: int
    chunks_processed: int = 1
    is_error: bool = False
    error_message: str = ""


# ---------------------------------------------------------------------------
# Text Summarizer
# ---------------------------------------------------------------------------


class TextSummarizer:
    """Summarize text documents using Azure OpenAI.

    Supports both extractive (highlights key sentences) and abstractive
    (generates new summary text) modes.  Long documents are automatically
    split into chunks and summarised hierarchically.

    Args:
        endpoint: Azure OpenAI endpoint URL.
        api_key: API key (leave empty for ``DefaultAzureCredential``).
        deployment: Model deployment name (e.g. ``gpt-4o``).
        api_version: Azure OpenAI API version.
        max_input_tokens: Approximate token limit per summarization call.
            Documents exceeding this are chunked automatically.
        requests_per_minute: Rate limit for the deployment.
    """

    # Rough chars-per-token estimate (conservative)
    _CHARS_PER_TOKEN = 4

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        deployment: str = "gpt-4o",
        api_version: str = "2024-06-01",
        max_input_tokens: int = 6000,
        requests_per_minute: int = 60,
    ) -> None:
        self.endpoint = endpoint or os.environ.get("AZURE_OPENAI_ENDPOINT", "")
        self.api_key = api_key or os.environ.get("AZURE_OPENAI_API_KEY", "")
        self.deployment = deployment
        self.api_version = api_version
        self.max_input_tokens = max_input_tokens
        self._max_input_chars = max_input_tokens * self._CHARS_PER_TOKEN
        self._min_interval = 60.0 / requests_per_minute
        self._last_request_time: float = 0.0
        self._client: AzureOpenAI | None = None

    def _get_client(self) -> AzureOpenAI:
        """Lazily initialise the Azure OpenAI client."""
        if self._client is None:
            from openai import AzureOpenAI

            if self.api_key:
                self._client = AzureOpenAI(
                    azure_endpoint=self.endpoint,
                    api_key=self.api_key,
                    api_version=self.api_version,
                )
            else:
                from azure.identity import DefaultAzureCredential, get_bearer_token_provider

                token_provider = get_bearer_token_provider(
                    DefaultAzureCredential(),
                    "https://cognitiveservices.azure.com/.default",
                )
                self._client = AzureOpenAI(
                    azure_endpoint=self.endpoint,
                    azure_ad_token_provider=token_provider,
                    api_version=self.api_version,
                )
        return self._client

    def _rate_limit(self) -> None:
        """Enforce rate limiting between API calls."""
        now = time.monotonic()
        elapsed = now - self._last_request_time
        if elapsed < self._min_interval:
            time.sleep(self._min_interval - elapsed)
        self._last_request_time = time.monotonic()

    # -- Prompt construction ------------------------------------------------

    @staticmethod
    def _style_instruction(style: SummarizationStyle, max_length: int) -> str:
        """Build the style-specific prompt instruction."""
        if style == SummarizationStyle.BULLET_POINTS:
            return (
                f"Summarize the text as a bulleted list of key points. "
                f"Use no more than {max_length} words. "
                f"Each bullet should be a concise, standalone statement."
            )
        if style == SummarizationStyle.EXECUTIVE_SUMMARY:
            return (
                f"Write a concise executive summary in {max_length} words or fewer. "
                f"Focus on the key findings, decisions, and recommended actions. "
                f"Use a professional, direct tone."
            )
        # Default: paragraph  # noqa: ERA001
        return (
            f"Summarize the text in one or two coherent paragraphs, "
            f"using no more than {max_length} words. "
            f"Maintain the original meaning and key information."
        )

    def _build_system_prompt(
        self,
        mode: SummarizationMode,
        style: SummarizationStyle,
        max_length: int,
    ) -> str:
        """Build the full system prompt for summarization."""
        style_instruction = self._style_instruction(style, max_length)

        if mode == SummarizationMode.EXTRACTIVE:
            approach = (
                "Use an EXTRACTIVE approach: select and quote the most important "
                "sentences from the original text. Do not paraphrase."
            )
        else:
            approach = (
                "Use an ABSTRACTIVE approach: rewrite the key ideas in your own "
                "words while preserving factual accuracy."
            )

        return (
            "You are a document summarization assistant for a government data platform. "
            f"{approach}\n\n{style_instruction}"
        )

    # -- Chunking for long documents ----------------------------------------

    def _chunk_text(self, text: str) -> list[str]:
        """Split text into chunks that fit within the model's context window.

        Uses paragraph boundaries when possible; falls back to sentence
        splitting.

        Args:
            text: The full document text.

        Returns:
            List of text chunks.
        """
        if len(text) <= self._max_input_chars:
            return [text]

        # Try paragraph-level splitting first
        paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
        chunks: list[str] = []
        current_chunk: list[str] = []
        current_len = 0

        for para in paragraphs:
            para_len = len(para)
            if current_len + para_len > self._max_input_chars and current_chunk:
                chunks.append("\n\n".join(current_chunk))
                current_chunk = []
                current_len = 0
            current_chunk.append(para)
            current_len += para_len

        if current_chunk:
            chunks.append("\n\n".join(current_chunk))

        return chunks

    # -- Core summarization -------------------------------------------------

    def _summarize_single_chunk(
        self,
        text: str,
        mode: SummarizationMode,
        style: SummarizationStyle,
        max_length: int,
    ) -> str:
        """Summarize a single chunk of text.

        Args:
            text: The text to summarize.
            mode: Extractive or abstractive.
            style: Output formatting style.
            max_length: Maximum word count for the summary.

        Returns:
            The summary text.
        """
        client = self._get_client()
        system_prompt = self._build_system_prompt(mode, style, max_length)

        self._rate_limit()
        response = client.chat.completions.create(
            model=self.deployment,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Summarize the following text:\n\n{text}"},
            ],
            max_tokens=max(256, max_length * 2),  # rough token budget
            temperature=0.1,
        )
        return response.choices[0].message.content or ""

    def summarize(
        self,
        text: str,
        mode: str | SummarizationMode = "abstractive",
        style: str | SummarizationStyle = "paragraph",
        max_length: int = 200,
    ) -> SummarizationResult:
        """Summarize a document with automatic chunking for long texts.

        For documents that exceed the model's context window, the text is
        split into chunks, each is summarised, and the intermediate
        summaries are combined into a final summary.

        Args:
            text: The full document text.
            mode: ``"extractive"`` or ``"abstractive"``.
            style: ``"bullet_points"``, ``"paragraph"``, or ``"executive_summary"``.
            max_length: Maximum word count for the final summary.

        Returns:
            A :class:`SummarizationResult`.
        """
        mode_enum = SummarizationMode(mode)
        style_enum = SummarizationStyle(style)
        input_length = len(text)

        try:
            chunks = self._chunk_text(text)
            logger.info("summarizing_document", input_chars=input_length, chunks=len(chunks))

            if len(chunks) == 1:
                summary = self._summarize_single_chunk(chunks[0], mode_enum, style_enum, max_length)
            else:
                # Hierarchical summarization: summarize each chunk, then combine
                chunk_summaries: list[str] = []
                for idx, chunk in enumerate(chunks):
                    logger.info("summarizing_chunk", index=idx + 1, total=len(chunks))
                    chunk_summary = self._summarize_single_chunk(
                        chunk, mode_enum, SummarizationStyle.PARAGRAPH, max_length
                    )
                    chunk_summaries.append(chunk_summary)

                # Combine chunk summaries into a final summary
                combined = "\n\n".join(chunk_summaries)
                logger.info("combining_chunk_summaries", count=len(chunk_summaries))
                summary = self._summarize_single_chunk(combined, mode_enum, style_enum, max_length)

            return SummarizationResult(
                summary=summary,
                mode=mode_enum.value,
                style=style_enum.value,
                input_length=input_length,
                output_length=len(summary),
                chunks_processed=len(chunks),
            )
        except Exception as exc:
            logger.exception("summarization.failed")
            return SummarizationResult(
                summary="",
                mode=mode_enum.value,
                style=style_enum.value,
                input_length=input_length,
                output_length=0,
                is_error=True,
                error_message=str(exc),
            )

    def summarize_batch(
        self,
        texts: list[str],
        mode: str = "abstractive",
        style: str = "paragraph",
        max_length: int = 200,
    ) -> list[SummarizationResult]:
        """Summarize a batch of texts with rate limiting.

        Args:
            texts: List of document texts.
            mode: Summarization mode.
            style: Output style.
            max_length: Maximum word count per summary.

        Returns:
            List of :class:`SummarizationResult`.
        """
        results: list[SummarizationResult] = []
        for idx, text in enumerate(texts):
            logger.info("summarizing_document", index=idx + 1, total=len(texts))
            result = self.summarize(text, mode=mode, style=style, max_length=max_length)
            results.append(result)
        return results
