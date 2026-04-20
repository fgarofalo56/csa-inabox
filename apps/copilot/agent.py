"""CopilotAgent — Phase 1 grounded Q&A with PydanticAI.

The agent orchestrates the deterministic parts of the pipeline
(retrieval, grounding check, citation verification) in Python and
delegates **only the natural-language generation** to PydanticAI.  We
don't use PydanticAI's tool-calling loop for retrieval — giving the LLM
the context upfront keeps the control flow auditable and makes it
impossible for the model to "skip" the grounding check.

Flow::

    ask(question)
      -> retrieve top-k chunks via VectorStore (async)
      -> evaluate_coverage (pure)           -- REFUSAL POINT 1
      -> build context prompt with [1], [2]... markers
      -> PydanticAI Agent.run(prompt) -> _GenerationResult
      -> verify_citations (pure)            -- REFUSAL POINT 2
      -> (optional) retry once with a repair prompt
      -> AnswerResponse

The agent caches its PydanticAI ``Agent`` instance so repeat calls
reuse connection pools.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol

from pydantic import BaseModel, Field

from apps.copilot.config import CopilotSettings
from apps.copilot.grounding import (
    Coverage,
    GroundingPolicy,
    evaluate_coverage,
    verify_citations,
)
from apps.copilot.models import (
    AnswerResponse,
    Citation,
    CitationVerificationResult,
    DocType,
    RetrievedChunk,
)
from csa_platform.ai_integration.rag.pipeline import SearchResult, VectorStore
from csa_platform.common.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover
    from pydantic_ai import Agent as PydanticAIAgent

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------


SYSTEM_PROMPT = """You are the CSA-in-a-Box Copilot.

You answer questions about the CSA-in-a-Box data platform using ONLY the
context chunks provided in the user message. Each chunk is numbered
[1], [2], etc.

Hard rules:
1. Every factual claim MUST be followed by at least one citation marker
   like [1] or [2] that points to a chunk in the provided context.
2. Do NOT invent citation numbers. Only use numbers that appear in the
   context.
3. If the context is insufficient, say so explicitly and do not
   fabricate answers.
4. Keep answers concise (aim for under 300 words unless the question
   clearly requires more).
5. Return structured JSON matching the schema you were given: the
   ``answer`` field holds the prose with [n] markers and the
   ``citations`` field lists the ids you used.

