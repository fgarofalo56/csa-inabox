"""Prompt assembly and answer generation for the RAG pipeline (CSA-0133).

:func:`build_prompt` is pure and tested without Azure mocks.
:func:`generate_answer_async` expects an ``AsyncAzureOpenAI``-shaped
client and calls it once.  Keeping these small means prompt-string
regressions never need an LLM client to reproduce.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol

from csa_platform.common.logging import get_logger

from .rate_limit import AzureOpenAIRateLimiter, get_default_limiter
from .retriever import SearchResult
from .telemetry import record_openai_call

if TYPE_CHECKING:  # pragma: no cover
    from openai import AsyncAzureOpenAI

logger = get_logger(__name__)


SYSTEM_PROMPT = (
    "You are a helpful assistant for the CSA-in-a-Box data platform. "
    "Answer questions based on the provided context from the knowledge base. "
    "If the context does not contain enough information to answer the question, "
    "say so clearly. Always cite the source document when possible."
)

USER_PROMPT_TEMPLATE = (
    "Context from the knowledge base:\n\n"
    "{context}\n\n"
    "---\n\n"
    "Question: {question}\n\n"
    "Answer the question based on the context above. "
    "If the context is insufficient, state what additional information would be needed."
)


class AsyncChatClient(Protocol):
    """Duck-typed async chat client (``client.chat.completions.create``)."""

    chat: object


def build_prompt(question: str, results: list[SearchResult]) -> tuple[str, list[dict[str, object]]]:
    """Build the user-side prompt and the legacy-shaped sources payload."""
    context_parts: list[str] = []
    sources: list[dict[str, object]] = []
    for r in results:
        context_parts.append(f"[Source: {r.source}]\n{r.text}")
        sources.append(
            {"id": r.id, "source": r.source, "score": r.score, "metadata": r.metadata}
        )
    user_message = USER_PROMPT_TEMPLATE.format(
        context="\n\n".join(context_parts), question=question
    )
    return user_message, sources


async def generate_answer_async(
    *,
    client: AsyncAzureOpenAI,
    deployment: str,
    user_message: str,
    system_prompt: str | None = None,
    max_tokens: int = 2048,
    temperature: float = 0.1,
    rate_limiter: AzureOpenAIRateLimiter | None = None,
) -> str:
    """Invoke the async chat client and return the answer text (empty on no content).

    Every call is routed through an :class:`AzureOpenAIRateLimiter` for
    RPM/TPM throttling + 429 retry (CSA-0108) and instrumented via
    :func:`record_openai_call` for cost/latency telemetry (CSA-0105).
    Supply ``rate_limiter`` to share a single limiter across the
    service / indexer; otherwise the module-level default is used.
    """
    limiter = rate_limiter or get_default_limiter()
    # Rough request-level TPM reservation: max_tokens caps the worst
    # case so the bucket refuses impossibly-oversized calls up front.
    estimated = max(0, int(max_tokens))

    async def _call() -> Any:
        return await client.chat.completions.create(
            model=deployment,
            messages=[
                {"role": "system", "content": system_prompt or SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            max_tokens=max_tokens,
            temperature=temperature,
        )

    with record_openai_call(operation="chat.completions", model=deployment) as record:
        response = await limiter.run(_call, model=deployment, estimated_tokens=estimated)
        usage = getattr(response, "usage", None)
        if usage is not None:
            record["prompt_tokens"] = int(getattr(usage, "prompt_tokens", 0) or 0)
            record["completion_tokens"] = int(getattr(usage, "completion_tokens", 0) or 0)
            limiter.record_usage(
                prompt_tokens=record["prompt_tokens"],
                completion_tokens=record["completion_tokens"],
            )
    return response.choices[0].message.content or ""


__all__ = [
    "SYSTEM_PROMPT",
    "USER_PROMPT_TEMPLATE",
    "AsyncChatClient",
    "build_prompt",
    "generate_answer_async",
]
