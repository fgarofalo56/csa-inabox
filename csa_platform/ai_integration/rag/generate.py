"""Prompt assembly and answer generation for the RAG pipeline (CSA-0133).

:func:`build_prompt` is pure and tested without Azure mocks.
:func:`generate_answer_async` expects an ``AsyncAzureOpenAI``-shaped
client and calls it once.  Keeping these small means prompt-string
regressions never need an LLM client to reproduce.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from csa_platform.common.logging import get_logger

from .retriever import SearchResult

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
) -> str:
    """Invoke the async chat client and return the answer text (empty on no content)."""
    response = await client.chat.completions.create(
        model=deployment,
        messages=[
            {"role": "system", "content": system_prompt or SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return response.choices[0].message.content or ""


__all__ = [
    "SYSTEM_PROMPT",
    "USER_PROMPT_TEMPLATE",
    "AsyncChatClient",
    "build_prompt",
    "generate_answer_async",
]