When you cite a chunk, also include its id in the ``citations`` list of
your output.
"""


# ---------------------------------------------------------------------------
# LLM contract
# ---------------------------------------------------------------------------


class GenerationResult(BaseModel):
    """Structured output the LLM must produce.

    The Copilot agent passes this as the ``output_type`` to PydanticAI,
    forcing the model to emit well-formed JSON with the citation ids
    it actually used.
    """

    answer: str = Field(description="The answer text, with [n] markers for every claim.")
    citations: list[int] = Field(
        default_factory=list,
        description="The 1-based citation ids used in the answer.",
    )


class LLMGenerator(Protocol):
    """Minimal interface the agent needs from a language model.

    Implemented by :class:`PydanticAIGenerator` in production; tests
    pass a stub that returns a pre-baked :class:`GenerationResult`.
    """

    async def generate(self, prompt: str) -> GenerationResult: ...


# ---------------------------------------------------------------------------
# PydanticAI wiring
# ---------------------------------------------------------------------------


class PydanticAIGenerator:
    """Thin adapter over a PydanticAI ``Agent`` producing :class:`GenerationResult`.

    The adapter owns a single cached agent instance so successive
    ``generate`` calls reuse the underlying connection pool.  The model
    factory is lazy so importing this module never requires Azure
    credentials (a big UX win for tests and ``--help``).
    """

    def __init__(self, settings: CopilotSettings) -> None:
        self.settings = settings
        self._agent: PydanticAIAgent[None, GenerationResult] | None = None

    def _build_agent(self) -> PydanticAIAgent[None, GenerationResult]:
        """Construct the PydanticAI Agent bound to Azure OpenAI."""
        # Deferred imports: importing pydantic-ai and openai is
        # relatively heavy and shouldn't happen on module import.
        from openai import AsyncAzureOpenAI
        from pydantic_ai import Agent
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.azure import AzureProvider

        if self.settings.azure_openai_api_key and not self.settings.azure_openai_use_aad:
            openai_client = AsyncAzureOpenAI(
                azure_endpoint=self.settings.azure_openai_endpoint,
                api_key=self.settings.azure_openai_api_key,
                api_version=self.settings.azure_openai_api_version,
            )
        else:
            from azure.identity import get_bearer_token_provider
            from azure.identity.aio import (
                DefaultAzureCredential as AsyncDefaultAzureCredential,
            )

            credential = AsyncDefaultAzureCredential()
            token_provider = get_bearer_token_provider(
                credential,  # type: ignore[arg-type]
                "https://cognitiveservices.azure.com/.default",
            )
            openai_client = AsyncAzureOpenAI(
                azure_endpoint=self.settings.azure_openai_endpoint,
                azure_ad_token_provider=token_provider,
                api_version=self.settings.azure_openai_api_version,
            )

        provider = AzureProvider(openai_client=openai_client)
        model = OpenAIChatModel(
            self.settings.azure_openai_chat_deployment,
            provider=provider,
        )
        return Agent(
            model=model,
            output_type=GenerationResult,
            system_prompt=SYSTEM_PROMPT,
            retries=0,
        )

    async def generate(self, prompt: str) -> GenerationResult:
        """Run the agent once and return the parsed :class:`GenerationResult`."""
        if self._agent is None:
            self._agent = self._build_agent()
        result = await self._agent.run(prompt)
        # PydanticAI's AgentRunResult has an ``output`` attribute of the
        # typed output.  We copy into a fresh GenerationResult to guard
        # against any edge cases where the SDK evolves its types.
        output: GenerationResult = result.output
        return output


# ---------------------------------------------------------------------------
# Retrieval helpers
# ---------------------------------------------------------------------------


def _normalise_similarity(score: float) -> float:
    """Clamp an Azure AI Search score to ``[0.0, 1.0]``.

    Azure Search scores can exceed 1.0 for BM25/hybrid queries.  We
    map ``>=1.0`` → ``1.0`` and negatives → ``0.0``; everything else
    passes through unchanged.  This keeps the :class:`Coverage`
    contract (similarity in ``[0, 1]``) honest without silently
    rescaling legitimate 0-1 scores.
    """
    if score <= 0.0:
        return 0.0
    if score >= 1.0:
        return 1.0
    return score


def _search_result_to_retrieved_chunk(result: SearchResult) -> RetrievedChunk:
    """Convert a pipeline :class:`SearchResult` to a Copilot chunk."""
    meta = result.metadata or {}
    doc_type: DocType = meta.get("doc_type", "unknown")
    return RetrievedChunk(
        id=result.id,
        source_path=result.source or meta.get("source_path", ""),
        text=result.text,
        similarity=_normalise_similarity(result.score),
        doc_type=doc_type,
        metadata=meta,
    )


class SupportsAsyncSearch(Protocol):
    """Protocol for the part of :class:`VectorStore` the agent needs."""

    async def search_async(
        self,
        query_vector: list[float],
        query_text: str = "",
        top_k: int = 5,
        score_threshold: float = 0.0,
        filters: str | None = None,
        use_semantic_reranker: bool = False,
    ) -> list[SearchResult]: ...


class SupportsAsyncEmbed(Protocol):
    """Protocol for the async embedder."""

    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]: ...


# ---------------------------------------------------------------------------
# CopilotAgent
# ---------------------------------------------------------------------------


class CopilotAgent:
    """High-level grounded Q&A entry point.

    Dependencies are all injectable via constructor params so tests can
    substitute stubs for the embedder, retriever, and LLM.  The default
    factory (:meth:`from_settings`) wires up the production Azure
    stack.
    """

    def __init__(
        self,
        settings: CopilotSettings,
        *,
        retriever: SupportsAsyncSearch,
        embedder: SupportsAsyncEmbed,
        llm: LLMGenerator,
    ) -> None:
        self.settings = settings
        self.retriever = retriever
        self.embedder = embedder
        self.llm = llm
        self.policy = GroundingPolicy(
            min_similarity=settings.min_grounding_similarity,
            min_chunks=settings.min_grounded_chunks,
            refusal_message=settings.refusal_message,
            off_scope_classifier="similarity",
        )

    # -- factories -----------------------------------------------------------

    @classmethod
    def from_settings(cls, settings: CopilotSettings) -> CopilotAgent:
        """Build a CopilotAgent using the default Azure-backed components."""
        from csa_platform.ai_integration.rag.pipeline import EmbeddingGenerator

        use_openai_key = bool(settings.azure_openai_api_key) and not settings.azure_openai_use_aad
        embedder = EmbeddingGenerator(
            endpoint=settings.azure_openai_endpoint,
            api_key=settings.azure_openai_api_key if use_openai_key else "",
            deployment=settings.azure_openai_embed_deployment,
            api_version=settings.azure_openai_api_version,
            dimensions=settings.azure_openai_embed_dimensions,
        )

        use_search_key = bool(settings.azure_search_api_key) and not settings.azure_search_use_aad
        retriever = VectorStore(
            endpoint=settings.azure_search_endpoint,
            api_key=settings.azure_search_api_key if use_search_key else "",
            index_name=settings.azure_search_index_name,
            embedding_dimensions=settings.azure_openai_embed_dimensions,
        )

        llm = PydanticAIGenerator(settings)
        return cls(
            settings=settings,
            retriever=retriever,
            embedder=embedder,
            llm=llm,
        )

    # -- public API ----------------------------------------------------------

    async def ask(self, question: str) -> AnswerResponse:
        """Answer *question* with the full grounding + verification contract.

        Returns:
            An :class:`AnswerResponse`.  If ``refused`` is ``True`` the
            caller should surface ``refusal_reason`` alongside the
            refusal message rather than treating the response as a
            genuine answer.
        """
        if not question or not question.strip():
            return AnswerResponse(
                question=question,
                answer=self.policy.refusal_message,
                citations=[],
                groundedness=0.0,
                refused=True,
                refusal_reason="empty_question",
            )

        retrieved = await self._retrieve(question)
        coverage = evaluate_coverage(retrieved, self.policy)
        logger.info(
            "copilot.agent.coverage",
            is_grounded=coverage.is_grounded,
            max_sim=coverage.max_similarity,
            total=coverage.total_chunks,
            above=coverage.chunks_above_threshold,
        )

        if not coverage.is_grounded:
            return AnswerResponse(
                question=question,
                answer=self.policy.refusal_message,
                citations=[],
                groundedness=coverage.max_similarity,
                refused=True,
                refusal_reason="no_coverage",
            )

        # Build the numbered context once and keep the id/similarity
        # mapping for citation verification.
        id_to_chunk, prompt = self._build_grounded_prompt(question, retrieved)

        return await self._generate_and_verify(
            question=question,
            prompt=prompt,
            retrieved=retrieved,
            id_to_chunk=id_to_chunk,
            coverage=coverage,
        )

    # -- internals -----------------------------------------------------------

    async def _retrieve(self, question: str) -> list[RetrievedChunk]:
        """Embed + vector-search *question*, return normalised chunks."""
        embeddings = await self.embedder.embed_texts_async([question])
        query_vector = embeddings[0]
        raw = await self.retriever.search_async(
            query_vector=query_vector,
            query_text=question,
            top_k=self.settings.top_k,
        )
        return [_search_result_to_retrieved_chunk(r) for r in raw]

    def _build_grounded_prompt(
        self,
        question: str,
        retrieved: list[RetrievedChunk],
    ) -> tuple[dict[int, RetrievedChunk], str]:
        """Return (id→chunk map, user prompt) for LLM consumption."""
        id_to_chunk: dict[int, RetrievedChunk] = {}
        context_lines: list[str] = []
        for idx, chunk in enumerate(retrieved, start=1):
            id_to_chunk[idx] = chunk
            context_lines.append(
                f"[{idx}] ({chunk.source_path}, doc_type={chunk.doc_type}, "
                f"similarity={chunk.similarity:.2f})\n{chunk.text}",
            )

        context_block = "\n\n".join(context_lines)
        prompt = (
            "Context chunks (cite with [n] markers):\n\n"
            f"{context_block}\n\n"
            "---\n"
            f"Question: {question}\n\n"
            "Produce structured JSON. Every factual sentence must end "
            "with at least one [n] marker referencing the chunks above."
        )
        return id_to_chunk, prompt

    async def _generate_and_verify(
        self,
        *,
        question: str,
        prompt: str,
        retrieved: list[RetrievedChunk],
        id_to_chunk: dict[int, RetrievedChunk],
        coverage: Coverage,
    ) -> AnswerResponse:
        """Drive the LLM + citation verifier, with optional retry."""
        attempts = 0
        last_verification: CitationVerificationResult | None = None
        last_generation: GenerationResult | None = None
        current_prompt = prompt

        max_attempts = 1 + self.settings.max_citation_verification_retries

        while attempts < max_attempts:
            attempts += 1
            generation = await self.llm.generate(current_prompt)
            last_generation = generation

            chunk_id_by_citation = {
                cid: id_to_chunk[cid].id for cid in id_to_chunk if cid in id_to_chunk
            }
            verification = verify_citations(
                answer_text=generation.answer,
                retrieved_chunks=retrieved,
                cited_ids=generation.citations,
                chunk_id_by_citation=chunk_id_by_citation,
            )
            last_verification = verification

            if verification.valid:
                citations = self._build_citations(
                    cited_ids=generation.citations,
                    marker_ids=verification.marker_ids_found,
                    id_to_chunk=id_to_chunk,
                )
                return AnswerResponse(
                    question=question,
                    answer=generation.answer,
                    citations=citations,
                    groundedness=coverage.max_similarity,
                    refused=False,
                    refusal_reason=None,
                )

            # Failed verification: build a repair prompt if we have
            # retries left, otherwise break out to the refusal branch.
            if attempts >= max_attempts:
                break
            current_prompt = self._build_repair_prompt(
                original=prompt,
                bad_answer=generation.answer,
                verification=verification,
            )
            logger.warning(
                "copilot.agent.citation_retry",
                attempt=attempts,
                missing=verification.missing_markers,
                fabricated=verification.fabricated_ids,
            )

        # Exhausted retries — refuse.
        logger.error(
            "copilot.agent.citation_verification_failed",
            attempts=attempts,
            missing=last_verification.missing_markers if last_verification else [],
            fabricated=last_verification.fabricated_ids if last_verification else [],
            answer=(last_generation.answer if last_generation else "")[:400],
        )
        return AnswerResponse(
            question=question,
            answer=self.policy.refusal_message,
            citations=[],
            groundedness=coverage.max_similarity,
            refused=True,
            refusal_reason="citation_verification_failed",
        )

    # -- helpers -------------------------------------------------------------

    @staticmethod
    def _build_citations(
        cited_ids: list[int],
        marker_ids: list[int],
        id_to_chunk: dict[int, RetrievedChunk],
    ) -> list[Citation]:
        """Build the response's :class:`Citation` list from the verified ids."""
        ordered: list[int] = []
        seen: set[int] = set()
        for seq in (cited_ids, marker_ids):
            for cid in seq:
                if cid in seen:
                    continue
                if cid not in id_to_chunk:
                    continue
                seen.add(cid)
                ordered.append(cid)

        citations: list[Citation] = []
        for cid in ordered:
            chunk = id_to_chunk[cid]
            excerpt = chunk.text.strip()
            if len(excerpt) > 500:
                excerpt = excerpt[:497].rstrip() + "..."
            citations.append(
                Citation(
                    id=cid,
                    source_path=chunk.source_path,
                    excerpt=excerpt,
                    similarity=chunk.similarity,
                    chunk_id=chunk.id,
                ),
            )
        return citations

    @staticmethod
    def _build_repair_prompt(
        *,
        original: str,
        bad_answer: str,
        verification: CitationVerificationResult,
    ) -> str:
        """Prompt that asks the LLM to fix a citation violation."""
        issues: list[str] = []
        if verification.missing_markers:
            issues.append(
                "Citations claimed without a matching [n] marker: "
                + ", ".join(str(i) for i in verification.missing_markers),
            )
        if verification.fabricated_ids:
            issues.append(
                "Fabricated citation ids (not in the provided context): "
                + ", ".join(str(i) for i in verification.fabricated_ids),
            )
        if not verification.marker_ids_found:
            issues.append(
                "The previous answer contained no [n] citation markers; every "
                "factual sentence must carry at least one marker.",
            )

        issue_block = "\n- ".join(issues) if issues else "unspecified"

        return (
            f"{original}\n\n"
            "---\n"
            "Your previous answer failed citation verification:\n- "
            f"{issue_block}\n\n"
            "Previous answer:\n"
            f"{bad_answer}\n\n"
            "Regenerate the answer. Use only citation ids from the context "
            "above, put a [n] marker on every factual sentence, and list "
            "the ids you used in the ``citations`` field."
        )


def _require_any(value: Any, name: str) -> Any:  # pragma: no cover - defensive
    """Raise if *value* is falsy.  Unused in Phase 1 but kept for future phases."""
    if not value:
        raise ValueError(f"Copilot configuration error: {name} is required.")
    return value


__all__ = [
    "SYSTEM_PROMPT",
    "CopilotAgent",
    "GenerationResult",
    "LLMGenerator",
    "PydanticAIGenerator",
]
